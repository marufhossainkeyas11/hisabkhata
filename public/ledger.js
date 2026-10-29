// হিসাব ইঞ্জিন: কোনো ব্যালেন্স সেভ হয় না। সবকিছু ইভেন্ট (কেনা/বেচা/খরচ/ট্রান্সফার) থেকে হিসাব হয়।
// ডেবিট-ক্রেডিট ইউজারকে দেখতে হয় না; ভেতরে "হিসাব মিলছে কি না" যাচাই হয় (reconcile)।
import { getAll } from './db.js';

const n = (v) => Number(v) || 0;
const sum = (arr, f) => arr.reduce((s, x) => s + n(f(x)), 0);
const r2 = (v) => Math.round(v * 100) / 100;

// কেনার সময় ভাড়া/লেবার (extra_costs) প্রতিটি পণ্যে দামের অনুপাতে ভাগ হয়ে landed cost হয়।
export function landedUnitCosts(items, extraCosts) {
  const sub = sum(items, (i) => i.quantity * i.raw_unit_cost);
  const k = sub > 0 ? n(extraCosts) / sub : 0;
  return items.map((i) => r2(n(i.raw_unit_cost) * (1 + k)));
}

// একটা বিক্রির লাভ (পণ্য লাভ + ডেলিভারি লাভ − ফি)
export function saleProfit(sale, items) {
  const revenue = n(sale.subtotal) - n(sale.discount);
  const cogs = sum(items, (i) => i.quantity * i.unit_cogs);
  const delivery = n(sale.delivery_charge_customer) - n(sale.actual_courier_cost);
  return r2(revenue - cogs + delivery - n(sale.fee_incurred));
}

