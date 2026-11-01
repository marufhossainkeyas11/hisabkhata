// হিসাবের ইঞ্জিন — pure JS (DOM নেই, IndexedDB নেই, নেটওয়ার্ক নেই)।
// ইনপুট : ১৫টা সিঙ্ক টেবিলের কাঁচা রো ("সোর্স ডকুমেন্ট": বিক্রি, ক্রয়, খরচ...)
// আউটপুট: ডাবল-এন্ট্রি জার্নাল, টাইমলাইন, পণ্যভিত্তিক খাতা, পার্টি স্টেটমেন্ট, সামারি
// কিছুই জমা রাখা হয় না — প্রতিবার ডকুমেন্ট থেকে নতুন করে হিসাব হয়। তাই অফলাইন এডিট বা
// সিঙ্কের ক্রম যাই হোক, হিসাব কখনো নিজের সাথে গরমিল করতে পারে না।

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const live = (rows) => (rows || []).filter((r) => !r.is_deleted);
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byCreated = (a, b) => num(a.created_at) - num(b.created_at) || cmp(a.id, b.id);
const group = (arr, key) => {
  const m = new Map();
  for (const x of arr) { const k = x[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
};
const qtyText = (n) => String(r2(n));

export const EXPENSE_CATEGORIES = ['ভাড়া', 'খাবার', 'যাতায়াত', 'প্যাকেজিং', 'বিজ্ঞাপন', 'বেতন', 'ইউটিলিটি', 'ক্যাশআউট চার্জ', 'অন্যান্য'];
export const STATUS_LABEL = { delivered: 'ডেলিভারড', pending: 'পেন্ডিং', returned: 'রিটার্ন', cancelled: 'বাতিল' };
export const CASH_LABEL = {
  opening: 'শুরুর ব্যালেন্স', capital_in: 'পুঁজি জমা', capital_out: 'পুঁজি উত্তোলন',
  sale_in: 'বিক্রির টাকা', due_in: 'বাকি আদায়', purchase_out: 'মাল কেনা', supplier_out: 'সাপ্লায়ার পরিশোধ',
  courier_out: 'কুরিয়ার খরচ', fee_out: 'ক্যাশআউট/ট্রান্সফার ফি', refund_out: 'ফেরত দেওয়া টাকা', transfer: 'অ্যাকাউন্ট ট্রান্সফার'
};

// ---- হিসাবের খাত (chart of accounts) ----
// m:<id> = টাকার অ্যাকাউন্ট (ক্যাশ/বিকাশ...), x:<ক্যাটাগরি> = খরচের ধরন
export const isMoney = (a) => a.startsWith('m:');
export const isIncome = (a) => a === 'REV' || a === 'DELIV';
export const isExpense = (a) => a.startsWith('x:') || a === 'COGS' || a === 'COURIER' || a === 'FEE' || a === 'LOSS';

export function buildLedger(data) {
  const rows = (k) => live(data[k]);
  const accounts = rows('accounts').sort(byCreated);
  const customers = rows('customers');
  const suppliers = rows('suppliers');
  const products = rows('products');
  const variants = rows('product_variants');
  const aMap = byId(accounts), cMap = byId(customers), sMap = byId(suppliers), pMap = byId(products), vMap = byId(variants);

  const purchases = rows('purchases');
  const sales = rows('sales');
  const pIds = new Set(purchases.map((p) => p.id));
  const sIds = new Set(sales.map((s) => s.id));
  const pItemsBy = group(rows('purchase_items').filter((i) => pIds.has(i.purchase_id)).sort(byCreated), 'purchase_id');
  const sItemsBy = group(rows('sale_items').filter((i) => sIds.has(i.sale_id)).sort(byCreated), 'sale_id');

  const fallbackAcct = accounts[0] ? accounts[0].id : 'none';
  const M = (id) => 'm:' + (aMap.has(id) ? id : fallbackAcct);
  const vLabel = (id) => {
    const v = vMap.get(id);
    if (!v) return '(মোছা পণ্য)';
    const p = pMap.get(v.product_id);
    return [p ? p.name : '?', v.color, v.size].filter(Boolean).join(' · ');
  };
  const itemsText = (items) => items.map((i) => `${vLabel(i.variant_id)} ×${qtyText(i.quantity)}`).join(', ');
  const issues = [];

  // ===== ধাপ ১: ক্রয় — ল্যান্ডেড কস্ট (ভাড়া/ট্রান্সপোর্ট সব আইটেমে ভাগ হয়) =====
  const purchaseCalc = new Map();
  const ev = []; // স্টক ইভেন্ট
  for (const p of purchases) {
    const items = pItemsBy.get(p.id) || [];
    const lineVals = items.map((i) => r2(num(i.quantity) * num(i.raw_unit_cost)));
    const sub = r2(lineVals.reduce((s, x) => s + x, 0));
    const extra = r2(num(p.extra_costs));
    let left = extra;
    const lines = items.map((i, idx) => {
      const ex = idx === items.length - 1 ? left : r2(sub > 0 ? (extra * lineVals[idx]) / sub : extra / items.length);
      left = r2(left - ex);
      const value = r2(lineVals[idx] + ex);
      ev.push({ t: 'in', pri: 0, date: p.purchase_date, ts: p.created_at, id: i.id, variantId: i.variant_id, qty: num(i.quantity), value, label: 'ক্রয়', who: sMap.has(p.supplier_id) ? sMap.get(p.supplier_id).name : '' });
      return { item: i, raw: lineVals[idx], extra: ex, value };
    });
    purchaseCalc.set(p.id, { sub, extra, total: r2(sub + extra), lines });
  }

  // ===== ধাপ ২: বিক্রি/ফেরত/নষ্ট — স্টক ইভেন্ট =====
  const saleCalc = new Map();
  for (const s of sales) {
    const items = sItemsBy.get(s.id) || [];
    const lineTotals = items.map((i) => r2(num(i.quantity) * num(i.unit_price)));
    const subtotal = r2(lineTotals.reduce((a, x) => a + x, 0));
    const discount = r2(num(s.discount));
    const status = s.status || 'delivered';
    const cust = cMap.has(s.customer_id) ? cMap.get(s.customer_id).name : '';
    saleCalc.set(s.id, { subtotal, discount, revenue: r2(subtotal - discount), lineTotals, items, status });
    items.forEach((i) => {
      if (status === 'delivered') ev.push({ t: 'out', pri: 1, date: s.sale_date, ts: s.created_at, id: i.id, saleId: s.id, variantId: i.variant_id, qty: num(i.quantity), label: 'বিক্রি', who: cust });
      else if (status === 'pending') ev.push({ t: 'reserve', pri: 1, date: s.sale_date, ts: s.created_at, id: i.id, saleId: s.id, variantId: i.variant_id, qty: num(i.quantity), label: 'অর্ডার (পথে)', who: cust });
    });
  }
  const returns = rows('returns').filter((r) => sIds.has(r.sale_id));
  for (const r of returns) {
    if (r.restock) {
      const s = sales.find((x) => x.id === r.sale_id);
      ev.push({ t: 'ret', pri: 2, date: r.return_date, ts: r.created_at, id: r.id, saleId: r.sale_id, variantId: r.variant_id, qty: num(r.quantity), label: 'ফেরত', who: s && cMap.has(s.customer_id) ? cMap.get(s.customer_id).name : '' });
    }
  }
  const moves = rows('stock_movements').filter((m) => ['damage', 'adjustment', 'adjust'].includes(m.movement_type));
  for (const m of moves) {
    const q = num(m.quantity);
    if (q < 0) ev.push({ t: 'loss', pri: 3, date: m.movement_date, ts: m.created_at, id: m.id, variantId: m.variant_id, qty: -q, label: m.movement_type === 'damage' ? 'নষ্ট' : 'কম (অ্যাডজাস্ট)', who: m.note || '' });
    else if (q > 0) ev.push({ t: 'gain', pri: 3, date: m.movement_date, ts: m.created_at, id: m.id, variantId: m.variant_id, qty: q, unit: num(m.unit_cost), label: 'বেশি (অ্যাডজাস্ট)', who: m.note || '' });
  }

  // ===== ধাপ ৩: মুভিং ওয়েটেড-অ্যাভারেজ রিপ্লে (তারিখ অনুযায়ী, ডেটা ঢোকার ক্রম নয়) =====
  ev.sort((a, b) => cmp(a.date, b.date) || a.pri - b.pri || num(a.ts) - num(b.ts) || cmp(a.id, b.id));
  const st = new Map();
  const S = (vid) => {
    if (!st.has(vid)) st.set(vid, { qty: 0, value: 0, last: 0, reserved: 0, boughtQty: 0, boughtCost: 0, soldQty: 0, cogs: 0, retQty: 0, retValue: 0, lossQty: 0, lossValue: 0, rows: [] });
    return st.get(vid);
  };
  const itemCost = new Map();   // sale item id -> COGS
  const saleLine = new Map();   // saleId|variantId -> {qty, cost}
  const retCost = new Map();    // return id -> restock value
  const moveCost = new Map();   // stock movement id -> value
  const takeOut = (s, q, v) => {
    const fb = s.last || num(v && v.default_buy_price);
    if (s.qty > 0 && q <= s.qty + 1e-9) return Math.abs(q - s.qty) < 1e-9 ? r2(s.value) : r2((q * s.value) / s.qty);
    if (s.qty > 0) return r2(s.value + (q - s.qty) * (s.last || fb)); // স্টকের বেশি বিক্রি
    return r2(q * fb);
  };
  const refresh = (s) => { if (s.qty > 1e-9) s.last = s.value / s.qty; };
  for (const e of ev) {
    const s = S(e.variantId), v = vMap.get(e.variantId);
    const row = { date: e.date, kind: e.t, label: e.label, who: e.who, qtyIn: 0, qtyOut: 0 };
    if (e.t === 'in') {
      s.qty += e.qty; s.value = r2(s.value + e.value); s.boughtQty += e.qty; s.boughtCost = r2(s.boughtCost + e.value); refresh(s);
      row.qtyIn = e.qty; row.unit = e.qty ? e.value / e.qty : 0;
    } else if (e.t === 'out') {
      const cost = takeOut(s, e.qty, v);
      s.qty -= e.qty; s.value = r2(s.value - cost); s.soldQty += e.qty; s.cogs = r2(s.cogs + cost); refresh(s);
      itemCost.set(e.id, cost);
      const k = e.saleId + '|' + e.variantId, cur = saleLine.get(k) || { qty: 0, cost: 0 };
      saleLine.set(k, { qty: cur.qty + e.qty, cost: r2(cur.cost + cost) });
      row.qtyOut = e.qty; row.unit = e.qty ? cost / e.qty : 0;
    } else if (e.t === 'reserve') {
      s.reserved += e.qty; row.reserve = e.qty;
    } else if (e.t === 'ret') {
      const sl = saleLine.get(e.saleId + '|' + e.variantId);
      const unit = sl && sl.qty ? sl.cost / sl.qty : (s.qty > 0 ? s.value / s.qty : s.last || num(v && v.default_buy_price));
      const value = r2(e.qty * unit);
      s.qty += e.qty; s.value = r2(s.value + value); s.retQty += e.qty; s.retValue = r2(s.retValue + value); refresh(s);
      retCost.set(e.id, value);
      row.qtyIn = e.qty; row.unit = unit;
    } else if (e.t === 'loss') {
      const cost = takeOut(s, e.qty, v);
      s.qty -= e.qty; s.value = r2(s.value - cost); s.lossQty += e.qty; s.lossValue = r2(s.lossValue + cost); refresh(s);
      moveCost.set(e.id, cost);
      row.qtyOut = e.qty; row.unit = e.qty ? cost / e.qty : 0;
    } else if (e.t === 'gain') {
      const unit = e.unit || (s.qty > 0 ? s.value / s.qty : s.last || num(v && v.default_buy_price));
      const value = r2(e.qty * unit);
      s.qty += e.qty; s.value = r2(s.value + value); refresh(s);
      moveCost.set(e.id, value);
      row.qtyIn = e.qty; row.unit = unit;
    }
    row.balQty = s.qty; row.balValue = s.value;
    s.rows.push(row);
  }

  // ===== ধাপ ৪: জার্নাল (প্রতিটা ঘটনা → ডেবিট/ক্রেডিট) =====
  const entries = [];
  const DR = (acc, x, cat) => { x = r2(x); return x === 0 ? null : x > 0 ? { acc, dr: x, cr: 0, cat } : { acc, dr: 0, cr: -x, cat }; };
  const CR = (acc, x, cat) => DR(acc, -x, cat);
  const post = (o) => {
    const lines = o.lines.filter(Boolean).map((l) => ({ ...l, cat: l.cat || o.cat }));
    entries.push({ party: null, partyDelta: 0, meta: null, profit: undefined, void: false, sub: '', ...o, lines });
  };

  for (const a of accounts) {
    const ob = r2(num(a.opening_balance));
    if (ob) post({ id: 'open:' + a.id, kind: 'opening', table: 'accounts', refId: a.id, date: '0000-00-00', ts: num(a.created_at), title: `শুরুর ব্যালেন্স · ${a.name}`, cat: 'opening', lines: [DR('m:' + a.id, ob), CR('CAP', ob)] });
  }

  for (const c of rows('capital_entries')) {
    const amt = r2(num(c.amount)), inv = c.type === 'investment', m = M(c.account_id);
    post({ id: 'cap:' + c.id, kind: 'capital', table: 'capital_entries', refId: c.id, date: c.date, ts: num(c.created_at), title: inv ? 'পুঁজি জমা' : 'পুঁজি উত্তোলন', sub: c.note || '', cat: inv ? 'capital_in' : 'capital_out', lines: inv ? [DR(m, amt), CR('CAP', amt)] : [DR('CAP', amt), CR(m, amt)] });
  }

  for (const t of rows('account_transfers')) {
    const amt = r2(num(t.amount)), fee = r2(num(t.fee)), from = M(t.from_account_id), to = M(t.to_account_id);
    post({ id: 'trf:' + t.id, kind: 'transfer', table: 'account_transfers', refId: t.id, date: t.date, ts: num(t.created_at), title: `ট্রান্সফার · ${labelOf(from)} → ${labelOf(to)}`, sub: t.note || '', cat: 'transfer', lines: [DR(to, amt, 'transfer'), CR(from, amt, 'transfer'), DR('FEE', fee), CR(from, fee, 'fee_out')] });
  }

  for (const x of rows('expenses')) {
    const amt = r2(num(x.amount)), cat = (x.category || 'অন্যান্য').trim();
    post({ id: 'exp:' + x.id, kind: 'expense', table: 'expenses', refId: x.id, date: x.expense_date, ts: num(x.created_at), title: `খরচ · ${cat}`, sub: x.note || '', cat: 'x:' + cat, lines: [DR('x:' + cat, amt), CR(M(x.account_id), amt)] });
  }

  for (const p of purchases) {
    const c = purchaseCalc.get(p.id), paid = r2(num(p.amount_paid)), due = r2(c.total - paid), m = M(p.account_id);
    const sup = sMap.get(p.supplier_id);
    post({
      id: 'buy:' + p.id, kind: 'purchase', table: 'purchases', refId: p.id, date: p.purchase_date, ts: num(p.created_at),
      title: `ক্রয়${sup ? ' · ' + sup.name : ''}`, sub: itemsText(pItemsBy.get(p.id) || []), cat: 'purchase_out',
      lines: [DR('INV', c.total), CR(m, paid), CR('AP', due)],
      party: sup ? { type: 'supplier', id: sup.id } : null, partyDelta: due,
      meta: { sub: c.sub, extra: c.extra, total: c.total, paid, due, items: c.lines.map((l) => ({ label: vLabel(l.item.variant_id), qty: num(l.item.quantity), raw: num(l.item.raw_unit_cost), landed: l.value / (num(l.item.quantity) || 1) })) }
    });
  }

  const saleInfo = new Map();
  for (const s of sales) {
    const c = saleCalc.get(s.id), status = c.status;
    const delivery = r2(num(s.delivery_charge_customer)), courier = r2(num(s.actual_courier_cost)), fee = r2(num(s.fee_incurred));
    const received = r2(num(s.amount_received)), net = r2(c.revenue + delivery);
    const cust = cMap.get(s.customer_id);
    if (received > 0 && !aMap.has(s.account_id)) issues.push(`বিক্রি ${s.invoice_no || ''}: অ্যাকাউন্ট ঠিক করা নেই`);
    const m = M(s.account_id);
    const cogs = r2(c.items.reduce((a, i) => a + (itemCost.get(i.id) || 0), 0));
    const lines = [];
    let partyDelta = 0, profit;
    if (status === 'delivered') {
      const due = r2(net - received);
      lines.push(DR(m, received, 'sale_in'), DR('AR', due), CR('REV', c.revenue), CR('DELIV', delivery), DR('COGS', cogs), CR('INV', cogs));
      partyDelta = due;
      profit = r2(c.revenue + delivery - cogs - courier - fee);
    } else if (status === 'pending') {
      lines.push(DR(m, received, 'sale_in'), CR('ADV', received));
      partyDelta = -received;
    } else if (status === 'returned') {
      profit = r2(-courier - fee);
    }
    if (status !== 'cancelled') lines.push(DR('COURIER', courier), DR('FEE', fee), CR(m, courier, 'courier_out'), CR(m, fee, 'fee_out'));
    const items = c.items.map((i, idx) => ({ label: vLabel(i.variant_id), qty: num(i.quantity), price: num(i.unit_price), total: c.lineTotals[idx], cost: itemCost.get(i.id) || 0 }));
    const info = { id: s.id, invoice: s.invoice_no, status, customerId: s.customer_id, customer: cust ? cust.name : '', subtotal: c.subtotal, discount: c.discount, revenue: c.revenue, delivery, courier, fee, net, received, due: status === 'delivered' ? r2(net - received) : 0, cogs, profit, items, rawItems: c.items };
    saleInfo.set(s.id, info);
    post({
      id: 'sale:' + s.id, kind: 'sale', table: 'sales', refId: s.id, date: s.sale_date, ts: num(s.created_at),
      title: `${status === 'delivered' || status === 'pending' ? 'বিক্রি' : STATUS_LABEL[status] || 'বিক্রি'}${cust ? ' · ' + cust.name : ''}`,
      sub: itemsText(c.items), cat: 'sale_in', lines, party: cust && status !== 'cancelled' ? { type: 'customer', id: cust.id } : null, partyDelta,
      profit, void: status === 'cancelled', meta: info
    });
  }

  for (const r of returns) {
    const refund = r2(num(r.refund_amount)), si = saleInfo.get(r.sale_id), restock = retCost.get(r.id) || 0;
    const settledCash = r.account_id && aMap.has(r.account_id);
    post({
      id: 'ret:' + r.id, kind: 'return', table: 'returns', refId: r.id, date: r.return_date, ts: num(r.created_at),
      title: `ফেরত${si && si.customer ? ' · ' + si.customer : ''}`, sub: `${vLabel(r.variant_id)} ×${qtyText(r.quantity)}${r.restock ? '' : ' (স্টকে ওঠেনি)'}`, cat: 'refund_out',
      lines: [DR('REV', refund), settledCash ? CR(M(r.account_id), refund, 'refund_out') : CR('AR', refund), DR('INV', restock), CR('COGS', restock)],
      party: si && si.customerId && !settledCash ? { type: 'customer', id: si.customerId } : null, partyDelta: settledCash ? 0 : -refund,
      profit: r2(-refund + restock)
    });
  }

  for (const d of rows('due_payments')) {
    const amt = r2(num(d.amount)), m = M(d.account_id), isCust = d.type === 'customer_receipt';
    const who = isCust ? cMap.get(d.customer_id) : sMap.get(d.supplier_id);
    post({
      id: 'due:' + d.id, kind: isCust ? 'receipt' : 'payment', table: 'due_payments', refId: d.id, date: d.payment_date, ts: num(d.created_at),
      title: `${isCust ? 'বাকি আদায়' : 'সাপ্লায়ারকে পরিশোধ'}${who ? ' · ' + who.name : ''}`, sub: d.note || '', cat: isCust ? 'due_in' : 'supplier_out',
      lines: isCust ? [DR(m, amt), CR('AR', amt)] : [DR('AP', amt), CR(m, amt)],
      party: who ? { type: isCust ? 'customer' : 'supplier', id: who.id } : null, partyDelta: -amt
    });
  }

  for (const m of moves) {
    const q = num(m.quantity), v = moveCost.get(m.id) || 0;
    post({
      id: 'adj:' + m.id, kind: 'adjust', table: 'stock_movements', refId: m.id, date: m.movement_date, ts: num(m.created_at),
      title: `${q < 0 ? (m.movement_type === 'damage' ? 'নষ্ট মাল' : 'স্টক কম') : 'স্টক বেশি'} · ${vLabel(m.variant_id)} ×${qtyText(Math.abs(q))}`, sub: m.note || '', cat: 'adjust',
      lines: q < 0 ? [DR('LOSS', v), CR('INV', v)] : [DR('INV', v), CR('LOSS', v)], profit: q < 0 ? -v : v
    });
  }

  // ===== ধাপ ৫: সাজানো, চলতি ক্যাশ, ব্যালেন্স, ট্রায়াল ব্যালেন্স =====
  entries.sort((a, b) => cmp(a.date, b.date) || a.ts - b.ts || cmp(a.id, b.id));
  const bal = {};
  let running = 0, totalDr = 0, totalCr = 0;
  for (const e of entries) {
    let cash = 0;
    for (const l of e.lines) {
      bal[l.acc] = r2((bal[l.acc] || 0) + l.dr - l.cr);
      totalDr = r2(totalDr + l.dr); totalCr = r2(totalCr + l.cr);
      if (isMoney(l.acc)) cash = r2(cash + l.dr - l.cr);
    }
    running = r2(running + cash);
    e.cashDelta = cash; e.cashAfter = running;
  }

  function labelOf(acc) {
    if (isMoney(acc)) { const a = aMap.get(acc.slice(2)); return a ? a.name : 'অ্যাকাউন্ট'; }
    if (acc.startsWith('x:')) return acc.slice(2);
    return ({ INV: 'মজুত মাল (স্টক)', AR: 'পাওনা (কাস্টমার বাকি)', AP: 'দেনা (সাপ্লায়ার বাকি)', ADV: 'কাস্টমারের অগ্রিম', CAP: 'মূলধন', REV: 'বিক্রয় আয়', DELIV: 'ডেলিভারি চার্জ আয়', COGS: 'বিক্রিত মালের দাম', COURIER: 'কুরিয়ার খরচ', FEE: 'ক্যাশআউট/ট্রান্সফার ফি', LOSS: 'নষ্ট/কম মাল' })[acc] || acc;
  }

  // ===== ধাপ ৬: পার্টি স্টেটমেন্ট (কাস্টমার পাওনা / সাপ্লায়ার দেনা) =====
  const parties = new Map();
  for (const e of entries) {
    if (!e.party || !e.partyDelta && e.kind !== 'sale' && e.kind !== 'purchase') continue;
    const key = e.party.type + ':' + e.party.id;
    if (!parties.has(key)) {
      const src = e.party.type === 'customer' ? cMap.get(e.party.id) : sMap.get(e.party.id);
      parties.set(key, { key, type: e.party.type, id: e.party.id, name: src ? src.name : '?', phone: src ? src.phone : '', balance: 0, orders: 0, total: 0, rows: [] });
    }
    const p = parties.get(key);
    p.balance = r2(p.balance + e.partyDelta);
    if (e.kind === 'sale' && e.meta && e.meta.status === 'delivered') { p.orders += 1; p.total = r2(p.total + e.meta.net); }
    if (e.kind === 'purchase') { p.orders += 1; p.total = r2(p.total + e.meta.total); }
    p.rows.push({ date: e.date, title: e.title, sub: e.sub, delta: e.partyDelta, balance: p.balance, ref: e });
  }
  for (const c of customers) if (!parties.has('customer:' + c.id)) parties.set('customer:' + c.id, { key: 'customer:' + c.id, type: 'customer', id: c.id, name: c.name, phone: c.phone, balance: 0, orders: 0, total: 0, rows: [] });
  for (const s of suppliers) if (!parties.has('supplier:' + s.id)) parties.set('supplier:' + s.id, { key: 'supplier:' + s.id, type: 'supplier', id: s.id, name: s.name, phone: s.phone, balance: 0, orders: 0, total: 0, rows: [] });

  // ===== ধাপ ৭: পণ্যভিত্তিক খাতা (প্রতিটা রং/সাইজের নিজস্ব ইন-আউট-লাভ) =====
  const sold = new Map(); // variantId -> ডিসকাউন্ট বাদে বিক্রির টাকা
  for (const s of sales) {
    const c = saleCalc.get(s.id);
    if (c.status !== 'delivered') continue;
    c.items.forEach((i, idx) => {
      const share = c.subtotal > 0 ? c.lineTotals[idx] - (c.discount * c.lineTotals[idx]) / c.subtotal : c.lineTotals[idx];
      sold.set(i.variant_id, r2((sold.get(i.variant_id) || 0) + share));
    });
  }
  const refunds = new Map();
  for (const r of returns) refunds.set(r.variant_id, r2((refunds.get(r.variant_id) || 0) + num(r.refund_amount)));

  const books = new Map();
  for (const v of variants) {
    const s = st.get(v.id) || S(v.id);
    const revenue = r2((sold.get(v.id) || 0) - (refunds.get(v.id) || 0));
    const cogsNet = r2(s.cogs - s.retValue);
    const profit = r2(revenue - cogsNet);
    books.set(v.id, {
      variant: v, label: vLabel(v.id), productId: v.product_id,
      onHand: s.qty, reserved: s.reserved, available: s.qty - s.reserved, avgCost: s.qty > 1e-9 ? s.value / s.qty : s.last, stockValue: s.value,
      boughtQty: s.boughtQty, boughtCost: s.boughtCost, soldQty: s.soldQty - s.retQty, grossSoldQty: s.soldQty, retQty: s.retQty, lossQty: s.lossQty, lossValue: s.lossValue,
      revenue, cogs: cogsNet, profit, margin: revenue > 0 ? profit / revenue : 0, rows: s.rows,
      low: s.boughtQty > 0 && s.qty <= num(v.low_stock_threshold), negative: s.qty < -1e-9
    });
  }
  const productList = products.map((p) => {
    const vs = variants.filter((v) => v.product_id === p.id).map((v) => books.get(v.id));
    const sum = (k) => r2(vs.reduce((a, b) => a + (b[k] || 0), 0));
    return { product: p, variants: vs, onHand: sum('onHand'), stockValue: sum('stockValue'), revenue: sum('revenue'), cogs: sum('cogs'), profit: sum('profit'), soldQty: sum('soldQty'), boughtQty: sum('boughtQty'), boughtCost: sum('boughtCost') };
  }).sort((a, b) => cmp(a.product.name, b.product.name));

  const L = { entries, bal, accounts, aMap, customers, suppliers, products, variants, vMap, pMap, sMap, cMap, books, productList, parties, saleInfo, issues, labelOf, vLabel, totalDr, totalCr };
  L.audit = audit(L);
  return L;
}

// ---- নিজে নিজেকে যাচাই: হিসাব না মিললে ইউজারকে জানানো ----
function audit(L) {
  const problems = [...L.issues];
  const diff = r2(L.totalDr - L.totalCr);
  if (Math.abs(diff) > 0.01) problems.push(`ডেবিট-ক্রেডিট মিলছে না (পার্থক্য ${diff})`);
  let stock = 0;
  for (const b of L.books.values()) stock = r2(stock + b.stockValue);
  const invDiff = r2((L.bal.INV || 0) - stock);
  if (Math.abs(invDiff) > 0.5) problems.push(`স্টকের মূল্য খাতা ও জার্নালে মিলছে না (পার্থক্য ${invDiff})`);
  for (const b of L.books.values()) if (b.negative) problems.push(`স্টক মাইনাসে: ${b.label} (${r2(b.onHand)}) — ক্রয় এন্ট্রি বাকি আছে?`);
  return { ok: problems.length === 0, problems, diff, invDiff };
}

// ---- বর্তমান ব্যালেন্স (সব সময়ের) ----
export function snapshot(L) {
  const accts = L.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: r2(L.bal['m:' + a.id] || 0), active: a.is_active !== 0 }));
  const cash = r2(accts.reduce((s, a) => s + a.balance, 0));
  const inventory = r2(L.bal.INV || 0), receivable = r2(L.bal.AR || 0), payable = r2(-(L.bal.AP || 0)), advance = r2(-(L.bal.ADV || 0)), capital = r2(-(L.bal.CAP || 0));
  const all = summarize(L);
  const assets = r2(cash + inventory + receivable), liabilities = r2(payable + advance);
  return { accts, cash, inventory, receivable, payable, advance, capital, netProfitAll: all.net, assets, liabilities, equity: r2(assets - liabilities), identityDiff: r2(assets - liabilities - capital - all.net) };
}

