'use strict';

const express = require('express');
const { getDb } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { getPaymentSummary, ensureAllMonthlyBills } = require('../services/debtService');

const router = express.Router();

router.use(authenticate);

function getReportFilter(req) {
  if (req.user.role === 'superadmin') {
    if (req.query.distributorId) {
      return { clause: 'AND c.distributor_id = ?', params: [parseInt(req.query.distributorId)] };
    }
    return { clause: '', params: [] };
  } else if (req.user.role === 'collector') {
    let clause = 'AND c.distributor_id = ?';
    const params = [req.user.parent_id];
    if (req.user.allowed_neighborhoods) {
      const list = req.user.allowed_neighborhoods.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length > 0) {
        const placeholders = list.map(() => '?').join(',');
        clause += ` AND TRIM(c.neighborhood) IN (${placeholders})`;
        params.push(...list);
      } else {
        clause += ' AND 1 = 0';
      }
    } else {
      clause += ' AND 1 = 0';
    }
    return { clause, params };
  }
  return { clause: 'AND c.distributor_id = ?', params: [req.user.id] };
}

/**
 * @route  GET /api/reports/summary
 * @desc   Get collection summary stats
 */
router.get('/summary', (req, res) => {
  let distributorId = req.user.role === 'superadmin' ? null : req.user.id;
  let allowedNeighborhoods = null;
  if (req.user.role === 'superadmin' && req.query.distributorId) {
    distributorId = parseInt(req.query.distributorId);
  } else if (req.user.role === 'collector') {
    distributorId = req.user.parent_id;
    allowedNeighborhoods = req.user.allowed_neighborhoods;
  }
  const summary = getPaymentSummary(distributorId, allowedNeighborhoods);
  res.json({ success: true, data: summary });
});

/**
 * @route  GET /api/reports/customers-status
 * @desc   List all customers with their payment status for current month
 */
router.get('/customers-status', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { clause, params } = getReportFilter(req);

  const customers = db.prepare(`
    SELECT
      c.id, c.full_name, c.family_name, c.neighborhood, c.phone, c.monthly_amount,
      u.full_name AS distributor_name,
      mb.status AS this_month_status,
      mb.amount_due, mb.amount_paid,
      COALESCE(
        (SELECT SUM(mb2.amount_due - mb2.amount_paid)
         FROM monthly_bills mb2
         WHERE mb2.customer_id = c.id AND mb2.status != 'paid'), 0
      ) AS total_bill_debt,
      COALESCE(
        (SELECT SUM(e.amount) FROM customer_extras e WHERE e.customer_id = c.id AND e.is_paid = 0), 0
      ) AS total_obligation_debt
    FROM customers c
    JOIN users u ON u.id = c.distributor_id
    LEFT JOIN monthly_bills mb ON mb.customer_id = c.id AND mb.year = ? AND mb.month = ?
    WHERE c.is_active = 1 ${clause}
    ORDER BY (mb.status = 'unpaid') DESC, c.full_name ASC
  `).all(year, month, ...params);

  const result = customers.map((c) => ({
    ...c,
    total_debt: c.total_bill_debt + c.total_obligation_debt,
  }));

  const paid = result.filter((c) => c.this_month_status === 'paid').length;
  const unpaid = result.filter((c) => c.this_month_status !== 'paid').length;

  res.json({
    success: true,
    data: result,
    meta: { total: result.length, paid, unpaid, year, month },
  });
});

/**
 * @route  GET /api/reports/monthly
 * @desc   Get monthly breakdown for a specific year
 */
router.get('/monthly', (req, res) => {
  const db = getDb();
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const { clause, params } = getReportFilter(req);

  const monthly = db.prepare(`
    SELECT
      mb.month,
      COALESCE(SUM(mb.amount_due), 0)            AS total_billed,
      COALESCE(SUM(mb.amount_paid), 0)           AS total_collected,
      COALESCE(SUM(mb.amount_due - mb.amount_paid), 0) AS total_outstanding,
      COUNT(CASE WHEN mb.status = 'paid' THEN 1 END)    AS paid_count,
      COUNT(CASE WHEN mb.status != 'paid' THEN 1 END)   AS unpaid_count
    FROM monthly_bills mb
    JOIN customers c ON c.id = mb.customer_id
    WHERE mb.year = ? ${clause}
    GROUP BY mb.month
    ORDER BY mb.month ASC
  `).all(year, ...params);

  res.json({ success: true, data: monthly, year });
});

