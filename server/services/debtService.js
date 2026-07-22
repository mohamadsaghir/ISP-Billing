'use strict';

const { getDb } = require('../config/db');

/**
 * Generate monthly bill rows for a customer from subscription_date to current month.
 * Called when a customer is created or on cron tick.
 */
function ensureMonthlyBillsForCustomer(customerId) {
  const db = getDb();

  const customer = db.prepare(`
    SELECT id, monthly_amount, subscription_date, status
    FROM customers WHERE id = ? AND is_active = 1
  `).get(customerId);

  if (!customer) return;

  const startDate = new Date(customer.subscription_date);
  const now = new Date();

  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth() + 1; // 1-based
  let endYear = now.getFullYear();
  let endMonth = now.getMonth() + 1;

  if (customer.status === 'suspended') {
    endMonth--;
    if (endMonth < 1) {
      endMonth = 12;
      endYear--;
    }
  }

  // Delete unpaid bills outside the active subscription date range
  db.prepare(`
    DELETE FROM monthly_bills
    WHERE customer_id = ?
      AND status = 'unpaid'
      AND (
        (year < ? OR (year = ? AND month < ?))
        OR
        (year > ? OR (year = ? AND month > ?))
      )
  `).run(customerId, startYear, startYear, startMonth, endYear, endYear, endMonth);

  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    db.prepare(`
      INSERT OR IGNORE INTO monthly_bills (customer_id, year, month, amount_due)
      VALUES (?, ?, ?, ?)
    `).run(customerId, y, m, customer.monthly_amount);
    m++;
    if (m > 12) { m = 1; y++; }
  }

  db.save();
}

/**
 * Ensure monthly bills exist for ALL active customers.
 * Run on server start and via cron.
 */
function ensureAllMonthlyBills() {
  const db = getDb();
  const customers = db.prepare('SELECT id FROM customers WHERE is_active = 1').all();
  for (const c of customers) {
    ensureMonthlyBillsForCustomer(c.id);
  }
  db.save();
  console.log(`✅ Monthly bills ensured for ${customers.length} customers`);
}

/**
 * Get total outstanding debt for a customer.
 * = sum of (amount_due - amount_paid) for all unpaid/partial bills
 *   + sum of unpaid obligations
 */
