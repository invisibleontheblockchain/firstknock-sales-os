#!/bin/bash
# ───────────────────────────────────────────────────────────────
# GeoParquet → PMTiles Conversion Pipeline
#
# Blueprint: Offline-capable serverless map tile generation
# Uses Tippecanoe to convert Regrid bulk GeoParquet into PMTiles
# for Cloudflare R2 / S3 deployment with MapLibre GL JS.
#
# PREREQUISITES:
#   - tippecanoe: brew install tippecanoe (or build from source)
#   - ogr2ogr (GDAL): brew install gdal
#   - gpio (geoparquet-io): npm install -g @geoparquet-io/gpio-pmtiles
#
# USAGE:
#   ./scripts/generatePMTiles.sh [parquet_dir] [output_file]
#
# Example:
#   ./scripts/generatePMTiles.sh ./regrid_data ./dist/parcels.pmtiles
# ───────────────────────────────────────────────────────────────

set -euo pipefail

PARQUET_DIR="${1:-./regrid_data}"
OUTPUT="${2:-./dist/parcels.pmtiles}"
TMP_GEOJSON="/tmp/regrid_parcels.geojsonl"
TIPPECANOE_LOG="/tmp/tippecanoe_build.log"

echo "═══════════════════════════════════════════════════"
echo "  PMTiles Generation Pipeline"
echo "  Parquet dir: $PARQUET_DIR"
echo "  Output:      $OUTPUT"
echo "═══════════════════════════════════════════════════"

# ─── Verify dependencies ──────────────────────────────────────

command -v tippecanoe >/dev/null 2>&1 || {
    echo "❌ tippecanoe not found. Install: brew install tippecanoe"
    echo "   or: git clone https://github.com/felt/tippecanoe && cd tippecanoe && make -j && make install"
    exit 1
}

command -v ogr2ogr >/dev/null 2>&1 || {
    echo "❌ ogr2ogr (GDAL) not found. Install: brew install gdal"
    exit 1
}

# ─── Step 1: Convert GeoParquet → GeoJSON Lines ───────────────
# Blueprint: Reproject to EPSG:4326, stream without overloading memory

echo ""
echo "📦 Step 1: Converting Parquet → GeoJSON Lines..."
echo "   (selectively extracting ll_uuid + ll_row_parcel only)"

> "$TMP_GEOJSON"  # Clear

for parquet_file in "$PARQUET_DIR"/*.parquet; do
    if [ ! -f "$parquet_file" ]; then
        echo "   ⚠️ No .parquet files found in $PARQUET_DIR"
        exit 1
    fi
    
    echo "   Processing: $(basename "$parquet_file")"
    
    # ogr2ogr converts Parquet → GeoJSON newline-delimited
    # Blueprint: "Restrict attributes baked into tile to ll_uuid + ll_row_parcel only"
    ogr2ogr -f GeoJSONSeq \
        -t_srs EPSG:4326 \
        -select "ll_uuid,ll_row_parcel" \
        /vsistdout/ \
        "$parquet_file" \
        >> "$TMP_GEOJSON" 2>/dev/null || {
            echo "   ⚠️ Skipping $(basename "$parquet_file") (conversion error)"
        }
done

RECORD_COUNT=$(wc -l < "$TMP_GEOJSON" | tr -d ' ')
echo "   ✅ ${RECORD_COUNT} features extracted"

if [ "$RECORD_COUNT" -eq 0 ]; then
    echo "❌ No features extracted. Check Parquet files contain geometry."
    exit 1
fi

# ─── Step 2: Generate PMTiles via Tippecanoe ──────────────────
# Blueprint flags:
#   -zg                         Auto max zoom level
#   --drop-densest-as-needed    Suppress overlapping polygons at low zoom
#   --grid-low-zooms            Snap to stairstep grid at low zoom for size reduction
#   --no-feature-limit          Don't cap features per tile
#   --no-tile-size-limit        Allow larger tiles
#   -l parcels                  Single layer named "parcels"
#   -o output.pmtiles           Output to PMTiles format

echo ""
echo "🗺️  Step 2: Building PMTiles with Tippecanoe..."
echo "   Flags: -zg --drop-densest-as-needed --grid-low-zooms"

mkdir -p "$(dirname "$OUTPUT")"

tippecanoe \
    -zg \
    --drop-densest-as-needed \
    --grid-low-zooms \
    --no-feature-limit \
    --no-tile-size-limit \
    --simplification=10 \
    --detect-shared-borders \
    -l parcels \
    -o "$OUTPUT" \
    --force \
    "$TMP_GEOJSON" \
    2>&1 | tee "$TIPPECANOE_LOG"

# ─── Step 3: Summary ─────────────────────────────────────────

OUTPUT_SIZE=$(du -h "$OUTPUT" | cut -f1)

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ PMTiles Generated"
echo "  File:     $OUTPUT"
echo "  Size:     $OUTPUT_SIZE"
echo "  Features: $RECORD_COUNT"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Upload to Cloudflare R2:  wrangler r2 object put firstknock-tiles/parcels.pmtiles --file=$OUTPUT"
echo "  2. Or upload to S3:         aws s3 cp $OUTPUT s3://firstknock-tiles/parcels.pmtiles"
echo "  3. Add MapLibre source:     { type: 'vector', url: 'pmtiles://https://r2.firstknock.com/parcels.pmtiles' }"
echo ""

# Cleanup
rm -f "$TMP_GEOJSON"
echo "🧹 Cleaned up temp files"
