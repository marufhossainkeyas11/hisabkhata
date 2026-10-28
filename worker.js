/**
 * হিসাবখাতা (HisabKhata) - Core Worker
 * Complete Authentication, Security Headers, Rate Limiting, Sync Engine & Static Asset Router
 */

// ----------------------------------------------------------------------------
// CONSTANTS & SECURITY CONFIG
// ----------------------------------------------------------------------------
const SESSION_COOKIE_NAME = "hk_session";
const SESSION_DURATION_DAYS = 90;
const SESSION_DURATION_SEC = SESSION_DURATION_DAYS * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 100000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_BASE_SECONDS = 30;
const MAX_OPS_PER_REQUEST = 50;

const ALLOWED_COLUMNS = {
  accounts: ["id", "name", "type", "account_number", "opening_balance", "is_active", "is_deleted", "created_at", "updated_at"],
  capital_entries: ["id", "type", "amount", "account_id", "note", "date", "is_deleted", "created_at", "updated_at"],
  account_transfers: ["id", "from_account_id", "to_account_id", "amount", "fee", "note", "date", "is_deleted", "created_at", "updated_at"],
  suppliers: ["id", "name", "phone", "address", "note", "is_deleted", "created_at", "updated_at"],
  customers: ["id", "name", "phone", "address", "note", "is_deleted", "created_at", "updated_at"],
  products: ["id", "name", "category", "unit", "description", "is_deleted", "created_at", "updated_at"],
  product_variants: ["id", "product_id", "sku", "color", "size", "default_buy_price", "default_sell_price", "low_stock_threshold", "is_deleted", "created_at", "updated_at"],
  purchases: ["id", "supplier_id", "account_id", "purchase_date", "subtotal", "extra_costs", "total_cost", "amount_paid", "due_amount", "note", "is_deleted", "created_at", "updated_at"],
  purchase_items: ["id", "purchase_id", "variant_id", "quantity", "raw_unit_cost", "landed_unit_cost", "total_amount", "is_deleted", "created_at", "updated_at"],
  expenses: ["id", "category", "amount", "account_id", "expense_date", "note", "is_recurring", "is_deleted", "created_at", "updated_at"],
  sales: ["id", "invoice_no", "customer_id", "sale_date", "subtotal", "discount", "delivery_charge_customer", "actual_courier_cost", "net_payable", "account_id", "amount_received", "due_amount", "fee_incurred", "status", "source", "note", "is_deleted", "created_at", "updated_at"],
  sale_items: ["id", "sale_id", "variant_id", "quantity", "unit_price", "unit_cogs", "total_price", "is_deleted", "created_at", "updated_at"],
  due_payments: ["id", "customer_id", "supplier_id", "sale_id", "purchase_id", "account_id", "type", "amount", "payment_date", "note", "is_deleted", "created_at", "updated_at"],
  returns: ["id", "sale_id", "variant_id", "quantity", "refund_amount", "account_id", "return_date", "restock", "note", "is_deleted", "created_at", "updated_at"],
  stock_movements: ["id", "variant_id", "movement_type", "quantity", "unit_cost", "reference_id", "movement_date", "note", "is_deleted", "created_at", "updated_at"]
};

const SYNC_TABLES = Object.keys(ALLOWED_COLUMNS);

// ----------------------------------------------------------------------------
// CRYPTOGRAPHIC HELPERS (WebCrypto - constant-time & secure)
// ----------------------------------------------------------------------------

function bufferToHex(buf) {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return bufferToHex(digest);
}

function generateRandomHex(byteCount = 32) {
  const arr = new Uint8Array(byteCount);
  crypto.getRandomValues(arr);
  return bufferToHex(arr.buffer);
}

async function hashPassword(password, saltHex, serverPepper) {
  const enc = new TextEncoder();
  const passKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password + serverPepper),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const salt = hexToBuffer(saltHex);
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    passKey,
    256
  );
  return bufferToHex(derived);
}

// ----------------------------------------------------------------------------
// RESPONSE & SECURITY HEADERS WRAPPER
// ----------------------------------------------------------------------------

