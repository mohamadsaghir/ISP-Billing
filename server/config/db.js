'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const DB_PATH = path.resolve(config.db.path);

let db = null;

class DbWrapper {
  constructor(nativeDb) {
    this._db = nativeDb;
  }

  exec(sql) {
    this._db.exec(sql);
  }

  prepare(sql) {
    const stmt = this._db.prepare(sql);
    return new BetterStatementWrapper(stmt);
  }

  transaction(fn) {
    return this._db.transaction(fn);
  }

  pragma(pragmaStr) {
    this._db.pragma(pragmaStr);
  }

  save() {
    // No-op: better-sqlite3 persists automatically to disk.
  }

  close() {
    this._db.close();
  }
}

class BetterStatementWrapper {
  constructor(stmt) {
    this._stmt = stmt;
  }

  run(...params) {
    // Handle both run(a, b) and run([a, b])
    const result = this._stmt.run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid) // Safe conversion of BigInt to standard JS number
    };
  }

  get(...params) {
    return this._stmt.get(...params);
  }

  all(...params) {
    return this._stmt.all(...params);
  }
}

/**
 * Get database instance (singleton)
 */
function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Initialize database schema and seed superadmin
 */
async function initDb() {
  // Ensure the database parent directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Open native SQLite database connection
  const nativeDb = new Database(DB_PATH, {
    // verbose: console.log // Optional: logs queries to stdout for dev
  });

  db = new DbWrapper(nativeDb);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Check if users table exists and parent_id column exists
  let tableExists = false;
  let hasParentId = false;
  try {
    const res = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    tableExists = !!res;
    if (tableExists) {
      const info = db.prepare(`PRAGMA table_info(users)`).all();
      hasParentId = info.some(col => col.name === 'parent_id');
    }
  } catch (e) {}

  if (tableExists && !hasParentId) {
    try {
      db.pragma('foreign_keys = OFF');
      db.exec(`ALTER TABLE users RENAME TO users_old;`);
      db.exec(`
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
          full_name     TEXT    NOT NULL,
          phone         TEXT,
          company_name  TEXT,
          role          TEXT    NOT NULL DEFAULT 'distributor'
                        CHECK(role IN ('superadmin', 'distributor', 'collector')),
          password_hash TEXT    NOT NULL,
          parent_id     INTEGER DEFAULT NULL,
          allowed_neighborhoods TEXT DEFAULT NULL,
          is_active     INTEGER NOT NULL DEFAULT 1,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE SET NULL
        );
      `);
      db.exec(`
        INSERT INTO users (id, username, full_name, phone, company_name, role, password_hash, is_active, created_at, updated_at)
        SELECT id, username, full_name, phone, company_name, role, password_hash, is_active, created_at, updated_at
        FROM users_old;
      `);
      db.exec(`DROP TABLE users_old;`);
      db.pragma('foreign_keys = ON');
    } catch (err) {
      try {
        db.exec(`DROP TABLE IF EXISTS users;`);
        db.exec(`ALTER TABLE users_old RENAME TO users;`);
        db.pragma('foreign_keys = ON');
      } catch (e) {}
    }
  }

  // ── Users (Distributors + SuperAdmin + Collectors) ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
      full_name     TEXT    NOT NULL,
      phone         TEXT,
      company_name  TEXT,
      role          TEXT    NOT NULL DEFAULT 'distributor'
                    CHECK(role IN ('superadmin', 'distributor', 'collector')),
      password_hash TEXT    NOT NULL,
      parent_id     INTEGER DEFAULT NULL,
      allowed_neighborhoods TEXT DEFAULT NULL,
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // ── Customers ───────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      distributor_id    INTEGER NOT NULL,
      full_name         TEXT    NOT NULL,
      family_name       TEXT,
      neighborhood      TEXT,
      phone             TEXT,
      monthly_amount    REAL    NOT NULL CHECK(monthly_amount > 0),
      subscription_date DATE    NOT NULL,
      notes             TEXT,
      is_active         INTEGER NOT NULL DEFAULT 1,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (distributor_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Add columns if they do not exist
  try { db.exec(`ALTER TABLE customers ADD COLUMN family_name TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE customers ADD COLUMN neighborhood TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE customers ADD COLUMN status TEXT DEFAULT 'active'`); } catch (_) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN subscription_expires_at TEXT DEFAULT NULL`); } catch (_) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'trial'`); } catch (_) {}

  // ── Monthly Bills ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS monthly_bills (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id  INTEGER NOT NULL,
      year         INTEGER NOT NULL,
      month        INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      amount_due   REAL    NOT NULL CHECK(amount_due >= 0),
      amount_paid  REAL    NOT NULL DEFAULT 0 CHECK(amount_paid >= 0),
      status       TEXT    NOT NULL DEFAULT 'unpaid'
                   CHECK(status IN ('paid', 'partial', 'unpaid')),
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(customer_id, year, month),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
  `);

  // ── Payment Records ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id  INTEGER NOT NULL,
      amount       REAL    NOT NULL CHECK(amount > 0),
      payment_date DATE    NOT NULL,
      notes        TEXT,
      recorded_by  INTEGER NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (recorded_by) REFERENCES users(id)
    );
  `);

  // ── Obligations ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS obligations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      distributor_id INTEGER NOT NULL,
      description    TEXT    NOT NULL,
      amount         REAL    NOT NULL CHECK(amount > 0),
      due_date       DATE,
      is_paid        INTEGER NOT NULL DEFAULT 0,
      paid_date      DATETIME,
      notes          TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (distributor_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // ── Customer Extras ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_extras (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id    INTEGER NOT NULL,
      description    TEXT    NOT NULL,
      amount         REAL    NOT NULL CHECK(amount > 0),
      is_paid        INTEGER NOT NULL DEFAULT 0,
      paid_date      DATETIME,
      notes          TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
  `);

  // ── Refresh Tokens ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      token_hash  TEXT    UNIQUE NOT NULL,
      expires_at  DATETIME NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // ── Indexes ──────────────────────────────────────────────────────────────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_distributor ON customers(distributor_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_monthly_bills_customer ON monthly_bills(customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_monthly_bills_year_month ON monthly_bills(year, month)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_records_customer ON payment_records(customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obligations_distributor ON obligations(distributor_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_extras_customer ON customer_extras(customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`);

  // ── Seed SuperAdmin ──────────────────────────────────────────────────────────
  const existing = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('superadmin');
  if (!existing) {
    const hash = await bcrypt.hash(config.superAdmin.password, 12);
    db.prepare(`
      INSERT INTO users (username, full_name, role, password_hash)
      VALUES (?, ?, 'superadmin', ?)
    `).run(config.superAdmin.username, config.superAdmin.fullName, hash);

    console.log(`[DB] SuperAdmin seeded successfully.`);
  }

  console.log('✅ Database initialized successfully (better-sqlite3)');
  return db;
}

module.exports = { getDb, initDb };
