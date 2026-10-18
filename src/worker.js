// GeoDrive — Cloudflare Worker
// Serves the static site from /public and proxies routing + search APIs
// so we can cache responses and swap providers later without touching the frontend.

import { httpError, json } from './http.js';
import { favourites, login, logout, me } from './accounts.js';
import { resolve } from './resolve.js';

const UA = 'GeoDrive/0.1 (+https://github.com/jaba0x/georgia-drive-map)';

// Georgia bounding box: minLon, minLat, maxLon, maxLat
const GEORGIA_BBOX = '39.9,41.0,46.8,43.7';

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const PHOTON_URL = 'https://photon.komoot.io/api/';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      const dem = url.pathname.match(/^\/api\/dem\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
      if (dem) return await demTile(ctx, dem.slice(1).map(Number));

      switch (url.pathname) {
        case '/api/route':
          return await route(url, ctx);
        case '/api/search':
          return await search(url, ctx);
        case '/api/probe':
          // /check.html pings this so the Worker log records what the car's browser supports
          console.log('probe', JSON.stringify(Object.fromEntries(url.searchParams)));
          return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
        case '/api/send':
          return await sendToCar(request, env);
        case '/api/inbox':
          return await readInbox(url, env);
        case '/api/login':
          return await login(request, env);
        case '/api/logout':
          return await logout(request, env);
        case '/api/me':
          return await me(request, env);
        case '/api/favourites':
          return await favourites(request, env, url);
        case '/api/resolve':
          return await resolveLink(url);
        case '/api/health':
          return json({ ok: true, time: new Date().toISOString() });
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (err) {
      return json({ error: err.message || 'Upstream error' }, err.status || 502);
    }
  },
};

// GET /api/route?from=lon,lat&to=lon,lat[&bearing=deg][&alternatives=1]
async function route(url, ctx) {
  const from = parseLonLat(url.searchParams.get('from'));
  const to = parseLonLat(url.searchParams.get('to'));
  if (!from || !to) throw httpError(400, 'from and to must be "lon,lat"');

  // Before Start the car asks for alternatives so the driver can pick, the way
  // Google Maps offers two or three routes. A re-route never does: the driver
  // is moving and wants one answer. Cached apart, since the answers differ.
  const alternatives = url.searchParams.get('alternatives') === '1';
  const coords = `${from.join(',')};${to.join(',')}`;
  const key = `route/${coords}${alternatives ? '/alt' : ''}`;
  const base = `overview=full&geometries=geojson&steps=true&alternatives=${alternatives ? 3 : 'false'}`;

  // With a heading, OSRM starts the route on a road running that way. Without
  // one it takes the nearest edge whichever way it points, which on a re-route
  // means the opposite carriageway and an opening U-turn.
  const heading = Number(url.searchParams.get('bearing'));
  if (Number.isFinite(heading) && heading >= 0 && heading < 360) {
    const deg = Math.round(heading);
    const bucket = Math.round(deg / 15) * 15; // coarse, so the cache still gets hits
    try {
      return await cachedJson(
        ctx,
        `${key}/b${bucket}`,
        300,
        `${OSRM_URL}/${coords}?${base}&bearings=${deg},75;`,
      );
    } catch {
      // No road nearby runs that way, so ask again without the constraint
    }
  }

  return cachedJson(ctx, key, 300, `${OSRM_URL}/${coords}?${base}`);
}

// GET /api/search?q=...&lat=..&lon=..
async function search(url, ctx) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (q.length < 2) return json({ features: [] });

  const params = new URLSearchParams({ q, limit: '8', bbox: GEORGIA_BBOX });
  const lang = url.searchParams.get('lang');
  if (lang && ['en', 'de', 'fr'].includes(lang)) params.set('lang', lang);

  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', lat.toFixed(3));
    params.set('lon', lon.toFixed(3));
  }

  return cachedJson(ctx, `search/${params}`, 86400, `${PHOTON_URL}?${params}`);
}

