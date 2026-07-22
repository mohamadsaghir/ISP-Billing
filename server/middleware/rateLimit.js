'use strict';

const rateLimit = require('express-rate-limit');

/** Strict limiter for auth endpoints */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة جداً، يرجى الانتظار 15 دقيقة' },
  skipSuccessfulRequests: true,
});

/** General API limiter */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'طلبات كثيرة جداً، يرجى التباطؤ' },
});

/** WhatsApp send limiter */
const whatsappLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'حد إرسال رسائل WhatsApp مؤقت' },
});

module.exports = { authLimiter, apiLimiter, whatsappLimiter };
