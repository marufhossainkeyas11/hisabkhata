import { metaGet, metaSet, outboxAll, outboxRemove, outboxPut, onEvent } from './db.js';
import { api, runSync, AuthError } from './sync.js';
import { $, h, mount, toast, sheet } from './ui.js';
import { homeView, timelineView, productsView, moreMenu, openEntryMenu } from './screens.js';

const state = {
  user: null, view: 'home', online: navigator.onLine,
  busy: false, error: null, pending: 0, failed: 0, lastSync: null
};
let appMounted = false;
let started = false;

const VIEWS = [
  ['home', 'হোম', '🏠'], ['timeline', 'টাইমলাইন', '🕒'], ['add', 'নতুন', '＋'],
  ['products', 'পণ্য', '🏷️'], ['more', 'আরও', '☰']
];

// ---------- helpers ----------
function errText(e) {
  if (e instanceof TypeError) return 'ইন্টারনেট সংযোগ নেই বা সার্ভারে পৌঁছানো যাচ্ছে না';
  const m = String((e && e.message) || e);
  if (/Invalid credentials/i.test(m)) return 'ইউজারনেম বা পাসওয়ার্ড ভুল';
  if (/Too many attempts/i.test(m)) return 'অনেকবার ভুল হয়েছে — কিছুক্ষণ পরে আবার চেষ্টা করুন';
  if (/Current password/i.test(m)) return 'বর্তমান পাসওয়ার্ড মিলছে না';
  if (/SETUP_KEY/i.test(m)) return 'সেটআপ কী ভুল';
  return m;
}

let syncTimer;
function triggerSync(delay = 800) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (state.user && $('#auth').hidden) runSync();
  }, delay);
}

function registerBgSync() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => reg.sync && reg.sync.register('hk-sync')).catch(() => {});
}

// ---------- sync status chip ----------
function chipInfo() {
  if (!state.online) return ['offline', `অফলাইন${state.pending ? ` · ${state.pending}` : ''}`];
  if (state.busy) return ['busy', 'সিঙ্ক হচ্ছে…'];
  if (state.error || state.failed) return ['error', 'সিঙ্ক ত্রুটি'];
  if (state.pending) return ['pending', `পেন্ডিং (${state.pending})`];
  return ['ok', 'সিঙ্কড'];
}

function renderChip() {
  const el = $('#chip');
  if (!el) return;
  const [cls, text] = chipInfo();
  el.className = `chip ${cls}`;
  el.textContent = text;
}

async function refreshStats() {
  const ops = await outboxAll();
  state.pending = ops.filter((o) => !o.failed).length;
  state.failed = ops.length - state.pending;
  state.lastSync = await metaGet('lastSync');
  renderChip();
}

function handleEvent(e) {
  switch (e.type) {
    case 'sync-start': state.busy = true; renderChip(); break;
    case 'sync-done': state.busy = false; state.error = null; refreshStats(); renderView(); break;
    case 'sync-fail':
      state.busy = false;
      state.error = e.reason === 'network' ? 'নেটওয়ার্ক সমস্যা — আবার চেষ্টা হবে' : e.message;
      if (e.reason === 'auth' && $('#auth').hidden) showAuth('login');
      refreshStats();
      break;
    case 'data-changed': case 'outbox-changed': refreshStats(); renderView(); break;
    case 'local-change': refreshStats(); renderView(); triggerSync(); registerBgSync(); break;
  }
}

// ---------- sync sheet (status + pending queue viewer) ----------
let syncSheet = null;

async function openSyncSheet() {
  if (syncSheet) syncSheet.close();
  const ops = await outboxAll();
  const [cls, text] = chipInfo();
  const label = { INSERT: 'নতুন', UPDATE: 'এডিট', DELETE: 'মোছা' };

  const rows = ops.map((o) => h('div', { class: 'item col' },
    h('div', { class: 'row-between' },
      h('b', {}, `${label[o.opType] || o.opType} · ${o.table}`),
      h('span', { class: 'muted' }, new Date(o.ts).toLocaleString('bn-BD'))),
    o.failed && h('p', { class: 'err' }, `ব্যর্থ: ${o.failed.error}`),
    o.failed && h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: async () => {
        const { failed, ...rest } = o;
        await outboxPut([rest]); await refreshStats(); openSyncSheet(); triggerSync(0);
      } }, 'আবার চেষ্টা'),
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm('এই এন্ট্রি কিউ থেকে বাদ দেবেন? সার্ভারে যাবে না।')) return;
        await outboxRemove([o.seq]); await refreshStats(); openSyncSheet();
      } }, 'বাদ দিন'))
  ));

  syncSheet = sheet('সিঙ্ক অবস্থা', h('div', {},
    h('p', {}, h('span', { class: `chip ${cls}` }, text), ' ',
      h('span', { class: 'muted' }, state.lastSync ? `শেষ সিঙ্ক: ${new Date(state.lastSync).toLocaleString('bn-BD')}` : 'এখনো সিঙ্ক হয়নি')),
    state.error && h('p', { class: 'err' }, state.error),
    h('button', { class: 'btn full', onclick: async () => {
      const r = await runSync();
      if (!r.ok && r.reason === 'offline') toast('অফলাইন — ইন্টারনেট এলে নিজে থেকেই সিঙ্ক হবে');
      openSyncSheet();
    } }, 'এখনই সিঙ্ক করুন'),
    h('h4', {}, `কিউ (${ops.length})`),
    ...(rows.length ? rows : [h('p', { class: 'muted' }, 'কিউ খালি — সব সিঙ্কড।')])
  ));
}

