# Canvas self-hosted basemap (PMTiles on Cloudflare R2)

Goal: serve Canvas map tiles from one static file we own, so basemap cost stays
flat (~$3–5/month) instead of scaling per rep. Until step 6 is done, Canvas keeps
using the raster CARTO tiles and nothing changes visually.

## 1. Download a US extract

Get a Protomaps basemap `.pmtiles` build from https://maps.protomaps.com/builds/
(pick the newest `.pmtiles`). The planet file is ~110GB; extract just the US:

```bash
# one-time: install the extractor
brew install protomaps/made/pmtiles     # or: go install github.com/protomaps/go-pmtiles@latest

# US bounding box (CONUS + a margin). Produces a much smaller archive.
pmtiles extract https://build.protomaps.com/20260101.pmtiles us.pmtiles \
  --bbox=-125.0,24.4,-66.9,49.4
```

Verify it locally before uploading:

```bash
pmtiles show us.pmtiles          # prints zoom range, tile count, bounds
```

## 2. Create the R2 bucket

Cloudflare dashboard → R2 → Create bucket, name it `firstknock-basemap`.
R2 is the point of this design: zero egress fees.

## 3. Upload

```bash
npx wrangler r2 object put firstknock-basemap/us.pmtiles \
  --file=us.pmtiles --content-type=application/octet-stream
```

Large files upload faster with `rclone` or the dashboard's multipart upload.

## 4. Expose it over HTTP with range requests

R2 → your bucket → Settings → **Public access** → connect a custom domain
(e.g. `tiles.firstknock.com`). PMTiles reads byte ranges out of the single file,
so the URL must support HTTP `Range` requests — a custom domain on R2 does.
The `r2.dev` dev URL is rate-limited and not for production.

Confirm ranges work:

```bash
curl -sI -H "Range: bytes=0-99" https://tiles.firstknock.com/us.pmtiles | head -3
# expect: HTTP/2 206  and  content-range: bytes 0-99/...
```

## 5. Add CORS

R2 → bucket → Settings → CORS policy:

```json
[{ "AllowedOrigins": ["https://app.firstknock.com", "http://localhost:5173"],
   "AllowedMethods": ["GET", "HEAD"],
   "AllowedHeaders": ["range"],
   "ExposeHeaders": ["content-range", "content-length", "etag"],
   "MaxAgeSeconds": 86400 }]
```

Without `range` allowed and `content-range` exposed the map renders blank.

## 6. Point Canvas at it

Edit the root `.env` (build-time vars — Base44 secrets do not reach the frontend
bundle). Remove the raster URL and add the PMTiles URL:

```dotenv
VITE_CANVAS_BASEMAP_PMTILES_URL=https://tiles.firstknock.com/us.pmtiles
VITE_CANVAS_BASEMAP_ATTRIBUTION=&copy; OpenStreetMap contributors &copy; Protomaps
# delete or comment out VITE_CANVAS_BASEMAP_TILE_URL
```

Setting both raster and PMTiles URLs is rejected on purpose
(`getCanvasBasemapConfiguration` returns mode `invalid`) so the migration cannot
land half-done. The OSM-Carto theme in `canvasCartoFlavor.js` is the default
flavor — no extra variable needed.

## 7. Verify

```bash
node --test test/canvas-basemap.test.mjs
node scripts/check-canvas-production-readiness.mjs --components=web
npx vite build
```

Then open Canvas mode and confirm tiles render at metro and street zooms. Colors
are tuned in `src/components/canvas/canvasCartoFlavor.js` — one file, safe to
adjust once you see it on real tiles.

## Rollback

Put `VITE_CANVAS_BASEMAP_TILE_URL` back and remove
`VITE_CANVAS_BASEMAP_PMTILES_URL`, then rebuild. Raster CARTO returns immediately.

## Refreshing map data

Repeat steps 1 and 3 with a newer Protomaps build (quarterly is plenty for
door-knocking). Upload under a dated key (`us-20260401.pmtiles`) and update the
env var, so rollback stays one edit away.