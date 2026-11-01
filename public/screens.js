// স্ক্রিন: ড্যাশবোর্ড, টাইমলাইন, পণ্যের খাতা, কাস্টমার/সাপ্লায়ার, রিপোর্ট
import { getAll, TABLES, emit } from './db.js';
import {
  load, deleteDoc, openEntryMenu, openSaleForm, openPurchaseForm, openExpenseForm, openCapitalForm, openTransferForm,
  openDueForm, openReturnForm, openAdjustForm, openVariantForm, openAccountForm, openPartyForm
} from './forms.js';
import { snapshot, summarize, monthly, cashLabel, timelineCsv, STATUS_LABEL } from './ledger.js';
import { h, sheet, toast, chips, money, signed, fmt, pct, kv, colored, download, dateLabel, monthLabel, periodRange, getDigits, setDigits, todayStr, ICON } from './ui.js';

export { openEntryMenu };
const PERIODS = [['today', 'আজ'], ['week', 'এই সপ্তাহ'], ['month', 'এই মাস'], ['last', 'গত মাস'], ['all', 'সব']];
let period = 'month';
const tl = { filter: 'all', q: '', limit: 60 };
let pq = '';

const tbl = (head, rows, cls = '') => h('table', { class: 'tbl ' + cls },
  h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))),
  h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))));
const tile = (label, value, sub, cls = '') => h('div', { class: 'tile ' + cls }, h('div', { class: 'muted' }, label), h('div', { class: 'tv' }, value), sub && h('div', { class: 'muted' }, sub));