function setSecurityHeaders(responseHeaders) {
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  responseHeaders.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  responseHeaders.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
  );
  responseHeaders.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';"
  );
  return responseHeaders;
}

function jsonResponse(data, status = 200, customHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...customHeaders
  });
  setSecurityHeaders(headers);
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function checkEnvVars(env) {
  if (!env.SERVER_PEPPER || typeof env.SERVER_PEPPER !== 'string' || env.SERVER_PEPPER.length === 0) {
    return "Server misconfiguration: SERVER_PEPPER missing.";
  }
  if (!env.SETUP_KEY || typeof env.SETUP_KEY !== 'string' || env.SETUP_KEY.length === 0) {
    return "Server misconfiguration: SETUP_KEY missing.";
  }
  return null;
}

// ----------------------------------------------------------------------------
// CSRF & REQUEST VERIFICATION
// ----------------------------------------------------------------------------

function verifyCsrf(request) {
  const method = request.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;

  const origin = request.headers.get("Origin");
  const host = request.headers.get("Host");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.host !== host) return false;
    } catch {
      return false;
    }
  }

  const customHeader = request.headers.get("X-Requested-With");
  if (customHeader !== "HisabKhataClient") {
    return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// SESSION & AUTH LOGIC
// ----------------------------------------------------------------------------

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const parts = pair.split("=");
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join("=").trim();
    }
  });
  return cookies;
}

function makeSessionCookie(token, maxAgeSec = SESSION_DURATION_SEC) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
}

function makeClearCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function authenticateRequest(request, env) {
  const cookieHeader = request.headers.get("Cookie");
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const sessionHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  const session = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.expires_at, u.username 
     FROM sessions s 
     JOIN users u ON s.user_id = u.id 
     WHERE s.id = ? AND s.expires_at > ?`
  )
    .bind(sessionHash, now)
    .first();

  if (!session) return null;

  let needsCookieRefresh = false;
  const extendAfter = now + (SESSION_DURATION_DAYS - 1) * 24 * 60 * 60;
  
  if (session.expires_at < extendAfter) {
    const newExpiresAt = now + SESSION_DURATION_SEC;
    await env.DB.prepare(
      `UPDATE sessions SET expires_at = ?, last_active_at = ? WHERE id = ?`
    )
      .bind(newExpiresAt, now, sessionHash)
      .run();
    needsCookieRefresh = true;
  }

  return { session, token, needsCookieRefresh };
}

// ----------------------------------------------------------------------------
// BRUTE FORCE ATTACK PROTECTION
// ----------------------------------------------------------------------------

async function checkRateLimit(key, env) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT attempt_count, locked_until FROM login_attempts WHERE key = ?`
  )
    .bind(key)
    .first();

  if (row && row.locked_until > now) {
    const waitSeconds = row.locked_until - now;
    return {
      allowed: false,
      message: `Too many attempts. Locked for ${waitSeconds} seconds.`
    };
  }
  return { allowed: true };
}

