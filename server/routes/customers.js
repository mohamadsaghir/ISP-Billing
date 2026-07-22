'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { getDb } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ensureMonthlyBillsForCustomer, getCustomerDebt, ensureAllMonthlyBills } = require('../services/debtService');

const router = express.Router();

router.use(authenticate);

/** Resolve distributor filter based on role */
function getDistributorFilter(req) {
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
 * @route  GET /api/customers
 * @desc   List customers (filtered by distributor for non-admins)
 */
router.get('/', (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);
  const { search, status } = req.query;

  let where = `WHERE c.is_active = 1 ${clause}`;
  const qParams = [...params];

  if (search) {
    where += ' AND (c.full_name LIKE ? OR c.family_name LIKE ? OR c.neighborhood LIKE ? OR c.phone LIKE ?)';
    qParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const customers = db.prepare(`
    SELECT
      c.id, c.full_name, c.family_name, c.neighborhood, c.phone, c.monthly_amount, c.subscription_date,
      c.notes, c.is_active, c.created_at,
      u.full_name AS distributor_name, u.company_name,
      COALESCE(SUM(CASE WHEN mb.status != 'paid' THEN mb.amount_due - mb.amount_paid ELSE 0 END), 0) AS bill_debt,
      COALESCE((SELECT SUM(amount) FROM customer_extras WHERE customer_id = c.id AND is_paid = 0), 0) AS obligation_debt
    FROM customers c
    JOIN users u ON u.id = c.distributor_id
    LEFT JOIN monthly_bills mb ON mb.customer_id = c.id
    ${where}
    GROUP BY c.id
    ORDER BY c.full_name ASC
  `).all(...qParams);

  // Add total_debt field
  const result = customers.map((c) => ({
    ...c,
    total_debt: c.bill_debt + c.obligation_debt,
  }));

  res.json({ success: true, data: result, total: result.length });
});

/**
 * @route  GET /api/customers/neighborhoods
 * @desc   Get list of unique neighborhoods
 */
router.get('/neighborhoods', (req, res) => {
  const db = getDb();
  let clause = '';
  const params = [];
  if (req.user.role === 'superadmin') {
    if (req.query.distributorId) {
      clause = 'AND distributor_id = ?';
      params.push(parseInt(req.query.distributorId));
    }
  } else {
    clause = 'AND distributor_id = ?';
    params.push(req.user.role === 'collector' ? req.user.parent_id : req.user.id);
  }
  const rows = db.prepare(`
    SELECT DISTINCT neighborhood FROM customers 
    WHERE is_active = 1 AND neighborhood IS NOT NULL AND TRIM(neighborhood) != '' ${clause}
    ORDER BY neighborhood ASC
  `).all(...params);
  const list = rows.map(r => r.neighborhood.trim());
  res.json({ success: true, data: list });
});

/**
 * @route  GET /api/customers/:id
 * @desc   Get single customer with debt details
 */
router.get('/:id', [param('id').isInt(), validate], (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);

  const customer = db.prepare(`
    SELECT c.*, u.full_name AS distributor_name, u.company_name
    FROM customers c
    JOIN users u ON u.id = c.distributor_id
    WHERE c.id = ? AND c.is_active = 1 ${clause}
  `).get(req.params.id, ...params);

  if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

  const debt = getCustomerDebt(customer.id);

  // Get monthly bills
  const bills = db.prepare(`
    SELECT * FROM monthly_bills WHERE customer_id = ? ORDER BY year DESC, month DESC
  `).all(customer.id);

  const obligations = db.prepare(`
    SELECT * FROM customer_extras WHERE customer_id = ? ORDER BY is_paid ASC, created_at DESC
  `).all(customer.id);

  // Get last 10 payment records
  const payments = db.prepare(`
    SELECT pr.*, u.full_name AS recorded_by_name
    FROM payment_records pr
    JOIN users u ON u.id = pr.recorded_by
    WHERE pr.customer_id = ?
    ORDER BY pr.payment_date DESC
    LIMIT 10
  `).all(customer.id);

  res.json({
    success: true,
    data: { ...customer, debt, bills, obligations, payments },
  });
});