// =====================================================================
// 🏠 ড্যাশবোর্ড
// =====================================================================
export async function homeView() {
  const L = await load(), S = snapshot(L), all = summarize(L);
  const [from, to] = periodRange(period), P = summarize(L, from, to);
  const pending = [...L.saleInfo.values()].filter((s) => s.status === 'pending');
  const alerts = [...L.books.values()].filter((b) => b.low || b.negative);
  const dues = [...L.parties.values()].filter((p) => p.type === 'customer' && p.balance > 0.005).sort((a, b) => b.balance - a.balance).slice(0, 5);
  const balanced = Math.abs(L.audit.diff) <= 0.01 && Math.abs(L.audit.invDiff) <= 0.5;
  const out = [];

  if (!L.entries.length) {
    out.push(h('div', { class: 'card' }, h('h3', {}, 'শুরু করুন'),
      h('p', {}, '১. ', h('b', {}, 'আরও → অ্যাকাউন্ট'), ' থেকে ক্যাশ/বিকাশে শুরুতে কত ছিল লিখুন, অথবা নিচের ＋ চেপে ', h('b', {}, 'পুঁজি জমা'), ' দিন।'),
      h('p', {}, '২. ＋ → ', h('b', {}, 'মাল কিনলাম'), ' (রং-সাইজসহ) → ৩. ＋ → ', h('b', {}, 'বিক্রি'), '।'),
      h('p', { class: 'muted' }, 'ডেবিট-ক্রেডিট আপনাকে ভাবতে হবে না — অ্যাপ নিজেই হিসাব রাখবে।')));
  }

  out.push(h('div', { class: 'card hero' },
    h('div', { class: 'hero-l' }, 'এখন হাতে মোট টাকা'), h('div', { class: 'big' }, money(S.cash)),
    h('div', { class: 'pills' }, S.accts.filter((a) => a.active).map((a) => h('span', { class: 'pill' }, `${a.name} ${money(a.balance)}`)))));

  out.push(h('div', { class: 'tiles' },
    tile('মোট পুঁজি', money(S.capital)), tile('মোট ব্যয় (কেনা + খরচ)', money(all.spent)),
    tile('মোট বিক্রি', money(all.revenue), `${fmt(all.salesCount)}টি অর্ডার`), tile('নিট লাভ (শুরু থেকে)', colored(all.net, money(all.net)), null, all.net >= 0 ? 'good' : 'bad'),
    tile('মজুত মালের মূল্য', money(S.inventory), 'কেনা দামে'), tile('বাকির খাতা', `পাওনা ${money(S.receivable)}`, `দেনা ${money(S.payable)}`)));

  const pc = chips(PERIODS, period, (v) => { period = v; emit({ type: 'data-changed' }); });
  const opexRows = Object.entries(P.opex).filter(([, v]) => Math.abs(v) > 0.004).sort((a, b) => b[1] - a[1]);
  const maxOpex = Math.max(1, ...opexRows.map(([, v]) => v));
  out.push(h('div', { class: 'card' }, h('div', { class: 'row-between' }, h('h3', {}, 'লাভ-ক্ষতি')), pc,
    kv('বিক্রি (ডিসকাউন্ট-ফেরত বাদে)', money(P.revenue)), kv('− বিক্রিত মালের দাম', money(P.cogs)),
    kv('= মোট লাভ', colored(P.gross, money(P.gross)), 'total'),
    kv('ডেলিভারি চার্জ আয়', money(P.delivery)), kv('− কুরিয়ারকে দিয়েছি', money(P.courier)), kv('= ডেলিভারিতে লাভ/লস', colored(P.deliveryNet, money(P.deliveryNet))),
    kv('− ক্যাশআউট/গেটওয়ে/ট্রান্সফার ফি', money(P.fee)), P.loss ? kv('− নষ্ট/কম মাল', money(P.loss)) : null,
    kv('− অন্যান্য খরচ', money(P.opexTotal)),
    ...opexRows.map(([k, v]) => h('div', { class: 'bar-row' }, h('span', {}, k), h('span', { class: 'bar-track' }, h('i', { style: `width:${Math.round((v / maxOpex) * 100)}%` })), h('span', { class: 'v' }, money(v)))),
    kv('= নিট লাভ', colored(P.net, money(P.net)), 'total grand'),
    P.revenue > 0 ? h('p', { class: 'muted' }, `নিট মার্জিন ${pct(P.margin)} · ${fmt(P.salesCount)}টি বিক্রি`) : null));

  const flows = Object.entries(P.cash.flow).filter(([, v]) => Math.abs(v) > 0.004).sort((a, b) => b[1] - a[1]);
  out.push(h('div', { class: 'card' }, h('h3', {}, 'টাকার গল্প (ক্যাশ কোথা থেকে এলো, কোথায় গেল)'),
    kv(period === 'all' ? 'শুরুতে' : 'সময়ের শুরুতে হাতে ছিল', money(P.cash.open)),
    ...flows.map(([k, v]) => kv(cashLabel(k), colored(v, signed(v)))),
    kv('= সময়ের শেষে হাতে', money(P.cash.close), 'total')));

  out.push(h('div', { class: 'card ' + (balanced ? '' : 'warn') },
    h('h3', {}, balanced ? '✓ হিসাব মিলেছে' : '⚠️ হিসাবে গরমিল আছে'),
    kv('মূলধন', money(S.capital)), kv('+ নিট লাভ', colored(S.netProfitAll, signed(S.netProfitAll))), kv('= ব্যবসার মোট মালিকানা', money(S.capital + S.netProfitAll), 'total'),
    kv('ক্যাশ/ব্যাংক', money(S.cash)), kv('+ মজুত মাল', money(S.inventory)), kv('+ কাস্টমারের পাওনা', money(S.receivable)), kv('− সাপ্লায়ারের দেনা ও অগ্রিম', money(S.payable + S.advance)),
    kv('= সম্পদ − দেনা', money(S.equity), 'total'),
    ...L.audit.problems.map((p) => h('p', { class: 'err' }, '⚠️ ' + p))));

  if (pending.length) out.push(h('div', { class: 'card' }, h('h3', {}, `পথে থাকা অর্ডার (${fmt(pending.length)})`),
    ...pending.slice(0, 5).map((s) => h('button', { class: 'item btn-row', type: 'button', onclick: () => openSaleForm(s.id) }, h('span', {}, `${s.customer || 'সরাসরি'} — ${s.items.map((i) => i.label).join(', ')}`), h('span', { class: 'muted' }, money(s.net))))));
  if (dues.length) out.push(h('div', { class: 'card' }, h('h3', {}, 'কাস্টমারের কাছে পাওনা'),
    ...dues.map((p) => h('div', { class: 'item' }, h('span', {}, p.name), h('b', {}, money(p.balance)), h('button', { class: 'btn small', type: 'button', onclick: () => openDueForm({ type: 'customer_receipt', partyId: p.id }) }, 'আদায়')))));
  if (alerts.length) out.push(h('div', { class: 'card' }, h('h3', {}, 'স্টক সতর্কতা'),
    ...alerts.map((b) => h('button', { class: 'item btn-row', type: 'button', onclick: () => openProductBook(b.variant.id) }, h('span', {}, b.label), h('b', { class: b.negative ? 'neg' : '' }, b.negative ? `মাইনাস ${fmt(b.onHand)}` : `মাত্র ${fmt(b.onHand)} আছে`)))));
  return h('section', {}, out);
}