// ---- সময়কালের লাভ-ক্ষতি + ক্যাশের গল্প ----
export function summarize(L, from = '', to = '9999-12-31') {
  const pl = {};
  const cash = { open: 0, flow: {}, close: 0 };
  let purchased = 0, salesCount = 0;
  for (const e of L.entries) {
    const inP = e.date >= from && e.date <= to;
    if (inP && e.kind === 'purchase') purchased = r2(purchased + e.meta.total);
    if (inP && e.kind === 'sale' && e.meta.status === 'delivered') salesCount += 1;
    for (const l of e.lines) {
      if (inP && (isIncome(l.acc) || isExpense(l.acc))) pl[l.acc] = r2((pl[l.acc] || 0) + l.cr - l.dr);
      if (isMoney(l.acc)) {
        const v = l.dr - l.cr;
        if (e.date < from) cash.open = r2(cash.open + v);
        else if (e.date <= to) cash.flow[l.cat] = r2((cash.flow[l.cat] || 0) + v);
      }
    }
  }
  cash.close = r2(cash.open + Object.values(cash.flow).reduce((a, b) => a + b, 0));
  const revenue = pl.REV || 0, delivery = pl.DELIV || 0, cogs = r2(-(pl.COGS || 0)), courier = r2(-(pl.COURIER || 0)), fee = r2(-(pl.FEE || 0)), loss = r2(-(pl.LOSS || 0));
  const opex = {};
  let opexTotal = 0;
  for (const [k, v] of Object.entries(pl)) if (k.startsWith('x:')) { opex[k.slice(2)] = r2(-v); opexTotal = r2(opexTotal - v); }
  const gross = r2(revenue - cogs);
  const deliveryNet = r2(delivery - courier);
  const net = r2(gross + deliveryNet - fee - loss - opexTotal);
  return { revenue, cogs, gross, delivery, courier, deliveryNet, fee, loss, opex, opexTotal, net, purchased, spent: r2(purchased + opexTotal + courier + fee), salesCount, cash, margin: revenue > 0 ? net / revenue : 0 };
}

export function monthly(L) {
  const months = new Set(L.entries.filter((e) => e.date > '0001').map((e) => e.date.slice(0, 7)));
  return [...months].sort().reverse().map((m) => ({ month: m, ...summarize(L, m + '-01', m + '-31') }));
}

export const cashLabel = (cat) => (cat.startsWith('x:') ? 'খরচ · ' + cat.slice(2) : CASH_LABEL[cat] || cat);

export function timelineCsv(L) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['তারিখ', 'ধরন', 'বিবরণ', 'বিস্তারিত', 'ক্যাশ পরিবর্তন', 'ক্যাশ (পরে)', 'লাভ'];
  const out = [head.map(esc).join(',')];
  for (const e of L.entries) out.push([e.date, e.kind, e.title, e.sub, e.cashDelta, e.cashAfter, e.profit == null ? '' : e.profit].map(esc).join(','));
  return '﻿' + out.join('\n');
}

export const money2 = r2;