// ---------- views ----------
function moreView() {
  const msg = h('p', { class: 'muted', role: 'status' });
  const pw = (ph, ac) => h('input', { type: 'password', placeholder: ph, autocomplete: ac, required: true, minlength: 8 });
  const oldP = pw('বর্তমান পাসওয়ার্ড', 'current-password');
  const newP = pw('নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)', 'new-password');
  const conf = pw('নতুন পাসওয়ার্ড আবার', 'new-password');

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = '';
    if (newP.value !== conf.value) { msg.textContent = 'নতুন পাসওয়ার্ড দুইবার মিলছে না'; return; }
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { oldPassword: oldP.value, newPassword: newP.value } });
      oldP.value = newP.value = conf.value = '';
      msg.textContent = 'পাসওয়ার্ড বদলানো হয়েছে। অন্য ডিভাইস লগআউট হয়েছে।';
    } catch (ex) {
      if (ex instanceof AuthError) showAuth('login');
      msg.textContent = errText(ex);
    }
  } },
    h('h3', {}, 'পাসওয়ার্ড পরিবর্তন'),
    h('label', {}, 'বর্তমান', oldP), h('label', {}, 'নতুন', newP), h('label', {}, 'নিশ্চিত', conf),
    h('button', { class: 'btn full', type: 'submit' }, 'পরিবর্তন করুন'), msg);

  return h('section', {},
    moreMenu(),
    h('div', { class: 'card' }, form),
    h('div', { class: 'card' },
      h('h3', {}, 'নিরাপত্তা'),
      h('button', { class: 'btn full', type: 'button', onclick: async () => {
        if (!confirm('এই ডিভাইস বাদে সব ডিভাইস লগআউট হবে। চালিয়ে যাবেন?')) return;
        try { await api('/api/auth/revoke-other-sessions', { method: 'POST' }); toast('অন্য সব ডিভাইস লগআউট হয়েছে'); }
        catch (ex) { toast(errText(ex)); }
      } }, 'অন্য ডিভাইস থেকে লগআউট')),
    h('div', { class: 'card' },
      h('button', { class: 'btn full danger', type: 'button', onclick: logout }, 'লগআউট')));
}

const views = {
  home: homeView,
  timeline: timelineView,
  products: productsView,
  more: moreView
};