// =====================================================================
// 🕒 টাইমলাইন — সব লেনদেন, তারিখ ধরে, প্রতিটার পরে হাতে কত টাকা
// =====================================================================
const KIND_GROUP = { sale: ['sale', 'return'], purchase: ['purchase'], expense: ['expense'], money: ['capital', 'transfer', 'receipt', 'payment', 'opening', 'adjust'] };
export async function timelineView() {
  const L = await load();
  const list = h('div'), more = h('div');
  const draw = () => {
    let es = [...L.entries].reverse();
    if (tl.filter !== 'all') es = es.filter((e) => KIND_GROUP[tl.filter].includes(e.kind));
    const q = tl.q.trim().toLowerCase();
    if (q) es = es.filter((e) => (e.title + ' ' + e.sub).toLowerCase().includes(q));
    const shown = es.slice(0, tl.limit), groups = [];
    for (const e of shown) { const g = groups[groups.length - 1]; if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] }); }
    list.replaceChildren(...(groups.length ? groups.map((g) => {
      const inn = g.items.reduce((a, e) => a + Math.max(e.cashDelta, 0), 0), outt = g.items.reduce((a, e) => a + Math.min(e.cashDelta, 0), 0);
      return h('div', { class: 'day' },
        h('div', { class: 'day-head' }, h('b', {}, dateLabel(g.date)), h('span', { class: 'muted' }, `ঢুকেছে ${money(inn)} · বেরিয়েছে ${money(-outt)} · হাতে ${money(g.items[0].cashAfter)}`)),
        ...g.items.map((e) => h('button', { class: 'tl-row' + (e.void ? ' void' : ''), type: 'button', onclick: () => openDetail(e, L) },
          h('span', { class: 'tl-ico' }, ICON[e.kind] || '•'),
          h('span', { class: 'tl-main' }, h('b', {}, e.title), h('small', {}, e.sub || ' ')),
          h('span', { class: 'tl-amt' },
            Math.abs(e.cashDelta) > 0.004 ? colored(e.cashDelta, signed(e.cashDelta)) : h('span', { class: 'muted' }, '—'),
            e.profit != null ? h('small', { class: e.profit >= 0 ? 'pos' : 'neg' }, `লাভ ${signed(e.profit)}`) : null,
            e.meta && e.meta.due > 0.004 ? h('small', { class: 'warnc' }, `বাকি ${money(e.meta.due)}`) : null))));
    }) : [h('p', { class: 'muted pad' }, 'কিছু পাওয়া যায়নি। নিচের ＋ চেপে প্রথম এন্ট্রি দিন।')]));
    more.replaceChildren(es.length > tl.limit ? h('button', { class: 'btn full', type: 'button', onclick: () => { tl.limit += 60; draw(); } }, `আরও দেখুন (${fmt(es.length - tl.limit)}টি বাকি)`) : '');
  };
  const search = h('input', { type: 'search', placeholder: 'খুঁজুন: নাম, পণ্য, নোট…', value: tl.q });
  search.addEventListener('input', () => { tl.q = search.value; tl.limit = 60; draw(); });
  const fc = chips([['all', 'সব'], ['sale', 'বিক্রি'], ['purchase', 'ক্রয়'], ['expense', 'খরচ'], ['money', 'টাকা']], tl.filter, (v) => { tl.filter = v; tl.limit = 60; draw(); });
  draw();
  return h('section', {}, h('div', { class: 'card' }, search, fc), list, more);
}

