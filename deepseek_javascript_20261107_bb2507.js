/* ============================================================
   Семейная касса УПФ (УралПромФонд) — общая логика приложения
   Хранилище: localStorage (данные) + sessionStorage (сессия)
   ============================================================ */

/* ---------- Константы ---------- */
const LS = {
  users: 'users',
  operations: 'operations',
  loans: 'loans',
  cards: 'cards',
  requests: 'requests',
  config: 'config',
  remembered: 'sessionRememberedUser' // последний пользователь устройства
};
const SS = { session: 'upf_session' }; // активная сессия — только в sessionStorage
const IDLE_LIMIT_MS = 5 * 60 * 1000;   // 5 минут бездействия
const LOAN_PERCENT = 10;               // процент по займу
const LOAN_TERM_DAYS = 30;             // срок займа — 1 месяц

/* ---------- Утилиты хранилища ---------- */
function readLS(key, def) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : def;
  } catch (e) { return def; }
}
function writeLS(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}
function readSS(key) {
  try { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function writeSS(key, val) { sessionStorage.setItem(key, JSON.stringify(val)); }
function removeSS(key) { sessionStorage.removeItem(key); }

/* ---------- Утилиты ---------- */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowISO() { return new Date().toISOString(); }
function fmtMoney(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
}
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function initials(fio) {
  return String(fio || '')
    .trim().split(/\s+/).slice(0, 2)
    .map(w => w.charAt(0).toUpperCase()).join('') || '?';
}
function randomDigits(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

/* ---------- Хеширование паролей / PIN ----------
   Внимание: это учебная реализация. Используется SHA-256 от "соль+значение".
   Для продакшена нужен серверный bcrypt/argon2. */
async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashSecret(secret, salt) {
  return await sha256Hex(salt + '::' + secret);
}
async function makeHash(secret) {
  const salt = uid() + uid();
  return { salt, hash: await hashSecret(secret, salt) };
}
async function verifyHash(secret, salt, hash) {
  return (await hashSecret(secret, salt)) === hash;
}

/* ---------- Валидация ---------- */
function isEmailGmail(email) {
  return /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(String(email || '').trim());
}
function isPin5(pin) {
  return /^\d{5}$/.test(String(pin || ''));
}

/* ---------- Конфиг ---------- */
function getConfig() {
  return readLS(LS.config, {});
}
function saveConfig(cfg) { writeLS(LS.config, cfg); }

/* ---------- Пользователи ---------- */
function getUsers() { return readLS(LS.users, []); }
function saveUsers(u) { writeLS(LS.users, u); }
function getUserById(id) { return getUsers().find(u => u.id === id) || null; }
function getUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return getUsers().find(u => u.email.toLowerCase() === e) || null;
}

/* Статусы пользователя:
   'admin'      — администратор (первый зарегистрированный)
   'active'     — одобрен
   'pending'    — заявка на рассмотрении
   'rejected'   — отклонён
*/
function isApproved(u) {
  return u && (u.role === 'admin' || u.status === 'active');
}

/* ---------- Операции ---------- */
function getOperations() { return readLS(LS.operations, []); }
function saveOperations(o) { writeLS(LS.operations, o); }
function addOperation(op) {
  const ops = getOperations();
  ops.push({
    id: uid(),
    ts: nowISO(),
    ...op
  });
  saveOperations(ops);
}

/* ---------- Займы ---------- */
function getLoans() { return readLS(LS.loans, []); }
function saveLoans(l) { writeLS(LS.loans, l); }
function getActiveLoan(userId) {
  return getLoans().find(l => l.userId === userId && l.status === 'active') || null;
}

/* ---------- Карты ---------- */
function getCards() { return readLS(LS.cards, []); }
function saveCards(c) { writeLS(LS.cards, c); }
function getUserCard(userId) { return getCards().find(c => c.userId === userId) || null; }

/* ---------- Заявки (смена email и т.п.) ---------- */
function getRequests() { return readLS(LS.requests, []); }
function saveRequests(r) { writeLS(LS.requests, r); }
function addRequest(req) {
  const r = getRequests();
  r.push({ id: uid(), ts: nowISO(), status: 'pending', ...req });
  saveRequests(r);
}

/* ---------- Балансы ---------- */
/* Общая казна: сумма всех вкладов во вклады общей кассы минус выданные займы
   (заём берётся из казны, возвращается в казну с процентом). */
function getTreasuryBalance() {
  const ops = getOperations();
  let bal = 0;
  for (const op of ops) {
    if (op.type === 'contribute') bal += op.amount;          // взнос в казну
    else if (op.type === 'loan_out') bal -= op.amount;       // выдача займа
    else if (op.type === 'loan_return') bal += op.amount;    // возврат займа
    else if (op.type === 'personal_to_treasury') bal += op.amount; // перевод с личного
  }
  return Math.max(0, bal);
}

/* Вклады пользователя в казну (сумма взносов + переводов с личного) */
function getUserContributed(userId) {
  const ops = getOperations().filter(o => o.userId === userId);
  let sum = 0;
  for (const op of ops) {
    if (op.type === 'contribute' || op.type === 'personal_to_treasury') sum += op.amount;
  }
  return sum;
}

/* Личный счёт пользователя */
function getPersonalBalance(userId) {
  const ops = getOperations().filter(o => o.userId === userId);
  let bal = 0;
  for (const op of ops) {
    if (op.type === 'personal_deposit') bal += op.amount;
    else if (op.type === 'personal_withdraw') bal -= op.amount;
    else if (op.type === 'personal_to_treasury') bal -= op.amount;
  }
  return Math.max(0, bal);
}

/* ---------- Сессия ---------- */
function getSession() {
  const s = readSS(SS.session);
  if (!s || !s.userId) return null;
  const user = getUserById(s.userId);
  if (!user || !isApproved(user)) return null;
  return { ...s, user };
}
function setSession(userId) {
  writeSS(SS.session, { userId, loginAt: nowISO() });
  // запомним последнего пользователя устройства для PIN-входа
  localStorage.setItem(LS.remembered, JSON.stringify({ userId }));
}
function clearSession() {
  removeSS(SS.session);
}
function logout(reason) {
  clearSession();
  const url = 'login.html' + (reason ? '?reason=' + encodeURIComponent(reason) : '');
  window.location.href = url;
}

/* ---------- Таймер бездействия (5 минут) ---------- */
let _idleTimer = null;
function startIdleTimer() {
  if (!getSession()) return;
  resetIdleTimer();
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(ev => {
    document.addEventListener(ev, resetIdleTimer, { passive: true });
  });
}
function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    if (getSession()) {
      clearSession();
      window.location.href = 'login.html?reason=idle';
    }
  }, IDLE_LIMIT_MS);
}

