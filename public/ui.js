// ছোট UI টুলকিট — innerHTML কোথাও নেই, তাই ডেটা থেকে মার্কআপ ঢোকানো সম্ভব না (CSP-বান্ধব)।
export const $ = (s, r = document) => r.querySelector(s);

export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};
export const mount = (root, ...nodes) => root.replaceChildren(...nodes);

// ---- সংখ্যা ও তারিখ (বাংলা/English ডিজিট) ----
let digits = 'bn';
try { digits = localStorage.getItem('hk-digits') || 'bn'; } catch { /* প্রাইভেট মোডে ঠিক আছে */ }
export const getDigits = () => digits;
export const setDigits = (d) => { digits = d; try { localStorage.setItem('hk-digits', d); } catch { /* ignore */ } };
const locale = () => (digits === 'bn' ? 'bn-BD' : 'en-IN');
export const fmt = (n) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(Number(n) || 0);
export const money = (n) => (n < -0.004 ? '−' : '') + '৳' + fmt(Math.abs(n));
export const signed = (n) => (n > 0.004 ? '+' : '') + money(n);
export const pct = (x) => (x < 0 ? '−' : '') + fmt(Math.abs(Math.round(x * 1000) / 10)) + '%';

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => ymd(new Date());
export const dateLabel = (s) => {
  if (!s || s < '0001') return 'শুরুতে';
  return new Date(s + 'T00:00:00').toLocaleDateString(locale() === 'bn-BD' ? 'bn-BD' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};
export const monthLabel = (m) => new Date(m + '-01T00:00:00').toLocaleDateString(locale() === 'bn-BD' ? 'bn-BD' : 'en-GB', { month: 'long', year: 'numeric' });

export function periodRange(key) {
  const now = new Date(), t = todayStr();
  if (key === 'today') return [t, t];
  if (key === 'week') { const d = new Date(now); d.setDate(d.getDate() - ((d.getDay() + 1) % 7)); return [ymd(d), t]; } // শনিবার থেকে
  if (key === 'month') return [t.slice(0, 8) + '01', t.slice(0, 7) + '-31'];
  if (key === 'last') { const m = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7); return [m + '-01', m + '-31']; }
  return ['', '9999-12-31'];
}

// ---- টোস্ট (চাইলে "ফিরিয়ে আনুন" বাটনসহ) ----
let toastTimer;
export function toast(msg, action) {
  const t = $('#toast');
  if (!t) return;
  t.replaceChildren(msg, ...(action ? [h('button', { class: 'link toast-act', type: 'button', onclick: () => { t.hidden = true; action.fn(); } }, action.label)] : []));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3000);
}

// ---- নিচ থেকে ওঠা শীট ----
export function sheet(title, body) {
  const bg = h('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) close(); } });
  const close = () => bg.remove();
  bg.append(h('div', { class: 'sheet' },
    h('div', { class: 'row-between' }, h('h3', {}, title), h('button', { class: 'link', type: 'button', onclick: close }, 'বন্ধ')),
    body));
  document.body.append(bg);
  return { close, el: bg };
}

// ---- ফর্মের উপাদান ----
export const field = (label, input, hint) => h('label', {}, label, input, hint && h('small', { class: 'hint' }, hint));
export const textIn = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', maxlength: 80, autocomplete: 'off', ...attrs });
export const numIn = (value, attrs = {}) => h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: value ?? '', ...attrs });
export const dateIn = (value) => h('input', { type: 'date', value: value || todayStr(), required: true });
export function selectIn(opts, value) {
  const s = h('select', {}, opts.map(([v, l]) => h('option', { value: v }, l)));
  if (value != null) s.value = value;
  return s;
}
export function chips(options, value, onChange) {
  let cur = value;
  const box = h('div', { class: 'seg' });
  const paint = () => box.replaceChildren(...options.map(([v, l]) => h('button', { type: 'button', class: v === cur ? 'on' : '', onclick: () => { cur = v; paint(); if (onChange) onChange(v); } }, l)));
  paint();
  box.get = () => cur;
  return box;
}

// ---- ছোট ব্লক ----
export const kv = (label, value, cls = '') => h('div', { class: 'pl-row ' + cls }, h('span', {}, label), h('span', { class: 'v' }, value));
export const colored = (n, text) => h('span', { class: n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : '' }, text ?? signed(n));
export const download = (name, text, type = 'text/plain') => {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
export const ICON = { sale: '🛒', purchase: '📦', expense: '💸', capital: '💰', transfer: '🔁', receipt: '✅', payment: '🤝', return: '↩️', adjust: '⚖️', opening: '🏁' };