async function recordFailedAttempt(key, env) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT attempt_count FROM login_attempts WHERE key = ?`
  )
    .bind(key)
    .first();

  const attempts = (row ? row.attempt_count : 0) + 1;
  let lockedUntil = 0;

  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    const exponentialMultiplier = Math.pow(2, attempts - MAX_LOGIN_ATTEMPTS);
    lockedUntil = now + Math.min(LOCKOUT_BASE_SECONDS * exponentialMultiplier, 3600);
  }

  await env.DB.prepare(
    `INSERT INTO login_attempts (key, attempt_count, locked_until, last_attempt_at) 
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET 
       attempt_count = ?, 
       locked_until = ?, 
       last_attempt_at = ?`
  )
    .bind(key, attempts, lockedUntil, now, attempts, lockedUntil, now)
    .run();
}

async function resetLoginAttempts(key, env) {
  await env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(key).run();
}

async function performHousekeeping(env) {
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now),
      env.DB.prepare(`DELETE FROM login_attempts WHERE locked_until < ?`).bind(now - 86400)
    ]);
  } catch (err) {}
}

// ----------------------------------------------------------------------------
// AUDIT LOG HELPER
// ----------------------------------------------------------------------------

async function logAudit(env, userId, action, entity, entityId, details, ip) {
  try {
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, user_id, action, entity, entity_id, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        userId || null,
        action,
        entity,
        entityId || null,
        details ? JSON.stringify(details) : null,
        ip || "unknown",
        now
      )
      .run();
  } catch (err) {}
}

// ----------------------------------------------------------------------------
// API ROUTE HANDLERS
// ----------------------------------------------------------------------------

async function handleSetupStatus(env) {
  const user = await env.DB.prepare(`SELECT id FROM users LIMIT 1`).first();
  return jsonResponse({ ok: true, initialized: !!user });
}

async function handleSetup(request, env, clientIp) {
  const envError = checkEnvVars(env);
  if (envError) return errorResponse(envError, 500);

  const rateLimitKey = `setup:${clientIp}`;
  const rateLimit = await checkRateLimit(rateLimitKey, env);
  if (!rateLimit.allowed) return errorResponse(rateLimit.message, 429);

  const body = await request.json().catch(() => ({}));
  const { setupKey, username, password } = body;

  if (!timingSafeEqual(setupKey || "", env.SETUP_KEY)) {
    await recordFailedAttempt(rateLimitKey, env);
    return errorResponse("Invalid SETUP_KEY provided.", 401);
  }

  if (typeof username !== 'string' || username.trim().length < 3 || username.length > 50) {
    return errorResponse("Username must be a string between 3 and 50 characters.");
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 255) {
    return errorResponse("Password must be a string between 8 and 255 characters.");
  }

  const salt = generateRandomHex(16);
  const passwordHash = await hashPassword(password, salt, env.SERVER_PEPPER);
  const userId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const result = await env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, password_salt, totp_enabled, created_at, updated_at)
     SELECT ?, ?, ?, ?, 0, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM users)`
  )
    .bind(userId, username.trim(), passwordHash, salt, now, now)
    .run();

  if (result.meta.changes === 0) {
    return errorResponse("Setup has already been completed.", 403);
  }

  const cashAccId = crypto.randomUUID();
  const bkashAccId = crypto.randomUUID();
  const nowMs = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO accounts (id, name, type, opening_balance, is_active, is_deleted, created_at, updated_at)
       VALUES (?, 'ক্যাশ (Cash)', 'cash', 0.0, 1, 0, ?, ?)`
    ).bind(cashAccId, nowMs, nowMs),
    env.DB.prepare(
      `INSERT INTO accounts (id, name, type, opening_balance, is_active, is_deleted, created_at, updated_at)
       VALUES (?, 'বিকাশ (bKash)', 'mobile_banking', 0.0, 1, 0, ?, ?)`
    ).bind(bkashAccId, nowMs, nowMs)
  ]);

  await logAudit(env, userId, "SETUP", "USER", userId, { username }, clientIp);
  return jsonResponse({ ok: true, message: "System initialized successfully." });
}

async function handleLogin(request, env, clientIp) {
  const envError = checkEnvVars(env);
  if (envError) return errorResponse(envError, 500);

  const body = await request.json().catch(() => ({}));
  const { username, password } = body;

  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 255) {
    return errorResponse("Invalid username or password format.");
  }

  const userRateLimitKey = `user:${username}`;
  const ipRateLimitKey = `ip:${clientIp}`;
  
  const userRateLimit = await checkRateLimit(userRateLimitKey, env);
  const ipRateLimit = await checkRateLimit(ipRateLimitKey, env);
  
  if (!userRateLimit.allowed) return errorResponse(userRateLimit.message, 429);
  if (!ipRateLimit.allowed) return errorResponse(ipRateLimit.message, 429);

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, password_salt FROM users WHERE username = ?`
  )
    .bind(username.trim())
    .first();

  let computedHash;
  if (!user) {
    await hashPassword(password, "00000000000000000000000000000000", env.SERVER_PEPPER); // dummy hash for timing parity
  } else {
    computedHash = await hashPassword(password, user.password_salt, env.SERVER_PEPPER);
  }

  if (!user || !timingSafeEqual(computedHash, user.password_hash)) {
    await recordFailedAttempt(userRateLimitKey, env);
    await recordFailedAttempt(ipRateLimitKey, env);
    return errorResponse("Invalid credentials.", 401);
  }

  await resetLoginAttempts(userRateLimitKey, env);
  await resetLoginAttempts(ipRateLimitKey, env);
  env.ctx?.waitUntil(performHousekeeping(env)); // non-blocking cleanup if context allows

  const sessionToken = generateRandomHex(32);
  const sessionHash = await sha256Hex(sessionToken);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_DURATION_SEC;
  const userAgent = request.headers.get("User-Agent") || "Unknown";

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, user_agent, ip_address, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(sessionHash, user.id, userAgent, clientIp, now, expiresAt, now)
    .run();

  await logAudit(env, user.id, "LOGIN", "SESSION", sessionHash, { userAgent }, clientIp);

  return jsonResponse(
    { ok: true, user: { id: user.id, username: user.username } },
    200,
    { "Set-Cookie": makeSessionCookie(sessionToken) }
  );
}

