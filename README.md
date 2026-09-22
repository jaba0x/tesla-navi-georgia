# GeoDrive — Georgia road map

A big-screen web map for drivers in Georgia 🇬🇪, made to work well in a car's built-in browser (e.g. Tesla) and on phones.

- Live GPS position with follow mode
- Place search limited to Georgia
- Turn-by-turn route with ETA, step list and automatic re-routing
- Road updates layer (closures, works, hazards, EV chargers) from `public/updates.json`
- 3D driving view: tilted camera that turns with you, 3D buildings, real terrain and hill shading (3D button)
- Day / night map

Not affiliated with Tesla, Inc.

## Stack

| Part | Service |
| --- | --- |
| Hosting | Cloudflare Workers (static assets + API) |
| Map tiles | [OpenFreeMap](https://openfreemap.org) (OpenStreetMap data) |
| Map library | [MapLibre GL JS](https://maplibre.org) |
| Routing | [OSRM](https://project-osrm.org) public server, via `/api/route` |
| Search | [Photon](https://photon.komoot.io), via `/api/search` |
| 3D terrain | Mapzen terrarium elevation tiles on AWS Open Data, via `/api/dem/{z}/{x}/{y}.png` |
| Live traffic | [TomTom Traffic Flow](https://developer.tomtom.com) raster tiles, via `/api/traffic/flow/{z}/{x}/{y}.png` |

### Live traffic setup

The Worker needs a TomTom API key in a secret called `TOMTOM_KEY`
(Cloudflare dashboard → Workers → tesla → Settings → Variables and Secrets).
For local dev, put `TOMTOM_KEY=...` in `.dev.vars` (git-ignored).
Only tiles covering Georgia are fetched, and tiles are cached for 2 minutes, to stay inside the free tier.

The public OSRM and Photon servers are free but rate-limited and meant for light use. The Worker caches responses, and because the frontend only talks to `/api/*`, providers can be swapped later (OpenRouteService, GraphHopper, self-hosted Valhalla…) without touching the frontend.

## Project layout

```
public/          static site (index.html, app.js, style.css, updates.json)
src/worker.js    Cloudflare Worker: /api/route, /api/search, /api/health
wrangler.jsonc   Worker config
```

## Run locally

```bash
npm install
npm run dev        # http://localhost:8787
```

## Deploy

Connected to Cloudflare Workers Builds: every push to `main` deploys automatically.
Manual deploy: `npm run deploy`.

## Publishing road updates

Edit `public/updates.json`, commit and push. Each item:

```json
{
  "id": "unique-id",
  "type": "closure | works | hazard | charger | info",
  "title": "Short title",
  "description": "Details",
  "lat": 41.7, "lon": 44.8,
  "source": "Where the info came from",
  "updated": "2026-09-22"
}
```