/**
 * @route  POST /api/customers
 * @desc   Create new customer
 */
router.post(
  '/',
  [
    body('fullName').trim().notEmpty().withMessage('الاسم الكامل مطلوب'),
    body('familyName').optional().trim(),
    body('neighborhood').optional().trim(),
    body('phone').optional().trim(),
    body('monthlyAmount').isFloat({ min: 0.01 }).withMessage('المبلغ الشهري يجب أن يكون أكبر من صفر'),
    body('subscriptionDate').isDate().withMessage('تاريخ الاشتراك غير صالح'),
    body('notes').optional().trim(),
    body('distributorId').optional().isInt(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { fullName, familyName, neighborhood, phone, monthlyAmount, subscriptionDate, notes, distributorId } = req.body;

    if (req.user.role === 'collector') {
      const allowed = req.user.allowed_neighborhoods ? req.user.allowed_neighborhoods.split(',').map(s => s.trim().toLowerCase()) : [];
      const normalizedNeighborhood = (neighborhood || '').trim().toLowerCase();
      if (!normalizedNeighborhood || !allowed.includes(normalizedNeighborhood)) {
        return res.status(403).json({ success: false, message: 'غير مصرح لك بإضافة زبون في هذا الحي' });
      }
    }

    // Determine distributor
    const distId = req.user.role === 'superadmin' && distributorId
      ? distributorId
      : (req.user.role === 'collector' ? req.user.parent_id : req.user.id);

    // Verify distributor exists
    const dist = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(distId);
    if (!dist) return res.status(400).json({ success: false, message: 'الموزع غير موجود' });

    // Check for duplicate customer (same name and phone number) or duplicate phone number
    const cleanPhone = phone ? phone.trim() : null;
    if (cleanPhone) {
      const duplicatePhone = db.prepare(`
        SELECT id, full_name, family_name FROM customers 
        WHERE distributor_id = ? 
          AND phone = ?
          AND is_active = 1
      `).get(distId, cleanPhone);
      
      if (duplicatePhone) {
        return res.status(400).json({ 
          success: false, 
          message: `رقم الهاتف هذا مستخدم بالفعل للزبون: ${duplicatePhone.full_name} ${duplicatePhone.family_name || ''}` 
        });
      }
    }

    let existing;
    if (!cleanPhone) {
      existing = db.prepare(`
        SELECT id FROM customers 
        WHERE distributor_id = ? 
          AND LOWER(full_name) = LOWER(?) 
          AND (LOWER(family_name) = LOWER(?) OR (family_name IS NULL AND ? IS NULL))
          AND (phone IS NULL OR phone = '')
          AND is_active = 1
      `).get(distId, fullName, familyName || null, familyName || null);
      
      if (existing) {
        return res.status(400).json({ 
          success: false, 
          message: 'هذا الزبون مضاف بالفعل بنفس الاسم' 
        });
      }
    }

    const result = db.prepare(`
      INSERT INTO customers (distributor_id, full_name, family_name, neighborhood, phone, monthly_amount, subscription_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(distId, fullName, familyName || null, neighborhood || null, cleanPhone, monthlyAmount, subscriptionDate, notes || null);
    db.save();

    // Generate monthly bills for this customer
    ensureMonthlyBillsForCustomer(result.lastInsertRowid);

    res.status(201).json({
      success: true,
      message: 'تم إضافة الزبون بنجاح',
      data: { id: result.lastInsertRowid },
    });
  }
);

/**
 * @route  PUT /api/customers/:id
 * @desc   Update customer
 */
router.put(
  '/:id',
  [
    param('id').isInt(),
    body('fullName').optional().trim().notEmpty(),
    body('familyName').optional().trim(),
    body('neighborhood').optional().trim(),
    body('phone').optional().trim(),
    body('monthlyAmount').optional().isFloat({ min: 0.01 }),
    body('subscriptionDate').optional().isDate().withMessage('تاريخ الاشتراك غير صالح'),
    body('distributorId').optional().isInt(),
    body('status').optional().isIn(['active', 'suspended']).withMessage('حالة غير صالحة'),
    body('notes').optional().trim(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { clause, params } = getDistributorFilter(req);

    const customer = db.prepare(
      `SELECT id, distributor_id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
    ).get(req.params.id, ...params);

    if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

    const { fullName, familyName, neighborhood, phone, monthlyAmount, subscriptionDate, distributorId, status, notes } = req.body;

    if (req.user.role === 'collector' && neighborhood !== undefined) {
      const allowed = req.user.allowed_neighborhoods ? req.user.allowed_neighborhoods.split(',').map(s => s.trim().toLowerCase()) : [];
      const normalizedNeighborhood = (neighborhood || '').trim().toLowerCase();
      if (!normalizedNeighborhood || !allowed.includes(normalizedNeighborhood)) {
        return res.status(403).json({ success: false, message: 'غير مصرح لك بنقل زبون إلى هذا الحي' });
      }
    }

    if (phone !== undefined && phone !== null && phone.trim() !== '') {
      const cleanPhone = phone.trim();
      const duplicatePhone = db.prepare(`
        SELECT id, full_name, family_name FROM customers 
        WHERE distributor_id = ? 
          AND phone = ?
          AND id != ?
          AND is_active = 1
      `).get(customer.distributor_id, cleanPhone, req.params.id);
      
      if (duplicatePhone) {
        return res.status(400).json({ 
          success: false, 
          message: `رقم الهاتف هذا مستخدم بالفعل للزبون: ${duplicatePhone.full_name} ${duplicatePhone.family_name || ''}` 
        });
      }
    }
    const updates = [];
    const values = [];

    if (fullName !== undefined) { updates.push('full_name = ?'); values.push(fullName); }
    if (familyName !== undefined) { updates.push('family_name = ?'); values.push(familyName); }
    if (neighborhood !== undefined) { updates.push('neighborhood = ?'); values.push(neighborhood); }
    if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
    if (monthlyAmount !== undefined) { updates.push('monthly_amount = ?'); values.push(monthlyAmount); }
    if (subscriptionDate !== undefined) { updates.push('subscription_date = ?'); values.push(subscriptionDate); }
    if (distributorId !== undefined && req.user.role === 'superadmin') { updates.push('distributor_id = ?'); values.push(distributorId); }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (notes !== undefined) { updates.push('notes = ?'); values.push(notes); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'لا توجد بيانات للتحديث' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);

    db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    // If monthly amount was updated, adjust amount_due for unpaid/partial bills
    if (monthlyAmount !== undefined) {
      db.prepare(`
        UPDATE monthly_bills
        SET amount_due = ?
        WHERE customer_id = ? AND status != 'paid'
      `).run(monthlyAmount, req.params.id);
    }

    // Regenerate/ensure bills from the subscription date up to current month
    ensureMonthlyBillsForCustomer(req.params.id);

    db.save();

    res.json({ success: true, message: 'تم تحديث بيانات الزبون' });
  }
);

/**
 * @route  DELETE /api/customers/:id
 * @desc   Soft delete customer
 */
router.delete('/:id', [param('id').isInt(), validate], (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);

  const customer = db.prepare(
    `SELECT id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
  ).get(req.params.id, ...params);

  if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

  db.prepare('UPDATE customers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(req.params.id);
  db.save();

  res.json({ success: true, message: 'تم حذف الزبون' });
});

/**
 * @route  GET /api/customers/:id/debt
 * @desc   Get customer debt breakdown
 */
router.get('/:id/debt', [param('id').isInt(), validate], (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);

  const customer = db.prepare(
    `SELECT id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
  ).get(req.params.id, ...params);

  if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

  const debt = getCustomerDebt(customer.id);
  res.json({ success: true, data: debt });
});