async function handleLogout(request, env, session) {
  if (session) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(session.id).run();
  }
  return jsonResponse({ ok: true, message: "Logged out." }, 200, {
    "Set-Cookie": makeClearCookie()
  });
}

async function handleChangePassword(request, env, session, clientIp) {
  const envError = checkEnvVars(env);
  if (envError) return errorResponse(envError, 500);

  const body = await request.json().catch(() => ({}));
  const { oldPassword, newPassword } = body;

  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 255) {
    return errorResponse("New password must be a string of 8-255 characters.");
  }

  const user = await env.DB.prepare(
    `SELECT id, password_hash, password_salt FROM users WHERE id = ?`
  )
    .bind(session.user_id)
    .first();

  const oldHash = await hashPassword(oldPassword, user.password_salt, env.SERVER_PEPPER);

  if (!timingSafeEqual(oldHash, user.password_hash)) {
    return errorResponse("Current password does not match.", 401);
  }

  const newSalt = generateRandomHex(16);
  const newHash = await hashPassword(newPassword, newSalt, env.SERVER_PEPPER);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?`
    ).bind(newHash, newSalt, now, user.id),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).bind(
      user.id,
      session.id
    )
  ]);

  await logAudit(env, user.id, "CHANGE_PASSWORD", "USER", user.id, null, clientIp);
  return jsonResponse({ ok: true, message: "Password updated successfully. Other sessions revoked." });
}

async function handleGetSessions(env, session) {
  const rows = await env.DB.prepare(
    `SELECT id, user_agent, ip_address, created_at, last_active_at 
     FROM sessions 
     WHERE user_id = ? 
     ORDER BY last_active_at DESC`
  )
    .bind(session.user_id)
    .all();

  const sessions = (rows.results || []).map((s) => ({
    id: s.id,
    userAgent: s.user_agent,
    ipAddress: s.ip_address,
    createdAt: s.created_at,
    lastActiveAt: s.last_active_at,
    isCurrent: s.id === session.id
  }));

  return jsonResponse({ ok: true, sessions });
}

async function handleRevokeOtherSessions(env, session, clientIp) {
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`)
    .bind(session.user_id, session.id)
    .run();
  await logAudit(env, session.user_id, "REVOKE_SESSIONS", "SESSION", null, null, clientIp);
  return jsonResponse({ ok: true, message: "All other sessions revoked." });
}

// ----------------------------------------------------------------------------
// SYNC ENGINE: POST /api/sync & GET /api/sync
// ----------------------------------------------------------------------------