/**
 * @route  GET /api/reports/top-debtors
 * @desc   Customers with highest debt
 */
router.get('/top-debtors', (req, res) => {
  const db = getDb();
  let distributorId = req.user.role === 'superadmin' ? null : req.user.id;
  let allowedNeighborhoods = null;
  if (req.user.role === 'superadmin' && req.query.distributorId) {
    distributorId = parseInt(req.query.distributorId);
  } else if (req.user.role === 'collector') {
    distributorId = req.user.parent_id;
    allowedNeighborhoods = req.user.allowed_neighborhoods;
  }
  
  let distClause = distributorId ? 'AND c.distributor_id = ?' : '';
  const distParam = distributorId ? [distributorId] : [];
  
  if (allowedNeighborhoods) {
    const list = allowedNeighborhoods.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length > 0) {
      const placeholders = list.map(() => '?').join(',');
      distClause += ` AND TRIM(c.neighborhood) IN (${placeholders})`;
      distParam.push(...list);
    } else {
      distClause += ' AND 1 = 0';
    }
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const todayDay = now.getDate();

  const queryParams = [year, year, month, year, month, ...distParam];

  const customers = db.prepare(`
    SELECT
      c.id, c.full_name, c.family_name, c.neighborhood, c.phone, c.monthly_amount, c.subscription_date, c.status,
      u.full_name AS distributor_name,
      mb.status AS current_bill_status,
      COALESCE(mb.amount_due, c.monthly_amount) AS current_bill_due,
      COALESCE(mb.amount_paid, 0) AS current_bill_paid,
      COALESCE(
        (SELECT SUM(mb2.amount_due - mb2.amount_paid)
         FROM monthly_bills mb2
         WHERE mb2.customer_id = c.id 
           AND (mb2.year < ? OR (mb2.year = ? AND mb2.month < ?)) 
           AND mb2.status != 'paid'), 0
      ) AS past_bill_debt,
      COALESCE(
        (SELECT SUM(e.amount) FROM customer_extras e WHERE e.customer_id = c.id AND e.is_paid = 0), 0
      ) AS obligation_debt
    FROM customers c
    JOIN users u ON u.id = c.distributor_id
    LEFT JOIN monthly_bills mb ON mb.customer_id = c.id AND mb.year = ? AND mb.month = ?
    WHERE c.is_active = 1 ${distClause}
  `).all(...queryParams);

  const result = customers.map((c) => {
    // Parse subscription day of month and check if new this month
    let dueDay = 1;
    let isNewThisMonth = false;
    if (c.subscription_date) {
      const parts = c.subscription_date.split('-');
      if (parts.length === 3) {
        dueDay = parseInt(parts[2], 10) || 1;
        const startY = parseInt(parts[0], 10);
        const startM = parseInt(parts[1], 10);
        if (startY === year && startM === month) {
          isNewThisMonth = true;
        }
      }
    }

    const currentUnpaid = (c.current_bill_status !== 'paid');
    const pastDebt = c.past_bill_debt + c.obligation_debt;
    const currentDebtAmount = c.current_bill_due - c.current_bill_paid;
    const totalDebt = currentDebtAmount + pastDebt;

    // Classify customer into prioritization groups:
    // Group 1: Subscription expired / due first this month (unpaid current month & dueDay <= todayDay & not new this month)
    // Group 2: Accumulated debt from previous months / obligations
    // Group 3: Fully paid (current bill paid, no past debt)
    // Group 4: Future due date (unpaid current month, but dueDay > todayDay, and no past debt) OR new customer this month
    let group = 4;
    if (currentUnpaid && dueDay <= todayDay && !isNewThisMonth) {
      group = 1;
    } else if (pastDebt > 0) {
      group = 2;
    } else if (!currentUnpaid && totalDebt === 0) {
      group = 3;
    } else {
      group = 4;
    }

    return {
      ...c,
      dueDay,
      group,
      is_new_this_month: isNewThisMonth ? 1 : 0,
      total_debt: totalDebt
    };
  });

  // Sort according to priority rules:
  result.sort((a, b) => {
    if (a.group !== b.group) {
      return a.group - b.group;
    }

    if (a.group === 1) {
      // Group 1: Sort by dueDay ascending (expired first)
      if (a.dueDay !== b.dueDay) return a.dueDay - b.dueDay;
      return b.total_debt - a.total_debt;
    }

    if (a.group === 2) {
      // Group 2: Sort by total debt descending
      return b.total_debt - a.total_debt;
    }

    if (a.group === 3) {
      // Group 3: Sort by full name alphabetically
      return (a.full_name || '').localeCompare(b.full_name || '', 'ar');
    }

    if (a.group === 4) {
      // Group 4: Sort by dueDay ascending (earliest due day first)
      if (a.dueDay !== b.dueDay) return a.dueDay - b.dueDay;
      return (a.full_name || '').localeCompare(b.full_name || '', 'ar');
    }

    return 0;
  });

  res.json({ success: true, data: result });
});