/**
 * @route  POST /api/customers/:id/extras
 * @desc   Add extra charge for a customer
 */
router.post(
  '/:id/extras',
  [
    param('id').isInt(),
    body('description').trim().notEmpty().withMessage('وصف المستحق مطلوب'),
    body('amount').isFloat({ min: 0.01 }).withMessage('المبلغ يجب أن يكون أكبر من صفر'),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { clause, params } = getDistributorFilter(req);
    const customer = db.prepare(
      `SELECT id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
    ).get(req.params.id, ...params);

    if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

    const { description, amount, notes } = req.body;
    const result = db.prepare(`
      INSERT INTO customer_extras (customer_id, description, amount, notes)
      VALUES (?, ?, ?, ?)
    `).run(customer.id, description, amount, notes || null);
    db.save();

    res.status(201).json({
      success: true,
      message: 'تم إضافة المستحق بنجاح',
      data: { id: result.lastInsertRowid },
    });
  }
);

/**
 * @route  PATCH /api/customers/:id/extras/:extraId/pay
 * @desc   Mark customer extra charge as paid
 */
router.patch(
  '/:id/extras/:extraId/pay',
  [
    param('id').isInt(),
    param('extraId').isInt(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { clause, params } = getDistributorFilter(req);
    const customer = db.prepare(
      `SELECT id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
    ).get(req.params.id, ...params);

    if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

    const extra = db.prepare(`
      SELECT id FROM customer_extras WHERE id = ? AND customer_id = ? AND is_paid = 0
    `).get(req.params.extraId, customer.id);

    if (!extra) return res.status(404).json({ success: false, message: 'المستحق غير موجود أو مدفوع بالفعل' });

    db.prepare(`
      UPDATE customer_extras SET is_paid = 1, paid_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(extra.id);
    db.save();

    res.json({ success: true, message: 'تم تسجيل الدفع بنجاح' });
  }
);

/**
 * @route  PATCH /api/customers/:id/extras/:extraId/unpay
 * @desc   Mark customer extra charge as unpaid (reverse payment)
 */
router.patch(
  '/:id/extras/:extraId/unpay',
  [
    param('id').isInt(),
    param('extraId').isInt(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { clause, params } = getDistributorFilter(req);
    const customer = db.prepare(
      `SELECT id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
    ).get(req.params.id, ...params);

    if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

    const extra = db.prepare(`
      SELECT id FROM customer_extras WHERE id = ? AND customer_id = ? AND is_paid = 1
    `).get(req.params.extraId, customer.id);

    if (!extra) return res.status(404).json({ success: false, message: 'المستحق غير موجود أو غير مدفوع' });

    db.prepare(`
      UPDATE customer_extras SET is_paid = 0, paid_date = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(extra.id);
    db.save();

    res.json({ success: true, message: 'تم إلغاء دفع المستحق بنجاح' });
  }
);

/**
 * @route  DELETE /api/customers/:id/extras/:extraId
 * @desc   Delete customer extra charge
 */
router.delete(
  '/:id/extras/:extraId',
  [
    param('id').isInt(),
    param('extraId').isInt(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { clause, params } = getDistributorFilter(req);
    const customer = db.prepare(
      `SELECT id FROM customers c WHERE c.id = ? AND c.is_active = 1 ${clause}`
    ).get(req.params.id, ...params);

    if (!customer) return res.status(404).json({ success: false, message: 'الزبون غير موجود' });

    const extra = db.prepare(`
      SELECT id FROM customer_extras WHERE id = ? AND customer_id = ?
    `).get(req.params.extraId, customer.id);

    if (!extra) return res.status(404).json({ success: false, message: 'المستحق غير موجود' });

    db.prepare('DELETE FROM customer_extras WHERE id = ?').run(extra.id);
    db.save();

    res.json({ success: true, message: 'تم الحذف بنجاح' });
  }
);

/**
 * @route  POST /api/customers/import
 * @desc   Batch import customers from parsed Excel/CSV data
 */
router.post(
  '/import',
  [
    body('customers').isArray().withMessage('يجب إرسال مصفوفة من الزبائن'),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { customers } = req.body;
    const distributorId = req.user.id;

    try {
      let importedCount = 0;

      const insertCustomer = db.prepare(`
        INSERT INTO customers (distributor_id, full_name, family_name, neighborhood, phone, monthly_amount, subscription_date, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const c of customers) {
        let { fullName, familyName, neighborhood, phone, monthlyAmount, subscriptionDate, notes } = c;

        if (!fullName || !monthlyAmount || !subscriptionDate) {
          continue;
        }

        const fAmount = parseFloat(monthlyAmount);
        if (isNaN(fAmount) || fAmount <= 0) continue;

        const sPhone = phone ? String(phone).trim() : null;
        const fName = String(fullName).trim();
        const famName = familyName ? String(familyName).trim() : null;

        // Check for duplicates (same phone number or same name if no phone)
        let existing;
        if (sPhone) {
          existing = db.prepare(`
            SELECT id FROM customers 
            WHERE distributor_id = ? 
              AND phone = ?
              AND is_active = 1
          `).get(distributorId, sPhone);
        } else {
          existing = db.prepare(`
            SELECT id FROM customers 
            WHERE distributor_id = ? 
              AND LOWER(full_name) = LOWER(?) 
              AND (LOWER(family_name) = LOWER(?) OR (family_name IS NULL AND ? IS NULL))
              AND (phone IS NULL OR phone = '')
              AND is_active = 1
          `).get(distributorId, fName, famName, famName);
        }

        if (existing) {
          // Skip duplicate customer silently during import
          continue;
        }

        let formattedDate = subscriptionDate;
        if (typeof subscriptionDate === 'string') {
          const match = subscriptionDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (match) {
            const day = match[1].padStart(2, '0');
            const month = match[2].padStart(2, '0');
            const year = match[3];
            formattedDate = `${year}-${month}-${day}`;
          }
        }

        const result = insertCustomer.run(
          distributorId,
          String(fullName).trim(),
          familyName ? String(familyName).trim() : null,
          neighborhood ? String(neighborhood).trim() : null,
          sPhone,
          fAmount,
          formattedDate,
          notes ? String(notes).trim() : null
        );

        ensureMonthlyBillsForCustomer(result.lastInsertRowid);
        importedCount++;
      }

      db.save();

      res.status(201).json({
        success: true,
        message: `تم استيراد ${importedCount} زبون بنجاح`,
        data: { importedCount }
      });
    } catch (err) {
      console.error('Import customers error:', err);
      res.status(500).json({ success: false, message: 'خطأ في الخادم أثناء الاستيراد' });
    }
  }
);