async function handleSyncPost(request, env, session, clientIp) {
  const body = await request.json().catch(() => ({}));
  const { ops } = body;

  if (!Array.isArray(ops) || ops.length === 0) {
    return errorResponse("Invalid or empty ops batch.");
  }
  if (ops.length > MAX_OPS_PER_REQUEST) {
    return errorResponse(`Too many operations in a single request. Max is ${MAX_OPS_PER_REQUEST}.`, 413);
  }

  const statements = [env.DB.prepare("PRAGMA defer_foreign_keys = ON;")];
  const opsMetadata = [];
  const processedOpIds = [];
  const rejected = [];
  const seenOpIds = new Set();
  const nowMs = Date.now();

  for (const op of ops) {
    const { opId, table, opType, payload } = op;

    if (
      typeof opId !== 'string' ||
      typeof table !== 'string' ||
      typeof opType !== 'string' ||
      typeof payload !== 'object' ||
      payload === null ||
      typeof payload.id !== 'string' ||
      typeof payload.updated_at !== 'number'
    ) {
      rejected.push({ opId, error: "Malformed operation or payload." });
      continue;
    }

    if (!SYNC_TABLES.includes(table)) {
      rejected.push({ opId, error: "Table not whitelisted for sync." });
      continue;
    }

    if (seenOpIds.has(opId)) {
      continue;
    }
    seenOpIds.add(opId);

    const existing = await env.DB.prepare(`SELECT op_id FROM sync_ops WHERE op_id = ?`).bind(opId).first();
    if (existing) {
      processedOpIds.push(opId);
      continue;
    }

    const cleanPayload = {};
    const allowed = ALLOWED_COLUMNS[table];
    for (const key of allowed) {
      if (payload[key] !== undefined) {
        let val = payload[key];
        if (typeof val === 'boolean') {
          val = val ? 1 : 0;
        }
        if (typeof val === 'string' || typeof val === 'number' || val === null) {
          cleanPayload[key] = val;
        }
      }
    }

    if (!cleanPayload.id || !cleanPayload.updated_at) {
      rejected.push({ opId, error: "Missing required id or updated_at after cleaning." });
      continue;
    }

    statements.push(
      env.DB.prepare(`INSERT INTO sync_ops (op_id, table_name, record_id, applied_at) VALUES (?, ?, ?, ?)`).bind(opId, table, cleanPayload.id, nowMs)
    );
    opsMetadata.push({ opId, isOpRecord: true });

    const clientUpdatedAt = cleanPayload.updated_at;

    if (opType === "INSERT" || opType === "UPDATE") {
      const keys = Object.keys(cleanPayload);
      const cols = keys.map((k) => `"${k}"`).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const values = keys.map((k) => cleanPayload[k]);

      const updateClauses = keys
        .filter((k) => k !== "id")
        .map((k) => `"${k}" = excluded."${k}"`)
        .join(", ");

      const sql = `
        INSERT INTO "${table}" (${cols})
        VALUES (${placeholders})
        ON CONFLICT(id) DO UPDATE SET ${updateClauses}
        WHERE excluded.updated_at >= "${table}".updated_at
      `;
      statements.push(env.DB.prepare(sql).bind(...values));
      opsMetadata.push({ opId, isOpRecord: false });
    } else if (opType === "DELETE") {
      const sql = `
        UPDATE "${table}" 
        SET is_deleted = 1, updated_at = ? 
        WHERE id = ? AND updated_at <= ?
      `;
      statements.push(env.DB.prepare(sql).bind(clientUpdatedAt, cleanPayload.id, clientUpdatedAt));
      opsMetadata.push({ opId, isOpRecord: false });
    } else {
      rejected.push({ opId, error: "Invalid opType." });
    }
  }

  if (statements.length > 1) {
    try {
      await env.DB.batch(statements);
      for (const op of opsMetadata) {
        if (op.isOpRecord && !processedOpIds.includes(op.opId)) {
          processedOpIds.push(op.opId);
        }
      }
    } catch (e) {
      // Batch failed. Retry individually (skip PRAGMA defer_foreign_keys to isolate completely)
      for (let i = 1; i < statements.length; i += 2) { 
        // i is sync_ops INSERT, i+1 is the actual table MUTATION
        const currentOpMeta = opsMetadata[i - 1]; 
        try {
          await env.DB.prepare(statements[i].statement).bind(...statements[i].bindings).run();
          await env.DB.prepare(statements[i + 1].statement).bind(...statements[i + 1].bindings).run();
          if (!processedOpIds.includes(currentOpMeta.opId)) {
            processedOpIds.push(currentOpMeta.opId);
          }
        } catch (err) {
          if (!rejected.some(r => r.opId === currentOpMeta.opId)) {
            rejected.push({ opId: currentOpMeta.opId, error: err.message });
          }
        }
      }
    }
  }

  await logAudit(env, session.user_id, "SYNC_PUSH", "SYNC", null, { opCount: processedOpIds.length, rejectedCount: rejected.length }, clientIp);
  return jsonResponse({ ok: true, processedOpIds, rejected, serverTimestamp: nowMs });
}

