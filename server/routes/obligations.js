'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { getDb } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

// Block collectors from accessing network obligations (expenses)
router.use((req, res, next) => {
  if (req.user.role === 'collector') {
    return res.status(403).json({ success: false, message: 'غير مصرح للجامي بإدارة مصاريف ومستحقات الشبكة' });
  }
  next();
});

function getDistributorFilter(req) {
  return req.user.role === 'superadmin'
    ? { clause: '', params: [] }
    : { clause: 'AND o.distributor_id = ?', params: [req.user.id] };
}

/**
 * @route  GET /api/obligations
 * @desc   List obligations (filtered by distributor)
 */
router.get('/', (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);
  const { isPaid } = req.query;

  let where = `WHERE 1=1 ${clause}`;
  const qParams = [...params];

  if (isPaid !== undefined) {
    where += ' AND o.is_paid = ?';
    qParams.push(isPaid === 'true' ? 1 : 0);
  }

  const obligations = db.prepare(`
    SELECT o.*, u.full_name AS distributor_name
    FROM obligations o
    JOIN users u ON u.id = o.distributor_id
    ${where}
    ORDER BY o.is_paid ASC, o.created_at DESC
  `).all(...qParams);

  res.json({ success: true, data: obligations });
});

/**
 * @route  POST /api/obligations
 * @desc   Add obligation for the network
 */
router.post(
  '/',
  [
    body('description').trim().notEmpty().withMessage('وصف المستحق مطلوب'),
    body('amount').isFloat({ min: 0.01 }).withMessage('المبلغ يجب أن يكون أكبر من صفر'),
    body('dueDate').optional().isDate(),
    body('notes').optional().trim(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { description, amount, dueDate, notes } = req.body;
    const distributorId = req.user.id;

    const result = db.prepare(`
      INSERT INTO obligations (distributor_id, description, amount, due_date, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(distributorId, description, amount, dueDate || null, notes || null);
    db.save();

    res.status(201).json({
      success: true,
      message: 'تم إضافة المستحق بنجاح',
      data: { id: result.lastInsertRowid },
    });
  }
);

/**
 * @route  PUT /api/obligations/:id
 * @desc   Update obligation
 */
router.put(
  '/:id',
  [
    param('id').isInt(),
    body('description').optional().trim().notEmpty(),
    body('amount').optional().isFloat({ min: 0.01 }),
    body('dueDate').optional().isDate(),
    body('notes').optional().trim(),
    validate,
  ],
  (req, res) => {
    const db = getDb();
    const { clause, params } = getDistributorFilter(req);

    const obl = db.prepare(`
      SELECT o.* FROM obligations o
      WHERE o.id = ? ${clause}
    `).get(req.params.id, ...params);
    if (!obl) return res.status(404).json({ success: false, message: 'المستحق غير موجود' });

    const { description, amount, dueDate, notes } = req.body;
    const updates = [];
    const values = [];

    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (amount !== undefined) { updates.push('amount = ?'); values.push(amount); }
    if (dueDate !== undefined) { updates.push('due_date = ?'); values.push(dueDate); }
    if (notes !== undefined) { updates.push('notes = ?'); values.push(notes); }

    if (updates.length === 0) return res.status(400).json({ success: false, message: 'لا توجد بيانات' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);

    db.prepare(`UPDATE obligations SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    db.save();
    res.json({ success: true, message: 'تم تحديث المستحق' });
  }
);

/**
 * @route  PATCH /api/obligations/:id/pay
 * @desc   Mark obligation as paid
 */
router.patch('/:id/pay', [param('id').isInt(), validate], (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);

  const obl = db.prepare(`
    SELECT o.* FROM obligations o
    WHERE o.id = ? AND o.is_paid = 0 ${clause}
  `).get(req.params.id, ...params);
  if (!obl) return res.status(404).json({ success: false, message: 'المستحق غير موجود أو مدفوع بالفعل' });

  db.prepare(`
    UPDATE obligations SET is_paid = 1, paid_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);
  db.save();

  res.json({ success: true, message: 'تم تسجيل الدفع' });
});

/**
 * @route  DELETE /api/obligations/clear/all
 * @desc   Clear all obligations for the distributor
 */
router.delete('/clear/all', (req, res) => {
  const db = getDb();
  const distributorId = req.user.role === 'superadmin' ? null : req.user.id;

  if (distributorId) {
    db.prepare('DELETE FROM obligations WHERE distributor_id = ?').run(distributorId);
  } else {
    db.prepare('DELETE FROM obligations').run();
  }
  db.save();

  res.json({ success: true, message: 'تم تفريغ كافة المستحقات بنجاح' });
});

/**
 * @route  DELETE /api/obligations/:id
 * @desc   Delete obligation
 */
router.delete('/:id', [param('id').isInt(), validate], (req, res) => {
  const db = getDb();
  const { clause, params } = getDistributorFilter(req);

  const obl = db.prepare(`
    SELECT o.id FROM obligations o
    WHERE o.id = ? ${clause}
  `).get(req.params.id, ...params);
  if (!obl) return res.status(404).json({ success: false, message: 'المستحق غير موجود' });

  db.prepare('DELETE FROM obligations WHERE id = ?').run(req.params.id);
  db.save();
  res.json({ success: true, message: 'تم حذف المستحق' });
});

module.exports = router;