async function renderView() {
  const view = $('#view');
  if (!view) return;
  const a = document.activeElement;
  if (a && view.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return; // don't wipe a form while typing
  const v = state.view;
  try {
    const node = await views[v]();
    if (state.view === v) view.replaceChildren(node);
  } catch (e) {
    view.replaceChildren(h('div', { class: 'card warn' }, h('h3', {}, 'স্ক্রিন লোড হয়নি'), h('p', { class: 'err' }, String((e && e.message) || e))));
  }
}

function go(v) {
  if (v === 'add') { openEntryMenu(); return; }
  state.view = v;
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  renderView();
}

function buildShell() {
  mount($('#app'),
    h('header', { class: 'top' },
      h('img', { src: '/icons/icon.svg', alt: '', width: 28, height: 28 }),
      h('b', {}, 'হিসাবখাতা'),
      h('button', { id: 'chip', class: 'chip', type: 'button', onclick: openSyncSheet })),
    h('main', { id: 'view' }),
    h('nav', { class: 'nav' }, VIEWS.map(([id, label, icon]) =>
      h('button', { type: 'button', 'data-v': id, class: id === 'add' ? 'add-btn' : '', onclick: () => go(id) },
        h('span', { class: 'ico' }, icon), h('span', {}, label)))));
}

// ---------- auth screens ----------
function showAuth(mode) {
  const a = $('#auth');
  mount(a, authScreen(mode));
  a.hidden = false;
  $('#splash').hidden = true;
}

function authScreen(mode) {
  const isSetup = mode === 'setup';
  const err = h('p', { class: 'err', role: 'alert' });
  const field = (label, attrs) => h('label', {}, label, h('input', attrs));
  const btn = h('button', { class: 'btn full', type: 'submit' }, isSetup ? 'সেটআপ সম্পন্ন করুন' : 'লগইন');

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = ''; btn.disabled = true;
    try {
      const f = new FormData(form);
      if (isSetup) {
        if (f.get('password') !== f.get('confirm')) throw new Error('পাসওয়ার্ড দুইবার মিলছে না');
        await api('/api/auth/setup', { method: 'POST', body: { setupKey: f.get('setupKey'), username: f.get('username'), password: f.get('password') } });
      }
      const res = await api('/api/auth/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      await onLoggedIn(res.user);
    } catch (ex) {
      err.textContent = errText(ex);
    } finally { btn.disabled = false; }
  } },
    isSetup && field('সেটআপ কী (SETUP_KEY)', { type: 'password', name: 'setupKey', required: true, autocomplete: 'off' }),
    field('ইউজারনেম', { type: 'text', name: 'username', required: true, minlength: 3, autocomplete: 'username', autocapitalize: 'none', value: state.user ? state.user.username : '' }),
    field('পাসওয়ার্ড', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: isSetup ? 'new-password' : 'current-password' }),
    isSetup && field('পাসওয়ার্ড আবার', { type: 'password', name: 'confirm', required: true, minlength: 8, autocomplete: 'new-password' }),
    err, btn);

  return h('div', { class: 'card auth-card' },
    h('img', { class: 'logo', src: '/icons/icon.svg', alt: '' }),
    h('h1', {}, isSetup ? 'প্রথম সেটআপ' : 'হিসাবখাতা'),
    form);
}

function showOfflineFirstRun() {
  const a = $('#auth');
  mount(a, h('div', { class: 'card auth-card' },
    h('img', { class: 'logo', src: '/icons/icon.svg', alt: '' }),
    h('h1', {}, 'ইন্টারনেট দরকার'),
    h('p', { class: 'muted' }, 'প্রথমবার লগইনের জন্য ইন্টারনেট লাগবে। এরপর অফলাইনেও চলবে।'),
    h('button', { class: 'btn full', onclick: () => location.reload() }, 'আবার চেষ্টা করুন')));
  a.hidden = false;
  $('#splash').hidden = true;
}

async function onLoggedIn(user) {
  state.user = user;
  await metaSet('user', user);
  openApp();
  triggerSync(0);
}

async function logout() {
  if (state.pending && !confirm(`${state.pending}টি এন্ট্রি এখনো সিঙ্ক হয়নি। আবার লগইন না করা পর্যন্ত সিঙ্ক হবে না (ডেটা ডিভাইসে থাকবে)। চালিয়ে যাবেন?`)) return;
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    if (!(e instanceof AuthError)) { toast('অফলাইনে লগআউট করা যাচ্ছে না'); return; }
  }
  await metaSet('user', null);
  state.user = null;
  showAuth('login');
}

// ---------- app lifecycle ----------
function startTriggers() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => { state.online = true; renderChip(); triggerSync(0); });
  window.addEventListener('offline', () => { state.online = false; renderChip(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    triggerSync(0);
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  });
  setInterval(() => triggerSync(0), 60000);
}

function openApp() {
  $('#splash').hidden = true;
  $('#auth').hidden = true;
  if (!appMounted) { buildShell(); appMounted = true; startTriggers(); }
  $('#app').hidden = false;
  go(state.view);
  refreshStats();
}

// ---------- service worker + update prompt ----------
function showUpdateBar(worker) {
  if ($('#upd')) return;
  document.body.prepend(h('div', { id: 'upd', class: 'update' },
    'নতুন ভার্সন পাওয়া গেছে',
    h('button', { class: 'btn small', onclick: () => worker.postMessage({ type: 'SKIP_WAITING' }) }, 'আপডেট')));
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { type: 'module' });
    if (reg.waiting && hadController) showUpdateBar(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(w);
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
  } catch (e) { /* app still works online without SW */ }
}

async function boot() {
  registerSW();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  onEvent(handleEvent);
  state.user = await metaGet('user'); // cached user => can start offline
  try {
    const me = await api('/api/auth/me');
    await onLoggedIn(me.user);
  } catch (e) {
    if (e instanceof AuthError) {
      let initialized = true;
      try { initialized = (await api('/api/auth/setup-status')).initialized; } catch {}
      showAuth(initialized ? 'login' : 'setup');
    } else if (state.user) {
      openApp(); // offline / server unreachable: work from local data
    } else {
      showOfflineFirstRun();
    }
  }
}

boot();