// ---- লেনদেনের বিস্তারিত + "হিসাবের ভাষায়" ডেবিট/ক্রেডিট ----
const EDIT = {
  sales: (id) => openSaleForm(id), purchases: (id) => openPurchaseForm(id), expenses: (id) => openExpenseForm(id), capital_entries: (id) => openCapitalForm(id),
  account_transfers: (id) => openTransferForm(id), due_payments: (id) => openDueForm({}, id), accounts: (id) => openAccountForm(id),
  returns: (id, L) => openReturnForm(L.raw.returns.find((r) => r.id === id).sale_id, id),
  stock_movements: (id, L) => openAdjustForm(L.raw.stock_movements.find((r) => r.id === id).variant_id, id)
};
export function openDetail(e, L) {
  const m = e.meta, body = h('div', {});
  body.append(h('p', { class: 'muted' }, `${dateLabel(e.date)}${m && m.status ? ' · ' + STATUS_LABEL[m.status] : ''}${m && m.invoice ? ' · ' + m.invoice : ''}`));
  if (e.kind === 'sale') {
    body.append(tbl(['পণ্য', 'পরিমাণ × দাম', 'মোট'], m.items.map((i) => [i.label, `${fmt(i.qty)} × ${fmt(i.price)}`, money(i.total)])),
      kv('পণ্যের মোট', money(m.subtotal)), m.discount ? kv('− ডিসকাউন্ট', money(m.discount)) : null, m.delivery ? kv('+ ডেলিভারি চার্জ', money(m.delivery)) : null,
      kv('কাস্টমার দেবে', money(m.net), 'total'), kv('পেয়েছি', money(m.received)), m.due > 0.004 ? kv('বাকি', money(m.due)) : null,
      m.status === 'delivered' ? kv('মালের দাম (কেনা)', money(m.cogs)) : null, m.courier ? kv('কুরিয়ারকে দিয়েছি', money(m.courier)) : null, m.fee ? kv('ফি', money(m.fee)) : null,
      m.profit != null ? kv('এই বিক্রিতে লাভ', colored(m.profit, signed(m.profit)), 'total') : null);
  } else if (e.kind === 'purchase') {
    body.append(tbl(['পণ্য', 'পরিমাণ × দাম', 'খরচসহ/পিস'], m.items.map((i) => [i.label, `${fmt(i.qty)} × ${fmt(i.raw)}`, money(i.landed)])),
      kv('মালের দাম', money(m.sub)), m.extra ? kv('+ অতিরিক্ত খরচ (ভাগ হয়ে মালের দামে)', money(m.extra)) : null, kv('মোট', money(m.total), 'total'), kv('দিয়েছি', money(m.paid)), m.due ? kv('বাকি (দেনা)', money(m.due)) : null);
  } else if (e.sub) body.append(h('p', {}, e.sub));
  if (e.lines.length) body.append(h('h4', {}, 'হিসাবের ভাষায় (অ্যাপ নিজে বানিয়েছে)'), tbl(['খাত', 'ডেবিট', 'ক্রেডিট'], e.lines.map((l) => [L.labelOf(l.acc), l.dr ? money(l.dr) : '', l.cr ? money(l.cr) : '']), 'journal'));
  const s = sheet(e.title, body);
  const acts = h('div', { class: 'grid2' });
  if (EDIT[e.table]) acts.append(h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); EDIT[e.table](e.refId, L); } }, '✏️ এডিট'));
  if (e.table !== 'accounts') acts.append(h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('মুছে ফেলবেন? (পরে ফিরিয়ে আনা যাবে)')) { s.close(); await deleteDoc(e.table, e.refId); } } }, '🗑 মুছুন'));
  if (e.kind === 'sale' && m.status === 'delivered') acts.append(h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openReturnForm(e.refId); } }, '↩️ ফেরত নিন'));
  if (e.kind === 'sale' && m.due > 0.004 && m.customerId) acts.append(h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openDueForm({ type: 'customer_receipt', partyId: m.customerId }); } }, '✅ বাকি আদায়'));
  body.append(acts);
}

