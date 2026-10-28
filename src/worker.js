// GeoDrive — Cloudflare Worker
// Serves the static site from /public and proxies routing + search APIs
// so we can cache responses and swap providers later without touching the frontend.

import { httpError, json } from './http.js';
import { favourites, login, logout, me } from './accounts.js';
import { resolve } from './resolve.js';
import { CAMERA_QUERY, OVERPASS_URLS, parseCameras } from './cameras.mjs';

const UA = 'GeoDrive/0.1 (+https://github.com/jaba0x/georgia-drive-map)';

// Georgia bounding box: minLon, minLat, maxLon, maxLat
const GEORGIA_BBOX = '39.9,41.0,46.8,43.7';

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/trace_attributes';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/sw.js') return serviceWorker(request, env);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      const dem = url.pathname.match(/^\/api\/dem\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
      if (dem) return await demTile(ctx, dem.slice(1).map(Number));

      switch (url.pathname) {
        case '/api/route':
          return await route(url, ctx);
        case '/api/limits':
          return await speedLimits(request, ctx);
        case '/api/cameras':
          return await cameras(request, env, ctx);
        case '/api/search':
          return await search(url, ctx);
        case '/api/reverse':
          return await reverse(url, ctx);
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

// GET /sw.js — the service worker (public/sw.js), stamped with this deployment's
// id. Every deployment then changes the file, browsers install it, and it fetches a
// fresh copy of the app; without the stamp a device would keep the old app.
async function serviceWorker(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!res.ok) return res;
  const version = (env.VERSION && env.VERSION.id) || 'dev';
  return new Response((await res.text()).replace('__VERSION__', version), {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

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

// POST /api/limits — the speed limits along a route, from the maxspeed tags in
// OpenStreetMap. OSRM, which draws the routes, doesn't report them, so the route
// line is matched to the roads by Valhalla on FOSSGIS's public server.
// Body: the route line as an encoded polyline (precision 5).
// Answer: { limits: [[fromPoint, toPoint, kmh], …] }, in point numbers of that line;
// stretches with no signed limit are left out.
// Per request, at most this many points and metres: the public server turns down
// a trace longer than 200 km
const TRACE_POINTS = 2500;
const TRACE_METRES = 150000;

async function speedLimits(request, ctx) {
  if (request.method !== 'POST') throw httpError(405, 'POST only');
  const line = (await request.text()).trim();
  if (!line || line.length > 300000) throw httpError(400, 'Expected the route as an encoded polyline');

  const cache = caches.default;
  const cacheKey = new Request(`https://geodrive.cache/limits-v2/${await sha1(line)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const points = decodePolyline(line);
  if (points.length < 2) throw httpError(400, 'The route line is too short');

  const limits = [];
  let matched = 0, missed = 0;
  // Stretch by stretch, one after the other: the server asks for no more than a
  // request a second from any one user
  for (const [start, end] of stretches(points)) {
    const edges = await traceEdges(points.slice(start, end + 1));
    if (!edges) {
      missed++;   // this stretch could not be matched; keep the rest
      continue;
    }
    matched++;
    for (const e of edges) {
      const kmh = e.speed_limit;
      if (!(kmh >= 5 && kmh <= 150)) continue;   // unknown
      const from = start + e.begin_shape_index;
      const to = start + e.end_shape_index;
      const last = limits[limits.length - 1];
      if (last && last[2] === kmh && last[1] >= from) last[1] = Math.max(last[1], to);
      else limits.push([from, to, kmh]);
    }
  }
  if (!matched) throw httpError(502, 'Speed limits are not available right now');

  // Kept for a day, unless a stretch is missing: then the next ask tries again
  const res = new Response(JSON.stringify({ limits }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': missed ? 'no-store' : 'public, max-age=86400',
    },
  });
  if (!missed) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// [first, last] point numbers of each stretch; neighbours share their end point
function stretches(points) {
  const out = [];
  let start = 0, metres = 0;
  for (let i = 1; i < points.length; i++) {
    metres += haversine(points[i - 1], points[i]);
    if (i - start + 1 >= TRACE_POINTS || metres >= TRACE_METRES || i === points.length - 1) {
      out.push([start, i]);
      start = i;
      metres = 0;
    }
  }
  return out;
}

function haversine([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

async function traceEdges(points) {
  try {
    const res = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shape: points.map(([lon, lat]) => ({ lat, lon })),
        costing: 'auto',
        shape_match: 'map_snap',
        filters: {
          attributes: ['edge.speed_limit', 'edge.begin_shape_index', 'edge.end_shape_index'],
          action: 'include',
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.edges) ? data.edges : null;
  } catch {
    return null;
  }
}

// Google's encoded polyline format, 5 decimals: [[lon, lat], …]
function decodePolyline(text) {
  const points = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0, b;
    do {
      if (i >= text.length) throw httpError(400, 'Broken polyline');
      b = text.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    lat += next();
    lon += next();
    points.push([lon / 1e5, lat / 1e5]);
  }
  return points;
}

async function sha1(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// GET /api/cameras — speed cameras in and around Georgia, from OpenStreetMap.
// Answered at once, from this data centre's copy or else the one shipped with the
// site (public/cameras.json, made by npm run cameras). A copy more than a day old
// is renewed from Overpass in the background: its public servers can take a minute.
const CAMERAS_KEY = 'https://geodrive.cache/cameras-v1';
const CAMERAS_MAX_AGE = 24 * 60 * 60 * 1000;
let camerasRefreshing = false;

async function cameras(request, env, ctx) {
  const cache = caches.default;
  const hit = await cache.match(CAMERAS_KEY);
  const fetched = hit ? Number(hit.headers.get('X-Fetched')) || 0 : 0;
  if (Date.now() - fetched > CAMERAS_MAX_AGE && !camerasRefreshing) {
    camerasRefreshing = true;
    ctx.waitUntil(refreshCameras(cache).finally(() => { camerasRefreshing = false; }));
  }
  const body = hit
    ? await hit.text()
    : await (await env.ASSETS.fetch(new URL('/cameras.json', request.url))).text();
  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}

async function refreshCameras(cache) {
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA },
        body: new URLSearchParams({ data: CAMERA_QUERY }),
        // work left running after a response gets 30 s in all
        signal: AbortSignal.timeout(14000),
      });
      if (!res.ok) continue;
      const list = parseCameras(await res.json());
      if (!list.length) continue;   // an empty answer is a server fault, not news
      await cache.put(CAMERAS_KEY, new Response(
        JSON.stringify({ updated: new Date().toISOString(), cameras: list }),
        {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=604800',
            'X-Fetched': String(Date.now()),
          },
        },
      ));
      return;
    } catch {
      // busy or slow: try the next server
    }
  }
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

// GET /api/reverse?lat=..&lon=.. — what is at a spot on the map: the few nearest
// places and addresses, within 300 m. The page picks one: the nearest is often a
// statue or a plaque. Rounded to about 10 m, as exact as a finger on a map anyway.
async function reverse(url, ctx) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw httpError(400, 'lat and lon are required');
  }
  const params = new URLSearchParams({
    lat: lat.toFixed(4), lon: lon.toFixed(4), limit: '6', radius: '0.3', lang: 'en',
  });
  return cachedJson(ctx, `reverse/${params}`, 86400, `${PHOTON_REVERSE_URL}?${params}`);
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


