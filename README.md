# ISP Billing System

A comprehensive, lightweight, and offline-first billing and management system designed for local internet service providers (ISPs) and distributors.

## Table of Contents
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Installation and Setup](#installation-and-setup)
- [Default Credentials](#default-credentials)
- [Auto-Login Bypass](#auto-login-bypass)
- [Admin Access](#admin-access)

## Key Features
- Stats Dashboard: View monthly earnings, paid/unpaid subscriptions, and total outstanding debt.
- Customer Management: Add, edit, delete, and suspend customer accounts.
- Automated Billing: Generate monthly bills automatically via cron jobs.
- Obligations and Extra Fees: Record additional costs for customers or general expenses for the distributor.
- WhatsApp and SMS Integration: Send payment receipts and outstanding balance reminders to customers.
- PWA and Offline Support: Installable web app with local caching and offline sync.
- Auto-Login Bypass: Bypasses the login screen to access the distributor dashboard directly.

## Tech Stack
### Backend
- Node.js & Express
- SQLite (better-sqlite3)
- JWT (JSON Web Tokens)
- Helmet & CORS

### Frontend
- HTML5 & CSS3 (Vanilla)
- JavaScript (Vanilla)
- SheetJS (XLSX)

## Installation and Setup

### Prerequisites
- Node.js (version 18 or higher)

### Steps
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
3. Run the backend server:
   - Double-click "تشغيل_الخادم.bat" or run:
     ```bash
     npm start
     ```
4. Open the frontend:
   - Double-click "فتح_البرنامج.bat" or open "http://localhost:3000" in your browser.

## Default Credentials

### Distributor Account (Auto-Logged In)
- Username: mohamad
- Password: (Bypassed automatically, no password needed)

### SuperAdmin Account (Admin Panel)
- Username: admin
- Password: Admin@123456

## Auto-Login Bypass
- The system automatically authenticates standard distributor requests by falling back to the first active distributor user in the database (mohamad).
- When loading index.html, a dummy token is generated in localStorage, and the page redirects to dashboard.html instantly.

## Admin Access
- To access the admin panel, navigate to http://localhost:3000/admin.html
- Login using the SuperAdmin credentials listed above.