async function handleSyncGet(request, env) {
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const since = parseInt(sinceParam || "0", 10);
  const nowMs = Date.now();
  
  const deltas = {};
  let hasMore = false;

  for (const table of SYNC_TABLES) {
    const query = `
      SELECT t.* 
      FROM "${table}" t 
      WHERE t.id IN (
        SELECT record_id FROM sync_ops WHERE table_name = ? AND applied_at > ?
      )
      LIMIT 501
    `;
    const result = await env.DB.prepare(query).bind(table, since).all();
    let records = result.results || [];
    
    if (records.length > 500) {
      hasMore = true;
      records = records.slice(0, 500);
    }
    deltas[table] = records;
  }

  // overlapping cursor safe due to idempotency
  return jsonResponse({
    ok: true,
    cursor: nowMs - 10000, 
    deltas,
    hasMore
  });
}

// ----------------------------------------------------------------------------
// MAIN WORKER DISPATCHER
// ----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    env.ctx = ctx; // make context available for waitUntil
    const url = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

    if (!verifyCsrf(request)) {
      return errorResponse("CSRF verification failed.", 403);
    }

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/auth/setup-status" && request.method === "GET") {
        return handleSetupStatus(env);
      }
      if (url.pathname === "/api/auth/setup" && request.method === "POST") {
        return handleSetup(request, env, clientIp);
      }
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        return handleLogin(request, env, clientIp);
      }

      const sessionData = await authenticateRequest(request, env);

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return handleLogout(request, env, sessionData ? sessionData.session : null);
      }

      if (!sessionData) {
        return errorResponse("Unauthorized", 401);
      }

      const { session, token, needsCookieRefresh } = sessionData;
      let response;

      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        response = jsonResponse({ ok: true, user: { id: session.user_id, username: session.username } });
      } else if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
        response = await handleChangePassword(request, env, session, clientIp);
      } else if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        response = await handleGetSessions(env, session);
      } else if (url.pathname === "/api/auth/revoke-other-sessions" && request.method === "POST") {
        response = await handleRevokeOtherSessions(env, session, clientIp);
      } else if (url.pathname === "/api/sync" && request.method === "POST") {
        response = await handleSyncPost(request, env, session, clientIp);
      } else if (url.pathname === "/api/sync" && request.method === "GET") {
        response = await handleSyncGet(request, env);
      } else {
        return errorResponse("API route not found", 404);
      }

      if (needsCookieRefresh && response) {
        response = new Response(response.body, response);
        response.headers.append("Set-Cookie", makeSessionCookie(token));
      }
      
      return response;
    }

    // ------------------------------------------------------------------------
    // STATIC ASSETS ROUTING (Cloudflare Sites /public)
    // ------------------------------------------------------------------------
    if (env.ASSETS) {
      try {
        const assetResponse = await env.ASSETS.fetch(request);
        const headers = new Headers(assetResponse.headers);
        setSecurityHeaders(headers);

        if (url.pathname === "/sw.js") {
          headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
        } else if (url.pathname.startsWith("/icons/") || url.pathname.endsWith(".webmanifest")) {
          headers.set("Cache-Control", "public, max-age=604800, immutable");
        }

        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        });
      } catch (e) {}
    }

    return new Response("Not Found", { status: 404 });
  }
};