// =====================================================================
// 🏷️ পণ্য — প্রতিটা রং/সাইজের নিজস্ব ইন-আউট-লাভ
// =====================================================================
export async function productsView() {
  const L = await load();
  const list = h('div');
  const draw = () => {
    const q = pq.trim().toLowerCase();
    const ps = L.productList.filter((p) => !q || (p.product.name + ' ' + p.variants.map((v) => v.label).join(' ')).toLowerCase().includes(q));
    list.replaceChildren(...(ps.length ? ps.map((p) => h('div', { class: 'card' },
      h('div', { class: 'row-between' }, h('h3', {}, p.product.name), h('span', { class: 'muted' }, `স্টক ${fmt(p.onHand)} · লাভ `, colored(p.profit, money(p.profit)))),
      ...p.variants.map((b) => h('button', { class: 'item btn-row v-row', type: 'button', onclick: () => openProductBook(b.variant.id) },
        h('span', {}, [b.variant.color, b.variant.size].filter(Boolean).join(' · ') || 'সাধারণ', b.low ? h('em', { class: 'badge' }, 'কম') : null, b.negative ? h('em', { class: 'badge bad' }, 'মাইনাস') : null),
        h('span', { class: 'v-nums' }, h('b', {}, `${fmt(b.onHand)} পিস`), h('small', {}, `বিক্রি ${fmt(b.soldQty)} · লাভ ${money(b.profit)}`)))))) : [h('p', { class: 'muted pad' }, 'এখনো কোনো পণ্য নেই। "মাল কিনলাম" দিলেই পণ্য তৈরি হবে।')]));
  };
  const search = h('input', { type: 'search', placeholder: 'পণ্য খুঁজুন…', value: pq });
  search.addEventListener('input', () => { pq = search.value; draw(); });
  draw();
  return h('section', {}, h('div', { class: 'card' }, search, h('button', { class: 'btn full', type: 'button', onclick: () => openVariantForm() }, '＋ নতুন পণ্য (রং/সাইজসহ)')), list);
}

export async function openProductBook(variantId) {
  const L = await load(), b = L.books.get(variantId);
  if (!b) return;
  const body = h('div', {});
  body.append(h('div', { class: 'tiles' },
    tile('কিনেছি', `${fmt(b.boughtQty)} পিস`, money(b.boughtCost)), tile('বিক্রি (ফেরত বাদে)', `${fmt(b.soldQty)} পিস`, money(b.revenue)),
    tile('স্টকে আছে', `${fmt(b.onHand)} পিস`, b.reserved ? `পথে ${fmt(b.reserved)} · ফাঁকা ${fmt(b.available)}` : `মূল্য ${money(b.stockValue)}`),
    tile('গড় কেনা দাম', money(b.avgCost), 'খরচসহ/পিস'), tile('এই পণ্যে লাভ', colored(b.profit, money(b.profit)), b.revenue > 0 ? `মার্জিন ${pct(b.margin)}` : null, b.profit >= 0 ? 'good' : 'bad'),
    tile('ফেরত / নষ্ট', `${fmt(b.retQty)} / ${fmt(b.lossQty)}`, b.lossValue ? `নষ্টে ক্ষতি ${money(b.lossValue)}` : null)));
  body.append(h('h4', {}, 'পণ্যের খাতা (ঢুকলো / বেরোলো)'), tbl(['তারিখ', 'বিবরণ', '+/−', 'স্টক'], b.rows.map((r) => [
    dateLabel(r.date).replace(/^[^,]*,\s*/, ''), h('span', {}, r.label, r.who ? ` · ${r.who}` : '', r.unit ? h('small', { class: 'muted' }, ` (${money(r.unit)}/পিস)`) : null),
    r.reserve ? h('span', { class: 'muted' }, `রিজার্ভ ${fmt(r.reserve)}`) : colored(r.qtyIn - r.qtyOut, (r.qtyIn ? '+' + fmt(r.qtyIn) : '−' + fmt(r.qtyOut))), r.reserve ? '' : fmt(r.balQty)]), 'card-tbl'));
  const s = sheet(b.label, body);
  body.append(h('div', { class: 'grid2' },
    h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openPurchaseForm(null, { variantId }); } }, '📦 আরও কিনুন'),
    h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openSaleForm(null, { variantId }); } }, '🛒 বিক্রি করুন'),
    h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openAdjustForm(variantId); } }, '⚖️ নষ্ট / স্টক ঠিক'),
    h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openVariantForm(variantId); } }, '✏️ দাম / নাম এডিট')));
}

