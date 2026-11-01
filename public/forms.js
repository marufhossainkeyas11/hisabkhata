// এন্ট্রি ফর্ম — ইউজার শুধু বলে "কী ঘটেছে"; ডেবিট/ক্রেডিট ledger.js নিজে বানায়।
import { TABLES, getAll, save, remove, onEvent } from './db.js';
import { buildLedger, EXPENSE_CATEGORIES, STATUS_LABEL } from './ledger.js';
import { h, sheet, toast, field, textIn, numIn, dateIn, selectIn, chips, money, fmt, todayStr } from './ui.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const val = (el) => Number(el.value) || 0;
const uid = () => 'dl' + Math.random().toString(36).slice(2, 8);
const low = (s) => String(s || '').trim().toLowerCase();

// ---- ডেটা লোড (পরিবর্তন হলে নতুন করে হিসাব) ----
let cache = null, ver = 0;
export const invalidate = () => { cache = null; ver += 1; };
onEvent((e) => { if (e.type === 'local-change' || e.type === 'data-changed') invalidate(); }); // নিজের বা অন্য ট্যাব/সিঙ্কের পরিবর্তনে নতুন করে হিসাব
export async function load() {
  if (cache) return cache;
  const v = ver, data = {};
  await Promise.all(TABLES.map(async (t) => { data[t] = await getAll(t); }));
  const L = buildLedger(data);
  L.raw = data;
  if (v === ver) cache = L;
  return L;
}

// ---- মোছা + ফিরিয়ে আনা (soft delete) ----
const CHILD = { purchases: ['purchase_items', 'purchase_id'], sales: ['sale_items', 'sale_id'] };
export async function deleteDoc(table, id) {
  const L = await load();
  const head = L.raw[table].find((r) => r.id === id);
  if (!head) return;
  const recs = [[table, head]];
  if (CHILD[table]) for (const it of L.raw[CHILD[table][0]].filter((i) => i[CHILD[table][1]] === id)) recs.push([CHILD[table][0], it]);
  for (const [t, r] of [...recs].reverse()) await remove(t, r.id);
  toast('মুছে ফেলা হয়েছে', { label: 'ফিরিয়ে আনুন', fn: async () => { for (const [t, r] of recs) await save(t, { ...r, is_deleted: 0 }); toast('ফিরিয়ে আনা হয়েছে'); } });
}

// ---- সহায়ক ----
function formSheet(title, nodes, onSubmit, label = 'সেভ করুন') {
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn full', type: 'submit' }, label);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try { await onSubmit(); s.close(); } catch (ex) { err.textContent = ex.message || String(ex); btn.disabled = false; }
    }
  }, nodes, err, btn);
  const s = sheet(title, form);
  return s;
}
const acctOpts = (L, cur) => {
  const o = L.accounts.filter((a) => a.is_active !== 0 || a.id === cur).map((a) => [a.id, `${a.name} · ${money(L.bal['m:' + a.id] || 0)}`]);
  return o.length ? o : [['', 'অ্যাকাউন্ট নেই — আরও → অ্যাকাউন্ট']];
};
const needAcct = (el) => { if (!el.value) throw new Error('অ্যাকাউন্ট বাছুন (আরও → অ্যাকাউন্টে যোগ করা যায়)'); };
const partyBox = (list, value, placeholder) => {
  const id = uid();
  const inp = textIn(value, { list: id, placeholder });
  return { inp, dl: h('datalist', { id }, list.map((p) => h('option', { value: p.name }))) };
};
async function ensureParty(table, name, phone, list) {
  name = (name || '').trim();
  if (!name) return null;
  const hit = list.find((p) => low(p.name) === low(name));
  if (hit) { if (phone && !hit.phone) await save(table, { ...hit, phone }); return hit.id; }
  const rec = await save(table, { name, phone: phone || null, address: null, note: null });
  list.push(rec);
  return rec.id;
}

// ---- ➕ মেনু ----
export function openEntryMenu() {
  const items = [
    ['🛒', 'বিক্রি', () => openSaleForm()], ['📦', 'মাল কিনলাম', () => openPurchaseForm()],
    ['💸', 'খরচ', () => openExpenseForm()], ['💰', 'পুঁজি জমা / উত্তোলন', () => openCapitalForm()],
    ['🔁', 'ট্রান্সফার / ক্যাশআউট', () => openTransferForm()], ['✅', 'বাকি আদায় / পরিশোধ', () => openDueForm()]
  ];
  const s = sheet('কী হয়েছে?', h('div', { class: 'menu-grid' }, items.map(([i, l, fn]) =>
    h('button', { class: 'menu-btn', type: 'button', onclick: () => { s.close(); fn(); } }, h('span', { class: 'big-ico' }, i), l))));
}

