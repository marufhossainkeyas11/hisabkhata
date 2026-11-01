// IndexedDB layer + outbox. DOM-free: runs in the page AND in the service worker.
export const TABLES = [
  'accounts', 'capital_entries', 'account_transfers', 'suppliers', 'customers',
  'products', 'product_variants', 'purchases', 'purchase_items', 'expenses',
  'sales', 'sale_items', 'due_payments', 'returns', 'stock_movements'
];
const DB_NAME = 'hisabkhata';
const DB_VERSION = 1;

// ---- events (works across page / service worker / other tabs) ----
const listeners = new Set();
const bus = new BroadcastChannel('hk-events');
bus.onmessage = (e) => listeners.forEach((fn) => fn(e.data));
export const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = (evt) => { listeners.forEach((fn) => fn(evt)); bus.postMessage(evt); };

// ---- low-level helpers ----
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

let dbp = null;
export function openDB() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const t of TABLES) {
          if (!db.objectStoreNames.contains(t)) {
            db.createObjectStore(t, { keyPath: 'id' }).createIndex('updated_at', 'updated_at');
          }
        }
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
      r.onerror = () => { dbp = null; reject(r.error); };
    });
  }
  return dbp;
}

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    let p;
    try { p = Promise.resolve(fn(t)); } catch (e) { p = Promise.reject(e); }
    p.then((r) => { result = r; }).catch((e) => { try { t.abort(); } catch {} reject(e); });
  });
}

export const uuid = () => crypto.randomUUID();

// ---- reads ----
export async function getAll(table, { includeDeleted = false } = {}) {
  const rows = await tx([table], 'readonly', (t) => req(t.objectStore(table).getAll()));
  return includeDeleted ? rows : rows.filter((r) => !r.is_deleted);
}
export const get = (table, id) => tx([table], 'readonly', (t) => req(t.objectStore(table).get(id)));

// ---- writes: record + outbox op in ONE transaction (optimistic, offline-safe) ----
export async function save(table, data) {
  if (!TABLES.includes(table)) throw new Error('Unknown table: ' + table);
  const now = Date.now();
  const rec = await tx([table, 'outbox'], 'readwrite', async (t) => {
    const store = t.objectStore(table);
    const id = data.id || uuid();
    const old = data.id ? await req(store.get(id)) : null;
    const rec = {
      is_deleted: 0,
      ...(old || {}),
      ...data,
      id,
      created_at: (old && old.created_at) || data.created_at || now,
      updated_at: now
    };
    await req(store.put(rec));
    await req(t.objectStore('outbox').add({
      opId: uuid(), table, opType: old ? 'UPDATE' : 'INSERT', payload: rec, ts: now
    }));
    return rec;
  });
  emit({ type: 'local-change' });
  return rec;
}

// Soft delete (tombstone). Undo = save(table, { ...rec, is_deleted: 0 })
export async function remove(table, id) {
  if (!TABLES.includes(table)) throw new Error('Unknown table: ' + table);
  const now = Date.now();
  const ok = await tx([table, 'outbox'], 'readwrite', async (t) => {
    const store = t.objectStore(table);
    const old = await req(store.get(id));
    if (!old) return false;
    await req(store.put({ ...old, is_deleted: 1, updated_at: now }));
    await req(t.objectStore('outbox').add({
      opId: uuid(), table, opType: 'DELETE', payload: { id, updated_at: now }, ts: now
    }));
    return true;
  });
  if (ok) emit({ type: 'local-change' });
  return ok;
}

// ---- outbox ----
export const outboxAll = () => tx(['outbox'], 'readonly', (t) => req(t.objectStore('outbox').getAll()));
export const outboxRemove = (seqs) => tx(['outbox'], 'readwrite', (t) => { seqs.forEach((s) => t.objectStore('outbox').delete(s)); });
export const outboxPut = (items) => tx(['outbox'], 'readwrite', (t) => { items.forEach((i) => t.objectStore('outbox').put(i)); });

// ---- apply server changes (last-write-wins by updated_at) ----
export async function applyRemote(deltas) {
  const tables = Object.keys(deltas).filter((t) => TABLES.includes(t) && deltas[t] && deltas[t].length);
  if (!tables.length) return 0;
  let n = 0;
  await tx(tables, 'readwrite', async (t) => {
    for (const table of tables) {
      const store = t.objectStore(table);
      for (const row of deltas[table]) {
        const local = await req(store.get(row.id));
        if (!local || row.updated_at >= local.updated_at) { store.put(row); n++; }
      }
    }
  });
  return n;
}

// ---- meta (cursor, lastSync, cached user) ----
export async function metaGet(key, fallback = null) {
  const r = await tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').get(key)));
  return r ? r.value : fallback;
}
export const metaSet = (key, value) => tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').put({ key, value }); });