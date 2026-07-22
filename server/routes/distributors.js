'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param } = require('express-validator');
const { getDb } = require('../config/db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

// All distributor routes require authentication
router.use(authenticate);

/**
 * @route  GET /api/distributors
 * @desc   List all distributors
 */
router.get('/', requireSuperAdmin, (req, res) => {
  const db = getDb();
  const distributors = db.prepare(`
    SELECT
      u.id, u.username, u.full_name, u.phone, u.company_name, u.is_active, u.created_at,
      u.subscription_expires_at, u.subscription_status,
      COUNT(c.id) AS customer_count
    FROM users u
    LEFT JOIN customers c ON c.distributor_id = u.id AND c.is_active = 1
    WHERE u.role = 'distributor'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();

  const collectors = db.prepare(`
    SELECT id, username, full_name, phone, parent_id, allowed_neighborhoods, is_active, created_at
    FROM users
    WHERE role = 'collector'
  `).all();

  const result = distributors.map((d) => ({
    ...d,
    collectors: collectors.filter((col) => col.parent_id === d.id)
  }));

  res.json({ success: true, data: result });
});

/**
 * @route  GET /api/distributors/collectors
 * @desc   List collectors for the logged-in distributor
 */
router.get('/collectors', (req, res) => {
  const db = getDb();
  let parentId = req.user.id;
  if (req.user.role === 'superadmin') {
    if (req.query.distributorId) {
      parentId = parseInt(req.query.distributorId);
    } else {
      const all = db.prepare('SELECT id, username, full_name, phone, parent_id, allowed_neighborhoods, is_active, created_at FROM users WHERE role = \'collector\'').all();
      return res.json({ success: true, data: all });
    }
  }
  const collectors = db.prepare(`
    SELECT id, username, full_name, phone, parent_id, allowed_neighborhoods, is_active, created_at
    FROM users
    WHERE role = 'collector' AND parent_id = ?
  `).all(parentId);
  res.json({ success: true, data: collectors });
});

/**
 * @route  POST /api/distributors/collectors
 * @desc   Create a new collector under a distributor
 */
router.post('/collectors', [
  body('username').trim().isLength({ min: 3 }).withMessage('اسم المستخدم يجب أن يكون 3 أحرف على الأقل'),
  body('fullName').trim().notEmpty().withMessage('الاسم الكامل مطلوب'),
  body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل'),
  body('parentId').optional().isInt().withMessage('الموزع الرئيسي غير صالح'),
  body('allowedNeighborhoods').optional().trim(),
  validate
], async (req, res) => {
  try {
    const db = getDb();
    const { username, fullName, password, parentId, allowedNeighborhoods } = req.body;

    const finalParentId = req.user.role === 'superadmin' ? parentId : req.user.id;
    if (!finalParentId) {
      return res.status(400).json({ success: false, message: 'الموزع الرئيسي مطلوب' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (existing) {
      return res.status(409).json({ success: false, message: 'اسم المستخدم مستخدم بالفعل' });
    }

    const hash = await bcrypt.hash(password, 12);
    db.prepare(`
      INSERT INTO users (username, full_name, role, password_hash, parent_id, allowed_neighborhoods)
      VALUES (?, ?, 'collector', ?, ?, ?)
    `).run(username, fullName, hash, finalParentId, allowedNeighborhoods || null);

    db.save();
    res.status(201).json({ success: true, message: 'تم إضافة الجابي بنجاح' });
  } catch (err) {
    console.error('Create collector error:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

/**
 * @route  PUT /api/distributors/collectors/:id
 * @desc   Update a collector
 */
router.put('/collectors/:id', [
  param('id').isInt(),
  body('fullName').trim().notEmpty().withMessage('الاسم الكامل مطلوب'),
  body('password').optional().isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل'),
  body('allowedNeighborhoods').optional().trim(),
  body('isActive').isInt().withMessage('الحالة مطلوبة'),
  validate
], async (req, res) => {
  try {
    const db = getDb();
    const { fullName, password, allowedNeighborhoods, isActive } = req.body;
    const { id } = req.params;

    const existingCol = db.prepare('SELECT parent_id FROM users WHERE id = ? AND role = \'collector\'').get(id);
    if (!existingCol) return res.status(404).json({ success: false, message: 'الجابي غير موجود' });
    
    if (req.user.role !== 'superadmin' && existingCol.parent_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بتعديل هذا الجابي' });
    }

    const updates = ['full_name = ?', 'allowed_neighborhoods = ?', 'is_active = ?'];
    const values = [fullName, allowedNeighborhoods || null, isActive];

    if (password) {
      const hash = await bcrypt.hash(password, 12);
      updates.push('password_hash = ?');
      values.push(hash);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ? AND role = 'collector'`).run(...values);
    db.save();

    res.json({ success: true, message: 'تم تحديث بيانات الجابي بنجاح' });
  } catch (err) {
    console.error('Update collector error:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

/**
 * @route  DELETE /api/distributors/collectors/:id
 * @desc   Delete a collector
 */
router.delete('/collectors/:id', [param('id').isInt(), validate], (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const existingCol = db.prepare('SELECT parent_id FROM users WHERE id = ? AND role = \'collector\'').get(id);
    if (!existingCol) return res.status(404).json({ success: false, message: 'الجابي غير موجود' });
    
    if (req.user.role !== 'superadmin' && existingCol.parent_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بحذف هذا الجابي' });
    }

    db.prepare('DELETE FROM users WHERE id = ? AND role = \'collector\'').run(id);
    db.save();

    res.json({ success: true, message: 'تم حذف الجابي بنجاح' });
  } catch (err) {
    console.error('Delete collector error:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

/**
 * @route  GET /api/distributors/:id
 * @desc   Get single distributor with stats
 */
router.get('/:id', [requireSuperAdmin, param('id').isInt(), validate], (req, res) => {
  const db = getDb();
  const dist = db.prepare(`
    SELECT id, username, full_name, phone, company_name, is_active, created_at, subscription_expires_at, subscription_status
    FROM users WHERE id = ? AND role = 'distributor'
  `).get(req.params.id);

  if (!dist) return res.status(404).json({ success: false, message: 'الموزع غير موجود' });

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_customers,
      COALESCE(SUM(monthly_amount), 0) AS total_monthly_revenue
    FROM customers
    WHERE distributor_id = ? AND is_active = 1
  `).get(req.params.id);

  res.json({ success: true, data: { ...dist, stats } });
});

/**
 * @route  POST /api/distributors
 * @desc   Create a new distributor
 */
router.post(
  '/',
  [
    requireSuperAdmin,
    body('username').trim().isLength({ min: 3 }).withMessage('اسم المستخدم يجب أن يكون 3 أحرف على الأقل'),
    body('fullName').trim().notEmpty().withMessage('الاسم الكامل مطلوب'),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور 8 أحرف على الأقل'),
    body('phone').optional().trim(),
    body('companyName').optional().trim(),
    validate,
  ],
  async (req, res) => {
    try {
      const db = getDb();
      const { username, fullName, password, phone, companyName } = req.body;

      const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
      if (existing) {
        return res.status(409).json({ success: false, message: 'اسم المستخدم مستخدم بالفعل' });
      }

      const hash = await bcrypt.hash(password, 12);
      const subscriptionExpiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const result = db.prepare(`
        INSERT INTO users (username, full_name, phone, company_name, role, password_hash, subscription_status, subscription_expires_at)
        VALUES (?, ?, ?, ?, 'distributor', ?, 'trial', ?)
      `).run(username, fullName, phone || null, companyName || null, hash, subscriptionExpiresAt);

      db.save();

      res.status(201).json({
        success: true,
        message: 'تم إنشاء الموزع بنجاح',
        data: { id: result.lastInsertRowid },
      });
    } catch (err) {
      console.error('Create distributor error:', err);
      res.status(500).json({ success: false, message: 'خطأ في الخادم' });
    }
  }
);

/**
 * @route  PUT /api/distributors/:id
 * @desc   Update distributor info
 */
router.put(
  '/:id',
  [
    requireSuperAdmin,
    param('id').isInt(),
    body('fullName').optional().trim().notEmpty(),
    body('phone').optional().trim(),
    body('companyName').optional().trim(),
    body('isActive').optional().isBoolean(),
    body('password').optional().isLength({ min: 8 }).withMessage('كلمة المرور 8 أحرف على الأقل'),
    validate,
  ],
  async (req, res) => {
    try {
      const db = getDb();
      const dist = db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(req.params.id, 'distributor');
       if (!dist) return res.status(404).json({ success: false, message: 'الموزع غير موجود' });
 
       const { fullName, phone, companyName, isActive, password, subscriptionStatus, subscriptionExpiresAt } = req.body;
       const updates = [];
       const values = [];
 
       if (fullName !== undefined) { updates.push('full_name = ?'); values.push(fullName); }
       if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
       if (companyName !== undefined) { updates.push('company_name = ?'); values.push(companyName); }
       if (isActive !== undefined) { updates.push('is_active = ?'); values.push(isActive ? 1 : 0); }
       if (subscriptionStatus !== undefined) { updates.push('subscription_status = ?'); values.push(subscriptionStatus); }
       if (subscriptionExpiresAt !== undefined) { updates.push('subscription_expires_at = ?'); values.push(subscriptionExpiresAt || null); }
       if (password) {
         const hash = await bcrypt.hash(password, 12);
         updates.push('password_hash = ?');
         values.push(hash);
       }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'لا توجد بيانات للتحديث' });
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(req.params.id);

      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      db.save();

      res.json({ success: true, message: 'تم التحديث بنجاح' });
    } catch (err) {
      console.error('Update distributor error:', err);
      res.status(500).json({ success: false, message: 'خطأ في الخادم' });
    }
  }
);

/**
 * @route  DELETE /api/distributors/:id
 * @desc   Permanently delete distributor (hard delete)
 */
router.delete('/:id', [requireSuperAdmin, param('id').isInt(), validate], (req, res) => {
  const db = getDb();
  const dist = db.prepare('SELECT id, full_name FROM users WHERE id = ? AND role = ?').get(req.params.id, 'distributor');
  if (!dist) return res.status(404).json({ success: false, message: 'الموزع غير موجود' });

  try {
    // Manual cascade: delete in FK order (child → parent)
    const customerIds = db.prepare('SELECT id FROM customers WHERE distributor_id = ?').all(req.params.id).map(r => r.id);

    for (const cid of customerIds) {
      db.prepare('DELETE FROM customer_extras WHERE customer_id = ?').run(cid);
      db.prepare('DELETE FROM payment_records WHERE customer_id = ?').run(cid);
      db.prepare('DELETE FROM monthly_bills WHERE customer_id = ?').run(cid);
    }
    db.prepare('DELETE FROM obligations WHERE distributor_id = ?').run(req.params.id);
    db.prepare('DELETE FROM customers WHERE distributor_id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE parent_id = ?').run(req.params.id);
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    db.save();
    res.json({ success: true, message: `تم حذف الموزع "${dist.full_name}" نهائياً` });
  } catch (err) {
    console.error('Delete distributor error:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم أثناء الحذف: ' + err.message });
  }
});

module.exports = router;