// =====================================================================
// 🛒 বিক্রি
// =====================================================================
export async function openSaleForm(id, preset = {}) {
  const L = await load();
  const old = id ? L.raw.sales.find((s) => s.id === id) : null;
  const oldItems = old ? L.raw.sale_items.filter((i) => i.sale_id === id) : [];
  const books = L.productList.flatMap((p) => p.variants);
  if (!books.length) { toast('আগে "মাল কিনলাম" থেকে পণ্য যোগ করুন'); return openPurchaseForm(); }
  const opts = [['', 'পণ্য বাছুন'], ...books.map((b) => [b.variant.id, `${b.label} · স্টক ${fmt(b.available)}`])];
  const custOld = old && L.cMap.get(old.customer_id);

  const date = dateIn(old && old.sale_date);
  const { inp: cust, dl } = partyBox(L.customers, custOld ? custOld.name : '', 'কাস্টমারের নাম (না দিলে সরাসরি বিক্রি)');
  const phone = textIn('', { type: 'tel', placeholder: 'ফোন (নতুন কাস্টমারের জন্য, ঐচ্ছিক)', inputmode: 'tel' });
  const custHint = h('small', { class: 'hint' });
  cust.addEventListener('input', () => {
    const p = [...L.parties.values()].find((x) => x.type === 'customer' && low(x.name) === low(cust.value));
    custHint.textContent = p && Math.abs(p.balance) > 0.005 ? `এই কাস্টমারের ${p.balance > 0 ? 'আগের বাকি' : 'অগ্রিম জমা'}: ${money(Math.abs(p.balance))}` : '';
  });
  const rowsBox = h('div'), rows = [];
  const discount = numIn(old ? old.discount : '', { placeholder: '০' });
  const delivery = numIn(old ? old.delivery_charge_customer : '', { placeholder: 'কাস্টমার যা দিচ্ছে' });
  const courier = numIn(old ? old.actual_courier_cost : '', { placeholder: 'আমি যা দিয়েছি' });
  const feeIn = numIn(old ? old.fee_incurred : '', { placeholder: 'বিকাশ/নগদ ক্যাশআউট চার্জ' });
  const acct = selectIn(acctOpts(L, old && old.account_id), old ? old.account_id : undefined);
  const received = numIn(old ? old.amount_received : '', { placeholder: 'টাকা হাতে পেয়েছি' });
  const status = chips(Object.entries(STATUS_LABEL), old ? old.status : 'delivered', () => recalc());
  const source = selectIn([['shop', 'দোকান'], ['facebook', 'ফেসবুক'], ['website', 'ওয়েবসাইট'], ['phone', 'ফোন']], old ? old.source : 'shop');
  const note = textIn(old ? old.note : '', { placeholder: 'নোট (ঐচ্ছিক)', maxlength: 200 });
  const summary = h('div', { class: 'sum-box' }), warn = h('p', { class: 'err' });
  let recvTouched = !!old;
  received.addEventListener('input', () => { recvTouched = true; recalc(); });

  function recalc() {
    let sub = 0, cost = 0; const msgs = [];
    for (const r of rows) {
      const q = val(r.qty), p = val(r.price), b = L.books.get(r.sel.value);
      sub += q * p; r.line.textContent = money(q * p);
      if (b) {
        cost += q * (b.avgCost || Number(b.variant.default_buy_price) || 0);
        const prev = oldItems.filter((i) => i.variant_id === b.variant.id).reduce((a, i) => a + Number(i.quantity), 0);
        if (q > b.available + (old && old.status !== 'cancelled' ? prev : 0) + 1e-9) msgs.push(`${b.label}: স্টকে আছে ${fmt(b.available)}`);
      }
    }
    warn.textContent = msgs.length ? '⚠️ ' + msgs.join(' · ') : '';
    const net = sub - val(discount) + val(delivery);
    if (!recvTouched) received.value = status.get() === 'pending' || status.get() === 'cancelled' || status.get() === 'returned' ? '' : String(r2(net));
    const due = net - val(received);
    const profit = sub - val(discount) + val(delivery) - cost - val(courier) - val(feeIn);
    summary.replaceChildren(
      h('div', { class: 'pl-row' }, h('span', {}, 'পণ্যের মোট'), h('span', { class: 'v' }, money(sub))),
      h('div', { class: 'pl-row total' }, h('span', {}, 'কাস্টমার দেবে'), h('span', { class: 'v' }, money(net))),
      h('div', { class: 'pl-row' }, h('span', {}, 'বাকি থাকছে'), h('span', { class: 'v' }, money(status.get() === 'delivered' ? due : 0))),
      h('div', { class: 'pl-row' }, h('span', {}, 'আনুমানিক লাভ'), h('span', { class: 'v ' + (profit >= 0 ? 'pos' : 'neg') }, money(profit))));
  }
  function addRow(init = {}) {
    const sel = selectIn(opts, init.variantId || '');
    const qty = numIn(init.qty ?? 1, { min: '0.01', required: true });
    const price = numIn(init.price ?? '', { required: true, placeholder: 'দাম/পিস' });
    const line = h('div', { class: 'line-total' });
    let touched = init.price != null;
    price.addEventListener('input', () => { touched = true; recalc(); });
    qty.addEventListener('input', recalc);
    sel.addEventListener('change', () => { const b = L.books.get(sel.value); if (b && !touched) price.value = b.variant.default_sell_price || ''; recalc(); });
    const row = { id: init.id, sel, qty, price, line };
    row.el = h('div', { class: 'item-card' }, sel,
      h('div', { class: 'grid3' }, field('পরিমাণ', qty), field('দাম/পিস', price), field('মোট', line)),
      h('button', { type: 'button', class: 'link neg', onclick: () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); recalc(); } }, '✕ বাদ দিন'));
    rows.push(row); rowsBox.append(row.el);
    if (init.variantId && init.price == null) { const b = L.books.get(init.variantId); if (b) price.value = b.variant.default_sell_price || ''; }
    recalc();
  }
  [discount, delivery, courier, feeIn].forEach((el) => el.addEventListener('input', recalc));
  if (oldItems.length) oldItems.forEach((i) => addRow({ id: i.id, variantId: i.variant_id, qty: i.quantity, price: i.unit_price }));
  else addRow({ variantId: preset.variantId });

  formSheet(old ? 'বিক্রি এডিট' : 'নতুন বিক্রি', [
    field('তারিখ', date), field('কাস্টমার', cust), dl, custHint, field('ফোন', phone),
    h('h4', {}, 'কী কী বিক্রি হলো'), rowsBox,
    h('button', { type: 'button', class: 'btn small', onclick: () => addRow() }, '＋ আরেকটা পণ্য'), warn,
    h('div', { class: 'grid2' }, field('ডিসকাউন্ট ৳', discount), field('ডেলিভারি চার্জ (কাস্টমার) ৳', delivery)),
    h('div', { class: 'grid2' }, field('কুরিয়ার খরচ (আমার) ৳', courier), field('ক্যাশআউট/গেটওয়ে ফি ৳', feeIn)),
    field('টাকা কোন অ্যাকাউন্টে', acct), field('টাকা পেয়েছি ৳', received),
    field('অবস্থা', status), field('কোথা থেকে অর্ডার', source), field('নোট', note), summary
  ], async () => {
    const lines = rows.filter((r) => r.sel.value);
    if (!lines.length) throw new Error('কমপক্ষে একটা পণ্য বাছুন');
    for (const r of lines) { if (!(val(r.qty) > 0)) throw new Error('পরিমাণ ০-এর বেশি হতে হবে'); if (r.price.value === '') throw new Error('দাম দিন'); }
    const st = status.get();
    const sub = r2(lines.reduce((a, r) => a + val(r.qty) * val(r.price), 0));
    const net = r2(sub - val(discount) + val(delivery));
    const recv = r2(val(received)), due = r2(net - recv);
    if (val(discount) > sub) throw new Error('ডিসকাউন্ট পণ্যের মোটের বেশি');
    if ((recv > 0 || val(courier) > 0 || val(feeIn) > 0)) needAcct(acct);
    if (st === 'delivered' && due > 0.005 && !cust.value.trim()) throw new Error('বাকি থাকলে কাস্টমারের নাম দিন');
    const customerId = await ensureParty('customers', cust.value, phone.value.trim(), L.customers.slice());
    const sale = await save('sales', {
      id: old ? old.id : undefined, invoice_no: old ? old.invoice_no : `S-${date.value.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      customer_id: customerId, sale_date: date.value, subtotal: sub, discount: r2(val(discount)), delivery_charge_customer: r2(val(delivery)), actual_courier_cost: r2(val(courier)),
      net_payable: net, account_id: acct.value || null, amount_received: recv, due_amount: st === 'delivered' ? due : 0, fee_incurred: r2(val(feeIn)),
      status: st, source: source.value, note: note.value.trim() || null
    });
    const keep = new Set();
    for (const r of lines) {
      const b = L.books.get(r.sel.value), q = val(r.qty), p = val(r.price);
      const it = await save('sale_items', { id: r.id, sale_id: sale.id, variant_id: r.sel.value, quantity: q, unit_price: p, unit_cogs: r2(b ? b.avgCost || 0 : 0), total_price: r2(q * p) });
      keep.add(it.id);
    }
    for (const it of oldItems) if (!keep.has(it.id)) await remove('sale_items', it.id);
    toast('বিক্রি সেভ হয়েছে');
  });
}

// =====================================================================
// 📦 মাল কেনা — পণ্যের নাম+রং+সাইজ লিখলেই পণ্য তৈরি/মিলে যায়
// =====================================================================
export async function openPurchaseForm(id, preset = {}) {
  const L = await load();
  const old = id ? L.raw.purchases.find((p) => p.id === id) : null;
  const oldItems = old ? L.raw.purchase_items.filter((i) => i.purchase_id === id) : [];
  const supOld = old && L.sMap.get(old.supplier_id);
  const names = uid(), colors = uid(), sizes = uid();
  const uniq = (a) => [...new Set(a.filter(Boolean))];

  const date = dateIn(old && old.purchase_date);
  const { inp: sup, dl } = partyBox(L.suppliers, supOld ? supOld.name : '', 'সাপ্লায়ার / দোকানের নাম (ঐচ্ছিক)');
  const rowsBox = h('div'), rows = [];
  const extra = numIn(old ? old.extra_costs : '', { placeholder: 'ট্রান্সপোর্ট/লেবার/অন্যান্য' });
  const acct = selectIn(acctOpts(L, old && old.account_id), old ? old.account_id : undefined);
  const paid = numIn(old ? old.amount_paid : '', { placeholder: 'কত দিলাম' });
  const note = textIn(old ? old.note : '', { placeholder: 'নোট (ঐচ্ছিক)', maxlength: 200 });
  const summary = h('div', { class: 'sum-box' });
  let paidTouched = !!old;
  paid.addEventListener('input', () => { paidTouched = true; recalc(); });

  function recalc() {
    let sub = 0;
    for (const r of rows) { const t = val(r.qty) * val(r.cost); sub += t; r.line.textContent = money(t); }
    const total = r2(sub + val(extra));
    if (!paidTouched) paid.value = total ? String(total) : '';
    summary.replaceChildren(
      h('div', { class: 'pl-row' }, h('span', {}, 'মালের দাম'), h('span', { class: 'v' }, money(sub))),
      h('div', { class: 'pl-row' }, h('span', {}, '+ অতিরিক্ত খরচ (মালে ভাগ হবে)'), h('span', { class: 'v' }, money(val(extra)))),
      h('div', { class: 'pl-row total' }, h('span', {}, 'মোট'), h('span', { class: 'v' }, money(total))),
      h('div', { class: 'pl-row' }, h('span', {}, 'বাকি থাকছে (দেনা)'), h('span', { class: 'v' }, money(total - val(paid)))));
  }
  function addRow(init = {}) {
    const prod = textIn(init.product, { list: names, required: true, placeholder: 'পণ্যের নাম (যেমন: টি-শার্ট)' });
    const color = textIn(init.color, { list: colors, placeholder: 'রং' });
    const size = textIn(init.size, { list: sizes, placeholder: 'সাইজ' });
    const qty = numIn(init.qty, { min: '0.01', required: true, placeholder: 'পরিমাণ' });
    const cost = numIn(init.cost, { required: true, placeholder: 'কেনা দাম/পিস' });
    const sell = numIn(init.sell, { placeholder: 'বিক্রির দাম/পিস' });
    const line = h('b', {});
    const fill = () => {
      const p = L.products.find((x) => low(x.name) === low(prod.value));
      const v = p && L.variants.find((x) => x.product_id === p.id && low(x.color) === low(color.value) && low(x.size) === low(size.value));
      if (v) { if (cost.value === '' && v.default_buy_price) cost.value = v.default_buy_price; if (sell.value === '' && v.default_sell_price) sell.value = v.default_sell_price; recalc(); }
    };
    [prod, color, size].forEach((el) => el.addEventListener('change', fill));
    [qty, cost].forEach((el) => el.addEventListener('input', recalc));
    const row = { id: init.id, prod, color, size, qty, cost, sell, line };
    row.el = h('div', { class: 'item-card' }, prod, h('div', { class: 'grid2' }, color, size),
      h('div', { class: 'grid3' }, field('পরিমাণ', qty), field('কেনা দাম', cost), field('বিক্রির দাম', sell)),
      h('div', { class: 'row-between' }, h('span', { class: 'muted' }, 'লাইন মোট: ', line), h('button', { type: 'button', class: 'link neg', onclick: () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); recalc(); } }, '✕ বাদ')));
    rows.push(row); rowsBox.append(row.el); recalc();
  }
  extra.addEventListener('input', recalc);
  const vInit = (i) => {
    const v = L.vMap.get(i.variant_id), p = v && L.pMap.get(v.product_id);
    return { id: i.id, product: p ? p.name : '', color: v ? v.color : '', size: v ? v.size : '', qty: i.quantity, cost: i.raw_unit_cost, sell: v ? v.default_sell_price : '' };
  };
  if (oldItems.length) oldItems.forEach((i) => addRow(vInit(i)));
  else if (preset.variantId) { const v = L.vMap.get(preset.variantId), p = v && L.pMap.get(v.product_id); addRow(v ? { product: p.name, color: v.color, size: v.size, cost: v.default_buy_price || '', sell: v.default_sell_price || '' } : {}); }
  else addRow();

  formSheet(old ? 'ক্রয় এডিট' : 'মাল কিনলাম', [
    field('তারিখ', date), field('সাপ্লায়ার', sup), dl,
    h('datalist', { id: names }, uniq(L.products.map((p) => p.name)).map((v) => h('option', { value: v }))),
    h('datalist', { id: colors }, uniq(L.variants.map((v) => v.color)).map((v) => h('option', { value: v }))),
    h('datalist', { id: sizes }, uniq(L.variants.map((v) => v.size)).map((v) => h('option', { value: v }))),
    h('h4', {}, 'কী কী কিনলাম'), rowsBox,
    h('button', { type: 'button', class: 'btn small', onclick: () => addRow() }, '＋ আরেকটা পণ্য / রং / সাইজ'),
    field('অতিরিক্ত খরচ ৳ (ট্রান্সপোর্ট, লেবার)', extra), field('টাকা কোন অ্যাকাউন্ট থেকে', acct), field('কত দিলাম ৳', paid), field('নোট', note), summary
  ], async () => {
    const lines = rows.filter((r) => r.prod.value.trim());
    if (!lines.length) throw new Error('কমপক্ষে একটা পণ্য দিন');
    for (const r of lines) { if (!(val(r.qty) > 0)) throw new Error('পরিমাণ ০-এর বেশি হতে হবে'); if (r.cost.value === '') throw new Error('কেনা দাম দিন'); }
    if (val(paid) > 0) needAcct(acct);
    const prods = L.products.slice(), vars = L.variants.slice();
    const supplierId = await ensureParty('suppliers', sup.value, '', L.suppliers.slice());
    const resolved = [];
    for (const r of lines) {
      const pn = r.prod.value.trim(), c = r.color.value.trim(), z = r.size.value.trim();
      let p = prods.find((x) => low(x.name) === low(pn));
      if (!p) { p = await save('products', { name: pn, category: null, unit: 'pc', description: null }); prods.push(p); }
      let v = vars.find((x) => x.product_id === p.id && low(x.color) === low(c) && low(x.size) === low(z));
      const buy = val(r.cost), sellP = r.sell.value === '' ? null : val(r.sell);
      if (!v) { v = await save('product_variants', { product_id: p.id, sku: null, color: c || null, size: z || null, default_buy_price: buy, default_sell_price: sellP || 0, low_stock_threshold: 3 }); vars.push(v); }
      else if (Number(v.default_buy_price) !== buy || (sellP != null && Number(v.default_sell_price) !== sellP)) {
        v = await save('product_variants', { ...v, default_buy_price: buy, default_sell_price: sellP != null ? sellP : v.default_sell_price });
      }
      resolved.push({ row: r, variantId: v.id });
    }
    const sub = r2(resolved.reduce((a, x) => a + val(x.row.qty) * val(x.row.cost), 0)), ex = r2(val(extra)), total = r2(sub + ex), pd = r2(val(paid));
    const p = await save('purchases', {
      id: old ? old.id : undefined, supplier_id: supplierId, account_id: acct.value || (L.accounts[0] && L.accounts[0].id), purchase_date: date.value,
      subtotal: sub, extra_costs: ex, total_cost: total, amount_paid: pd, due_amount: r2(total - pd), note: note.value.trim() || null
    });
    const keep = new Set();
    for (const x of resolved) {
      const q = val(x.row.qty), raw = val(x.row.cost), line = q * raw;
      const landed = q ? raw + (sub > 0 ? ex * (line / sub) : 0) / q : raw;
      const it = await save('purchase_items', { id: x.row.id, purchase_id: p.id, variant_id: x.variantId, quantity: q, raw_unit_cost: raw, landed_unit_cost: r2(landed), total_amount: r2(landed * q) });
      keep.add(it.id);
    }
    for (const it of oldItems) if (!keep.has(it.id)) await remove('purchase_items', it.id);
    toast('ক্রয় সেভ হয়েছে — স্টক বেড়েছে');
  });
}

// =====================================================================
// 💸 খরচ
// =====================================================================
export async function openExpenseForm(id) {
  const L = await load();
  const old = id ? L.raw.expenses.find((x) => x.id === id) : null;
  const listId = uid();
  const cats = [...new Set([...EXPENSE_CATEGORIES, ...L.raw.expenses.map((x) => x.category)])];
  const date = dateIn(old && old.expense_date);
  const cat = textIn(old ? old.category : '', { list: listId, required: true, placeholder: 'যেমন: ভাড়া, খাবার' });
  const amount = numIn(old ? old.amount : '', { required: true, min: '0.01', placeholder: '০' });
  const acct = selectIn(acctOpts(L, old && old.account_id), old ? old.account_id : undefined);
  const note = textIn(old ? old.note : '', { placeholder: 'নোট (ঐচ্ছিক)', maxlength: 200 });
  const rec = h('input', { type: 'checkbox' }); rec.checked = !!(old && old.is_recurring);
  formSheet(old ? 'খরচ এডিট' : 'খরচ', [
    field('তারিখ', date), field('কিসের খরচ', cat), h('datalist', { id: listId }, cats.map((c) => h('option', { value: c }))),
    h('div', { class: 'seg wrap' }, cats.map((c) => h('button', { type: 'button', onclick: () => { cat.value = c; } }, c))),
    field('টাকা ৳', amount), field('কোন অ্যাকাউন্ট থেকে', acct), field('নোট', note),
    h('label', { class: 'check' }, rec, ' প্রতি মাসে হয় (যেমন বাসাভাড়া)')
  ], async () => {
    needAcct(acct);
    if (!(val(amount) > 0)) throw new Error('টাকার পরিমাণ দিন');
    await save('expenses', { id: old ? old.id : undefined, category: cat.value.trim() || 'অন্যান্য', amount: r2(val(amount)), account_id: acct.value, expense_date: date.value, note: note.value.trim() || null, is_recurring: rec.checked ? 1 : 0 });
    toast('খরচ সেভ হয়েছে');
  });
}

// =====================================================================
// 💰 পুঁজি জমা / উত্তোলন
// =====================================================================
export async function openCapitalForm(id) {
  const L = await load();
  const old = id ? L.raw.capital_entries.find((x) => x.id === id) : null;
  const type = chips([['investment', '＋ পুঁজি জমা দিলাম'], ['withdrawal', '− পুঁজি থেকে তুললাম']], old ? old.type : 'investment');
  const date = dateIn(old && old.date);
  const amount = numIn(old ? old.amount : '', { required: true, min: '0.01', placeholder: '০' });
  const acct = selectIn(acctOpts(L, old && old.account_id), old ? old.account_id : undefined);
  const note = textIn(old ? old.note : '', { placeholder: 'নোট (ঐচ্ছিক)', maxlength: 200 });
  formSheet(old ? 'পুঁজি এডিট' : 'পুঁজি', [type, field('তারিখ', date), field('টাকা ৳', amount), field('কোন অ্যাকাউন্টে / থেকে', acct), field('নোট', note)], async () => {
    needAcct(acct);
    if (!(val(amount) > 0)) throw new Error('টাকার পরিমাণ দিন');
    await save('capital_entries', { id: old ? old.id : undefined, type: type.get(), amount: r2(val(amount)), account_id: acct.value, note: note.value.trim() || null, date: date.value });
    toast('সেভ হয়েছে');
  });
}

// =====================================================================
// 🔁 ট্রান্সফার (যেমন বিকাশ → ক্যাশ, চার্জসহ)
// =====================================================================
export async function openTransferForm(id) {
  const L = await load();
  const old = id ? L.raw.account_transfers.find((x) => x.id === id) : null;
  const date = dateIn(old && old.date);
  const from = selectIn(acctOpts(L, old && old.from_account_id), old ? old.from_account_id : undefined);
  const to = selectIn(acctOpts(L, old && old.to_account_id), old ? old.to_account_id : (L.accounts[1] ? L.accounts[1].id : undefined));
  const amount = numIn(old ? old.amount : '', { required: true, min: '0.01', placeholder: '০' });
  const fee = numIn(old ? old.fee : '', { placeholder: 'ক্যাশআউট চার্জ (যে অ্যাকাউন্ট থেকে যাচ্ছে সেখান থেকে কাটবে)' });
  const note = textIn(old ? old.note : '', { placeholder: 'নোট (ঐচ্ছিক)', maxlength: 200 });
  formSheet(old ? 'ট্রান্সফার এডিট' : 'ট্রান্সফার / ক্যাশআউট', [
    field('তারিখ', date), field('যেখান থেকে', from), field('যেখানে', to), field('টাকা ৳', amount), field('চার্জ ৳', fee), field('নোট', note)
  ], async () => {
    needAcct(from); needAcct(to);
    if (from.value === to.value) throw new Error('একই অ্যাকাউন্টে ট্রান্সফার হয় না');
    if (!(val(amount) > 0)) throw new Error('টাকার পরিমাণ দিন');
    await save('account_transfers', { id: old ? old.id : undefined, from_account_id: from.value, to_account_id: to.value, amount: r2(val(amount)), fee: r2(val(fee)), note: note.value.trim() || null, date: date.value });
    toast('ট্রান্সফার সেভ হয়েছে');
  });
}

// =====================================================================
// ✅ বাকি আদায় / পরিশোধ
// =====================================================================
export async function openDueForm(preset = {}, id) {
  const L = await load();
  const old = id ? L.raw.due_payments.find((x) => x.id === id) : null;
  let type = old ? old.type : preset.type || 'customer_receipt';
  const date = dateIn(old && old.payment_date);
  const partySel = selectIn([['', '…']]);
  const amount = numIn(old ? old.amount : '', { required: true, min: '0.01', placeholder: '০' });
  const acct = selectIn(acctOpts(L, old && old.account_id), old ? old.account_id : undefined);
  const note = textIn(old ? old.note : '', { placeholder: 'নোট (ঐচ্ছিক)', maxlength: 200 });
  let touched = !!old;
  amount.addEventListener('input', () => { touched = true; });
  const current = () => L.parties.get((type === 'customer_receipt' ? 'customer:' : 'supplier:') + partySel.value);
  const fill = (pick) => {
    const kind = type === 'customer_receipt' ? 'customer' : 'supplier', keep = pick || (old && (old.customer_id || old.supplier_id));
    const list = [...L.parties.values()].filter((p) => p.type === kind && (p.balance > 0.005 || p.id === keep));
    partySel.replaceChildren(...(list.length ? list.map((p) => h('option', { value: p.id }, `${p.name} · বাকি ${money(p.balance)}`)) : [h('option', { value: '' }, 'কারো বাকি নেই')]));
    if (keep && list.some((p) => p.id === keep)) partySel.value = keep;
    if (!touched && current()) amount.value = String(Math.max(r2(current().balance), 0));
  };
  partySel.addEventListener('change', () => { if (!touched && current()) amount.value = String(Math.max(r2(current().balance), 0)); });
  const typeChips = chips([['customer_receipt', 'কাস্টমার থেকে আদায়'], ['supplier_payment', 'সাপ্লায়ারকে পরিশোধ']], type, (v) => { type = v; fill(); });
  fill(preset.partyId);
  formSheet(old ? 'বাকি এডিট' : 'বাকি আদায় / পরিশোধ', [typeChips, field('তারিখ', date), field('কার', partySel), field('টাকা ৳', amount), field(type === 'customer_receipt' ? 'টাকা কোন অ্যাকাউন্টে এলো' : 'কোন অ্যাকাউন্ট থেকে দিলাম', acct), field('নোট', note)], async () => {
    needAcct(acct);
    if (!partySel.value) throw new Error('কার বাকি বাছুন');
    if (!(val(amount) > 0)) throw new Error('টাকার পরিমাণ দিন');
    const isC = type === 'customer_receipt';
    await save('due_payments', { id: old ? old.id : undefined, customer_id: isC ? partySel.value : null, supplier_id: isC ? null : partySel.value, sale_id: null, purchase_id: null, account_id: acct.value, type, amount: r2(val(amount)), payment_date: date.value, note: note.value.trim() || null });
    toast('সেভ হয়েছে');
  });
}

// =====================================================================
// ↩️ ফেরত
// =====================================================================
export async function openReturnForm(saleId, id) {
  const L = await load();
  const si = L.saleInfo.get(saleId);
  if (!si) return;
  const old = id ? L.raw.returns.find((x) => x.id === id) : null;
  const prior = L.raw.returns.filter((r) => r.sale_id === saleId && r.id !== id);
  const lines = si.rawItems.map((it, i) => {
    const back = prior.filter((r) => r.variant_id === it.variant_id).reduce((a, r) => a + Number(r.quantity), 0);
    const unit = si.items[i].total / Number(it.quantity) * (si.subtotal ? si.revenue / si.subtotal : 1);
    return { variantId: it.variant_id, label: si.items[i].label, left: Number(it.quantity) - back, unit };
  }).filter((l, i, a) => a.findIndex((x) => x.variantId === l.variantId) === i);
  const sel = selectIn(lines.map((l) => [l.variantId, `${l.label} (ফেরতযোগ্য ${fmt(l.left)})`]), old ? old.variant_id : undefined);
  const qty = numIn(old ? old.quantity : 1, { min: '0.01', required: true });
  const refund = numIn(old ? old.refund_amount : '', { required: true });
  let touched = !!old;
  const calc = () => { const l = lines.find((x) => x.variantId === sel.value); if (l && !touched) refund.value = String(r2(val(qty) * l.unit)); };
  refund.addEventListener('input', () => { touched = true; });
  qty.addEventListener('input', calc); sel.addEventListener('change', () => { touched = false; calc(); });
  calc();
  const date = dateIn(old && old.return_date);
  const settle = chips([['cash', 'টাকা ফেরত দিলাম'], ['due', 'কাস্টমারের বাকি থেকে কাটো']], old && !old.account_id ? 'due' : 'cash');
  const acct = selectIn(acctOpts(L, old && old.account_id), old ? old.account_id : undefined);
  const restock = h('input', { type: 'checkbox' }); restock.checked = old ? !!old.restock : true;
  const note = textIn(old ? old.note : '', { placeholder: 'কারণ (ঐচ্ছিক)', maxlength: 200 });
  formSheet(old ? 'ফেরত এডিট' : `ফেরত · ${si.customer || 'সরাসরি বিক্রি'}`, [
    field('কোন পণ্য', sel), h('div', { class: 'grid2' }, field('কয়টা ফেরত', qty), field('ফেরত মূল্য ৳', refund)), field('তারিখ', date),
    settle, field('টাকা কোন অ্যাকাউন্ট থেকে গেল', acct), h('label', { class: 'check' }, restock, ' ভালো আছে, আবার স্টকে তুলবো'), field('নোট', note)
  ], async () => {
    const l = lines.find((x) => x.variantId === sel.value);
    if (!l) throw new Error('পণ্য বাছুন');
    if (!(val(qty) > 0) || val(qty) > l.left + 1e-9) throw new Error(`ফেরতযোগ্য সর্বোচ্চ ${fmt(l.left)}`);
    if (settle.get() === 'cash') needAcct(acct);
    await save('returns', { id: old ? old.id : undefined, sale_id: saleId, variant_id: l.variantId, quantity: val(qty), refund_amount: r2(val(refund)), account_id: settle.get() === 'cash' ? acct.value : null, return_date: date.value, restock: restock.checked ? 1 : 0, note: note.value.trim() || null });
    toast('ফেরত সেভ হয়েছে');
  });
}

// =====================================================================
// ⚖️ স্টক নষ্ট / কম-বেশি
// =====================================================================
export async function openAdjustForm(variantId, id) {
  const L = await load();
  const b = L.books.get(variantId);
  if (!b) return;
  const old = id ? L.raw.stock_movements.find((x) => x.id === id) : null;
  const kind = chips([['damage', 'নষ্ট / হারিয়েছে'], ['out', 'কম পাচ্ছি'], ['in', 'বেশি পেয়েছি']], old ? (old.movement_type === 'damage' ? 'damage' : Number(old.quantity) > 0 ? 'in' : 'out') : 'damage');
  const qty = numIn(old ? Math.abs(old.quantity) : '', { min: '0.01', required: true });
  const date = dateIn(old && old.movement_date);
  const note = textIn(old ? old.note : '', { placeholder: 'কারণ (ঐচ্ছিক)', maxlength: 200 });
  formSheet(`${b.label} — স্টক ঠিক করা`, [h('p', { class: 'muted' }, `এখন স্টকে: ${fmt(b.onHand)}`), kind, field('কয়টা', qty), field('তারিখ', date), field('নোট', note)], async () => {
    if (!(val(qty) > 0)) throw new Error('পরিমাণ দিন');
    const k = kind.get();
    await save('stock_movements', { id: old ? old.id : undefined, variant_id: variantId, movement_type: k === 'damage' ? 'damage' : 'adjustment', quantity: k === 'in' ? val(qty) : -val(qty), unit_cost: r2(b.avgCost || 0), reference_id: null, movement_date: date.value, note: note.value.trim() || null });
    toast('স্টক ঠিক করা হয়েছে');
  });
}

// =====================================================================
// 🏷️ পণ্য / রং-সাইজ, অ্যাকাউন্ট, কাস্টমার-সাপ্লায়ার
// =====================================================================
export async function openVariantForm(variantId) {
  const L = await load();
  const v = variantId ? L.vMap.get(variantId) : null, p = v && L.pMap.get(v.product_id);
  const listId = uid();
  const name = textIn(p ? p.name : '', { list: listId, required: true, placeholder: 'পণ্যের নাম' });
  const color = textIn(v ? v.color : '', { placeholder: 'রং' }), size = textIn(v ? v.size : '', { placeholder: 'সাইজ' });
  const buy = numIn(v ? v.default_buy_price : '', { placeholder: 'কেনা দাম' }), sell = numIn(v ? v.default_sell_price : '', { placeholder: 'বিক্রির দাম' });
  const lowS = numIn(v ? v.low_stock_threshold : 3, { min: '0' });
  formSheet(v ? 'পণ্য এডিট' : 'নতুন পণ্য', [
    field('নাম', name, v ? 'নাম বদলালে এই পণ্যের সব রং-সাইজে বদলাবে' : null), h('datalist', { id: listId }, L.products.map((x) => h('option', { value: x.name }))),
    h('div', { class: 'grid2' }, field('রং', color), field('সাইজ', size)), h('div', { class: 'grid2' }, field('কেনা দাম ৳', buy), field('বিক্রির দাম ৳', sell)),
    field('স্টক কমে গেলে সতর্ক করো (পিস)', lowS)
  ], async () => {
    const pn = name.value.trim();
    if (!pn) throw new Error('নাম দিন');
    let prod = v ? p : L.products.find((x) => low(x.name) === low(pn));
    if (v && p.name !== pn) prod = await save('products', { ...p, name: pn });
    if (!prod) prod = await save('products', { name: pn, category: null, unit: 'pc', description: null });
    const dup = L.variants.find((x) => x.id !== (v && v.id) && x.product_id === prod.id && low(x.color) === low(color.value) && low(x.size) === low(size.value));
    if (dup) throw new Error('এই রং-সাইজ আগেই আছে');
    await save('product_variants', { id: v ? v.id : undefined, product_id: prod.id, sku: v ? v.sku : null, color: color.value.trim() || null, size: size.value.trim() || null, default_buy_price: r2(val(buy)), default_sell_price: r2(val(sell)), low_stock_threshold: Math.round(val(lowS)) });
    toast('পণ্য সেভ হয়েছে');
  });
}

export async function openAccountForm(id) {
  const L = await load();
  const a = id ? L.aMap.get(id) : null;
  const name = textIn(a ? a.name : '', { required: true, placeholder: 'যেমন: ক্যাশ, বিকাশ, নগদ, ব্যাংক' });
  const type = selectIn([['cash', 'ক্যাশ'], ['mobile_banking', 'মোবাইল ব্যাংকিং'], ['bank', 'ব্যাংক'], ['other', 'অন্যান্য']], a ? a.type : 'cash');
  const ob = numIn(a ? a.opening_balance : '', { placeholder: '০', min: undefined });
  const active = h('input', { type: 'checkbox' }); active.checked = a ? a.is_active !== 0 : true;
  formSheet(a ? 'অ্যাকাউন্ট এডিট' : 'নতুন অ্যাকাউন্ট', [
    field('নাম', name), field('ধরন', type), field('এই অ্যাপ শুরুর আগে ব্যালেন্স ছিল ৳', ob, 'এটা "শুরুর পুঁজি" হিসেবে ধরা হবে'), h('label', { class: 'check' }, active, ' চালু আছে')
  ], async () => {
    if (!name.value.trim()) throw new Error('নাম দিন');
    await save('accounts', { id: a ? a.id : undefined, name: name.value.trim(), type: type.value, account_number: a ? a.account_number : null, opening_balance: r2(val(ob)), is_active: active.checked ? 1 : 0 });
    toast('অ্যাকাউন্ট সেভ হয়েছে');
  });
}

export async function openPartyForm(kind, id) {
  const L = await load();
  const table = kind === 'customer' ? 'customers' : 'suppliers';
  const p = id ? L.raw[table].find((x) => x.id === id) : null;
  const name = textIn(p ? p.name : '', { required: true }), phone = textIn(p ? p.phone : '', { type: 'tel', inputmode: 'tel' }), address = textIn(p ? p.address : '', { maxlength: 200 });
  formSheet((p ? 'এডিট' : 'নতুন') + (kind === 'customer' ? ' কাস্টমার' : ' সাপ্লায়ার'), [field('নাম', name), field('ফোন', phone), field('ঠিকানা', address)], async () => {
    if (!name.value.trim()) throw new Error('নাম দিন');
    await save(table, { id: p ? p.id : undefined, name: name.value.trim(), phone: phone.value.trim() || null, address: address.value.trim() || null, note: p ? p.note : null });
    toast('সেভ হয়েছে');
  });
}

export { STATUS_LABEL, todayStr };
