/* Synthetic route + the off-route state machine.
 * Checks that a real missed turn re-routes, and that a merely coarse GPS does not.
 * node nav.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
global.window = {};
new Function(fs.readFileSync(path.join(here, '..', 'public', 'nav.js'), 'utf8'))();
const N = global.window.GeoNav;

// ---- a route: east along one street, right turn, then south -----------------
const LAT = 41.7151, LON0 = 44.7900, JUNC = 44.8000, ENDLAT = 41.7100;
const coords = [];
for (let lon = LON0; lon < JUNC - 1e-9; lon += 0.0002) coords.push([+lon.toFixed(6), LAT]);
coords.push([JUNC, LAT]);
for (let lat = LAT - 0.0002; lat > ENDLAT - 1e-9; lat -= 0.0002) coords.push([JUNC, +lat.toFixed(6)]);

const route = {
  duration: 200,
  geometry: { coordinates: coords },
  legs: [{ steps: [
    { name: 'Chavchavadze Avenue', distance: 830, maneuver: { type: 'depart', bearing_after: 90, location: [LON0, LAT] } },
    { name: 'Barnovi Street', distance: 567, maneuver: { type: 'turn', modifier: 'right', location: [JUNC, LAT] } },
    { name: '', distance: 0, maneuver: { type: 'arrive', location: [JUNC, ENDLAT] } },
  ] }],
};
const nav = N.prepare(route);

// ---- constants mirrored from app.js ----------------------------------------
const OFF_ROUTE_METERS = 45, ACCURACY_SLACK_MAX = 60, OFF_ROUTE_FIXES = 3, OFF_ROUTE_MS = 5000;
const MAX_REROUTES = 3, STEP_PASSED_METERS = 10;

/** The off-route half of trackProgress, so the state machine itself is tested.
 *  `tick` is the gap between GPS fixes, because the rule is now partly about time. */
function drive(points, accuracy, tick = 1000) {
  const s = { offRouteFixes: 0, offRouteSince: 0, rerouteRun: 0, reroutes: 0 };
  let now = 0;
  for (const p of points) {
    now += tick;
    const match = N.project(p, nav.coords, nav.cum, 0);
    const limit = OFF_ROUTE_METERS + Math.min(accuracy, ACCURACY_SLACK_MAX);
    if (match.distance > limit) {
      if (!s.offRouteSince) s.offRouteSince = now;
      s.offRouteFixes++;
      if (s.offRouteFixes >= OFF_ROUTE_FIXES && now - s.offRouteSince >= OFF_ROUTE_MS
          && s.rerouteRun < MAX_REROUTES) {
        s.rerouteRun++; s.reroutes++; s.offRouteFixes = 0; s.offRouteSince = 0;
      }
    } else {
      s.offRouteFixes = 0; s.offRouteSince = 0; s.rerouteRun = 0;
    }
  }
  return s;
}

const stepAt = (traveled) => {
  let i = 0;
  while (i + 1 < nav.steps.length && nav.offsets[i + 1] + STEP_PASSED_METERS <= traveled) i++;
  return i;
};

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

console.log(`route: ${Math.round(nav.total)} m, turn at ${Math.round(nav.offsets[1])} m\n`);

// 1. A genuine missed turn: carry straight on past the junction, drifting further
const missed = [];
for (let i = 1; i <= 12; i++) missed.push([JUNC + i * 0.0004, LAT]);   // ~33 m per fix
const real = drive(missed, 150);
console.log('  drifting away:', missed.slice(0, 6).map((p) => Math.round(N.project(p, nav.coords, nav.cum, 0).distance) + 'm').join(' '));
check('a real missed turn re-routes', real.reroutes >= 1, true);

// The case that actually failed on the road: you turn off and then drive along a
// street roughly parallel to the route, so the distance stops growing. The old
// rule wanted every fix to be further off than the last and never fired at all.
const parallel = [];
for (let i = 1; i <= 15; i++) parallel.push([JUNC + 0.0016 + i * 0.00002, LAT - i * 0.00018]);
const parallelOff = Math.round(N.project(parallel[0], nav.coords, nav.cum, 0).distance);
console.log(`  parallel street, ${parallelOff} m off the line and barely widening`);
check('re-routes when off-route but no longer diverging', drive(parallel, 150).reroutes >= 1, true);
check('and does not re-route more than the cap', real.reroutes <= MAX_REROUTES, true);

// 2. A coarse but steady position, parked 90 m off the line. This is what put
//    the car in a re-routing loop on the road.
const steady = [];
for (let i = 0; i < 40; i++) steady.push([LON0 + 0.004 + (i % 2) * 0.00001, LAT - 0.0008]);
const off = Math.round(N.project(steady[0], nav.coords, nav.cum, 0).distance);
console.log(`  steady offset: ${off} m, limit ${OFF_ROUTE_METERS + 60} m`);
check('a steady coarse offset never re-routes', drive(steady, 200).reroutes, 0);

const spike = [[JUNC + 0.004, LAT], [JUNC + 0.004, LAT]].concat(
  Array.from({ length: 10 }, (_, i) => [LON0 + 0.002 + i * 0.0002, LAT]));
check('a two-fix GPS spike does not re-route', drive(spike, 20).reroutes, 0);

// 3. Even a far, steady offset must not loop for ever
const far = [];
for (let i = 0; i < 60; i++) far.push([LON0 + 0.004, LAT - 0.0030 - (i % 2) * 0.00001]);
check('a far steady offset stops at the cap', drive(far, 200).reroutes <= MAX_REROUTES, true);

// 4. A stale index from further down the route must not pin the match there
const stale = N.project([44.7920, LAT], nav.coords, nav.cum, 60);
check('recovers from a stale forward index', stale.index < 20 && stale.distance < 5, true);

// 5. The instruction must survive until the turn is behind you
check('banner holds the turn 5 m before it', stepAt(nav.offsets[1] - 5), 0);
check('banner advances once past it', stepAt(nav.offsets[1] + 15), 1);
check('step index recovers after a correction', stepAt(400), 0);
check('instruction wording', N.instruction(nav.steps[1]), 'Turn right onto Barnovi Street');

console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
