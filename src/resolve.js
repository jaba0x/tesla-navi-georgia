// GET /api/resolve?url=... — turn a shared map link into coordinates.
//
// A short link (maps.app.goo.gl) has to be followed server-side to see where
// it goes. Where it goes has changed over the years:
//   old:  https://www.google.com/maps/place/Name/@41.71,44.79,17z/data=…!3d41.71!4d44.79
//   now, often: https://maps.google.com/?q=Name,+Street,+Tbilisi&ftid=0x…:0x…
//         or    https://www.google.com/maps/place/Name/data=!4m2!3m1!1s0x…   (no numbers)
// The newer forms carry a name but no coordinates, and the coordinates are
// only inside Google's page, which Google refuses to serve to Cloudflare's
// addresses (it answers 429). So when the link itself has no numbers, the
// place name it carries is looked up in Photon, the same search the car uses,
// limited to Georgia. Google's page is never needed.
//
// Only these hosts are followed, so this cannot be used to fetch anything else.

export const MAP_HOSTS = [
  'maps.app.goo.gl', 'goo.gl', 'maps.google.com', 'www.google.com', 'google.com',
  'maps.google.ge', 'www.google.ge', 'google.ge',
  'maps.apple.com', 'www.waze.com', 'waze.com', 'ul.waze.com',
];
// Google's cookie wall. Never fetched; the link it wraps is in ?continue=
const CONSENT_HOSTS = ['consent.google.com', 'consent.google.ge'];

const GEORGIA_BBOX = '39.9,41.0,46.8,43.7';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Coordinates written into the link itself, or null. */
export function extractPlace(text) {
  const patterns = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,        // Google place data
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,             // Google map centre
    /[?&](?:q|ll|query|daddr|destination|center|sll)=(-?\d{1,2}\.\d+)\s*(?:,|%2C)\s*(?:\+|%20)?(-?\d{1,3}\.\d+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lat, lon, name: extractQuery(text) || '' };
      }
    }
  }
  return null;
}

/** The place name or address a link names, or ''. */
export function extractQuery(text) {
  const decode = (s) => {
    try { return decodeURIComponent(s.replace(/\+/g, ' ')).trim(); } catch { return ''; }
  };
  const place = text.match(/\/maps\/place\/([^/@?#]+)/);
  if (place) return decode(place[1]).slice(0, 120);

  let url;
  try { url = new URL(text); } catch { return ''; }
  for (const key of ['q', 'query', 'destination', 'daddr', 'address']) {
    const v = url.searchParams.get(key);
    if (v && !/^\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/.test(v)) return v.trim().slice(0, 120);
  }
  return '';
}

/** Where a cookie-wall URL was going. */
function unwrapConsent(url) {
  try {
    const next = new URL(url).searchParams.get('continue');
    return next ? new URL(next).toString() : null;
  } catch { return null; }
}

/** Look the name up in Photon, inside Georgia. Tries the full text, then just
 *  the part before the first comma ("Fabrika, 8 Egnate Ninoshvili St" → "Fabrika"). */
export async function geocode(query, fetcher = fetch) {
  const tries = [query];
  const head = query.split(',')[0].trim();
  if (head && head !== query) tries.push(head);
  for (const q of tries) {
    const params = new URLSearchParams({ q, limit: '1', bbox: GEORGIA_BBOX });
    try {
      const res = await fetcher(`${PHOTON_URL}?${params}`, { headers: { 'User-Agent': 'TeslaNaviGeorgia (+https://tesla.jaba.ge)' } });
      if (!res.ok) continue;
      const data = await res.json();
      const f = data.features?.[0];
      const c = f?.geometry?.coordinates;
      if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        return { lat: c[1], lon: c[0], name: f.properties?.name || head || query };
      }
    } catch { /* try the next */ }
  }
  return null;
}

/**
 * Follow the link and return { lat, lon, name } or throw { status, message }.
 * `fetcher` is injectable so the tests can run without the network.
 */
export async function resolve(raw, fetcher = fetch) {
  raw = String(raw || '').trim();
  if (!raw) throw err(400, 'No link given');
  // People paste the whole share text: "Fabrika https://maps.app.goo.gl/…"
  const inText = raw.match(/https?:\/\/\S+/);
  if (inText) raw = inText[0];

  let current;
  try { current = new URL(raw).toString(); } catch { throw err(400, 'That is not a link'); }
  if (!MAP_HOSTS.includes(new URL(current).hostname)) {
    throw err(400, 'Only Google, Apple or Waze map links work here');
  }

  let query = '';
  for (let hop = 0; hop < 6; hop++) {
    const host = new URL(current).hostname;
    if (CONSENT_HOSTS.includes(host)) {
      const next = unwrapConsent(current);
      if (!next) break;
      current = next;
      continue;
    }
    if (!MAP_HOSTS.includes(host)) throw err(400, 'That link leads somewhere unexpected');

    const found = extractPlace(current);
    if (found) return found;
    query = extractQuery(current) || query;

    // A link that already names the place needs nothing more from Google
    if (query && host !== 'maps.app.goo.gl' && host !== 'goo.gl') break;

    let res;
    try {
      res = await fetcher(current, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    } catch { break; }
    const location = res.headers.get('location');
    if (location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (res.ok) {
      // Some links only reveal the place inside the page itself
      const body = (await res.text()).slice(0, 300000);
      const inPage = extractPlace(body);
      if (inPage) return { ...inPage, name: inPage.name || query };
    }
    break;
  }

  if (query) {
    const hit = await geocode(query, fetcher);
    if (hit) return hit;
    throw err(404, `Could not find “${query.slice(0, 60)}” in Georgia`);
  }
  throw err(404, 'No location found in that link');
}

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
