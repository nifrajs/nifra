#!/usr/bin/env bash
# Copy repo-root brand assets into site/public (no cropping — use pre-sized exports).
# 64/256 exports are the crystal-N mark only (no wordmark, tight crop) — favicon must read at 16px.
# 512 keeps the full logo + wordmark: it serves the OG/social card where the text helps.
# nifra_background.png is the text-free mountains strip (hero atmosphere; H1 carries the headline).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUB="$ROOT/site/public"

cp "$ROOT/nifra_icon_64.png"  "$PUB/favicon.png"
cp "$ROOT/nifra_icon_256.png" "$PUB/logo-mark.png"
cp "$ROOT/nifra_icon_512.png" "$PUB/icon.png"
cp "$ROOT/nifra_background.png" "$PUB/background.png"

echo "synced site/public/{favicon,logo-mark,icon,background}.png"
