'use strict';

// Global PWA Install Prompter
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.deferredPrompt = e;
  window.dispatchEvent(new CustomEvent('pwa-installable'));
});

/**
 * Shared UI utilities used across all pages
 */

// ── Toast Notifications ──────────────────────────────────────
const Toast = (() => {
  let container;

  function init() {
    container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
  }

  function show(message, type = 'info', duration = 4000) {
    if (!container) init();

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return {
    success: (msg) => show(msg, 'success'),
    error:   (msg) => show(msg, 'error', 5000),
    warning: (msg) => show(msg, 'warning'),
    info:    (msg) => show(msg, 'info'),
  };
})();

// ── Modal Manager ────────────────────────────────────────────
const Modal = (() => {
  function show(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('show');
  }

  function hide(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
  }

  function confirm(message, onConfirm, title = 'تأكيد') {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3 class="modal-title">⚠️ ${title}</h3>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-secondary)">${message}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="confirm-cancel">إلغاء</button>
          <button class="btn btn-danger" id="confirm-ok">تأكيد</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#confirm-ok').addEventListener('click', () => {
      overlay.remove();
      onConfirm();
    });
    overlay.querySelector('#confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  function showSendReceiptModal(name, phone, amount, totalDebt) {
    if (!phone) {
      Toast.warning('الزبون ليس لديه رقم هاتف لإرسال التأكيد له');
      return;
    }
    const tFull = localStorage.getItem('template_receipt_full') || 'السلام عليكم {name}،\nتم استلام دفعة بقيمة {amount} $ بنجاح (خالص الحساب).\nشكراً لكم لثقتكم بنا 🙏';
    const tPartial = localStorage.getItem('template_receipt_partial') || 'السلام عليكم {name}،\nتم استلام دفعة جزئية بقيمة {amount} $ بنجاح.\nالمتبقي بذمتكم: {remaining} $.\nشكراً لكم لثقتكم بنا 🙏';
    const tDefault = localStorage.getItem('template_receipt_default') || 'السلام عليكم {name}،\nتم استلام دفعة بقيمة {amount} $ بنجاح.\nشكراً لكم لثقتكم بنا 🙏';

    let message = '';
    if (totalDebt !== undefined && totalDebt !== null) {
      const remaining = Number(totalDebt) - Number(amount);
      if (remaining > 0.01) {
        message = tPartial
          .replace('{name}', name)
          .replace('{amount}', Number(amount).toFixed(2))
          .replace('{remaining}', Number(remaining).toFixed(2));
      } else {
        message = tFull
          .replace('{name}', name)
          .replace('{amount}', Number(amount).toFixed(2));
      }
    } else {
      message = tDefault
        .replace('{name}', name)
        .replace('{amount}', Number(amount).toFixed(2));
    }
    const cleaned = phone.replace(/\D/g, '');
    const encoded = encodeURIComponent(message);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.style.zIndex = '9999';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3 class="modal-title">📨 إرسال تأكيد الدفع</h3>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-secondary);margin-bottom:12px">تم تسجيل الدفعة بنجاح! هل تريد إرسال رسالة تأكيد للزبون؟</p>
          <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;font-size:0.85rem;color:var(--text-muted);white-space:pre-wrap;text-align:right">${message}</div>
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;flex-direction:column">
          <div style="display:flex;gap:8px;width:100%">
            <button class="btn btn-success" id="btn-send-wa" style="flex:1">🟢 واتساب</button>
            <button class="btn btn-primary" id="btn-send-sms" style="flex:1">📱 رسالة نصية (SMS)</button>
          </div>
          <button class="btn btn-secondary" id="btn-send-close" style="width:100%">إلغاء</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-send-wa').addEventListener('click', () => {
      openWhatsAppLink(cleaned, encoded);
      overlay.remove();
    });

    overlay.querySelector('#btn-send-sms').addEventListener('click', () => {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      const separator = isIOS ? '&' : '?';
      window.open(`sms:${cleaned}${separator}body=${encoded}`, '_blank');
      overlay.remove();
    });

    overlay.querySelector('#btn-send-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  return { show, hide, confirm, showSendReceiptModal };
})();