function getCustomerDebt(customerId) {
  const db = getDb();

  const billDebt = db.prepare(`
    SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS total
    FROM monthly_bills
    WHERE customer_id = ? AND status != 'paid'
  `).get(customerId);

  const extraDebt = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM customer_extras
    WHERE customer_id = ? AND is_paid = 0
  `).get(customerId);

  const bTotal = billDebt ? billDebt.total : 0;
  const eTotal = extraDebt ? extraDebt.total : 0;

  return {
    billDebt: bTotal,
    obligationDebt: eTotal,
    total: bTotal + eTotal,
  };
}

/**
 * Apply a payment amount to a customer's oldest unpaid bills (FIFO).
 * Returns detailed breakdown of which bills were affected.
 */
function applyPayment(customerId, amount) {
  const db = getDb();

  // Get unpaid/partial bills ordered by oldest first
  const unpaidBills = db.prepare(`
    SELECT * FROM monthly_bills
    WHERE customer_id = ? AND status != 'paid'
    ORDER BY year ASC, month ASC
  `).all(customerId);

  let remaining = amount;
  const affected = [];

  for (const bill of unpaidBills) {
    if (remaining <= 0) break;

    const outstanding = bill.amount_due - bill.amount_paid;
    const toApply = Math.min(remaining, outstanding);
    const newPaid = bill.amount_paid + toApply;
    const newStatus = newPaid >= bill.amount_due ? 'paid' : 'partial';

    db.prepare(`
      UPDATE monthly_bills SET amount_paid = ?, status = ? WHERE id = ?
    `).run(newPaid, newStatus, bill.id);

    affected.push({ year: bill.year, month: bill.month, applied: toApply, status: newStatus });
    remaining -= toApply;
  }

  db.save();
  return { affected, overpayment: remaining };
}

/**
 * Get payment summary for a distributor (or all if no distributorId)
 */
function getPaymentSummary(distributorId = null, allowedNeighborhoods = null) {
  const db = getDb();

  // Clear obligations from prior months automatically
  db.prepare(`
    DELETE FROM obligations 
    WHERE strftime('%Y-%m', created_at) < strftime('%Y-%m', 'now', 'localtime')
  `).run();
  db.save();

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let monthly, allTime, obligations, totalObligationsVal = 0;

  // Build neighborhood filtering clause if needed
  let nhClause = '';
  const nhParams = [];
  if (allowedNeighborhoods) {
    const list = allowedNeighborhoods.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length > 0) {
      const placeholders = list.map(() => '?').join(',');
      nhClause = ` AND TRIM(c.neighborhood) IN (${placeholders})`;
      nhParams.push(...list);
    } else {
      nhClause = ' AND 1 = 0';
    }
  }

  if (distributorId) {
    monthly = db.prepare(`
      SELECT
        COALESCE(SUM(mb.amount_due), 0)                        AS total_billed,
        COALESCE(SUM(mb.amount_paid), 0)                       AS total_collected,
        COALESCE(SUM(mb.amount_due - mb.amount_paid), 0)       AS total_outstanding,
        COUNT(DISTINCT CASE WHEN mb.status = 'paid' THEN mb.customer_id END)   AS paid_count,
        COUNT(DISTINCT CASE WHEN mb.status != 'paid' THEN mb.customer_id END)  AS unpaid_count
      FROM monthly_bills mb
      JOIN customers c ON c.id = mb.customer_id
      WHERE mb.year = ? AND mb.month = ? AND c.distributor_id = ? AND c.is_active = 1 ${nhClause}
    `).get(year, month, distributorId, ...nhParams);

    allTime = db.prepare(`
      SELECT COALESCE(SUM(mb.amount_due - mb.amount_paid), 0) AS total
      FROM monthly_bills mb
      JOIN customers c ON c.id = mb.customer_id
      WHERE mb.status != 'paid' AND c.distributor_id = ? AND c.is_active = 1 ${nhClause}
    `).get(distributorId, ...nhParams);

    obligations = db.prepare(`
      SELECT COALESCE(SUM(o.amount), 0) AS total
      FROM obligations o
      WHERE o.is_paid = 0 AND o.distributor_id = ?
    `).get(distributorId);

    totalObligationsVal = db.prepare(`
      SELECT COALESCE(SUM(o.amount), 0) AS total
      FROM obligations o
      WHERE o.distributor_id = ?
    `).get(distributorId).total;
  } else {
    monthly = db.prepare(`
      SELECT
        COALESCE(SUM(mb.amount_due), 0)                        AS total_billed,
        COALESCE(SUM(mb.amount_paid), 0)                       AS total_collected,
        COALESCE(SUM(mb.amount_due - mb.amount_paid), 0)       AS total_outstanding,
        COUNT(DISTINCT CASE WHEN mb.status = 'paid' THEN mb.customer_id END)   AS paid_count,
        COUNT(DISTINCT CASE WHEN mb.status != 'paid' THEN mb.customer_id END)  AS unpaid_count
      FROM monthly_bills mb
      JOIN customers c ON c.id = mb.customer_id
      WHERE mb.year = ? AND mb.month = ? AND c.is_active = 1
    `).get(year, month);

    allTime = db.prepare(`
      SELECT COALESCE(SUM(mb.amount_due - mb.amount_paid), 0) AS total
      FROM monthly_bills mb
      JOIN customers c ON c.id = mb.customer_id
      WHERE mb.status != 'paid' AND c.is_active = 1
    `).get();

    obligations = db.prepare(`
      SELECT COALESCE(SUM(o.amount), 0) AS total
      FROM obligations o
      WHERE o.is_paid = 0
    `).get();

    totalObligationsVal = db.prepare(`
      SELECT COALESCE(SUM(o.amount), 0) AS total
      FROM obligations o
    `).get().total;
  }

  let unpaidExtras = 0;
  if (distributorId) {
    unpaidExtras = db.prepare(`
      SELECT COALESCE(SUM(ce.amount), 0) AS total
      FROM customer_extras ce
      JOIN customers c ON c.id = ce.customer_id
      WHERE ce.is_paid = 0 AND c.is_active = 1 AND c.distributor_id = ? ${nhClause}
    `).get(distributorId, ...nhParams).total;
  } else {
    unpaidExtras = db.prepare(`
      SELECT COALESCE(SUM(ce.amount), 0) AS total
      FROM customer_extras ce
      JOIN customers c ON c.id = ce.customer_id
      WHERE ce.is_paid = 0 AND c.is_active = 1
    `).get().total;
  }

  let suspendedQuery, suspendedValQuery;
  if (distributorId) {
    suspendedQuery = db.prepare(`
      SELECT COUNT(*) AS count FROM customers c
      WHERE c.distributor_id = ? AND c.is_active = 1 AND c.status = 'suspended' ${nhClause}
    `).get(distributorId, ...nhParams);
    suspendedValQuery = db.prepare(`
      SELECT COALESCE(SUM(c.monthly_amount), 0) AS total FROM customers c
      WHERE c.distributor_id = ? AND c.is_active = 1 AND c.status = 'suspended' ${nhClause}
    `).get(distributorId, ...nhParams);
  } else {
    suspendedQuery = db.prepare(`
      SELECT COUNT(*) AS count FROM customers 
      WHERE is_active = 1 AND status = 'suspended'
    `).get();
    suspendedValQuery = db.prepare(`
      SELECT COALESCE(SUM(monthly_amount), 0) AS total FROM customers 
      WHERE is_active = 1 AND status = 'suspended'
    `).get();
  }
  const suspendedCount = suspendedQuery ? suspendedQuery.count : 0;
  const suspendedValue = suspendedValQuery ? suspendedValQuery.total : 0;

  return {
    thisMonth: monthly || { total_billed: 0, total_collected: 0, total_outstanding: 0, paid_count: 0, unpaid_count: 0 },
    allTimeOutstanding: allTime ? allTime.total : 0,
    unpaidObligations: obligations ? obligations.total : 0,
    grandTotal: (allTime ? allTime.total : 0) + (obligations ? obligations.total : 0),
    suspendedCount,
    suspendedValue,
    unpaidExtras
  };
}

module.exports = {
  ensureMonthlyBillsForCustomer,
  ensureAllMonthlyBills,
  getCustomerDebt,
  applyPayment,
  getPaymentSummary,
};
