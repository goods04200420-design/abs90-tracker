const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const SESSION_COOKIE = 'fit_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const MAX_LOGIN_FAILURES = 5;
const LOCK_MINUTES = 15;
const encoder = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  return request.headers.get('cookie')
    ?.split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

function bytesToBase64Url(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const raw = atob(normalized);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

async function sha256(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64UrlToBytes(salt),
    iterations,
  }, key, 256));
}

function safeEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function authenticatedUser(request, env) {
  const host = new URL(request.url).hostname;
  if ((host === '127.0.0.1' || host === 'localhost') && env.DEV_USER_ID) {
    return { id: env.DEV_USER_ID, username: env.DEV_USER_EMAIL || 'local' };
  }

  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = bytesToBase64Url(await sha256(token));
  const now = new Date().toISOString();
  return env.DB.prepare(`
    SELECT u.id, u.username
    FROM auth_sessions s
    JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2
  `).bind(tokenHash, now).first();
}

async function loginApi(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 400); }

  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!username || !password || username.length > 64 || password.length > 256) {
    return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  const user = await env.DB.prepare(`
    SELECT id, username, password_salt, password_hash, password_iterations,
           failed_attempts, locked_until
    FROM app_users WHERE username = ?1 COLLATE NOCASE
  `).bind(username).first();
  if (!user) return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);

  const now = new Date();
  if (user.locked_until && new Date(user.locked_until) > now) {
    return json({ error: '로그인이 잠시 잠겼습니다. 15분 후 다시 시도하세요.' }, 429);
  }

  const derived = await derivePassword(password, user.password_salt, Number(user.password_iterations));
  const expected = base64UrlToBytes(user.password_hash);
  if (!safeEqual(derived, expected)) {
    const failures = Number(user.failed_attempts || 0) + 1;
    const shouldLock = failures >= MAX_LOGIN_FAILURES;
    const lockedUntil = shouldLock
      ? new Date(now.getTime() + LOCK_MINUTES * 60 * 1000).toISOString()
      : null;
    await env.DB.prepare(`
      UPDATE app_users SET failed_attempts = ?1, locked_until = ?2 WHERE id = ?3
    `).bind(shouldLock ? 0 : failures, lockedUntil, user.id).run();
    return json({
      error: shouldLock
        ? '로그인이 잠시 잠겼습니다. 15분 후 다시 시도하세요.'
        : '아이디 또는 비밀번호가 올바르지 않습니다.',
    }, shouldLock ? 429 : 401);
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(tokenBytes);
  const tokenHash = bytesToBase64Url(await sha256(token));
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE app_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?1').bind(createdAt),
    env.DB.prepare(`
      INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
      VALUES (?1, ?2, ?3, ?4)
    `).bind(tokenHash, user.id, expiresAt, createdAt),
  ]);
  return json({ ok: true, username: user.username }, 200, { 'set-cookie': sessionCookie(token) });
}

async function logoutApi(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    const tokenHash = bytesToBase64Url(await sha256(token));
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(tokenHash).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': expiredSessionCookie() });
}

function parseRow(row) {
  if (!row) return null;
  return {
    state: JSON.parse(row.data_json),
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

async function getRow(env, userId) {
  return env.DB.prepare(
    'SELECT data_json, version, updated_at FROM user_state WHERE user_id = ?1'
  ).bind(userId).first();
}

async function stateApi(request, env, user) {
  if (request.method === 'GET') {
    const record = parseRow(await getRow(env, user.id));
    return json({ ...record, email: user.username, userKey: user.id });
  }

  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 900_000) return json({ error: 'Record is too large' }, 413);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body.state !== 'object' || Array.isArray(body.state)) {
    return json({ error: 'Invalid state' }, 400);
  }
  const clientVersion = Number(body.version || 0);
  if (!Number.isInteger(clientVersion) || clientVersion < 0) {
    return json({ error: 'Invalid version' }, 400);
  }
  const dataJson = JSON.stringify(body.state);
  if (encoder.encode(dataJson).byteLength > 900_000) {
    return json({ error: 'Record is too large' }, 413);
  }

  const current = await getRow(env, user.id);
  if (current && Number(current.version) !== clientVersion) {
    return json({ error: 'Version conflict', ...parseRow(current), email: user.username, userKey: user.id }, 409);
  }
  if (!current && clientVersion !== 0) {
    return json({ error: 'Version conflict', state: null, version: 0, email: user.username, userKey: user.id }, 409);
  }

  const now = new Date().toISOString();
  let result;
  if (current) {
    result = await env.DB.prepare(`
      UPDATE user_state
      SET email = ?1, data_json = ?2, version = version + 1, updated_at = ?3
      WHERE user_id = ?4 AND version = ?5
    `).bind(user.username, dataJson, now, user.id, clientVersion).run();
  } else {
    result = await env.DB.prepare(`
      INSERT INTO user_state (user_id, email, data_json, version, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4)
    `).bind(user.id, user.username, dataJson, now).run();
  }

  if (!result.success || result.meta?.changes !== 1) {
    const latest = parseRow(await getRow(env, user.id));
    return json({ error: 'Version conflict', ...latest, email: user.username, userKey: user.id }, 409);
  }
  return json({ version: clientVersion + 1, updatedAt: now, email: user.username, userKey: user.id });
}

function loginAssetRequest(request) {
  const url = new URL(request.url);
  url.pathname = '/login.html';
  url.search = '';
  return new Request(url, { method: 'GET', headers: request.headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'abs.get1004.com') {
      const target = new URL(request.url);
      target.hostname = 'fit.get1004.com';
      return Response.redirect(target.toString(), 308);
    }

    try {
      if (url.pathname === '/api/auth/login') return loginApi(request, env);
      if (url.pathname === '/api/auth/logout') return logoutApi(request, env);

      const user = await authenticatedUser(request, env);
      if (url.pathname.startsWith('/api/')) {
        if (!user) return json({ error: 'Authentication required' }, 401);
        if (url.pathname === '/api/state') return stateApi(request, env, user);
        if (url.pathname === '/api/me') return json({ username: user.username });
        return json({ error: 'Not found' }, 404);
      }

      if (url.pathname === '/login' || url.pathname === '/login.html') {
        if (user) return Response.redirect(new URL('/', request.url).toString(), 302);
        return env.ASSETS.fetch(loginAssetRequest(request));
      }
      if (url.pathname === '/manifest.json' || url.pathname === '/icon.svg') {
        return env.ASSETS.fetch(request);
      }
      if (!user) return Response.redirect(new URL('/login', request.url).toString(), 302);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: 'Server error' }, 500);
    }
  },
};
