// Live traffic along a route, read from the keyless endpoint the Google Maps
// website itself calls. No key, no account, no licence, and no promise from
// Google: this is the same technique Vela Maps (GPL-3.0, PimpinPumpkin/Vela)
// documents openly, and it has the same standing. It is off unless the
// GOOGLE_TRAFFIC variable is "on", and everything else works without it.
//
// Where it is going to break: the response is undocumented nested JSON read by
// position. When Google shuffles the positions, parseDirections() returns null
// and the car simply shows no traffic. Fix it by capturing a fresh response
// (test/fixtures/google-directions.json shows how), updating PATHS below until
// test/traffic.test.js passes, and redeploying.
//
// What it will not do: evade blocking. Plain requests with normal browser
// headers. If Google starts refusing Cloudflare's addresses, this is over.

import { httpError, json } from './http.js';

const ENDPOINT = 'https://www.google.com/maps/preview/directions?authuser=0&hl=en&gl=ge';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

// The request template, protobuf-as-URL. Only the four coordinates and the
// travel mode are ours; the rest is the viewport and feature flags the website
// sends, and we send them unchanged so the answer has the same shape. Template
// from Vela's calibration.json, mode 0 is driving.
const PB_TEMPLATE =
  '!1m4!3m2!3d{OLAT}!4d{OLNG}!6e2!1m4!3m2!3d{DLAT}!4d{DLNG}!6e2!3m12!1m3!1d24960.741896132306' +
  '!2d-121.7527808!3d38.554674999999996!2m3!1f0.0!2f0.0!3f0.0!3m2!1i1024!2i768!4f13.1!6m56!1m5!18b1!30b1!31m1!1b1!34e1' +
  '!2m4!5m1!6e2!20e3!39b1!6m27!32i1!49b1!63m0!66b1!85b1!114b1!149b1!206b1!209b1!212b1!216b1!222b1!223b1!232b1!234b1!235b1' +
  '!244b1!246b1!250b1!253b1!260b1!266b1!270b1!273b1!279b1!281b1!291m0!10b1!12b1!13b1!14b1!16b1!17m1!3e1!20m5!1e0!2e3!5e2' +
  '!6b1!14b1!46m1!1b0!96b1!99b1!15i10142!20m28!1m6!1m2!1i0!2i0!2m2!1i530!2i768!1m6!1m2!1i974!2i0!2m2!1i1024!2i768!1m6!1m2' +
  '!1i0!2i0!2m2!1i1024!2i20!1m6!1m2!1i0!2i748!2m2!1i1024!2i768!27b1!40i783!47m2!8b1!10e2';

// Where things sit in the response. Verified against a real Tbilisi response on
// 13 Oct 2026; see test/fixtures/google-directions.json. `summary` is route[0].
export const PATHS = {
  routes: [0, 1],                 // data[0][1] → list of routes
  summary: [0],                   // route[0]
  road: [1],                      // summary[1]        "Merab Kostava St"
  distance: [2, 0],               // summary[2][0]     metres
  staticSec: [3, 0],              // summary[3][0]     duration without live traffic
  trafficSec: [10, 0, 0],         // summary[10][0][0] duration in current traffic
  level: [10, 2],                 // summary[10][2]    0 light, 1 moderate, 2 heavy
  freeflowSec: [10, 3, 0],        // summary[10][3][0]
  typical: [10, 4],               // summary[10][4]    [lowSec, highSec, "18–37 min"]
  spans: [3, 5, 0],               // route[3][5][0]    [[level, startMetres, lengthMetres], …]
};

const at = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function buildUrl(from, to) {
  const pb = PB_TEMPLATE
    .replace('{OLAT}', from.lat.toFixed(6)).replace('{OLNG}', from.lon.toFixed(6))
    .replace('{DLAT}', to.lat.toFixed(6)).replace('{DLNG}', to.lon.toFixed(6));
  return `${ENDPOINT}&pb=${pb}`;
}

/** Strip the XSSI guard and parse. Returns null rather than throwing on junk. */
export function parseBody(text) {
  const body = text.startsWith(")]}'") ? text.slice(4) : text;
  try { return JSON.parse(body); } catch { return null; }
}

/**
 * Pull out what the car needs from one response. Returns null when the shape
 * is not what PATHS expects, so a format change degrades to "no traffic"
 * rather than a broken route panel.
 */
export function parseDirections(data) {
  const routes = at(data, PATHS.routes);
  if (!Array.isArray(routes) || routes.length === 0) return null;

  const out = [];
  for (const route of routes) {
    const summary = at(route, PATHS.summary);
    const distance = num(at(summary, PATHS.distance));
    const staticSec = num(at(summary, PATHS.staticSec));
    const trafficSec = num(at(summary, PATHS.trafficSec));
    if (distance === null || staticSec === null) continue;

    const spansRaw = at(route, PATHS.spans);
    const spans = [];
    if (Array.isArray(spansRaw)) {
      for (const s of spansRaw) {
        if (!Array.isArray(s) || s.length < 3) continue;
        const [level, start, length] = s.map(num);
        if (level === null || start === null || length === null) continue;
        if (start < 0 || length <= 0 || start + length > distance * 1.02) continue;
        spans.push({ level, start, length });
      }
    }

    const typical = at(summary, PATHS.typical);
    out.push({
      road: typeof at(summary, PATHS.road) === 'string' ? at(summary, PATHS.road) : '',
      distance,
      staticSec,
      trafficSec,                                   // null when Google has no live data
      freeflowSec: num(at(summary, PATHS.freeflowSec)),
      level: num(at(summary, PATHS.level)),
      typical: Array.isArray(typical) ? [num(typical[0]), num(typical[1])] : null,
      spans,
    });
  }
  return out.length ? out : null;
}

/**
 * Map Google's congestion stretches onto the remaining OSRM line by fraction of
 * length. Honest only when the two routes are about the same road, so the
 * caller checks the distances agree before using this.
 */
export function transferSpans(spans, googleDistance, ourDistance) {
  if (!googleDistance || !ourDistance) return [];
  const k = ourDistance / googleDistance;
  return spans.map((s) => ({ level: s.level, start: s.start * k, length: s.length * k }));
}

// ---------------------------------------------------------------- endpoint
// GET /api/traffic?from=lon,lat&to=lon,lat
export async function traffic(url, env, ctx) {
  if (env.GOOGLE_TRAFFIC !== 'on') return json({ enabled: false });

  const from = parsePoint(url.searchParams.get('from'));
  const to = parsePoint(url.searchParams.get('to'));
  if (!from || !to) throw httpError(400, 'from and to must be "lon,lat"');

  // One answer per ~100 m cell per minute: a car re-asking every two minutes
  // while barely moving should not be a new request each time.
  const key = `traffic/${from.lon.toFixed(3)},${from.lat.toFixed(3)}/${to.lon.toFixed(3)},${to.lat.toFixed(3)}`;
  const cache = caches.default;
  const cacheKey = new Request(`https://geodrive.cache/${encodeURIComponent(key)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let text;
  try {
    const res = await fetch(buildUrl(from, to), {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return json({ enabled: true, routes: null, reason: `google ${res.status}` });
    text = await res.text();
  } catch {
    return json({ enabled: true, routes: null, reason: 'unreachable' });
  }

  const routes = parseDirections(parseBody(text));
  const out = json({ enabled: true, routes, reason: routes ? null : 'unparsed' });
  out.headers.set('Cache-Control', 'public, max-age=60');
  if (routes) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

function parsePoint(value) {
  const m = String(value || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lon = Number(m[1]), lat = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lon, lat };
}
