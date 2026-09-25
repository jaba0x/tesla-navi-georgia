/* Does camera padding put the car where we ask, at a real pitch, on every screen
 * the app has to run on? MapLibre runs for real in headless Chromium; no tiles
 * needed, because this is the camera maths the old metres-to-pixels code got wrong.
 *
 * The padding rule here mirrors navPadding() in public/app.js.
 *
 *   npm install --no-save playwright maplibre-gl && npx playwright install chromium
 *   node test/camera.test.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let chromium, MAPLIBRE;
try {
  ({ chromium } = await import('playwright'));
  MAPLIBRE = require.resolve('maplibre-gl/dist/maplibre-gl.mjs');
} catch {
  console.log('SKIP  camera test needs playwright and maplibre-gl:');
  console.log('      npm install --no-save playwright maplibre-gl && npx playwright install chromium');
  process.exit(0);
}

const ROOT = here;
const CAR_SCREEN_Y = 0.72;
const CAR_CARD_GAP = 56;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = url.startsWith('/maplibre') && url.endsWith('.mjs')
    ? path.join(path.dirname(MAPLIBRE), path.basename(url === '/maplibre.mjs' ? MAPLIBRE : url))
    : path.join(ROOT, url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/javascript';
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(file));
});

const PAGE = path.join(ROOT, 'camera-page.html');
const page_html = `<!doctype html><meta charset="utf-8">
<style>html,body,#map{margin:0;width:100%;height:100%}</style><div id="map"></div>
<script type="module">
import { Map as MLMap } from '/maplibre.mjs';
const CENTER = [44.7930, 41.7151];
const map = new MLMap({
  container: 'map',
  style: { version: 8, sources: {}, layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#111' } }] },
  center: CENTER, zoom: 17, pitch: 0, bearing: 0,
});
map.on('load', () => { window.map = map; window.CENTER = CENTER; });
</script>`;

// The turn card, from style.css: left 16, bottom 16, collapsed width min(430, vw-32)
const card = (w, h) => {
  const width = Math.min(430, w - 32);
  return { left: 16, right: 16 + width, top: h - 16 - 116, width };
};

// Mirrors navPadding()
const paddingTop = (w, h) => {
  let y = h * CAR_SCREEN_Y;
  const box = card(w, h);
  const middle = w / 2;
  if (box.left < middle + 40 && box.right > middle - 40) y = Math.min(y, box.top - CAR_CARD_GAP);
  const fraction = Math.max(0.5, y / h);
  return Math.max(0, Math.round(h * (2 * fraction - 1)));
};

const probe = (pitch, zoom, padTop) => `(() => {
  map.jumpTo({ center: CENTER, zoom: ${zoom}, pitch: ${pitch}, bearing: 0,
               padding: { top: ${padTop}, bottom: 0, left: 0, right: 0 } });
  return map.project(CENTER).y;
})()`;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

(async () => {
  await new Promise((r) => server.listen(8901, r));
  fs.writeFileSync(PAGE, page_html);
  const exe = process.env.PW_CHROME;
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  for (const v of [
    { name: 'Model 3 / Y landscape', w: 1280, h: 800 },
    { name: 'Model S portrait', w: 1200, h: 1780 },
    { name: 'short car window', w: 1100, h: 620 },
    { name: 'shorter still', w: 900, h: 500 },
    { name: 'narrow: card spans the width', w: 440, h: 620 },
  ]) {
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h } });
    await page.goto('http://localhost:8901/camera-page.html');
    await page.waitForFunction('window.map !== undefined', { timeout: 20000 });

    const pad = paddingTop(v.w, v.h);
    const box = card(v.w, v.h);
    console.log(`\n== ${v.name}  ${v.w}x${v.h}   padding top ${pad}, card top ${box.top}`);

    const seen = [];
    for (const zoom of [15.6, 17, 18]) {
      for (const pitch of [0, 58]) seen.push(await page.evaluate(probe(pitch, zoom, pad)));
    }
    const lowest = Math.max(...seen);
    const spread = lowest - Math.min(...seen);
    check('car sits in the same place at every zoom and pitch', spread < 2, `spread ${spread.toFixed(1)} px`);
    check('car is on screen', lowest > 0 && lowest < v.h, `y=${Math.round(lowest)}`);

    const overlapsCentre = box.left < v.w / 2 + 40 && box.right > v.w / 2 - 40;
    if (overlapsCentre) {
      check('car clears the turn card', box.top - lowest >= CAR_CARD_GAP - 2,
        `${Math.round(box.top - lowest)} px of clearance`);
    } else {
      console.log(`   note   card sits off to the left, no clash (car at ${(lowest / v.h).toFixed(2)} down)`);
    }
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} failing` : '\nall green');
  process.exit(failures ? 1 : 0);
})();
