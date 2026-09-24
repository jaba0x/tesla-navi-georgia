# Brand assets

Original vector artwork, built from the project's own bolt mark and the car
marker that already sits on the map. No stock art and nothing borrowed.

| File | Size | Where it goes |
| --- | --- | --- |
| `patreon-avatar.png` | 1024 × 1024 | Patreon profile photo. Shown as a circle, so it is drawn as a disc rather than the rounded square used in the app |
| `patreon-cover.png` | 2500 × 1000 | Patreon cover. Patreon lays the page title and About panel over the left half, so the car and the destination sit right of centre and the left is left as empty map |

## Regenerating

```bash
npm install --no-save playwright
npx playwright install chromium
node tools/brand.js
```

Both files are written back into this folder. The street grid is seeded, so the
output is identical every run and a re-render produces no spurious diff. Set
`PW_CHROME` to use a Chromium that is already on the machine.

Colours are the ones the app uses: `#e31937` for the mark and the car,
`#b30d27` for the roof panel, and the night-map greys for the background.
