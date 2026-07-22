'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const config = require('./config/config');
const { initDb, getDb } = require('./config/db');
const { apiLimiter } = require('./middleware/rateLimit');
const { ensureAllMonthlyBills } = require('./services/debtService');
const requestLogger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');

// Routes
const authRoutes = require('./routes/auth');
const distributorRoutes = require('./routes/distributors');
const customerRoutes = require('./routes/customers');
const paymentRoutes = require('./routes/payments');
const obligationRoutes = require('./routes/obligations');
const reportRoutes = require('./routes/reports');

const app = express();

// ── Security Middleware ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net', 'https://static.cloudflareinsights.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cloudflareinsights.com'],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  })
);

app.use(
  cors({
    origin: config.server.appUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(requestLogger);

// ── Static Files ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api', apiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/obligations', obligationRoutes);
app.use('/api/reports', reportRoutes);

// ── Health Check ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    app: config.server.appName,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── SPA Fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'المسار غير موجود' });
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Global Error Handler ───────────────────────────────────────────────────────
app.use(errorHandler);

// ── Startup ────────────────────────────────────────────────────────────────────
let serverInstance = null;

async function start() {
  try {
    await initDb();

    // Ensure monthly bills on startup
    ensureAllMonthlyBills();

    // Daily cron at 00:01 to ensure monthly bills for all active customers
    cron.schedule('1 0 * * *', () => {
      console.log('[CRON] Running daily bill check...');
      ensureAllMonthlyBills();
    });

    const PORT = config.server.port;
    serverInstance = app.listen(PORT, () => {
      console.log('');
      console.log('╔════════════════════════════════════════╗');
      console.log('║     ISP Billing System - Started ✅    ║');
      console.log(`║  URL: http://localhost:${PORT}             ║`);
      console.log(`║  Mode: ${config.server.nodeEnv.padEnd(32)}║`);
      console.log('╚════════════════════════════════════════╝');
      console.log('');
      console.log(`  SuperAdmin: ${config.superAdmin.username} / ${config.superAdmin.password}`);
      console.log('');
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
  if (serverInstance) {
    serverInstance.close(() => {
      console.log('[Server] HTTP server closed.');
      try {
        const db = getDb();
        db.close();
        console.log('[DB] SQLite connection closed cleanly.');
      } catch (err) {
        console.error('[DB] Error closing SQLite connection:', err);
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start();