// ── Format Helpers ───────────────────────────────────────────
function formatMoney(amount) {
  if (amount == null) return '—';
  return Number(amount).toFixed(2) + ' $';
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function monthName(month) {
  return String(month).padStart(2, '0');
}

// ── Navigation Highlight ─────────────────────────────────────
function highlightNav() {
  const page = window.location.pathname.split('/').pop() || 'dashboard.html';
  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach((item) => {
    const href = item.getAttribute('href');
    if (href && href.includes(page)) {
      item.classList.add('active');
    }
  });
}

// ── User Info ────────────────────────────────────────────────
function loadUserInfo() {
  const user = API.getCurrentUser();
  if (!user) return;

  const nameEl = document.getElementById('user-name');
  const roleEl = document.getElementById('user-role');
  const avatarEl = document.getElementById('user-avatar');

  if (nameEl) nameEl.textContent = user.fullName || user.username;
  if (roleEl) roleEl.textContent = user.role === 'superadmin' ? 'مدير عام' : 'موزع';
  if (avatarEl) avatarEl.textContent = (user.fullName || user.username || '?')[0];

  // Hide superadmin-only items for distributors
  if (user.role !== 'superadmin') {
    document.querySelectorAll('.superadmin-only').forEach((el) => el.remove());
  }
}

// ── Logout ───────────────────────────────────────────────────
async function logout() {
  const { refresh } = API.getTokens();
  try {
    await API.post('/auth/logout', { refreshToken: refresh });
  } catch (_) {}
  API.clearTokens();
  window.location.href = 'index.html';
}

// ── Auth Guard ───────────────────────────────────────────────
function requireAuth() {
  if (!API.isLoggedIn()) {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

// ── Mobile Sidebar Toggle ─────────────────────────────────────
function initSidebarToggle() {
  const toggle = document.getElementById('app-sidebar-toggle');
  const sidebar = document.getElementById('app-sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('active'));
    document.addEventListener('click', (e) => {
      if (!sidebar.contains(e.target) && e.target !== toggle) {
        sidebar.classList.remove('active');
      }
    });
  }
}

// ── Search Debounce ───────────────────────────────────────────
function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// ── Init on page load ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;
  if (!path.endsWith('index.html') && !path.endsWith('/pos_netwoark/') && !path.endsWith('/pos_netwoark') && path !== '/') {
    requireAuth();
    loadUserInfo();
    highlightNav();
    initSidebarToggle();
  }

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('show');
    });
  });

  // Logout button
  document.getElementById('logout-btn')?.addEventListener('click', logout);
  document.getElementById('mobile-logout-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });
});

function sendDirectReminder(name, phone, total, monthly, obligations) {
  if (!phone) {
    Toast.warning('الزبون ليس لديه رقم هاتف لتذكيره');
    return;
  }
  const defaultTemplate = "السلام عليكم {name}،\n\nنذكركم بمستحقات خدمة الإنترنت:\n💵 اشتراك الإنترنت: {monthly} $\n{obligations_line}\n💰 المجموع المستحق: {total} $\n\nيرجى الدفع في أقرب وقت ممكن.\nشكراً لكم 🙏";
  const template = localStorage.getItem('template_reminder') || defaultTemplate;
  
  const oblLine = (obligations && Number(obligations) > 0.01)
    ? `📦 مستحقات أخرى: ${Number(obligations).toFixed(2)} $`
    : '';

  const message = template
    .replace('{name}', name)
    .replace('{monthly}', Number(monthly || 0).toFixed(2))
    .replace('{obligations_line}', oblLine)
    .replace('{obligations}', Number(obligations || 0).toFixed(2))
    .replace('{total}', Number(total).toFixed(2))
    .replace(/\n\n+/g, '\n\n') // clean up excess double returns
    .trim();

  const cleaned = phone.replace(/\D/g, '');
  const encoded = encodeURIComponent(message);
  openWhatsAppLink(cleaned, encoded);
}

