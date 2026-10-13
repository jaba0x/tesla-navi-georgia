/* The Google directions parser, against a real response captured in Tbilisi.
 * When Google changes the shape, this is the test that goes red first, and
 * PATHS in src/traffic.js is what you fix.
 *   node test/traffic.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseDirections, parseBody, transferSpans, buildUrl } =
  await import(path.join(here, '..', 'src', 'traffic.js'));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'google-directions.json'), 'utf8'));
const routes = parseDirections(fixture);

// --- the captured Tbilisi response, Rustaveli Avenue to Saburtalo -----------
check('three routes parsed', routes?.length, 3);
const r = routes[0];
check('road name', r.road, 'Merab Kostava St');
check('distance 5.8 km', r.distance, 5780);
check('static duration 19 min', r.staticSec, 1141);
check('in-traffic duration 32 min', r.trafficSec, 1917);
check('traffic level is heavy-ish', r.level, 1);
check('typical spread 18–37 min', r.typical, [1090, 2230]);
check('five congestion stretches', r.spans.length, 5);
check('first stretch', r.spans[0], { level: 2, start: 326, length: 277 });
check('stretches are in order', r.spans.every((s, i) => i === 0 || s.start >= r.spans[i - 1].start), true);
check('stretches sit inside the route', r.spans.every((s) => s.start + s.length <= r.distance), true);
check('every route has a distance', routes.every((x) => x.distance > 0), true);

// --- a format change must degrade, not throw ----------------------------------
check('empty object → null', parseDirections({}), null);
check('null → null', parseDirections(null), null);
check('routes missing → null', parseDirections([[null, null]]), null);
check('route with no summary → skipped', parseDirections([[null, [[]]]]), null);
check('garbage spans are dropped', parseDirections([[null, [[[0, 'x', [1000], [60], 0, 0, 0, 0, 0, 0, [[90], 0, 1]], 0, 0, [0, 0, 0, 0, 0, [[[2, -5, 10], [1, 100, 2000], 'nope', [1, 200, 50]]]]]]]])[0].spans,
  [{ level: 1, start: 200, length: 50 }]);

// --- the XSSI guard -----------------------------------------------------------
check('strips )]}\' before parsing', parseBody(")]}'\n[1,2]"), [1, 2]);
check('plain JSON still parses', parseBody('[3]'), [3]);
check('junk → null', parseBody('<html>'), null);

// --- the request --------------------------------------------------------------
const url = buildUrl({ lon: 44.798, lat: 41.698 }, { lon: 44.765, lat: 41.724 });
check('origin lands in the template', url.includes('!3d41.698000!4d44.798000'), true);
check('destination too', url.includes('!3d41.724000!4d44.765000'), true);
check('driving mode', url.includes('!1e0!'), true);
check('no placeholder left behind', /\{[A-Z]+\}/.test(url), false);

// --- transferring stretches onto our own line ---------------------------------
const moved = transferSpans([{ level: 2, start: 1000, length: 500 }], 5000, 6000);
check('stretch scales with the route', moved, [{ level: 2, start: 1200, length: 600 }]);
check('zero distance → nothing', transferSpans([{ level: 2, start: 1, length: 1 }], 0, 100), []);

console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