// GET /api/dem/{z}/{x}/{y}.png — elevation tiles for the 3D terrain.
// Proxied because the upstream bucket sends no CORS header, which the 3D
// renderer needs. Only tiles covering Georgia are fetched, and they never change,
// so they are cached for a long time.
async function demTile(ctx, [z, x, y]) {
  const max = 2 ** z;
  if (z > 14 || x >= max || y >= max || !tileTouchesGeorgia(z, x, y)) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=604800' } });
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://geodrive.cache/dem/${z}/${x}/${y}.png`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetch(
    `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`,
  );
  if (!upstream.ok) throw httpError(502, `Elevation tiles returned ${upstream.status}`);

  const res = new Response(upstream.body, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function tileTouchesGeorgia(z, x, y) {
  const [minLon, minLat, maxLon, maxLat] = GEORGIA_BBOX.split(',').map(Number);
  const n = 2 ** z;
  const lon = (i) => (i / n) * 360 - 180;
  const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  // a small margin so the horizon beyond the border still has relief
  const m = 0.5;
  return lon(x + 1) >= minLon - m && lon(x) <= maxLon + m &&
    lat(y) >= minLat - m && lat(y + 1) <= maxLat + m;
}

// Sending a destination from a phone to the car.
// The car shows a short code; the phone posts a place under that code; the car
// picks it up on its next check. Kept for 15 minutes, and deleted once read.
const CODE_RE = /^[A-HJ-NP-Z2-9]{4,6}$/;

async function sendToCar(request, env) {
  if (request.method !== 'POST') throw httpError(405, 'POST only');
  if (!env.INBOX) throw httpError(503, 'Sending to the car is not set up yet');

  let body;
  try {
    body = await request.json();
  } catch {
    throw httpError(400, 'Expected JSON');
  }
  const code = String(body.code || '').toUpperCase();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!CODE_RE.test(code)) throw httpError(400, 'That car code does not look right');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw httpError(400, 'Bad coordinates');
  }

  const name = String(body.name || 'Shared place').slice(0, 80);
  const now = Date.now();

  await ensureInbox(env);
  await env.INBOX.batch([
    env.INBOX.prepare('INSERT OR REPLACE INTO inbox (code, lat, lon, name, at) VALUES (?, ?, ?, ?, ?)')
      .bind(code, lat, lon, name, now),
    // anything older than 15 minutes was never collected
    env.INBOX.prepare('DELETE FROM inbox WHERE at < ?').bind(now - 15 * 60 * 1000),
  ]);
  return json({ ok: true });
}

async function readInbox(url, env) {
  if (!env.INBOX) return json({ enabled: false });
  const code = String(url.searchParams.get('code') || '').toUpperCase();
  if (!CODE_RE.test(code)) throw httpError(400, 'Bad code');

  await ensureInbox(env);
  const row = await env.INBOX.prepare(
    'SELECT lat, lon, name, at FROM inbox WHERE code = ? AND at > ?',
  ).bind(code, Date.now() - 15 * 60 * 1000).first();

  if (!row) return json({ enabled: true });
  // Read once: the car has it now
  await env.INBOX.prepare('DELETE FROM inbox WHERE code = ?').bind(code).run();
  return json({ enabled: true, place: row });
}

let inboxReady = false;
async function ensureInbox(env) {
  if (inboxReady) return;
  await env.INBOX.prepare(
    'CREATE TABLE IF NOT EXISTS inbox (code TEXT PRIMARY KEY, lat REAL, lon REAL, name TEXT, at INTEGER)',
  ).run();
  inboxReady = true;
}

// GET /api/resolve?url=... — see src/resolve.js
async function resolveLink(url) {
  return json(await resolve(url.searchParams.get('url')));
}

// ---------- helpers ----------

async function cachedJson(ctx, key, ttlSeconds, upstreamUrl) {
  const cache = caches.default;
  const cacheKey = new Request(`https://geodrive.cache/${encodeURIComponent(key)}`);

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetch(upstreamUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!upstream.ok) throw httpError(502, `Upstream returned ${upstream.status}`);

  const res = new Response(await upstream.text(), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttlSeconds}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function parseLonLat(value) {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lon, lat] = parts;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  // 5 decimals ≈ 1 m — enough precision, better cache hits
  return [lon.toFixed(5), lat.toFixed(5)];
}


