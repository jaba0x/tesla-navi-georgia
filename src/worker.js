// GeoDrive — Cloudflare Worker
// Serves the static site from /public and proxies routing + search APIs
// so we can cache responses and swap providers later without touching the frontend.

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

// GET /api/route?from=lon,lat&to=lon,lat
async function route(url, ctx) {
  const from = parseLonLat(url.searchParams.get('from'));
  const to = parseLonLat(url.searchParams.get('to'));
  if (!from || !to) throw httpError(400, 'from and to must be "lon,lat"');

  const coords = `${from.join(',')};${to.join(',')}`;
  const upstream =
    `${OSRM_URL}/${coords}?overview=full&geometries=geojson&steps=true&alternatives=false`;

  return cachedJson(ctx, `route/${coords}`, 300, upstream);
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
    if (res.ok) {
      // Some links only reveal the place inside the page itself
      const body = (await res.text()).slice(0, 300000);
      const found2 = extractPlace(body);
      if (found2) return json(found2);
    }
    break;
  }
  throw httpError(404, 'No location found in that link');
}

function extractPlace(text) {
  const patterns = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,        // Google place data
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,             // Google map centre
    /[?&](?:q|ll|daddr|destination|center)=(-?\d{1,2}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i,
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