// =====================================================================
// ☰ আরও: অ্যাকাউন্ট, কাস্টমার, সাপ্লায়ার, রিপোর্ট, ব্যাকআপ
// =====================================================================
export function moreMenu() {
  const items = [['🏦', 'অ্যাকাউন্ট ও ব্যালেন্স', openAccounts], ['👥', 'কাস্টমার (পাওনা)', () => openParties('customer')], ['🏭', 'সাপ্লায়ার (দেনা)', () => openParties('supplier')],
    ['📊', 'মাসিক রিপোর্ট', openReports], ['💾', 'ব্যাকআপ ও ভাষা', openData], ['↩️', 'সাম্প্রতিক ফেরত', openReturnsList]];
  return h('div', { class: 'menu-grid' }, items.map(([i, l, fn]) => h('button', { class: 'menu-btn', type: 'button', onclick: fn }, h('span', { class: 'big-ico' }, i), l)));
}

async function openAccounts() {
  const L = await load(), S = snapshot(L);
  const body = h('div', {}, ...S.accts.map((a) => h('button', { class: 'item btn-row', type: 'button', onclick: () => { s.close(); openAccountForm(a.id); } }, h('span', {}, a.name, a.active ? '' : h('em', { class: 'badge' }, 'বন্ধ')), h('b', {}, money(a.balance)))),
    kv('মোট', money(S.cash), 'total'), h('button', { class: 'btn full', type: 'button', onclick: () => { s.close(); openAccountForm(); } }, '＋ নতুন অ্যাকাউন্ট'));
  const s = sheet('অ্যাকাউন্ট ও ব্যালেন্স', body);
}

async function openParties(kind) {
  const L = await load();
  const ps = [...L.parties.values()].filter((p) => p.type === kind).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  const word = (p) => (kind === 'customer' ? (p.balance >= 0 ? 'পাবো' : 'অগ্রিম') : (p.balance >= 0 ? 'দেবো' : 'অগ্রিম'));
  const body = h('div', {}, ...(ps.length ? ps.map((p) => h('button', { class: 'item btn-row', type: 'button', onclick: () => { s.close(); openPartyBook(p.key); } },
    h('span', {}, p.name, h('small', { class: 'muted' }, ` ${fmt(p.orders)}টি লেনদেন`)), h('b', { class: Math.abs(p.balance) > 0.004 ? 'warnc' : 'muted' }, `${word(p)} ${money(Math.abs(p.balance))}`))) : [h('p', { class: 'muted' }, 'কেউ নেই। বিক্রি/ক্রয়ের সময় নাম লিখলেই যোগ হবে।')]),
    h('button', { class: 'btn full', type: 'button', onclick: () => { s.close(); openPartyForm(kind); } }, '＋ নতুন যোগ করুন'));
  const s = sheet(kind === 'customer' ? 'কাস্টমার' : 'সাপ্লায়ার', body);
}

