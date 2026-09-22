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
      const tile = url.pathname.match(/^\/api\/traffic\/flow\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
      if (tile) return await trafficTile(request, env, ctx, url, tile.slice(1).map(Number));

      switch (url.pathname) {
        case '/api/config':
          return json({ traffic: Boolean(env.TOMTOM_KEY) });
        case '/api/route':
          return await route(url, ctx);
        case '/api/search':
          return await search(url, ctx);
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

// GET /api/traffic/flow/{z}/{x}/{y}.png[?dark=1]
// Proxies TomTom raster flow tiles so the API key never reaches the browser.
// Only tiles covering Georgia are fetched, and each tile is cached for 2 minutes
// and shared by every visitor, to stay inside TomTom's free monthly allowance.
async function trafficTile(request, env, ctx, url, [z, x, y]) {
  if (!env.TOMTOM_KEY) throw httpError(503, 'Traffic is not configured');
  const max = 2 ** z;
  if (z < 5 || z > 18 || x >= max || y >= max) return emptyTile();
  if (!tileTouchesGeorgia(z, x, y)) return emptyTile();

  // Soft hotlink protection: tiles are only for pages on this site
  const referer = request.headers.get('Referer');
  if (referer && new URL(referer).host !== url.host) throw httpError(403, 'Forbidden');

  const style = url.searchParams.get('dark') === '1' ? 'relative0-dark' : 'relative0';
  const cache = caches.default;
  const cacheKey = new Request(`https://geodrive.cache/traffic/${style}/${z}/${x}/${y}.png`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetch(
    `https://api.tomtom.com/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.png` +
      `?key=${env.TOMTOM_KEY}&tileSize=512`,
  );
  if (!upstream.ok) throw httpError(502, `Traffic provider returned ${upstream.status}`);

  const res = new Response(upstream.body, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=120' },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function tileTouchesGeorgia(z, x, y) {
  const [minLon, minLat, maxLon, maxLat] = GEORGIA_BBOX.split(',').map(Number);
  const n = 2 ** z;
  const lon = (i) => (i / n) * 360 - 180;
  const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  const tWest = lon(x), tEast = lon(x + 1), tNorth = lat(y), tSouth = lat(y + 1);
  return tEast >= minLon && tWest <= maxLon && tNorth >= minLat && tSouth <= maxLat;
}

function emptyTile() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=86400' } });
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
