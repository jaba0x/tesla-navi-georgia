// Accounts, sessions and saved places.
//
// Passwords are hashed with PBKDF2 through WebCrypto, which is what the Workers
// runtime gives us; bcrypt and argon2 are not available here. The session token
// is random and only its SHA-256 is stored, so a copy of the database does not
// hand anyone a live session. There is no sign-up endpoint on purpose: accounts
// are created with tools/adduser.mjs, so the site has no public attack surface.

import { httpError, json } from './http.js';

const COOKIE = 'geo_session';
const SESSION_DAYS = 120;          // a car should not ask you to sign in every drive
const PBKDF2_ITERATIONS = 210000;  // OWASP guidance for PBKDF2-SHA256
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAVOURITES = 60;

// A hash to compare against when the username does not exist, so a missing user
// and a wrong password take about the same time to answer.
const DUMMY =
  'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const enc = new TextEncoder();
let ready = false;

export async function ensureAccounts(env) {
  if (ready || !env.INBOX) return;
  await env.INBOX.batch([
    env.INBOX.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      pw TEXT NOT NULL,
      created INTEGER NOT NULL)`),
    env.INBOX.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires INTEGER NOT NULL)`),
    env.INBOX.prepare(`CREATE TABLE IF NOT EXISTS favourites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      created INTEGER NOT NULL)`),
    env.INBOX.prepare(`CREATE TABLE IF NOT EXISTS login_failures (
      username TEXT NOT NULL,
      at INTEGER NOT NULL)`),
    env.INBOX.prepare('CREATE INDEX IF NOT EXISTS idx_fav_user ON favourites (user_id)'),
    env.INBOX.prepare('CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions (user_id)'),
    env.INBOX.prepare('CREATE INDEX IF NOT EXISTS idx_fail ON login_failures (username, at)'),
  ]);
  ready = true;
}

// ---------------------------------------------------------------- passwords
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  const saltBytes = salt ? unb64(salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256,
  );
  return `pbkdf2$${iterations}$${b64(saltBytes)}$${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, want] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !salt || !want) return false;
  const got = await hashPassword(password, salt, Number(iterations) || PBKDF2_ITERATIONS);
  return equalConstantTime(got.split('$')[3], want);
}

function equalConstantTime(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- sessions
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cookieValue(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setCookie(res, value, maxAge) {
  res.headers.append(
    'Set-Cookie',
    `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  );
  return res;
}

export async function currentUser(request, env) {
  if (!env.INBOX) return null;
  const token = cookieValue(request, COOKIE);
  if (!token) return null;
  await ensureAccounts(env);
  const row = await env.INBOX.prepare(
    `SELECT u.id AS id, u.username AS username, s.expires AS expires
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
  ).bind(await sha256Hex(token)).first();
  if (!row || row.expires < Date.now()) return null;
  return { id: row.id, username: row.username };
}

// ---------------------------------------------------------------- endpoints
export async function login(request, env) {
  if (request.method !== 'POST') throw httpError(405, 'POST only');
  if (!env.INBOX) throw httpError(503, 'Accounts are not set up yet');
  await ensureAccounts(env);

  let body;
  try { body = await request.json(); } catch { throw httpError(400, 'Expected JSON'); }
  const username = String(body.username || '').trim().toLowerCase().slice(0, 40);
  const password = String(body.password || '');
  if (!username || !password) throw httpError(400, 'Username and password are both needed');

  const since = Date.now() - FAILURE_WINDOW_MS;
  const failures = await env.INBOX.prepare(
    'SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?',
  ).bind(username, since).first();
  if ((failures?.n || 0) >= MAX_FAILURES) {
    throw httpError(429, 'Too many attempts. Try again in a few minutes.');
  }

  const user = await env.INBOX.prepare(
    'SELECT id, username, pw FROM users WHERE username = ?',
  ).bind(username).first();
  const ok = await verifyPassword(password, user ? user.pw : DUMMY) && Boolean(user);

  if (!ok) {
    await env.INBOX.batch([
      env.INBOX.prepare('INSERT INTO login_failures (username, at) VALUES (?, ?)')
        .bind(username, Date.now()),
      env.INBOX.prepare('DELETE FROM login_failures WHERE at < ?').bind(since),
    ]);
    // Deliberately the same answer whether the name or the password was wrong
    throw httpError(401, 'Wrong username or password');
  }

  const token = newToken();
  await env.INBOX.batch([
    env.INBOX.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)')
      .bind(await sha256Hex(token), user.id, Date.now() + SESSION_DAYS * 86400000),
    env.INBOX.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()),
    env.INBOX.prepare('DELETE FROM login_failures WHERE username = ?').bind(username),
  ]);
  return setCookie(json({ username: user.username }), token, SESSION_DAYS * 86400);
}

export async function logout(request, env) {
  const token = cookieValue(request, COOKIE);
  if (token && env.INBOX) {
    await ensureAccounts(env);
    await env.INBOX.prepare('DELETE FROM sessions WHERE token = ?')
      .bind(await sha256Hex(token)).run();
  }
  return setCookie(json({ ok: true }), '', 0);
}

export async function me(request, env) {
  const user = await currentUser(request, env);
  return json({ username: user ? user.username : null });
}

export async function favourites(request, env, url) {
  const user = await currentUser(request, env);
  if (!user) throw httpError(401, 'Sign in first');

  if (request.method === 'GET') {
    const { results } = await env.INBOX.prepare(
      'SELECT id, name, lat, lon FROM favourites WHERE user_id = ? ORDER BY created DESC',
    ).bind(user.id).all();
    return json({ items: results || [] });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { throw httpError(400, 'Expected JSON'); }
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw httpError(400, 'Bad coordinates');
    }
    const name = String(body.name || 'Saved place').trim().slice(0, 80) || 'Saved place';

    const count = await env.INBOX.prepare(
      'SELECT COUNT(*) AS n FROM favourites WHERE user_id = ?',
    ).bind(user.id).first();
    if ((count?.n || 0) >= MAX_FAVOURITES) {
      throw httpError(409, `That is ${MAX_FAVOURITES} saved places already. Remove one first.`);
    }

    // Saving the same spot twice is a fumble, not a new favourite
    const near = await env.INBOX.prepare(
      `SELECT id FROM favourites WHERE user_id = ?
       AND abs(lat - ?) < 0.0005 AND abs(lon - ?) < 0.0005`,
    ).bind(user.id, lat, lon).first();
    if (near) return json({ id: near.id, name, lat, lon, existing: true });

    const res = await env.INBOX.prepare(
      'INSERT INTO favourites (user_id, name, lat, lon, created) VALUES (?, ?, ?, ?, ?)',
    ).bind(user.id, name, lat, lon, Date.now()).run();
    return json({ id: res.meta?.last_row_id, name, lat, lon });
  }

  if (request.method === 'DELETE') {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isFinite(id)) throw httpError(400, 'Which one?');
    // Scoped to the signed-in user, so an id from someone else does nothing
    await env.INBOX.prepare('DELETE FROM favourites WHERE id = ? AND user_id = ?')
      .bind(id, user.id).run();
    return json({ ok: true });
  }

  throw httpError(405, 'GET, POST or DELETE');
}