/**
 * @route  DELETE /api/customers/clear/all
 * @desc   Clear all customers and related records (payments, bills, extras) for the distributor
 */
router.delete('/clear/all', (req, res) => {
  const db = getDb();
  const distributorId = req.user.role === 'superadmin' ? null : req.user.id;

  try {
    if (distributorId) {
      db.prepare(`DELETE FROM payment_records WHERE customer_id IN (SELECT id FROM customers WHERE distributor_id = ?)`).run(distributorId);
      db.prepare(`DELETE FROM monthly_bills WHERE customer_id IN (SELECT id FROM customers WHERE distributor_id = ?)`).run(distributorId);
      db.prepare(`DELETE FROM customer_extras WHERE customer_id IN (SELECT id FROM customers WHERE distributor_id = ?)`).run(distributorId);
      db.prepare(`DELETE FROM customers WHERE distributor_id = ?`).run(distributorId);
    } else {
      db.prepare('DELETE FROM payment_records').run();
      db.prepare('DELETE FROM monthly_bills').run();
      db.prepare('DELETE FROM customer_extras').run();
      db.prepare('DELETE FROM customers').run();
    }
    db.save();

    res.json({ success: true, message: 'تم تصفير وحذف جميع الزبائن بنجاح' });
  } catch (err) {
    console.error('Clear customers error:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم أثناء تصفير الزبائن' });
  }
});

module.exports = router;
