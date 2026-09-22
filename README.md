# GeoDrive — Georgia road map

A big-screen web map for drivers in Georgia 🇬🇪, made to work well in a car's built-in browser (e.g. Tesla) and on phones.

- Live GPS position with follow mode
- Place search limited to Georgia
- Turn-by-turn route with ETA, step list and automatic re-routing
- Road updates layer (closures, works, hazards, EV chargers) from `public/updates.json`
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
