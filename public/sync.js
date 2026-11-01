// Sync engine: DOM-free, runs in the page and in the service worker (Background Sync).
import { outboxAll, outboxRemove, outboxPut, applyRemote, metaGet, metaSet, emit } from './db.js';

export class AuthError extends Error {}
const BATCH = 50;

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'HisabKhataClient',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && data && data.error === 'Unauthorized') throw new AuthError('Unauthorized');
  if (!res.ok || (data && data.ok === false)) {
    const e = new Error((data && data.error) || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

async function push() {
  for (let guard = 0; guard < 200; guard++) {
    const items = (await outboxAll()).filter((o) => !o.failed).slice(0, BATCH);
    if (!items.length) return;
    
    const data = await api('/api/sync', {
      method: 'POST',
      body: { ops: items.map(({ opId, table, opType, payload }) => ({ opId, table, opType, payload })) }
    });
    
    const done = new Set(data.processedOpIds || []);
    const rejected = new Map((data.rejected || []).map((r) => [r.opId, r.error || 'rejected']));
    const ackSeqs = items.filter((o) => done.has(o.opId)).map((o) => o.seq);
    const failed = items
      .filter((o) => rejected.has(o.opId))
      .map((o) => ({ ...o, failed: { error: String(rejected.get(o.opId)), at: Date.now() } }));
    
    if (!ackSeqs.length && !failed.length) throw new Error('Sync made no progress');
    await outboxRemove(ackSeqs); // acknowledged ops leave the queue
    await outboxPut(failed); // rejected ops are parked so they never block the queue
    emit({ type: 'outbox-changed' });
  }
}

async function pull() {
  let cursor = await metaGet('cursor', 0);
  for (let guard = 0; guard < 100; guard++) {
    const data = await api(`/api/sync?since=${encodeURIComponent(cursor)}`);
    const changed = await applyRemote(data.deltas || {});
    if (data.hasMore && !(data.cursor > cursor)) throw new Error('Sync cursor stalled');
    cursor = data.cursor;
    await metaSet('cursor', cursor);
    if (changed) emit({ type: 'data-changed' });
    if (!data.hasMore) return;
  }
}

async function exec() {
  emit({ type: 'sync-start' });
  try {
    await push();
    await pull();
    await metaSet('lastSync', Date.now());
    emit({ type: 'sync-done' });
    return { ok: true };
  } catch (e) {
    const reason = e instanceof AuthError ? 'auth' : e instanceof TypeError ? 'network' : 'error';
    emit({ type: 'sync-fail', reason, message: String((e && e.message) || e) });
    return { ok: false, reason, message: String((e && e.message) || e) };
  }
}

export function runSync() {
  if (!navigator.onLine) return Promise.resolve({ ok: false, reason: 'offline' });
  if (navigator.locks) {
    // one sync at a time across tabs and the service worker
    return navigator.locks.request('hk-sync', { ifAvailable: true }, (lock) =>
      lock ? exec() : { ok: false, reason: 'busy' });
  }
  return exec();
}