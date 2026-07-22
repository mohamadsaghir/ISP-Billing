'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { getDb } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { applyPayment, ensureMonthlyBillsForCustomer } = require('../services/debtService');

const router = express.Router();

router.use(authenticate);

function getDistributorFilter(req) {
  if (req.user.role === 'superadmin') {
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
 * @route  GET /api/payments
 * @desc   List payment records (optionally filter by customer)
 */
router.get('/', (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);
  const { customerId, limit = 50, offset = 0 } = req.query;

  let where = `WHERE 1=1 ${clause}`;
  const qParams = [...params];

  if (customerId) {
    where += ' AND pr.customer_id = ?';
    qParams.push(parseInt(customerId));
  }

  const records = db.prepare(`
    SELECT
      pr.id, pr.customer_id, pr.amount, pr.payment_date, pr.notes, pr.created_at,
      c.full_name AS customer_name, c.phone,
      u.full_name AS recorded_by_name
    FROM payment_records pr
    JOIN customers c ON c.id = pr.customer_id
    JOIN users u ON u.id = pr.recorded_by
    ${where}
    ORDER BY pr.payment_date DESC, pr.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...qParams, parseInt(limit), parseInt(offset));

  res.json({ success: true, data: records });
});

/**
 * @route  GET /api/payments/monthly-bills/:customerId
 * @desc   Get all monthly bills for a customer
 */
router.get('/monthly-bills/:customerId', [param('customerId').isInt(), validate], (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);

  // Verify access
  const customer = db.prepare(
    `SELECT id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
  ).get(req.params.customerId, ...params);
  if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

  const bills = db.prepare(`
    SELECT * FROM monthly_bills WHERE customer_id = ? ORDER BY year DESC, month DESC
  `).all(req.params.customerId);

  res.json({ success: true, data: bills });
});

/**
 * @route  POST /api/payments
 * @desc   Record a payment for a customer
 */
router.post(
  '/',
  [
    body('customerId').isInt().withMessage('معرف الزبون مطلوب'),
    body('amount').isFloat({ min: 0.01 }).withMessage('المبلغ يجب أن يكون أكبر من صفر'),
    body('paymentDate').isDate().withMessage('تاريخ الدفع غير صالح'),
    body('notes').optional().trim(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { clause, params } = getDistributorFilter(req);
    const { customerId, amount, paymentDate, notes } = req.body;

    // Verify customer access
    const customer = db.prepare(
      `SELECT id, full_name, monthly_amount FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
    ).get(customerId, ...params);
    if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

    // Ensure monthly bills are up to date
    ensureMonthlyBillsForCustomer(customerId);

    // Apply payment to bills (FIFO)
    const { affected, overpayment } = applyPayment(customerId, amount);

    // Record the payment
    const result = db.prepare(`
      INSERT INTO payment_records (customer_id, amount, payment_date, notes, recorded_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(customerId, amount, paymentDate, notes || null, req.user.id);

    db.save();

    res.status(201).json({
      success: true,
      message: 'تم تسجيل الدفعة بنجاح',
      data: {
        paymentId: result.lastInsertRowid,
        amountApplied: amount - overpayment,
        overpayment,
        billsAffected: affected,
      },
    });
  }
);

/**
 * @route  DELETE /api/payments/:id
 * @desc   Delete a payment record (admin only) — reverses the payment
 */
router.delete('/:id', [param('id').isInt(), validate], (req, res) => {
  const db = getDb();

  const payment = db.prepare(`
    SELECT pr.*, c.distributor_id
    FROM payment_records pr
    JOIN customers c ON c.id = pr.customer_id
    WHERE pr.id = ?
  `).get(req.params.id);

  if (!payment) return res.status(404).json({ success: false, message: 'الدفعة غير موجودة' });

  // Distributors can only delete own payments
  if (req.user.role !== 'superadmin' && payment.distributor_id !== req.user.id) {
    return res.status(403).json({ success: false, message: 'غير مصرح' });
  }

  // Reverse: reduce amount_paid on newest bill that has payment first
  // Simple approach: regenerate by re-computing from all remaining payments
  db.prepare('DELETE FROM payment_records WHERE id = ?').run(req.params.id);

  // Reset all bills for this customer
  db.prepare(`UPDATE monthly_bills SET amount_paid = 0, status = 'unpaid' WHERE customer_id = ?`)
    .run(payment.customer_id);

  // Re-apply all remaining payments in order
  const remainingPayments = db.prepare(`
    SELECT * FROM payment_records WHERE customer_id = ? ORDER BY payment_date ASC, id ASC
  `).all(payment.customer_id);

  for (const p of remainingPayments) {
    applyPayment(payment.customer_id, p.amount);
  }

  db.save();

  res.json({ success: true, message: 'تم حذف الدفعة وإعادة حساب الديون' });
});

module.exports = router;