/* ---------- Требуем вход на защищённых страницах ---------- */
function requireAuth() {
  const sess = getSession();
  if (!sess) {
    window.location.href = 'login.html';
    return null;
  }
  return sess;
}

/* ---------- Уведомления ---------- */
function ensureToastWrap() {
  let w = document.querySelector('.toast-wrap');
  if (!w) {
    w = document.createElement('div');
    w.className = 'toast-wrap';
    document.body.appendChild(w);
  }
  return w;
}
function toast(msg, type) {
  const w = ensureToastWrap();
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  w.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

/* ---------- Модальные окна ---------- */
function openModal(id) {
  const ov = document.getElementById(id);
  if (!ov) return;
  ov.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  const ov = document.getElementById(id);
  if (!ov) return;
  ov.classList.remove('open');
  document.body.style.overflow = '';
}
// Закрытие по клику на фон и по Esc
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
    document.body.style.overflow = '';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(ov => {
      ov.classList.remove('open');
      document.body.style.overflow = '';
    });
  }
});

/* ---------- Меню-«бутерброд» ---------- */
function initDrawer(activePage) {
  // разметка вставляется в шапку страницы
  const burger = document.querySelector('.burger');
  const drawer = document.querySelector('.drawer');
  const overlay = document.querySelector('.drawer-overlay');
  if (!burger || !drawer || !overlay) return;

  function openDrawer() {
    drawer.classList.add('open');
    overlay.classList.add('open');
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
  }
  burger.addEventListener('click', openDrawer);
  overlay.addEventListener('click', closeDrawer);

  // подсветка активного пункта
  drawer.querySelectorAll('nav a[data-page]').forEach(a => {
    if (a.dataset.page === activePage) a.classList.add('active');
  });

  // выход
  const logoutBtn = drawer.querySelector('[data-logout]');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
  }
}

/* ---------- QR-код (через qrcode.js с CDN) ---------- */
function renderQRCode(container, text, size) {
  if (!container) return;
  container.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    container.innerHTML = '<div style="font-size:11px;color:#7f8c8d;padding:6px;text-align:center">QR недоступен</div>';
    return;
  }
  try {
    const div = document.createElement('div');
    container.appendChild(div);
    new QRCode(div, {
      text: text,
      width: size || 140,
      height: size || 140,
      colorDark: '#2c3e50',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (e) {
    container.innerHTML = '<div style="font-size:11px;color:#7f8c8d;padding:6px;text-align:center">Ошибка QR</div>';
  }
}

/* ---------- Генерация номера и CVV карты ---------- */
function generateCardNumber() {
  // 10 цифр, без ведущего нуля
  return String(1 + Math.floor(Math.random() * 9)) + randomDigits(9);
}
function generateCardCode() {
  return randomDigits(3);
}

/* ---------- Обрезка аватарки под круг и сохранение как data URL ---------- */
function cropAvatarToCircle(file, size, cb) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // вычисляем квадрат по центру
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      // круглый клип
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      cb(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ---------- Автозапуск ---------- */
document.addEventListener('DOMContentLoaded', () => {
  // Инициализируем конфиг, если нет
  const cfg = getConfig();
  if (!cfg.loanPercent) {
    saveConfig({ loanPercent: LOAN_PERCENT, loanTermDays: LOAN_TERM_DAYS });
  }
});