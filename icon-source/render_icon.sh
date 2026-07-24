#!/bin/bash
# Rasterizes an SVG to PNG at a given size using wkhtmltoimage via an HTML wrapper,
# since no true SVG CLI rasterizer (rsvg-convert/inkscape) is available in this sandbox.
set -e
SVG_FILE="$1"
SIZE="$2"
OUT_FILE="$3"

WRAPPER=$(mktemp --suffix=.html)
cat > "$WRAPPER" << HTML
<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:transparent;}
  svg{display:block;}
</style></head><body>
HTML
cat "$SVG_FILE" >> "$WRAPPER"
echo "</body></html>" >> "$WRAPPER"

wkhtmltoimage --width "$SIZE" --height "$SIZE" --quality 100 "$WRAPPER" "$OUT_FILE" 2>&1 | grep -v "QStandardPaths\|Loading page\|Rendering\|Done\|^\[" || true
rm -f "$WRAPPER"
echo "Rendered $OUT_FILE at ${SIZE}x${SIZE}"
