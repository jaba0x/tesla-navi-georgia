// Speed cameras in and around Georgia, from OpenStreetMap.
// Shared by the Worker (/api/cameras) and scripts/cameras.mjs, which writes the
// copy shipped with the site (public/cameras.json). An .mjs file, so Node reads it
// as a module without the whole package switching to modules.

// Public Overpass servers, tried in turn: any one of them can be busy
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Georgia's bounding box (south, west, north, east), the same area as search
const BBOX = '41.0,39.9,43.7,46.8';

// Camera points, plus enforcement relations and the device nodes they point to
// (how a red-light or average-speed camera is usually mapped)
export const CAMERA_QUERY = `[out:json][timeout:60];
(
  node["highway"="speed_camera"](${BBOX});
  relation["type"="enforcement"](${BBOX});
);
out body;
node(r:"device");
out;`;

const KINDS = {
  maxspeed: 'speed', average_speed: 'average', traffic_signals: 'red_light',
};

const COMPASS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/** Overpass JSON -> [{ id, lon, lat, kmh, dir, kind }] */
export function parseCameras(osm) {
  const nodes = new Map();
  for (const e of osm.elements || []) {
    if (e.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon)) nodes.set(e.id, e);
  }

  const out = new Map();
  const add = (node, tags) => {
    out.set(node.id, {
      id: node.id,
      lon: Math.round(node.lon * 1e6) / 1e6,
      lat: Math.round(node.lat * 1e6) / 1e6,
      kmh: kmh(tags.maxspeed) ?? kmh((node.tags || {}).maxspeed),
      dir: directions((node.tags || {}).direction ?? tags.direction),
      kind: KINDS[tags.enforcement] || 'speed',
    });
  };

  for (const node of nodes.values()) {
    if ((node.tags || {}).highway === 'speed_camera') add(node, node.tags);
  }
  for (const rel of osm.elements || []) {
    if (rel.type !== 'relation') continue;
    for (const m of rel.members || []) {
      const node = m.type === 'node' && m.role === 'device' && nodes.get(m.ref);
      if (node) add(node, rel.tags || {});
    }
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

// "60" -> 60, "40 mph" -> 64; "RU:urban", "none" and the like -> null
function kmh(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,3})(\s*mph)?$/);
  if (!m) return null;
  const n = m[2] ? Math.round(Number(m[1]) * 1.609) : Number(m[1]);
  return n >= 5 && n <= 150 ? n : null;
}

// The way of travel the camera watches, in degrees: "90", "-73", "25;205" or "NE".
// "forward" / "backward" only mean something along a way, so they count as unknown.
function directions(value) {
  if (value == null) return null;
  const dirs = String(value).split(';').map((v) => {
    const s = v.trim().toUpperCase();
    if (s in COMPASS) return COMPASS[s];
    return /^-?\d{1,3}(\.\d+)?$/.test(s) ? ((Math.round(Number(s)) % 360) + 360) % 360 : null;
  });
  return dirs.length && dirs.every((d) => d !== null) ? dirs : null;
}
