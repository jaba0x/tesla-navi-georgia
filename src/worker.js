// GeoDrive — Cloudflare Worker
// Serves the static site from /public and proxies routing + search APIs
// so we can cache responses and swap providers later without touching the frontend.

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

// GET /api/route?from=lon,lat&to=lon,lat&bearing=deg&alternatives=1
async function route(url, ctx) {
  const from = parseLonLat(url.searchParams.get('from'));
  const to = parseLonLat(url.searchParams.get('to'));
  if (!from || !to) throw httpError(400, 'from and to must be "lon,lat"');

  const coords = `${from.join(',')};${to.join(',')}`;
  // alternatives=1: up to two other ways there as well, for the driver to choose
  // from before a trip. A re-route on the way asks for the best one only.
  const alternatives = url.searchParams.get('alternatives') === '1';
  const base = `overview=full&geometries=geojson&steps=true&alternatives=${alternatives ? 2 : false}`;
  const key = `route/${coords}${alternatives ? '/alt' : ''}`;

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

// GET /api/resolve?url=... — turn a shared map link into coordinates.
// Short links (maps.app.goo.gl) have to be followed server-side, and only
// these map hosts are allowed, so this can't be used to fetch anything else.
const MAP_HOSTS = [
  'maps.app.goo.gl', 'goo.gl', 'maps.google.com', 'www.google.com', 'google.com',
  'maps.apple.com', 'www.waze.com', 'waze.com', 'ul.waze.com',
];

async function resolveLink(url) {
  const raw = (url.searchParams.get('url') || '').trim();
  if (!raw) throw httpError(400, 'No link given');

  let target;
  try {
    target = new URL(raw);
  } catch {
    throw httpError(400, 'That is not a link');
  }
  if (!MAP_HOSTS.includes(target.hostname)) {
    throw httpError(400, 'Only Google, Apple or Waze map links work here');
  }

  let current = target.toString();
  for (let hop = 0; hop < 5; hop++) {
    const found = extractPlace(current);
    if (found) return json(found);

    // A Google link that names the place rather than giving its coordinates
    const named = googlePlaceQuery(current);
    if (named) {
      const place = await googlePlace(named);
      if (place) return json(place);
      break;   // Google itself does not know it
    }

    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    });
    const location = res.headers.get('location');
    if (location) {
      current = new URL(location, current).toString();
      if (!MAP_HOSTS.includes(new URL(current).hostname)) {
        throw httpError(400, 'That link leads somewhere unexpected');
      }
      continue;
    }
    // Some links only reveal the place inside the page itself. Not Google's: its
    // pages open on a default view and find the place with scripts afterwards.
    if (res.ok && !isGoogle(current)) {
      const body = (await res.text()).slice(0, 300000);
      const found2 = extractPlace(body);
      if (found2) return json(found2);
    }
    break;
  }
  throw httpError(404, 'No location found in that link');
}

function isGoogle(link) {
  return /(^|\.)google\.com$/.test(new URL(link).hostname);
}

// Links shared from the Google Maps phone app name the place (?q=name, address
// &ftid=…), as do /maps/place/Name and ?cid= links. Returns what to ask for.
function googlePlaceQuery(link) {
  if (!isGoogle(link)) return null;
  const u = new URL(link);
  const p = u.searchParams;
  const title = (p.get('q') || p.get('query') || pathName(u.pathname)).trim();

  const fid = (p.get('ftid') || (link.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [])[1] || '')
    .match(/^0x[0-9a-f]{1,16}:(0x[0-9a-f]{1,16})$/i);
  const cid = fid ? BigInt(fid[1]).toString() : ((p.get('cid') || '').match(/^\d{1,20}$/) || [])[0];
  if (cid) return { pb: `!1m3!3m2!1m1!4s${cid}`, title };   // that very place
  if (title) return { pb: `!1m2!2m1!1s${encodeURIComponent(title).replace(/!/g, '%21')}`, title };   // Google's search
  return null;
}

function pathName(path) {
  const m = path.match(/\/maps\/(?:place|search)\/([^/@]+)/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch {
    return '';
  }
}

// Google's embed page answers a place query in its first 3 KB, coordinates included
async function googlePlace({ pb, title }) {
  const res = await fetch(`https://www.google.com/maps/embed?origin=mfe&pb=${pb}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
  });
  if (!res.ok) return null;
  const page = (await res.text()).slice(0, 100000);
  title = title.split(',')[0].trim();

  // One place: ["0x…:0x…","name, address",[lat,lon],"cid"],"name"
  let m = page.match(/"0x[0-9a-f]+:0x[0-9a-f]+","(?:[^"\\]|\\.)*",\[(-?\d+\.\d+),(-?\d+\.\d+)\],"\d+"\],"((?:[^"\\]|\\.)*)"/i);
  if (m) return checkedPlace(m[1], m[2], jsonText(m[3]) || title);
  // A search: the first result, in degrees × 10⁷
  m = page.match(/\[\["\d+","\d+"\],"[^"]*",null,\[(-?\d+),(-?\d+)\]/);
  if (m) return checkedPlace(m[1] / 1e7, m[2] / 1e7, title);
  // Otherwise the view Google opens on, unless it is the whole world (nothing found)
  m = page.match(/\[\[\[(\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/);
  if (m && Number(m[1]) < 50000) return checkedPlace(m[3], m[2], title);
  return null;
}

function checkedPlace(lat, lon, name) {
  lat = Number(lat);
  lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon, name: String(name || '').slice(0, 80) };
}

function jsonText(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return '';
  }
}

function extractPlace(text) {
  const patterns = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,        // Google place data
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,             // Google map centre
    /[?&](?:q|query|ll|daddr|destination|center|coordinate)=(-?\d{1,2}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lat, lon, name: extractName(text) };
      }
    }
  }
  return null;
}

function extractName(text) {
  const m = text.match(/\/place\/([^/@?]+)/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).slice(0, 80);
  } catch {
    return '';
  }
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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
