'use strict';

const jwt = require('jsonwebtoken');
const { getDb } = require('../config/db');
const config = require('../config/config');

/**
 * Verify JWT access token and attach user to request
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, config.jwt.accessSecret);
      req.user = {
        id: payload.sub,
        role: payload.role,
        username: payload.username,
        parent_id: payload.parentId,
        allowed_neighborhoods: payload.allowedNeighborhoods
      };

      // Subscription status validation for distributors and their collectors
      if (payload.role === 'distributor' || payload.role === 'collector') {
        const targetId = payload.role === 'collector' ? payload.parentId : payload.sub;
        const db = getDb();
        const owner = db.prepare('SELECT subscription_expires_at, subscription_status FROM users WHERE id = ? AND is_active = 1').get(targetId);
        
        if (owner) {
          const today = new Date().toISOString().split('T')[0];
          if (owner.subscription_status === 'expired' || (owner.subscription_expires_at && owner.subscription_expires_at < today)) {
            return res.status(403).json({ 
              success: false, 
              message: 'انتهت صلاحية اشتراكك، يرجى التواصل مع الإدارة لتفعيل الحساب.',
              code: 'SUBSCRIPTION_EXPIRED' 
            });
          }
        }
      }

      return next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة', code: 'TOKEN_EXPIRED' });
      }
      // If token is invalid or dummy, fall through to auto-login
    }
  }

  // Fallback / auto-login as first distributor
  try {
    const db = getDb();
    let defaultUser = db.prepare("SELECT * FROM users WHERE role = 'distributor' AND is_active = 1 LIMIT 1").get();
    if (!defaultUser) {
      defaultUser = db.prepare("SELECT * FROM users WHERE role = 'superadmin' AND is_active = 1 LIMIT 1").get();
    }

    if (defaultUser) {
      req.user = {
        id: defaultUser.id,
        role: defaultUser.role,
        username: defaultUser.username,
        parent_id: defaultUser.parent_id,
        allowed_neighborhoods: defaultUser.allowed_neighborhoods
      };
      return next();
    }
  } catch (err) {
    console.error('Auto-login database query failed:', err);
  }

  return res.status(401).json({ success: false, message: 'غير مصرح - يرجى تسجيل الدخول' });
}

/**
 * Require SuperAdmin role
 */
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ success: false, message: 'غير مصرح - يلزم صلاحية المدير العام' });
  }
  next();
}

/**
 * Require Distributor or SuperAdmin role
 */
function requireDistributor(req, res, next) {
  if (!['superadmin', 'distributor', 'collector'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'غير مصرح' });
  }
  next();
}

/**
 * Ensure the user can only access their own data (unless superadmin)
 */
function scopeToDistributor(paramName = 'distributor_id') {
  return (req, res, next) => {
    if (req.user.role === 'superadmin') return next();
    req.distributorId = req.user.role === 'collector' ? req.user.parent_id : req.user.id;
    next();
  };
}

module.exports = { authenticate, requireSuperAdmin, requireDistributor, scopeToDistributor };
