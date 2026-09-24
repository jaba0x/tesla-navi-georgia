// Refreshes public/cameras.json, the camera list shipped with the site. The Worker
// answers /api/cameras with it until it has fetched a newer list itself.
//   npm run cameras
import { writeFile } from 'node:fs/promises';
import { CAMERA_QUERY, OVERPASS_URLS, parseCameras } from '../src/cameras.mjs';

for (const url of OVERPASS_URLS) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': 'TeslaNaviGeorgia camera list (npm run cameras)' },
      body: new URLSearchParams({ data: CAMERA_QUERY }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cameras = parseCameras(await res.json());
    if (!cameras.length) throw new Error('no cameras in the answer');
    // One camera a line, so a refresh shows up in git as the cameras that changed
    const lines = cameras.map((c) => JSON.stringify(c)).join(',\n');
    const body = `{"updated":"${new Date().toISOString()}","cameras":[\n${lines}\n]}\n`;
    await writeFile(new URL('../public/cameras.json', import.meta.url), body);
    console.log(`${cameras.length} cameras from ${url}`);
    process.exit(0);
  } catch (err) {
    console.warn(`${url}: ${err.message}`);
  }
}
console.error('No Overpass server answered; public/cameras.json is unchanged');
process.exit(1);
