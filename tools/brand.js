/* Draws the Patreon avatar and cover for TeslaNaviGeorgia.
 * Everything is original vector work built from the project's own bolt mark and
 * the car marker that is already on the map.
 */
const { chromium } = require('playwright');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'brand');

const RED = '#e31937';
const RED_DARK = '#a50c23';
const BOLT = 'M23.5 6.5 12.5 22.5h6.2L16.5 33.5l11.2-16.3h-6.4z'; // 40x40 box, bbox ~ (12.5,6.5)-(27.7,33.5)

// deterministic noise, so the street grid is the same every run
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A faint street grid, the way the night map looks zoomed out. */
function streets(w, h, seed) {
  const r = rng(seed);
  const out = [];
  for (let y = -40; y < h + 40; y += 26 + r() * 46) {
    const drift = (r() - 0.5) * 26;
    out.push(`<path d="M-20 ${y.toFixed(1)} L${w + 20} ${(y + drift).toFixed(1)}"
      stroke="#8fa0b3" stroke-width="${(0.8 + r() * 1.9).toFixed(2)}" opacity="${(0.05 + r() * 0.09).toFixed(3)}"/>`);
  }
  for (let x = -40; x < w + 40; x += 30 + r() * 54) {
    const drift = (r() - 0.5) * 30;
    out.push(`<path d="M${x.toFixed(1)} -20 L${(x + drift).toFixed(1)} ${h + 20}"
      stroke="#8fa0b3" stroke-width="${(0.8 + r() * 1.9).toFixed(2)}" opacity="${(0.05 + r() * 0.09).toFixed(3)}"/>`);
  }
  // a few blocks, so it reads as a city rather than graph paper
  for (let i = 0; i < 90; i++) {
    const bx = r() * w, by = r() * h, bw = 10 + r() * 46, bh = 8 + r() * 34;
    out.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"
      rx="2" fill="#8fa0b3" opacity="${(0.025 + r() * 0.045).toFixed(3)}"/>`);
  }
  return out.join('\n');
}

/** Contour rings, a nod to the mountain terrain the app draws. */
function contours(cx, cy, seed) {
  const r = rng(seed);
  const out = [];
  for (let ring = 0; ring < 7; ring++) {
    const rad = 90 + ring * 62;
    const pts = [];
    for (let a = 0; a <= 360; a += 18) {
      const wob = 1 + (r() - 0.5) * 0.22;
      const rr = rad * wob;
      pts.push(`${(cx + Math.cos((a * Math.PI) / 180) * rr * 1.5).toFixed(1)},${(cy + Math.sin((a * Math.PI) / 180) * rr * 0.72).toFixed(1)}`);
    }
    out.push(`<polygon points="${pts.join(' ')}" fill="none" stroke="#7d8fa3"
      stroke-width="1.6" opacity="${(0.13 - ring * 0.012).toFixed(3)}"/>`);
  }
  return out.join('\n');
}

/** The car marker from the map, placed and rotated. */
function car(cx, cy, scale, rot) {
  return `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(${scale}) translate(-18 -32)">
    <path d="M2.2 17.2h4.2a1 1 0 0 1 1 1v1.8a1 1 0 0 1-1 1H2.2zM29.6 17.2h4.2a1 1 0 0 1 1 1v1.8a1 1 0 0 1-1 1h-4.2z"
          fill="${RED}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M18 1.5c4.8 0 8.6 2.1 10.2 5.9l2 5.8c1.2 3.8 1.8 8 1.8 12.4V46c0 5-.6 9.4-1.8 13-.5 1.6-1.5 2.4-3 2.4H8.8c-1.5 0-2.5-.8-3-2.4C4.6 55.4 4 51 4 46V25.6c0-4.4.6-8.6 1.8-12.4l2-5.8C9.4 3.6 13.2 1.5 18 1.5z"
          fill="${RED}" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M9.8 22.4h16.4l1 20.4H8.8z" fill="#b30d27"/>
    <path transform="translate(5.34 20) scale(0.63)" d="${BOLT}" fill="#fff"/>
    <path d="M11 21.8c1.4-4.9 3.4-7.1 7-7.1s5.6 2.2 7 7.1c-4-1.1-10-1.1-14 0z" fill="#0b0f14" opacity="0.82"/>
    <path d="M9 43.4c4-1.4 14-1.4 18 0l.8 6.2c-4.8-1.8-14-1.8-18.8 0z" fill="#0b0f14" opacity="0.82"/>
  </g>`;
}

// ---------------------------------------------------------------- avatar
const ROUTE_AVATAR = 'M170 840 L170 600 L512 600 L512 380 L854 380';
const avatar = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="disc" cx="34%" cy="26%" r="86%">
      <stop offset="0%" stop-color="#f43d55"/>
      <stop offset="58%" stop-color="${RED}"/>
      <stop offset="100%" stop-color="${RED_DARK}"/>
    </radialGradient>
    <clipPath id="circle"><circle cx="512" cy="512" r="512"/></clipPath>
  </defs>
  <g clip-path="url(#circle)">
    <circle cx="512" cy="512" r="512" fill="url(#disc)"/>
    <g opacity="0.5">${streets(1024, 1024, 7)}</g>
    <path d="${ROUTE_AVATAR}" fill="none" stroke="#fff" stroke-width="26"
          stroke-linecap="round" stroke-linejoin="round" opacity="0.13"/>
    <path transform="translate(522 524) scale(17.4) translate(-20.1 -20)" d="${BOLT}"
          fill="#0b0f14" opacity="0.16"/>
    <path transform="translate(512 512) scale(17.4) translate(-20.1 -20)" d="${BOLT}" fill="#fff"/>
    <circle cx="512" cy="512" r="497" fill="none" stroke="#fff" stroke-width="12" opacity="0.16"/>
  </g>
</svg>`;

// ---------------------------------------------------------------- cover
// Patreon overlays the page title and About panel on the LEFT, so the car and
// the end of the route sit right of centre.
// Split at the car, so the road already driven sits back the way it does in the app
const DRIVEN = 'M520 1120 L520 812 L1180 812 L1180 520 L1520 520';
const AHEAD = 'M1520 520 L1852 520 L1852 232 L2330 232';
const cover = `
<svg xmlns="http://www.w3.org/2000/svg" width="2500" height="1000" viewBox="0 0 2500 1000">
  <defs>
    <linearGradient id="sky" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#0e1216"/>
      <stop offset="55%" stop-color="#151b21"/>
      <stop offset="100%" stop-color="#1d252d"/>
    </linearGradient>
    <linearGradient id="fadeLeft" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#0e1216" stop-opacity="0.92"/>
      <stop offset="42%" stop-color="#0e1216" stop-opacity="0.32"/>
      <stop offset="70%" stop-color="#0e1216" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="26"/>
    </filter>
    <filter id="softglow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="46"/>
    </filter>
  </defs>

  <rect width="2500" height="1000" fill="url(#sky)"/>
  ${streets(2500, 1000, 21)}
  <g transform="translate(2030 120)">${contours(0, 0, 5)}</g>

  <!-- behind the car: the part already driven -->
  <path d="${DRIVEN}" fill="none" stroke="#5c6672" stroke-width="20"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>

  <!-- ahead of the car: glow underneath, solid line on top -->
  <path d="${AHEAD}" fill="none" stroke="${RED}" stroke-width="54" stroke-linecap="round"
        stroke-linejoin="round" opacity="0.42" filter="url(#glow)"/>
  <path d="${AHEAD}" fill="none" stroke="${RED}" stroke-width="22"
        stroke-linecap="round" stroke-linejoin="round"/>

  <!-- destination -->
  <circle cx="2330" cy="232" r="42" fill="${RED}" opacity="0.28" filter="url(#softglow)"/>
  <circle cx="2330" cy="232" r="19" fill="#fff"/>
  <circle cx="2330" cy="232" r="9" fill="${RED}"/>

  <!-- the car, on the straight, heading east -->
  <ellipse cx="1520" cy="520" rx="210" ry="130" fill="${RED}" opacity="0.3" filter="url(#softglow)"/>
  ${car(1520, 520, 5.1, 90)}

  <!-- settle the left side, where Patreon puts the title and About panel -->
  <rect width="2500" height="1000" fill="url(#fadeLeft)"/>
</svg>`;

(async () => {
  // PW_CHROME lets a sandbox point at its own Chromium; otherwise Playwright's own
  const exe = process.env.PW_CHROME;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  for (const [name, svg, w, h] of [
    ['patreon-avatar', avatar, 1024, 1024],
    ['patreon-cover', cover, 2500, 1000],
  ]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    await page.close();
    console.log(`${name}.png  ${w}x${h}`);
  }
  await browser.close();
})();