function openWhatsAppLink(phone, messageEncoded) {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (isMobile) {
    // Protocol link triggers Android/iOS app chooser (WhatsApp / WhatsApp Business)
    window.location.href = `whatsapp://send?phone=${phone}&text=${messageEncoded}`;
  } else {
    // Desktop fallback
    window.open(`https://wa.me/${phone}?text=${messageEncoded}`, '_blank');
  }
}

async function exportCustomersData() {
  try {
    if (typeof XLSX === 'undefined') {
      Toast.info('⏳ جاري تهيئة محرك الإكسيل...');
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    const res = await API.get('/customers');
    if (!res?.success) {
      Toast.error(res?.message || 'فشل جلب بيانات الزبائن');
      return;
    }

    if (!res.data.length) {
      Toast.warning('لا يوجد زبائن حاليين لتصديرهم');
      return;
    }

    const ws_data = [
      ["الاسم بالكامل", "الحي / المنطقة", "رقم الهاتف", "المبلغ الشهري ($)", "تاريخ الاشتراك", "إجمالي الديون الحالية ($)", "ملاحظات"]
    ];

    for (const c of res.data) {
      const fullName = `${c.full_name} ${c.family_name || ''}`.trim();
      ws_data.push([
        fullName,
        c.neighborhood || '',
        c.phone || '',
        c.monthly_amount,
        c.subscription_date ? formatDate(c.subscription_date) : '',
        c.total_debt || 0,
        c.notes || ''
      ]);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    XLSX.utils.book_append_sheet(wb, ws, "الزبائن الحاليين");

    const dateStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `ISP_Customers_Export_${dateStr}.xlsx`);
    Toast.success('تم تصدير وتحميل بيانات الزبائن بنجاح ✅');
  } catch (err) {
    console.error(err);
    Toast.error('حدث خطأ أثناء تصدير البيانات');
  }
}

function checkAllPaidStatus(isAllPaid) {
  if (isAllPaid) {
    if (localStorage.getItem('all_paid_congrats_shown') !== 'true') {
      localStorage.setItem('all_paid_congrats_shown', 'true');

      // Trigger modal
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay show';
      overlay.style.zIndex = '10000';
      overlay.innerHTML = `
        <div class="modal" style="max-width:440px; text-align:center; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-xl);">
          <div class="modal-body" style="padding:32px 24px;">
            <div style="font-size:4rem;margin-bottom:16px;">🎉</div>
            <h2 style="color:var(--success);margin-bottom:12px;font-size:1.5rem">جميع الزبائن دافعين!</h2>
            <p style="color:var(--text-secondary);line-height:1.6;margin-bottom:24px">
              تهانينا! تم تحصيل كافة المستحقات والاشتراكات بنجاح والحسابات كاملة خالصة وصفر.
              <br><br>
              هل ترغب في تحميل وتنزيل نسخة احتياطية من معلومات الزبائن الحالية الآن؟
            </p>
            <div style="display:flex;gap:12px;justify-content:center">
              <button class="btn btn-secondary" id="btn-congrats-cancel" style="padding:10px 20px">إغلاق</button>
              <button class="btn btn-success" id="btn-congrats-export" style="padding:10px 20px;display:flex;align-items:center;gap:6px">📥 تحميل المعلومات</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      overlay.querySelector('#btn-congrats-cancel').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#btn-congrats-export').addEventListener('click', async () => {
        overlay.remove();
        await exportCustomersData();
      });
    }
  } else {
    // Reset if there is any debt, so it can trigger next time all is paid
    localStorage.removeItem('all_paid_congrats_shown');
  }
}

function updateNetworkStatus() {
  const badge = document.getElementById('network-status-badge');
  if (!badge) return;

  if (navigator.onLine) {
    badge.style.display = 'flex';
    badge.style.opacity = '1';
    badge.className = 'network-status-badge online';
    badge.innerHTML = '<span>متصل</span>';
    
    // Fade out after 3 seconds
    setTimeout(() => {
      if (badge.classList.contains('online')) {
        badge.style.opacity = '0';
        setTimeout(() => {
          if (badge.style.opacity === '0') badge.style.display = 'none';
        }, 300);
      }
    }, 3000);
  } else {
    badge.style.display = 'flex';
    badge.style.opacity = '1';
    badge.className = 'network-status-badge offline';
    badge.innerHTML = '<span>وضع العمل المحلي</span>';
  }
}

// Inject styles and listener on load
document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = `
    .network-status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 99px;
      font-size: 0.8rem;
      font-weight: 700;
      transition: all 0.3s ease;
      margin-right: auto; /* Push to the left side in RTL */
      border: 1px solid transparent;
      line-height: 1;
    }
    .network-status-badge::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .network-status-badge.online {
      background: rgba(34, 197, 94, 0.05) !important;
      color: #22c55e !important;
      border-color: rgba(34, 197, 94, 0.15) !important;
    }
    .network-status-badge.online::before {
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
      animation: pulse-green 1.5s infinite;
    }
    .network-status-badge.offline {
      background: rgba(245, 158, 11, 0.05) !important;
      color: #f59e0b !important;
      border-color: rgba(245, 158, 11, 0.15) !important;
    }
    .network-status-badge.offline::before {
      background: #f59e0b;
      box-shadow: 0 0 8px #f59e0b;
      animation: pulse-amber 1.5s infinite;
    }
    @keyframes pulse-green {
      0% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
      70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
      100% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
    @keyframes pulse-amber {
      0% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7); }
      70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(245, 158, 11, 0); }
      100% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
    }
  `;
  document.head.appendChild(style);

  const topbar = document.querySelector('.topbar');
  if (topbar) {
    const badge = document.createElement('div');
    badge.id = 'network-status-badge';
    badge.className = 'network-status-badge';
    topbar.appendChild(badge);

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);

    // Initial check
    updateNetworkStatus();

    // Pre-cache all critical data for offline use
    if (typeof API !== 'undefined' && API.isLoggedIn() && navigator.onLine) {
      setTimeout(() => {
        API.precacheAllData().catch(() => {});
      }, 1500);
    }
  }

  // Register Service Worker for PWA support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('Service Worker registered successfully!', reg.scope);
        // Check for updates periodically every 60 seconds
        setInterval(() => {
          reg.update().catch(() => {});
        }, 60000);
      })
      .catch((err) => console.error('Service worker registration failed:', err));

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        const modalOpen = document.querySelector('.modal-overlay.show, .modal.show, .modal-backdrop.show');
        const userTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
        
        if (modalOpen || userTyping) {
          console.log('[PWA] Update deferred because user is active in a modal or typing.');
          if (window.Toast) {
            window.Toast.info('✨ يتوفر إصدار جديد للتطبيق. سيتم تطبيقه تلقائياً عند إغلاق النوافذ المفتوحة أو عند تحديث الصفحة.');
          }
        } else {
          refreshing = true;
          window.location.reload();
        }
      }
    });
  }
});

window.Toast = Toast;
window.Modal = Modal;
window.formatMoney = formatMoney;
window.formatDate = formatDate;
window.monthName = monthName;
window.logout = logout;
window.debounce = debounce;
window.sendDirectReminder = sendDirectReminder;
window.openWhatsAppLink = openWhatsAppLink;
window.exportCustomersData = exportCustomersData;
window.checkAllPaidStatus = checkAllPaidStatus;