/**
 * @route  GET /api/reports/cashbox
 * @desc   Daily cashbox report for collector/distributor/admin
 */
router.get('/cashbox', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    let paymentsQuery = `
      SELECT pr.*, c.full_name, c.family_name
      FROM payment_records pr
      JOIN customers c ON c.id = pr.customer_id
      WHERE pr.payment_date = ? AND c.is_active = 1
    `;
    const paymentsParams = [date];

    let extrasQuery = `
      SELECT ce.*, c.full_name, c.family_name
      FROM customer_extras ce
      JOIN customers c ON c.id = ce.customer_id
      WHERE ce.is_paid = 1 AND date(ce.paid_date, 'localtime') = ? AND c.is_active = 1
    `;
    const extrasParams = [date];

    let obligationsQuery = `
      SELECT o.*
      FROM obligations o
      WHERE o.is_paid = 1 AND date(o.paid_date, 'localtime') = ?
    `;
    const obligationsParams = [date];

    if (req.user.role === 'superadmin') {
      if (req.query.distributorId) {
        const dId = parseInt(req.query.distributorId);
        paymentsQuery += ' AND c.distributor_id = ?';
        paymentsParams.push(dId);

        extrasQuery += ' AND c.distributor_id = ?';
        extrasParams.push(dId);

        obligationsQuery += ' AND o.distributor_id = ?';
        obligationsParams.push(dId);
      }
    } else if (req.user.role === 'collector') {
      // 1. Payments recorded by this specific collector
      paymentsQuery += ' AND pr.recorded_by = ?';
      paymentsParams.push(req.user.id);

      // 2. Extras for customers under parent distributor and allowed neighborhoods
      extrasQuery += ' AND c.distributor_id = ?';
      extrasParams.push(req.user.parent_id);

      if (req.user.allowed_neighborhoods) {
        const list = req.user.allowed_neighborhoods.split(',').map(s => s.trim()).filter(Boolean);
        if (list.length > 0) {
          const placeholders = list.map(() => '?').join(',');
          extrasQuery += ` AND TRIM(c.neighborhood) IN (${placeholders})`;
          extrasParams.push(...list);
        } else {
          extrasQuery += ' AND 1 = 0';
        }
      } else {
        extrasQuery += ' AND 1 = 0';
      }

      // 3. Obligations: collectors do not pay obligations
      obligationsQuery += ' AND 1 = 0';
    } else {
      // distributor
      const dId = req.user.id;
      paymentsQuery += ' AND c.distributor_id = ?';
      paymentsParams.push(dId);

      extrasQuery += ' AND c.distributor_id = ?';
      extrasParams.push(dId);

      obligationsQuery += ' AND o.distributor_id = ?';
      obligationsParams.push(dId);
    }

    const payments = db.prepare(paymentsQuery).all(...paymentsParams);
    const totalPayments = payments.reduce((sum, p) => sum + p.amount, 0);

    const extras = db.prepare(extrasQuery).all(...extrasParams);
    const totalExtras = extras.reduce((sum, e) => sum + e.amount, 0);

    const obligations = db.prepare(obligationsQuery).all(...obligationsParams);
    const totalObligations = obligations.reduce((sum, o) => sum + o.amount, 0);

    const totalCollected = totalPayments + totalExtras;
    const netCash = totalCollected - totalObligations;

    let distributorPhone = null;
    let distributorName = null;
    if (req.user.role === 'collector') {
      const parent = db.prepare('SELECT full_name, phone FROM users WHERE id = ?').get(req.user.parent_id);
      if (parent) {
        distributorPhone = parent.phone;
        distributorName = parent.full_name;
      }
    }

    res.json({
      success: true,
      data: {
        date,
        totalPayments,
        totalExtras,
        totalCollected,
        totalObligations,
        netCash,
        distributorPhone,
        distributorName,
        details: {
          payments,
          extras,
          obligations
        }
      }
    });
  } catch (err) {
    console.error('Cashbox report error:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم أثناء تحميل الصندوق اليومي' });
  }
});

module.exports = router;
