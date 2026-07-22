'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body } = require('express-validator');
const { getDb } = require('../config/db');
const config = require('../config/config');
const { authLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/** Generate access + refresh token pair */
function generateTokens(user) {
  const payload = { 
    sub: user.id, 
    role: user.role, 
    username: user.username,
    parentId: user.parent_id,
    allowedNeighborhoods: user.allowed_neighborhoods
  };

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiresIn,
  });

  const refreshToken = crypto.randomBytes(64).toString('hex');
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  const db = getDb();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  // Clean old tokens for user
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at < CURRENT_TIMESTAMP').run(user.id);
  db.prepare(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(user.id, refreshHash, expiresAt.toISOString());
  db.save();

  return { accessToken, refreshToken };
}

/**
 * @route  POST /api/auth/login
 * @desc   Login with username + password
 */
router.post(
  '/login',
  authLimiter,
  [
    body('username').trim().notEmpty().withMessage('اسم المستخدم مطلوب'),
    body('password').notEmpty().withMessage('كلمة المرور مطلوبة'),
    validate,
  ],
  async (req, res) => {
    try {
      const { username, password } = req.body;
      const db = getDb();

      const user = db.prepare(
        'SELECT * FROM users WHERE username = ? AND is_active = 1 COLLATE NOCASE'
      ).get(username);

      if (!user) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const { accessToken, refreshToken } = generateTokens(user);

      res.json({
        success: true,
        data: {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            role: user.role,
            companyName: user.company_name,
            parentId: user.parent_id,
            allowedNeighborhoods: user.allowed_neighborhoods,
          },
        },
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ success: false, message: 'خطأ في الخادم' });
    }
  }
);

/**
 * @route  POST /api/auth/refresh
 * @desc   Refresh access token using refresh token
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ success: false, message: 'refreshToken مطلوب' });
  }

  try {
    const db = getDb();
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const stored = db.prepare(`
      SELECT rt.*, u.id as uid, u.username, u.role, u.full_name, u.is_active
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ? AND rt.expires_at > CURRENT_TIMESTAMP
    `).get(hash);

    if (!stored || !stored.is_active) {
      return res.status(401).json({ success: false, message: 'رمز تحديث غير صالح أو منتهي' });
    }

    // Rotate: delete old, issue new
    db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hash);
    db.save();

    const user = { id: stored.uid, username: stored.username, role: stored.role };
    const tokens = generateTokens(user);

    res.json({ success: true, data: tokens });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

/**
 * @route  POST /api/auth/logout
 * @desc   Invalidate refresh token
 */
router.post('/logout', authenticate, (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const db = getDb();
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hash);
    db.save();
  }
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

/**
 * @route  GET /api/auth/me
 * @desc   Get current user info
 */
router.get('/me', authenticate, (req, res) => {
  const db = getDb();
  const user = db.prepare(
    'SELECT id, username, full_name, phone, company_name, role, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

  res.json({ success: true, data: user });
});

/**
 * @route  PUT /api/auth/change-password
 * @desc   Change own password
 */
router.put(
  '/change-password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('كلمة المرور الحالية مطلوبة'),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل'),
    validate,
  ],
  async (req, res) => {
    try {
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

      const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
      if (!valid) {
        return res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
      }

      const hash = await bcrypt.hash(req.body.newPassword, 12);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(hash, req.user.id);

      // Invalidate all refresh tokens
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
      db.save();

      res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
    } catch (err) {
      console.error('Change password error:', err);
      res.status(500).json({ success: false, message: 'خطأ في الخادم' });
    }
  }
);

module.exports = router;
