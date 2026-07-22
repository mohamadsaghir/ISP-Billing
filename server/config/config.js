'use strict';

require('dotenv').config();

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    isDev: process.env.NODE_ENV !== 'production',
    appName: process.env.APP_NAME || 'ISP Billing System',
    appUrl: process.env.APP_URL || 'http://localhost:3000',
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
  },
  db: {
    path: process.env.DB_PATH || './database.sqlite',
  },
  superAdmin: {
    username: process.env.SUPERADMIN_USERNAME || 'admin',
    password: process.env.SUPERADMIN_PASSWORD || 'Admin@123456',
    fullName: process.env.SUPERADMIN_FULLNAME || 'مدير النظام',
  },
};

// Validate required secrets
if (!config.jwt.accessSecret || !config.jwt.refreshSecret) {
  console.error('FATAL: JWT secrets are not defined in .env file');
  process.exit(1);
}

module.exports = config;
