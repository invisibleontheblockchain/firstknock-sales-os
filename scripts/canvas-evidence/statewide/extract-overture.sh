#!/bin/sh
# Statewide Maryland Overture extraction, pinned to the authoritative release
# contract (Overture 2026-07-22.0, overturemaps 1.0.1). Each theme is uploaded
# to R2 as soon as it completes so a sandbox recycle never loses finished work.
# Usage: sh extract-overture.sh <work-dir>
set -eu

RELEASE="2026-07-22.0"
# Maryland statewide bounding box (west,south,east,north).
BBOX="-79.4877,37.8895,-74.9863,39.7230"
WORK="$1"
PREFIX="canvas-source-artifacts/maryland/statewide-v1/overture"
R2="node scripts/canvas-evidence/statewide/r2-object.mjs"
export PATH="$HOME/.local/bin:$PATH"

mkdir -p "$WORK"
python3 -m pip install --user --quiet "overturemaps==1.0.1"

# Fail closed: the extraction contract requires an explicit release pin.
if ! overturemaps download --help 2>&1 | grep -q -- "--release"; then
  echo "FATAL: overturemaps CLI does not support --release; cannot pin $RELEASE" >&2
  exit 1
fi

for THEME in address building place; do
  OUT="$WORK/$THEME.geojsonl"
  KEY="$PREFIX/$THEME.geojsonl"
  if $R2 exists "$KEY"; then
    echo "skip $THEME (checkpoint already in R2)"
    continue
  fi
  echo "extracting $THEME (release $RELEASE, bbox $BBOX)..."
  overturemaps download --bbox="$BBOX" -f geojsonseq --type="$THEME" --release "$RELEASE" -o "$OUT"
  echo "extracted $THEME; uploading checkpoint..."
  $R2 put "$OUT" "$KEY"
  echo "checkpointed $THEME"
done

echo "DONE overture statewide extraction"