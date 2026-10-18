/* The shared-link resolver, with the network faked. Covers the link shapes
 * Google has used, and the case that broke: Google refusing its own page.
 *   node test/resolve.test.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { resolve, extractPlace, extractQuery } = await import(path.join(here, '..', 'src', 'resolve.js'));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

/** A fake network: short links redirect, Google pages answer 429 like they do
 *  to Cloudflare, Photon knows two places. Records what was fetched. */
function net(redirects) {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    const u = new URL(url);
    if (redirects[url]) return { ok: false, status: 302, headers: new Map([['location', redirects[url]]]) };
    if (u.hostname === 'photon.komoot.io') {
      const q = u.searchParams.get('q');
      const known = { 'Fabrika': [44.8023, 41.7092], 'Rike Park': [44.8105, 41.6930] };
      const hit = known[q];
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ features: hit ? [{ geometry: { coordinates: hit }, properties: { name: q } }] : [] }) };
    }
    return { ok: false, status: 429, headers: new Map(), text: async () => '' };
  };
  return { fetcher, seen };
}
const attempt = async (raw, fetcher) => {
  try { return await resolve(raw, fetcher); } catch (e) { return { status: e.status, error: e.message }; }
};

// ---- link shapes --------------------------------------------------------------
check('coords in place data', extractPlace('https://www.google.com/maps/place/X/@41.1,44.1,17z/data=!3d41.7092!4d44.8023').lat, 41.7092);
check('q=lat,lon', extractPlace('https://maps.google.com/?q=41.7092,44.8023').lon, 44.8023);
check('q=lat,+lon', extractPlace('https://maps.google.com/?q=41.7092,+44.8023').lon, 44.8023);
check('a name is not coordinates', extractPlace('https://maps.google.com/?q=Fabrika,+Tbilisi&ftid=0x40440cd9:0x1'), null);
check('name from q=', extractQuery('https://maps.google.com/?q=Fabrika,+8+Ninoshvili+St,+Tbilisi&ftid=0x1:0x2'), 'Fabrika, 8 Ninoshvili St, Tbilisi');
check('name from /place/', extractQuery('https://www.google.com/maps/place/Rike+Park/data=!4m2!3m1!1s0x1'), 'Rike Park');

// ---- the case that broke: short link → name only → Google page refused --------
{
  const { fetcher, seen } = net({
    'https://maps.app.goo.gl/sw9oWqGPVzBYuv': 'https://maps.google.com/?q=Fabrika,+8+Egnate+Ninoshvili+St,+Tbilisi&ftid=0x40440cd9:0x1&entry=gps',
  });
  const r = await attempt('https://maps.app.goo.gl/sw9oWqGPVzBYuv', fetcher);
  check('name-only short link resolves through Photon', [r.lat, r.lon, r.name], [41.7092, 44.8023, 'Fabrika']);
  check('Google\'s own page is never requested', seen.some((u) => u.startsWith('https://maps.google.com')), false);
}
{
  const { fetcher } = net({ 'https://maps.app.goo.gl/abc': 'https://www.google.com/maps/place/Rike+Park/data=!4m2!3m1!1s0x40440cd9' });
  const r = await attempt('https://maps.app.goo.gl/abc', fetcher);
  check('/place/ link with no numbers resolves', [r.lat, r.lon], [41.693, 44.8105]);
}
{
  const { fetcher } = net({ 'https://maps.app.goo.gl/old': 'https://www.google.com/maps/place/Rike+Park/@41.693,44.81,17z/data=!3d41.6930!4d44.8105' });
  const r = await attempt('https://maps.app.goo.gl/old', fetcher);
  check('old-style link still read from the URL', [r.lat, r.lon, r.name], [41.693, 44.8105, 'Rike Park']);
}
{
  const { fetcher } = net({ 'https://maps.app.goo.gl/c': 'https://consent.google.com/m?continue=' + encodeURIComponent('https://www.google.com/maps/place/Fabrika/data=!4m2') });
  const r = await attempt('https://maps.app.goo.gl/c', fetcher);
  check('cookie wall is unwrapped, not fetched', r.name, 'Fabrika');
}
{
  const { fetcher } = net({ 'https://maps.app.goo.gl/x': 'https://maps.google.com/?q=Nowhere+Special' });
  const r = await attempt('Shared: https://maps.app.goo.gl/x', fetcher);
  check('share text around the link is fine; unknown place says so', r.status, 404);
}
{
  const { fetcher } = net({ 'https://maps.app.goo.gl/evil': 'https://evil.example/' });
  check('redirect off the map hosts is refused', (await attempt('https://maps.app.goo.gl/evil', fetcher)).status, 400);
  check('other hosts refused up front', (await attempt('https://evil.example/x', fetcher)).status, 400);
}

console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
