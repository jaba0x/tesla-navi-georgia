/* GeoDrive — navigation helpers
 * Geometry along the route, maneuver wording and the arrow icons.
 * Kept apart from app.js so the map code stays readable.
 */
window.GeoNav = (() => {
  'use strict';

  const R = 6371000;
  const rad = Math.PI / 180;

  function haversine(a, b) {
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearing(a, b) {
    const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
    const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) -
      Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
    return ((Math.atan2(y, x) / rad) + 360) % 360;
  }

  // Metres per degree at this latitude — good enough for the short distances here
  function scale(lat) {
    return { kx: 111320 * Math.cos(lat * rad), ky: 110540 };
  }

  /** Pre-compute what navigation needs from an OSRM route. */
  function prepare(route) {
    const coords = route.geometry.coordinates;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));

    const steps = route.legs.flatMap((l) => l.steps);
    const total = cum[cum.length - 1];

    // Where each maneuver sits along the route, in metres from the start
    let cursor = 0;
    const offsets = steps.map((s) => {
      const m = project(s.maneuver.location, coords, cum, cursor);
      cursor = m.index;
      return m.offset;
    });
    offsets[0] = 0;
    if (offsets.length > 1) offsets[offsets.length - 1] = total;

    return { coords, cum, steps, offsets, total, duration: route.duration };
  }

  /**
   * Nearest point on the route to `point`.
   * `fromIndex` limits the search to the road ahead, so a route that loops back
   * on itself doesn't snap to the wrong pass.
   */
  function project(point, coords, cum, fromIndex = 0) {
    if (coords.length < 2) {
      return { distance: 0, offset: 0, index: 0, point: coords[0] };
    }
    const { kx, ky } = scale(point[1]);

    function scan(start) {
      let best = { distance: Infinity, offset: 0, index: start, point: coords[start] };
      for (let i = start; i < coords.length - 1; i++) {
        const ax = (coords[i][0] - point[0]) * kx, ay = (coords[i][1] - point[1]) * ky;
        const bx = (coords[i + 1][0] - point[0]) * kx, by = (coords[i + 1][1] - point[1]) * ky;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const cx = ax + t * dx, cy = ay + t * dy;
        const distance = Math.hypot(cx, cy);
        if (distance < best.distance) {
          best = {
            distance,
            index: i,
            offset: cum[i] + t * (cum[i + 1] - cum[i]),
            point: [
              coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
              coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
            ],
          };
        }
        // Once we are clearly past the match, stop looking
        if (best.distance < 30 && cum[i] - best.offset > 400) break;
      }
      return best;
    }

    const start = Math.max(0, fromIndex - 40);
    const near = scan(start);
    // Nothing close on the road ahead. Look at the whole route before giving up,
    // otherwise one bad match pins guidance to the wrong part of the line and it
    // never finds its way back.
    if (near.distance > 60 && start > 0) {
      const all = scan(0);
      if (all.distance < near.distance) return all;
    }
    return near;
  }

  /** The position `metres` further along the route, for aiming the camera. */
  function pointAt(nav, metres) {
    const { coords, cum, total } = nav;
    const d = Math.max(0, Math.min(metres, total));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const span = cum[i] - cum[i - 1] || 1;
    const t = (d - cum[i - 1]) / span;
    return [
      coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
      coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
    ];
  }

  /** The part of the route between two distances, as a LineString. */
  function slice(nav, fromMetres, toMetres) {
    const { coords, cum } = nav;
    const from = Math.max(0, fromMetres), to = Math.min(toMetres, nav.total);
    const out = [pointAt(nav, from)];
    for (let i = 0; i < coords.length; i++) {
      if (cum[i] > from && cum[i] < to) out.push(coords[i]);
    }
    out.push(pointAt(nav, to));
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: out }, properties: {} };
  }

  // ---------------------------------------------------------------- wording
  function instruction(step, destinationName) {
    const m = step.maneuver;
    const road = step.name || step.ref || '';
    const onto = road ? ` onto ${road}` : '';
    const on = road ? ` on ${road}` : '';
    const mod = m.modifier || '';
    switch (m.type) {
      case 'depart': return `Head ${compass(m.bearing_after)}${on}`;
      case 'arrive': return destinationName ? `Arrive at ${destinationName}` : 'Arrive at your destination';
      case 'turn':
      case 'end of road':
        return mod === 'uturn' ? `Make a U-turn${onto}` : `Turn ${mod}${onto}`;
      case 'continue':
      case 'new name':
        return mod && mod !== 'straight' ? `Keep ${mod}${onto}` : `Continue${on}`;
      case 'merge': return `Merge ${mod}${onto}`;
      case 'on ramp': return `Take the ramp${mod ? ` on the ${mod}` : ''}${onto}`;
      case 'off ramp': return `Take the exit${mod ? ` on the ${mod}` : ''}${onto}`;
      case 'fork': return `Keep ${mod} at the fork${onto}`;
      case 'roundabout':
      case 'rotary':
      case 'roundabout turn':
        return m.exit ? `At the roundabout, take exit ${m.exit}${onto}` : `Enter the roundabout${onto}`;
      case 'exit roundabout':
      case 'exit rotary':
        return `Exit the roundabout${onto}`;
      default: return `${cap(m.type)} ${mod}${onto}`.trim();
    }
  }

  function compass(deg) {
    const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    return dirs[Math.round(((deg || 0) % 360) / 45) % 8];
  }

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  function fmtDist(m) {
    if (m < 10) return 'now';
    if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  }

  function fmtDuration(s) {
    const h = Math.floor(s / 3600);
    const min = Math.round((s % 3600) / 60);
    return h ? `${h} h ${min} min` : `${Math.max(min, 1)} min`;
  }

  /** Spoken version — "in 400 meters, turn right onto Rustaveli Avenue". */
  function spoken(step, metres, destinationName) {
    const text = instruction(step, destinationName);
    if (metres < 60) return text;
    const where = metres < 1000
      ? `In ${Math.round(metres / 50) * 50} meters`
      : `In ${(metres / 1000).toFixed(1)} kilometers`;
    return `${where}, ${text[0].toLowerCase()}${text.slice(1)}`;
  }

  // ---------------------------------------------------------------- arrows
  const P = {
    straight: 'M24 40V14M24 12l-9 9M24 12l9 9',
    'slight left': 'M28 40V25L17 14M15 12l1 10M15 12l10 1',
    'slight right': 'M20 40V25l11-11M33 12l-1 10M33 12l-10 1',
    left: 'M32 40V24a6 6 0 0 0-6-6H14M12 16l-6 6 6 6',
    right: 'M16 40V24a6 6 0 0 1 6-6h12M36 16l6 6-6 6',
    'sharp left': 'M31 40V27a7 7 0 0 0-7-7l-9 4M14 13l1 11M14 13l9 5',
    'sharp right': 'M17 40V27a7 7 0 0 1 7-7l9 4M34 13l-1 11M34 13l-9 5',
    uturn: 'M16 40V24a8 8 0 0 1 16 0v10M32 36l-5-6M32 36l5-6',
    roundabout: 'M24 40V31a7 7 0 1 1 7-7h8M38 20l6 4-6 4',
    arrive: 'M18 40V10h16l-4 6 4 6H18',
  };

  function arrow(maneuver) {
    const key = arrowKey(maneuver);
    const d = P[key] || P.straight;
    return `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="${d}"/></svg>`;
  }

  function arrowKey(m) {
    if (!m) return 'straight';
    if (m.type === 'arrive') return 'arrive';
    if (m.type.includes('roundabout') || m.type.includes('rotary')) return 'roundabout';
    if (m.modifier === 'uturn') return 'uturn';
    if (P[m.modifier]) return m.modifier;
    return 'straight';
  }

  return {
    haversine, bearing, prepare, project, pointAt, slice,
    instruction, spoken, fmtDist, fmtDuration, arrow,
  };
})();
