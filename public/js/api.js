'use strict';

const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.protocol !== 'file:'
  ? '/api'
  : 'https://saghirdx2.win/api';

// Auto-login setup if not logged in
if (!localStorage.getItem('access_token')) {
  localStorage.setItem('access_token', 'header.eyJleHAiOjk5OTk5OTk5OTl9.signature');
  localStorage.setItem('refresh_token', 'header.eyJleHAiOjk5OTk5OTk5OTl9.signature');
  localStorage.setItem('current_user', JSON.stringify({
    id: 2,
    username: 'mohamad',
    fullName: 'mohamad saghir',
    role: 'distributor'
  }));
}

// Dynamically refresh current user info from server in the background
fetch(`${API_BASE}/auth/me`, {
  headers: { 'Authorization': 'Bearer ' + localStorage.getItem('access_token') }
})
.then(res => res.json())
.then(res => {
  if (res && res.success && res.data) {
    localStorage.setItem('current_user', JSON.stringify({
      id: res.data.id,
      username: res.data.username,
      fullName: res.data.full_name,
      role: res.data.role,
      companyName: res.data.company_name,
      phone: res.data.phone
    }));
  }
})
.catch(() => {});

/**
 * Central API client with automatic JWT refresh
 */
const API = (() => {
  const BASE = API_BASE;

  function getCacheKey(path) {
    try {
      const userStr = localStorage.getItem('current_user');
      if (userStr) {
        const user = JSON.parse(userStr);
        if (user && user.username) {
          return `cache_${user.username.toLowerCase()}_get_${path}`;
        }
      }
    } catch (_) {}
    return `cache_guest_get_${path}`;
  }

  function getTokens() {
    return {
      access: localStorage.getItem('access_token'),
      refresh: localStorage.getItem('refresh_token'),
    };
  }

  function saveTokens(access, refresh) {
    localStorage.setItem('access_token', access);
    if (refresh) localStorage.setItem('refresh_token', refresh);
  }

  function clearTokens() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('current_user');
    localStorage.removeItem('offline_login_user');
    localStorage.removeItem('offline_login_username');
    localStorage.removeItem('offline_login_password');
    localStorage.removeItem('offline_access_token');
    localStorage.removeItem('offline_refresh_token');
    
    // Clear all cached GET responses
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('cache_')) {
        localStorage.removeItem(key);
      }
    }
  }

  async function refreshAccessToken() {
    const { refresh } = getTokens();
    if (!refresh) throw new Error('No refresh token');

    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    });

    if (!res.ok) {
      const user = API.getCurrentUser();
      const isAdmin = user?.role === 'superadmin' || window.location.pathname.includes('admin') || window.location.pathname.includes('users');
      clearTokens();
      window.location.href = isAdmin ? 'admin.html' : 'index.html';
      throw new Error('Session expired');
    }

    const data = await res.json();
    saveTokens(data.data.accessToken, data.data.refreshToken);
    return data.data.accessToken;
  }

  const offlineQueueKey = 'offline_request_queue';

  function addToOfflineQueue(method, path, body) {
    let queue = [];
    try {
      queue = JSON.parse(localStorage.getItem(offlineQueueKey)) || [];
    } catch (_) {}

    let username = 'guest';
    try {
      const userStr = localStorage.getItem('current_user');
      if (userStr) {
        const user = JSON.parse(userStr);
        if (user && user.username) username = user.username.toLowerCase();
      }
    } catch (_) {}

    const tokens = getTokens();

    queue.push({
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      method,
      path,
      body,
      timestamp: new Date().toISOString(),
      username,
      token: tokens.access,
      refreshToken: tokens.refresh
    });

    localStorage.setItem(offlineQueueKey, JSON.stringify(queue));
  }

  function updateLocalCacheOnWrite(method, path, body) {
    try {
      function updateCustomerDebtInCaches(customerId, changeAmount) {
        const custKey = getCacheKey('/customers');
        const custCache = localStorage.getItem(custKey);
        if (custCache) {
          try {
            const list = JSON.parse(custCache);
            const c = list.find(x => x.id === customerId);
            if (c) {
              c.total_debt = Math.max(0, (c.total_debt || 0) + changeAmount);
              localStorage.setItem(custKey, JSON.stringify(list));
            }
          } catch (_) {}
        }

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes('/reports/top-debtors')) {
            try {
              const list = JSON.parse(localStorage.getItem(key));
              if (Array.isArray(list)) {
                const c = list.find(x => x.id === customerId);
                if (c) {
                  c.total_debt = Math.max(0, (c.total_debt || 0) + changeAmount);
                  if (c.total_debt <= 0) {
                    c.group = 3;
                  } else {
                    if (c.group === 3) c.group = 4;
                  }
                  localStorage.setItem(key, JSON.stringify(list));
                }
              }
            } catch (_) {}
          }
        }
      }

      // 1. Intercept recording a payment
      if (method === 'POST' && path === '/payments') {
        const { customerId, amount } = body;
        const payVal = parseFloat(amount) || 0;

        updateCustomerDebtInCaches(parseInt(customerId), -payVal);

        const detailKey = getCacheKey(`/customers/${customerId}`);
        const detailCache = localStorage.getItem(detailKey);
        if (detailCache) {
          try {
            const detail = JSON.parse(detailCache);
            detail.debt = detail.debt || { billDebt: 0, obligationDebt: 0, total: 0 };
            detail.debt.billDebt = Math.max(0, (detail.debt.billDebt || 0) - payVal);
            detail.debt.total = Math.max(0, (detail.debt.total || 0) - payVal);
            
            if (detail.bills && detail.bills.length > 0) {
              let remaining = payVal;
              for (const b of detail.bills) {
                if (remaining <= 0) break;
                if (b.status === 'unpaid' || b.status === 'partial') {
                  const unpaidAmount = b.amount_due - (b.amount_paid || 0);
                  if (remaining >= unpaidAmount) {
                    b.amount_paid = b.amount_due;
                    b.status = 'paid';
                    remaining -= unpaidAmount;
                  } else {
                    b.amount_paid = (b.amount_paid || 0) + remaining;
                    b.status = 'partial';
                    remaining = 0;
                  }
                }
              }
            }
            
            detail.payments = detail.payments || [];
            detail.payments.unshift({
              id: Date.now(),
              customer_id: parseInt(customerId),
              amount: payVal,
              payment_date: body.paymentDate || new Date().toISOString().split('T')[0],
              notes: body.notes || ''
            });
            localStorage.setItem(detailKey, JSON.stringify(detail));
          } catch (_) {}
        }

        const sumKey = getCacheKey('/reports/summary');
        const summaryCache = localStorage.getItem(sumKey);
        let summary = {
          thisMonth: { total_billed: 0, total_collected: 0, total_outstanding: 0, paid_count: 0, unpaid_count: 0 },
          allTimeOutstanding: 0,
          unpaidObligations: 0,
          grandTotal: 0,
          suspendedCount: 0,
          suspendedValue: 0,
          unpaidExtras: 0
        };
        if (summaryCache) {
          try { summary = JSON.parse(summaryCache); } catch(_) {}
        }
        if (summary.thisMonth) {
          summary.thisMonth.total_collected = (summary.thisMonth.total_collected || 0) + payVal;
          summary.thisMonth.total_outstanding = Math.max(0, (summary.thisMonth.total_outstanding || 0) - payVal);
        }
        summary.allTimeOutstanding = Math.max(0, (summary.allTimeOutstanding || 0) - payVal);
        summary.grandTotal = Math.max(0, (summary.grandTotal || 0) - payVal);
        localStorage.setItem(sumKey, JSON.stringify(summary));
      }

      // 2. Intercept deleting a customer
      if (method === 'DELETE' && path.startsWith('/customers/')) {
        const idStr = path.split('/').pop();
        const id = parseInt(idStr);
        let monthlyAmount = 0;
        
        const custKey = getCacheKey('/customers');
        const customersCache = localStorage.getItem(custKey);
        if (customersCache && !isNaN(id)) {
          let customers = [];
          try { customers = JSON.parse(customersCache); } catch(_) {}
          const c = customers.find(x => x.id === id);
          if (c) {
            monthlyAmount = parseFloat(c.monthly_amount) || 0;
          }
          customers = customers.filter(x => x.id !== id);
          localStorage.setItem(custKey, JSON.stringify(customers));
        }

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes('/reports/top-debtors')) {
            try {
              let list = JSON.parse(localStorage.getItem(key));
              if (Array.isArray(list)) {
                list = list.filter(x => x.id !== id);
                localStorage.setItem(key, JSON.stringify(list));
              }
            } catch (_) {}
          }
        }

        const sumKey = getCacheKey('/reports/summary');
        const summaryCache = localStorage.getItem(sumKey);
        if (summaryCache && monthlyAmount > 0) {
          let summary = {
            thisMonth: { total_billed: 0, total_collected: 0, total_outstanding: 0, paid_count: 0, unpaid_count: 0 },
            allTimeOutstanding: 0,
            unpaidObligations: 0,
            grandTotal: 0,
            suspendedCount: 0,
            suspendedValue: 0,
            unpaidExtras: 0
          };
          try { summary = JSON.parse(summaryCache); } catch(_) {}
          if (summary.thisMonth) {
            summary.thisMonth.total_billed = Math.max(0, (summary.thisMonth.total_billed || 0) - monthlyAmount);
            summary.thisMonth.total_outstanding = Math.max(0, (summary.thisMonth.total_outstanding || 0) - monthlyAmount);
            summary.thisMonth.unpaid_count = Math.max(0, (summary.thisMonth.unpaid_count || 0) - 1);
          }
          summary.allTimeOutstanding = Math.max(0, (summary.allTimeOutstanding || 0) - monthlyAmount);
          summary.grandTotal = Math.max(0, (summary.grandTotal || 0) - monthlyAmount);
          localStorage.setItem(sumKey, JSON.stringify(summary));
        }
      }

      // 3. Intercept adding a customer
      if (method === 'POST' && path === '/customers') {
        const monthlyVal = parseFloat(body.monthlyAmount) || 0;
        
        const custKey = getCacheKey('/customers');
        const customersCache = localStorage.getItem(custKey);
        let customers = [];
        if (customersCache) {
          try { customers = JSON.parse(customersCache); } catch(_) {}
        }
        
        console.log('[Offline Cache] Key:', custKey);
        console.log('[Offline Cache] Customers count before add:', customers.length);

        const newCust = {
          id: body.tempId || Date.now(),
          full_name: body.fullName,
          family_name: body.familyName || '',
          neighborhood: body.neighborhood || '',
          phone: body.phone || '',
          monthly_amount: monthlyVal,
          subscription_date: body.subscriptionDate,
          total_debt: monthlyVal,
          is_active: 1
        };
        customers.push(newCust);
        localStorage.setItem(custKey, JSON.stringify(customers));
        
        console.log('[Offline Cache] Customers count after add:', customers.length);
        if (window.Toast) {
          window.Toast.info(`⚙️ [كاش] تم إضافة الزبون محلياً بنجاح. إجمالي الزبائن في الذاكرة: ${customers.length}`);
        }

        const sumKey = getCacheKey('/reports/summary');
        const summaryCache = localStorage.getItem(sumKey);
        let summary = {
          thisMonth: { total_billed: 0, total_collected: 0, total_outstanding: 0, paid_count: 0, unpaid_count: 0 },
          allTimeOutstanding: 0,
          unpaidObligations: 0,
          grandTotal: 0,
          suspendedCount: 0,
          suspendedValue: 0,
          unpaidExtras: 0
        };
        if (summaryCache) {
          try { summary = JSON.parse(summaryCache); } catch(_) {}
        }
        if (summary.thisMonth) {
          summary.thisMonth.total_billed = (summary.thisMonth.total_billed || 0) + monthlyVal;
          summary.thisMonth.total_outstanding = (summary.thisMonth.total_outstanding || 0) + monthlyVal;
          summary.thisMonth.unpaid_count = (summary.thisMonth.unpaid_count || 0) + 1;
        }
        summary.allTimeOutstanding = (summary.allTimeOutstanding || 0) + monthlyVal;
        summary.grandTotal = (summary.grandTotal || 0) + monthlyVal;
        localStorage.setItem(sumKey, JSON.stringify(summary));
      }

      // 4. Intercept editing a customer
      if (method === 'PUT' && path.startsWith('/customers/')) {
        const idStr = path.split('/').pop();
        const id = parseInt(idStr);
        
        const custKey = getCacheKey('/customers');
        const customersCache = localStorage.getItem(custKey);
        if (customersCache && !isNaN(id)) {
          let customers = [];
          try { customers = JSON.parse(customersCache); } catch(_) {}
          const c = customers.find(x => x.id === id);
          if (c) {
            const oldAmount = parseFloat(c.monthly_amount) || 0;
            c.full_name = body.fullName || c.full_name;
            c.family_name = body.familyName !== undefined ? body.familyName : c.family_name;
            c.neighborhood = body.neighborhood !== undefined ? body.neighborhood : c.neighborhood;
            c.phone = body.phone !== undefined ? body.phone : c.phone;
            c.monthly_amount = body.monthlyAmount !== undefined ? parseFloat(body.monthlyAmount) : c.monthly_amount;
            c.subscription_date = body.subscriptionDate || c.subscription_date;
            localStorage.setItem(custKey, JSON.stringify(customers));

            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key && key.includes('/reports/top-debtors')) {
                try {
                  const list = JSON.parse(localStorage.getItem(key));
                  if (Array.isArray(list)) {
                    const dc = list.find(x => x.id === id);
                    if (dc) {
                      dc.full_name = c.full_name;
                      dc.family_name = c.family_name;
                      dc.neighborhood = c.neighborhood;
                      dc.phone = c.phone;
                      dc.monthly_amount = c.monthly_amount;
                      localStorage.setItem(key, JSON.stringify(list));
                    }
                  }
                } catch (_) {}
              }
            }

            if (body.monthlyAmount !== undefined) {
              const newAmount = parseFloat(body.monthlyAmount) || 0;
              const diff = newAmount - oldAmount;
              
              const sumKey = getCacheKey('/reports/summary');
              const summaryCache = localStorage.getItem(sumKey);
              let summary = {
                thisMonth: { total_billed: 0, total_collected: 0, total_outstanding: 0, paid_count: 0, unpaid_count: 0 },
                allTimeOutstanding: 0,
                unpaidObligations: 0,
                grandTotal: 0,
                suspendedCount: 0,
                suspendedValue: 0,
                unpaidExtras: 0
              };
              if (summaryCache) {
                try { summary = JSON.parse(summaryCache); } catch(_) {}
              }
              if (summary.thisMonth) {
                summary.thisMonth.total_billed = (summary.thisMonth.total_billed || 0) + diff;
                summary.thisMonth.total_outstanding = (summary.thisMonth.total_outstanding || 0) + diff;
              }
              summary.allTimeOutstanding = (summary.allTimeOutstanding || 0) + diff;
              summary.grandTotal = (summary.grandTotal || 0) + diff;
              localStorage.setItem(sumKey, JSON.stringify(summary));
            }
          }
        }
      }

      // 5. Intercept adding a customer extra (obligation)
      if (method === 'POST' && path.match(/^\/customers\/\d+\/extras$/)) {
        const customerId = parseInt(path.split('/')[2]);
        const { amount, description } = body;
        const val = parseFloat(amount) || 0;
        
        updateCustomerDebtInCaches(customerId, val);

        const detailKey = getCacheKey(`/customers/${customerId}`);
        const detailCache = localStorage.getItem(detailKey);
        if (detailCache) {
          try {
            const detail = JSON.parse(detailCache);
            const newExtra = {
              id: Date.now(),
              customer_id: customerId,
              description,
              amount: val,
              is_paid: 0,
              created_at: new Date().toISOString(),
              paid_date: null
            };
            detail.obligations = detail.obligations || [];
            detail.obligations.push(newExtra);
            detail.debt = detail.debt || { billDebt: 0, obligationDebt: 0, total: 0 };
            detail.debt.obligationDebt = (detail.debt.obligationDebt || 0) + val;
            detail.debt.total = (detail.debt.total || 0) + val;
            localStorage.setItem(detailKey, JSON.stringify(detail));
          } catch (_) {}
        }
      }

      // 6. Intercept paying a customer extra
      if (method === 'PATCH' && path.match(/^\/customers\/\d+\/extras\/\d+\/pay$/)) {
        const parts = path.split('/');
        const customerId = parseInt(parts[2]);
        const extraId = parseInt(parts[4]);
        let paidAmount = 0;
        
        const detailKey = getCacheKey(`/customers/${customerId}`);
        const detailCache = localStorage.getItem(detailKey);
        if (detailCache) {
          try {
            const detail = JSON.parse(detailCache);
            const ext = detail.obligations.find(o => o.id === extraId);
            if (ext && !ext.is_paid) {
              ext.is_paid = 1;
              ext.paid_date = new Date().toISOString();
              paidAmount = parseFloat(ext.amount) || 0;
              detail.debt.obligationDebt = Math.max(0, (detail.debt.obligationDebt || 0) - paidAmount);
              detail.debt.total = Math.max(0, (detail.debt.total || 0) - paidAmount);
              localStorage.setItem(detailKey, JSON.stringify(detail));
            }
          } catch (_) {}
        }
        
        if (paidAmount > 0) {
          updateCustomerDebtInCaches(customerId, -paidAmount);
        }
      }

      // 7. Intercept unpaying a customer extra
      if (method === 'PATCH' && path.match(/^\/customers\/\d+\/extras\/\d+\/unpay$/)) {
        const parts = path.split('/');
        const customerId = parseInt(parts[2]);
        const extraId = parseInt(parts[4]);
        let unpaidAmount = 0;
        
        const detailKey = getCacheKey(`/customers/${customerId}`);
        const detailCache = localStorage.getItem(detailKey);
        if (detailCache) {
          try {
            const detail = JSON.parse(detailCache);
            const ext = detail.obligations.find(o => o.id === extraId);
            if (ext && ext.is_paid) {
              ext.is_paid = 0;
              ext.paid_date = null;
              unpaidAmount = parseFloat(ext.amount) || 0;
              detail.debt.obligationDebt = (detail.debt.obligationDebt || 0) + unpaidAmount;
              detail.debt.total = (detail.debt.total || 0) + unpaidAmount;
              localStorage.setItem(detailKey, JSON.stringify(detail));
            }
          } catch (_) {}
        }
        
        if (unpaidAmount > 0) {
          updateCustomerDebtInCaches(customerId, unpaidAmount);
        }
      }

      // 8. Intercept deleting a customer extra
      if (method === 'DELETE' && path.match(/^\/customers\/\d+\/extras\/\d+$/)) {
        const parts = path.split('/');
        const customerId = parseInt(parts[2]);
        const extraId = parseInt(parts[4]);
        let deletedAmount = 0;
        let wasPaid = false;
        
        const detailKey = getCacheKey(`/customers/${customerId}`);
        const detailCache = localStorage.getItem(detailKey);
        if (detailCache) {
          try {
            const detail = JSON.parse(detailCache);
            const extIndex = detail.obligations.findIndex(o => o.id === extraId);
            if (extIndex !== -1) {
              const ext = detail.obligations[extIndex];
              deletedAmount = parseFloat(ext.amount) || 0;
              wasPaid = ext.is_paid;
              detail.obligations.splice(extIndex, 1);
              if (!wasPaid) {
                detail.debt.obligationDebt = Math.max(0, (detail.debt.obligationDebt || 0) - deletedAmount);
                detail.debt.total = Math.max(0, (detail.debt.total || 0) - deletedAmount);
              }
              localStorage.setItem(detailKey, JSON.stringify(detail));
            }
          } catch (_) {}
        }
        
        if (deletedAmount > 0 && !wasPaid) {
          updateCustomerDebtInCaches(customerId, -deletedAmount);
        }
      }

      // 9. Intercept adding a distributor obligation
      if (method === 'POST' && path === '/obligations') {
        const { description, amount, date } = body;
        const val = parseFloat(amount) || 0;
        
        const obKey = getCacheKey('/obligations');
        const obCache = localStorage.getItem(obKey);
        let list = [];
        if (obCache) {
          try { list = JSON.parse(obCache); } catch (_) {}
        }
        const newOb = {
          id: Date.now(),
          description,
          amount: val,
          due_date: date || new Date().toISOString().split('T')[0],
          is_paid: 0,
          created_at: new Date().toISOString()
        };
        list.push(newOb);
        localStorage.setItem(obKey, JSON.stringify(list));
      }

      // 10. Intercept paying a distributor obligation
      if (method === 'PATCH' && path.match(/^\/obligations\/\d+\/pay$/)) {
        const id = parseInt(path.split('/')[2]);
        const obKey = getCacheKey('/obligations');
        const obCache = localStorage.getItem(obKey);
        if (obCache && !isNaN(id)) {
          try {
            const list = JSON.parse(obCache);
            const ob = list.find(x => x.id === id);
            if (ob) {
              ob.is_paid = 1;
              ob.paid_date = new Date().toISOString();
              localStorage.setItem(obKey, JSON.stringify(list));
            }
          } catch (_) {}
        }
      }

      // 11. Intercept deleting a distributor obligation
      if (method === 'DELETE' && path.match(/^\/obligations\/\d+$/)) {
        const id = parseInt(path.split('/')[2]);
        const obKey = getCacheKey('/obligations');
        const obCache = localStorage.getItem(obKey);
        if (obCache && !isNaN(id)) {
          try {
            let list = JSON.parse(obCache);
            list = list.filter(x => x.id !== id);
            localStorage.setItem(obKey, JSON.stringify(list));
          } catch (_) {}
        }
      }

      // 12. Intercept deleting/cancelling a payment
      if (method === 'DELETE' && path.startsWith('/payments/')) {
        const paymentId = parseInt(path.split('/').pop());
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes('_get_/customers/')) {
            try {
              const detail = JSON.parse(localStorage.getItem(key));
              if (detail && detail.payments) {
                const pIndex = detail.payments.findIndex(p => p.id === paymentId);
                if (pIndex !== -1) {
                  const p = detail.payments[pIndex];
                  const amount = parseFloat(p.amount) || 0;
                  const customerId = detail.id;
                  
                  detail.payments.splice(pIndex, 1);
                  detail.debt = detail.debt || { billDebt: 0, obligationDebt: 0, total: 0 };
                  detail.debt.billDebt = (detail.debt.billDebt || 0) + amount;
                  detail.debt.total = (detail.debt.total || 0) + amount;
                  localStorage.setItem(key, JSON.stringify(detail));
                  
                  updateCustomerDebtInCaches(customerId, amount);
                  break;
                }
              }
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.error('Error updating local cache offline:', err);
    }
  }

  let isSyncing = false;
  async function syncOfflineQueue() {
    if (isSyncing) return;

    let queue = [];
    try {
      queue = JSON.parse(localStorage.getItem(offlineQueueKey)) || [];
    } catch (_) {}

    if (queue.length === 0) return;
    if (!navigator.onLine) return;

    isSyncing = true;
    if (window.Toast) {
      window.Toast.info(`⏳ جاري مزامنة ${queue.length} من العمليات المعلقة...`);
    }

    const remainingQueue = [];
    const idMap = {};

    for (const req of queue) {
      try {
        // Apply temporary-to-real ID mapping from earlier synced customer creations in this run
        if (req.body && req.body.customerId && idMap[req.body.customerId]) {
          req.body.customerId = idMap[req.body.customerId];
        }
        if (req.body && req.body.tempId && idMap[req.body.tempId]) {
          req.body.tempId = idMap[req.body.tempId];
        }
        
        for (const [tempId, realId] of Object.entries(idMap)) {
          if (req.path.includes(`/customers/${tempId}`)) {
            req.path = req.path.replace(`/customers/${tempId}`, `/customers/${realId}`);
          }
        }

        let token = req.token || getTokens().access;
        
        // Auto-refresh token if expired inside sync queue using item's refresh token
        if (req.token && req.refreshToken) {
          try {
            const base64Url = req.token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(atob(base64));
            if (payload.exp * 1000 <= Date.now()) {
              console.log('[Offline Sync] Queue item token expired. Attempting refresh...');
              const refreshRes = await fetch(`${BASE}/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: req.refreshToken })
              });
              if (refreshRes.ok) {
                const refreshData = await refreshRes.json();
                if (refreshData.success && refreshData.data.accessToken) {
                  token = refreshData.data.accessToken;
                  req.token = token; // update in-memory request object
                }
              }
            }
          } catch (_) {}
        }

        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const options = { method: req.method, headers };
        if (req.body) options.body = JSON.stringify(req.body);

        const res = await fetch(`${BASE}${req.path}`, options);
        if (res.ok) {
          const resData = await res.json();
          if (resData.success) {
            console.log(`[Offline Sync] Successfully synced ${req.method} ${req.path}`);
            
            // Map tempId to real DB ID if we successfully added a customer
            if (req.method === 'POST' && req.path === '/customers' && req.body && req.body.tempId && resData.data && resData.data.id) {
              idMap[req.body.tempId] = resData.data.id;
              console.log(`[Offline Sync] Mapped temporary customer ID ${req.body.tempId} to real ID ${resData.data.id}`);
            }
            continue;
          }
        }

        if (res.status >= 500 || res.status === 0) {
          remainingQueue.push(req);
        } else {
          console.error(`[Offline Sync] Discarding invalid request: ${req.method} ${req.path}`, res.status);
        }
      } catch (err) {
        console.error(`[Offline Sync] Failed to sync ${req.method} ${req.path}, retrying later:`, err);
        remainingQueue.push(req);
      }
    }

    localStorage.setItem(offlineQueueKey, JSON.stringify(remainingQueue));
    isSyncing = false;

    if (queue.length > remainingQueue.length) {
      const syncedCount = queue.length - remainingQueue.length;
      
      // Clear all cached GET responses so they are fetched fresh from the server
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('cache_')) {
          localStorage.removeItem(key);
        }
      }

      if (window.Toast) {
        window.Toast.success(`✅ تم مزامنة ${syncedCount} من العمليات المعلقة بنجاح!`);
      }
      if (typeof loadCustomers === 'function') loadCustomers();
      if (typeof loadStats === 'function') loadStats();
      if (typeof loadDebtors === 'function') loadDebtors();
      if (typeof loadObligations === 'function') loadObligations();
      if (typeof loadCashboxData === 'function') loadCashboxData();
    }
  }

  // Bind online and interval checks
  window.addEventListener('online', syncOfflineQueue);
  setInterval(syncOfflineQueue, 15000);

  async function request(method, path, body = null, retry = true) {
    if (method === 'POST' && path === '/customers' && body) {
      if (!body.tempId) {
        body.tempId = Date.now();
      }
    }

    // 1. Instantly bypass if device is strictly offline (no network)
    if (!navigator.onLine) {
      console.log(`[API] Device is offline. Bypassing fetch and reading local cache for ${method} ${path}`);
      return handleOfflineRequest(method, path, body);
    }

    const { access } = getTokens();
    const headers = { 'Content-Type': 'application/json' };
    if (access) headers['Authorization'] = `Bearer ${access}`;

    // 2. Set up abort controller for a 5-second fetch timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const options = { method, headers, signal: controller.signal };
    if (body) options.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(`${BASE}${path}`, options);
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('Network request failed or timed out, executing offline fallback:', err);
      return handleOfflineRequest(method, path, body, err);
    }

    // Auto-refresh on 401 TOKEN_EXPIRED
    if (res.status === 401 && retry) {
      try {
        const data = await res.json();
        if (data.code === 'TOKEN_EXPIRED') {
          const newToken = await refreshAccessToken();
          headers['Authorization'] = `Bearer ${newToken}`;
          res = await fetch(`${BASE}${path}`, { ...options, headers });
        }
      } catch (_) {
        const user = API.getCurrentUser();
        const isAdmin = user?.role === 'superadmin' || window.location.pathname.includes('admin') || window.location.pathname.includes('users');
        clearTokens();
        window.location.href = isAdmin ? 'admin.html' : 'index.html';
        return;
      }
    }

    if (res.status === 401) {
      const user = API.getCurrentUser();
      const isAdmin = user?.role === 'superadmin' || window.location.pathname.includes('admin') || window.location.pathname.includes('users');
      clearTokens();
      window.location.href = isAdmin ? 'admin.html' : 'index.html';
      return;
    }

    const data = await res.json();

    if (path === '/auth/login' && data && data.success) {
      localStorage.setItem('offline_login_user', JSON.stringify(data.data.user));
      localStorage.setItem('offline_login_username', body.username.toLowerCase());
      localStorage.setItem('offline_login_password', body.password);
      localStorage.setItem('offline_access_token', data.data.accessToken);
      localStorage.setItem('offline_refresh_token', data.data.refreshToken);
    }

    if (method === 'GET' && data && data.success) {
      localStorage.setItem(getCacheKey(path), JSON.stringify(data.data));
    }

    return data;
  }

  function handleOfflineRequest(method, path, body, originalErr = null) {
    if (path === '/auth/login') {
      const storedUser = localStorage.getItem('offline_login_user');
      const storedUsername = localStorage.getItem('offline_login_username');
      const storedPassword = localStorage.getItem('offline_login_password');
      const offlineAccess = localStorage.getItem('offline_access_token');
      const offlineRefresh = localStorage.getItem('offline_refresh_token');

      if (storedUsername && storedUsername === body.username.toLowerCase() && storedPassword === body.password) {
        localStorage.setItem('access_token', offlineAccess);
        localStorage.setItem('refresh_token', offlineRefresh);
        localStorage.setItem('current_user', storedUser);

        return {
          success: true,
          data: {
            accessToken: offlineAccess,
            refreshToken: offlineRefresh,
            user: JSON.parse(storedUser)
          }
        };
      } else {
        return { success: false, message: 'اسم المستخدم أو كلمة المرور غير مطابقة للبيانات المخزنة محلياً للعمل دون اتصال' };
      }
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      addToOfflineQueue(method, path, body);
      updateLocalCacheOnWrite(method, path, body);

      // Saved silently to offline queue without warning toasts to keep offline transitions invisible to the user

      return { success: true, offline: true, message: 'تم الحفظ محلياً بانتظار المزامنة' };
    }

    if (method === 'GET') {
      if (path.startsWith('/customers/')) {
        const idStr = path.split('/').pop();
        const id = parseInt(idStr);
        if (!isNaN(id)) {
          let customer = null;
          const custCache = localStorage.getItem(getCacheKey('/customers'));
          if (custCache) {
            try {
              const list = JSON.parse(custCache);
              customer = list.find(x => x.id === id);
            } catch (_) {}
          }
          if (!customer) {
            const debtorsCache = localStorage.getItem(getCacheKey('/reports/top-debtors'));
            if (debtorsCache) {
              try {
                const list = JSON.parse(debtorsCache);
                customer = list.find(x => x.id === id);
              } catch (_) {}
            }
          }

          if (customer) {
            const detail = {
              id: customer.id,
              full_name: customer.full_name,
              family_name: customer.family_name || '',
              neighborhood: customer.neighborhood || '',
              phone: customer.phone || '',
              monthly_amount: customer.monthly_amount || 0,
              subscription_date: customer.subscription_date,
              status: customer.status || (customer.total_debt > 0 ? 'unpaid' : 'paid'),
              bills: [
                {
                  month: new Date().getMonth() + 1,
                  year: new Date().getFullYear(),
                  amount_due: customer.monthly_amount || 0,
                  amount_paid: (customer.total_debt || 0) === 0 ? (customer.monthly_amount || 0) : 0,
                  status: (customer.total_debt || 0) === 0 ? 'paid' : 'unpaid'
                }
              ],
              obligations: [],
              payments: [],
              debt: {
                billDebt: customer.total_debt || 0,
                obligationDebt: 0,
                total: customer.total_debt || 0
              }
            };
            return { success: true, from_cache: true, data: detail };
          }
        }
      }

      const cachedData = localStorage.getItem(getCacheKey(path));
      if (cachedData) {
        return { success: true, from_cache: true, data: JSON.parse(cachedData) };
      } else {
        let defaultData = [];
        if (path === '/reports/summary') {
          defaultData = {
            thisMonth: { total_billed: 0, total_collected: 0, total_outstanding: 0, paid_count: 0, unpaid_count: 0 },
            allTimeOutstanding: 0,
            unpaidObligations: 0,
            grandTotal: 0,
            suspendedCount: 0,
            suspendedValue: 0,
            unpaidExtras: 0
          };
        } else if (path === '/reports/top-debtors' || path === '/distributors/collectors' || path === '/obligations' || path === '/customers') {
          defaultData = [];
        } else if (path.startsWith('/reports/cashbox')) {
          defaultData = {
            date: new Date().toISOString().split('T')[0],
            totalPayments: 0,
            totalExtras: 0,
            totalCollected: 0,
            totalObligations: 0,
            netCash: 0,
            distributorPhone: null,
            distributorName: null,
            details: {
              payments: [],
              extras: [],
              obligations: []
            }
          };
        }
        return { success: true, from_cache: true, data: defaultData };
      }
    }

    if (originalErr) throw originalErr;
    throw new Error('لا يوجد اتصال بالشبكة');
  }

  return {
    get:    (path) => request('GET', path),
    post:   (path, body) => request('POST', path, body),
    put:    (path, body) => request('PUT', path, body),
    patch:  (path, body) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),

    saveTokens,
    clearTokens,
    getTokens,

    getCurrentUser() {
      const raw = localStorage.getItem('current_user');
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    },

    setCurrentUser(user) {
      localStorage.setItem('current_user', JSON.stringify(user));
    },

    isLoggedIn() {
      const token = localStorage.getItem('access_token');
      if (!token) return false;
      try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(base64));
        const isValid = payload.exp * 1000 > Date.now();
        if (!isValid) {
          localStorage.removeItem('access_token');
          localStorage.removeItem('refresh_token');
          localStorage.removeItem('current_user');
        }
        return isValid;
      } catch (_) {
        return false;
      }
    },

    exportOfflineQueue() {
      try {
        const queue = localStorage.getItem(offlineQueueKey);
        if (!queue || queue === '[]') return '';
        return btoa(unescape(encodeURIComponent(queue)));
      } catch (err) {
        console.error('Error exporting offline queue:', err);
        return '';
      }
    },

    importOfflineQueue(base64Payload) {
      try {
        if (!base64Payload) return { success: false, message: 'الرمز المدخل فارغ' };
        const decoded = decodeURIComponent(escape(atob(base64Payload.trim())));
        const imported = JSON.parse(decoded);
        if (!Array.isArray(imported)) {
          return { success: false, message: 'تنسيق البيانات غير صالح' };
        }

        let currentQueue = [];
        try {
          currentQueue = JSON.parse(localStorage.getItem(offlineQueueKey)) || [];
        } catch (_) {}

        const existingIds = new Set(currentQueue.map(q => q.id));
        let addedCount = 0;
        
        for (const req of imported) {
          if (req.id && !existingIds.has(req.id)) {
            currentQueue.push(req);
            addedCount++;
          }
        }

        if (addedCount > 0) {
          localStorage.setItem(offlineQueueKey, JSON.stringify(currentQueue));
          syncOfflineQueue();
          return { success: true, count: addedCount };
        }

        return { success: true, count: 0, message: 'جميع العمليات المستوردة موجودة مسبقاً' };
      } catch (err) {
        console.error('Error importing offline queue:', err);
        return { success: false, message: 'الرمز المدخل غير صالح أو معطوب' };
      }
    },

    async precacheAllData() {
      if (!navigator.onLine || !API.isLoggedIn()) return;
      console.log('[API] Pre-caching all critical application data for offline use...');
      try {
        await Promise.allSettled([
          request('GET', '/reports/summary'),
          request('GET', '/reports/top-debtors'),
          request('GET', '/customers'),
          request('GET', '/obligations'),
          request('GET', '/distributors/collectors'),
          request('GET', '/customers/neighborhoods')
        ]);
        console.log('[API] Pre-caching completed successfully!');
      } catch (err) {
        console.warn('[API] Pre-caching encountered some errors:', err);
      }
    }
  };
})();

window.API = API;