export function compute(d) {
  const live = (rows) => rows.filter((r) => !r.is_deleted);
  const sales = live(d.sales).filter((s) => s.status !== 'cancelled');
  const saleIds = new Set(sales.map((s) => s.id));
  const purchases = live(d.purchases);
  const purIds = new Set(purchases.map((p) => p.id));
  const saleItems = live(d.sale_items).filter((i) => saleIds.has(i.sale_id));
  const purItems = live(d.purchase_items).filter((i) => purIds.has(i.purchase_id));
  const returns = live(d.returns).filter((r) => saleIds.has(r.sale_id));
  const moves = live(d.stock_movements); // শুধু opening / adjust / damage; কেনা-বেচা আলাদা কপি হয় না
  const dues = live(d.due_payments);
  const expenses = live(d.expenses);
  const transfers = live(d.account_transfers);
  const capital = live(d.capital_entries);
  const saleById = new Map(sales.map((s) => [s.id, s]));
  const purById = new Map(purchases.map((p) => [p.id, p]));

  // ---- পণ্যের স্টক + গড় খরচ (weighted average), তারিখ অনুযায়ী replay ----
  const ev = [];
  purItems.forEach((i) => ev.push({ v: i.variant_id, q: n(i.quantity), c: n(i.landed_unit_cost), t: purById.get(i.purchase_id).purchase_date, o: i.created_at, k: 'in' }));
  saleItems.forEach((i) => ev.push({ v: i.variant_id, q: -n(i.quantity), t: saleById.get(i.sale_id).sale_date, o: i.created_at, k: 'out' }));
  returns.forEach((r) => {
    if (!r.restock) return;
    const si = saleItems.find((i) => i.sale_id === r.sale_id && i.variant_id === r.variant_id);
    ev.push({ v: r.variant_id, q: n(r.quantity), c: si ? n(si.unit_cogs) : 0, t: r.return_date, o: r.created_at, k: 'in' });
  });
  moves.forEach((m) => ev.push({ v: m.variant_id, q: n(m.quantity), c: n(m.unit_cost), t: m.movement_date, o: m.created_at, k: n(m.quantity) >= 0 ? (m.movement_type === 'opening' ? 'open' : 'in') : 'loss' }));
  ev.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : n(a.o) - n(b.o)));

  const stock = {}; // variantId -> { qty, avg }
  let openingStockValue = 0, stockLoss = 0;
  for (const e of ev) {
    const s = (stock[e.v] ||= { qty: 0, avg: 0 });
    if (e.q > 0) {
      const tot = s.qty + e.q;
      s.avg = tot > 0 ? (s.qty * s.avg + e.q * e.c) / tot : e.c;
      s.qty = tot;
      if (e.k === 'open') openingStockValue += e.q * e.c;
    } else {
      if (e.k === 'loss') stockLoss += -e.q * s.avg;
      s.qty += e.q;
    }
  }
  const stockValue = r2(Object.values(stock).reduce((t, s) => t + Math.max(s.qty, 0) * s.avg, 0));

  // ---- অ্যাকাউন্ট ব্যালেন্স (ক্যাশ/বিকাশ/ব্যাংক) ----
  const bal = {};
  live(d.accounts).forEach((a) => { bal[a.id] = n(a.opening_balance); });
  const add = (id, v) => { if (id in bal) bal[id] += v; };
  capital.forEach((c) => add(c.account_id, c.type === 'withdraw' ? -n(c.amount) : n(c.amount)));
  transfers.forEach((t) => { add(t.from_account_id, -(n(t.amount) + n(t.fee))); add(t.to_account_id, n(t.amount)); });
  purchases.forEach((p) => add(p.account_id, -n(p.amount_paid)));
  expenses.forEach((e) => add(e.account_id, -n(e.amount)));
  sales.forEach((s) => add(s.account_id, n(s.amount_received) - n(s.actual_courier_cost) - n(s.fee_incurred)));
  dues.forEach((p) => add(p.account_id, p.type === 'supplier_payment' ? -n(p.amount) : n(p.amount)));
  returns.forEach((r) => add(r.account_id, -n(r.refund_amount)));
  const cash = r2(Object.values(bal).reduce((t, v) => t + v, 0));

  // ---- পাওনা / দেনা ----
  const creditNotes = sum(returns.filter((r) => !r.account_id), (r) => r.refund_amount);
  const receivable = r2(sum(sales, (s) => s.due_amount) - sum(dues.filter((p) => p.type !== 'supplier_payment'), (p) => p.amount) - creditNotes);
  const payable = r2(sum(purchases, (p) => p.due_amount) - sum(dues.filter((p) => p.type === 'supplier_payment'), (p) => p.amount));

  // ---- লাভ ----
  const itemsBySale = {};
  saleItems.forEach((i) => (itemsBySale[i.sale_id] ||= []).push(i));
  const grossProfit = sum(sales, (s) => saleProfit(s, itemsBySale[s.id] || []));
  const returnImpact = returns.reduce((t, r) => {
    const si = saleItems.find((i) => i.sale_id === r.sale_id && i.variant_id === r.variant_id);
    return t - n(r.refund_amount) + (r.restock && si ? n(r.quantity) * n(si.unit_cogs) : 0);
  }, 0);
  const opex = sum(expenses, (e) => e.amount);
  const transferFees = sum(transfers, (t) => t.fee);
  const netProfit = r2(grossProfit + returnImpact - opex - transferFees - stockLoss);

  // ---- মিলন যাচাই: মোট সম্পদ − দেনা = পুঁজি + লাভ ----
  const equity = r2(cash + receivable + stockValue - payable);
  const capitalNet = r2(sum(live(d.accounts), (a) => a.opening_balance)
    + sum(capital, (c) => (c.type === 'withdraw' ? -n(c.amount) : n(c.amount))) + openingStockValue);
  const diff = r2(equity - (capitalNet + netProfit));

  const byCategory = {};
  expenses.forEach((e) => { byCategory[e.category] = r2((byCategory[e.category] || 0) + n(e.amount)); });

  return { cash, balances: bal, receivable, payable, stockValue, stock, equity, capitalNet,
    grossProfit: r2(grossProfit), returnImpact: r2(returnImpact), opex: r2(opex), transferFees: r2(transferFees),
    stockLoss: r2(stockLoss), netProfit, reconcileDiff: diff, balanced: Math.abs(diff) < 0.01, expensesByCategory: byCategory };
}

export async function loadAndCompute() {
  const names = ['accounts', 'capital_entries', 'account_transfers', 'purchases', 'purchase_items', 'expenses',
    'sales', 'sale_items', 'due_payments', 'returns', 'stock_movements'];
  const rows = await Promise.all(names.map((t) => getAll(t, { includeDeleted: true })));
  return compute(Object.fromEntries(names.map((t, i) => [t, rows[i]])));
}