async function openPartyBook(key) {
  const L = await load(), p = L.parties.get(key);
  if (!p) return;
  const isC = p.type === 'customer';
  const body = h('div', {}, p.phone ? h('p', {}, '📞 ', h('a', { href: 'tel:' + p.phone }, p.phone)) : null,
    kv(isC ? 'মোট কিনেছে' : 'মোট কিনেছি', money(p.total)), kv(isC ? 'এখন পাবো' : 'এখন দেবো', money(p.balance), 'total'),
    tbl(['তারিখ', 'বিবরণ', '+/−', 'বাকি'], p.rows.map((r) => [dateLabel(r.date).replace(/^[^,]*,\s*/, ''), r.title, colored(isC ? r.delta : -r.delta, signed(r.delta)), money(r.balance)]), 'card-tbl'));
  const s = sheet(p.name, body);
  body.append(h('div', { class: 'grid2' },
    h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openDueForm({ type: isC ? 'customer_receipt' : 'supplier_payment', partyId: p.id }); } }, isC ? '✅ আদায় করুন' : '✅ পরিশোধ করুন'),
    h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); openPartyForm(p.type, p.id); } }, '✏️ এডিট')));
}

async function openReports() {
  const L = await load(), ms = monthly(L);
  const body = h('div', {}, ms.length ? tbl(['মাস', 'বিক্রি', 'মোট লাভ', 'খরচ', 'নিট'], ms.map((m) => [monthLabel(m.month), money(m.revenue), money(m.gross), money(m.opexTotal + m.fee + m.loss + Math.max(-m.deliveryNet, 0)), colored(m.net, money(m.net))]), 'card-tbl') : h('p', { class: 'muted' }, 'এখনো কোনো লেনদেন নেই।'),
    h('p', { class: 'muted' }, 'খরচ = ভাড়া/খাবার ইত্যাদি + ফি + নষ্ট মাল + ডেলিভারিতে লস।'),
    h('button', { class: 'btn full', type: 'button', onclick: () => download(`hisabkhata-timeline-${todayStr()}.csv`, timelineCsv(L), 'text/csv') }, '⬇️ টাইমলাইন CSV (Excel-এ খোলে)'));
  sheet('মাসিক রিপোর্ট', body);
}

async function openReturnsList() {
  const L = await load();
  const rs = L.entries.filter((e) => e.kind === 'return').reverse();
  const body = h('div', {}, ...(rs.length ? rs.map((e) => h('button', { class: 'item btn-row', type: 'button', onclick: () => { s.close(); openDetail(e, L); } }, h('span', {}, e.title, h('small', { class: 'muted' }, ` ${e.sub}`)), h('b', {}, money(-e.cashDelta || 0)))) : [h('p', { class: 'muted' }, 'কোনো ফেরত নেই। বিক্রির বিস্তারিত থেকে "ফেরত নিন" চাপুন।')]));
  const s = sheet('ফেরত', body);
}

async function openData() {
  const dg = chips([['bn', 'বাংলা ১২৩'], ['en', 'English 123']], getDigits(), (v) => { setDigits(v); emit({ type: 'data-changed' }); });
  const body = h('div', {}, h('h4', {}, 'সংখ্যার ধরন'), dg,
    h('h4', {}, 'ব্যাকআপ'), h('p', { class: 'muted' }, 'সব ডেটা JSON ফাইলে নামবে। ডেটা আগে থেকেই সার্ভারেও সিঙ্ক থাকে — এটা বাড়তি নিরাপত্তা।'),
    h('button', { class: 'btn full', type: 'button', onclick: async () => {
      const tables = {};
      for (const t of TABLES) tables[t] = await getAll(t, { includeDeleted: true });
      download(`hisabkhata-backup-${todayStr()}.json`, JSON.stringify({ app: 'hisabkhata', exportedAt: new Date().toISOString(), tables }), 'application/json');
      toast('ব্যাকআপ নামানো হয়েছে');
    } }, '⬇️ সব ডেটা ব্যাকআপ (JSON)'));
  sheet('ব্যাকআপ ও ভাষা', body);
}
