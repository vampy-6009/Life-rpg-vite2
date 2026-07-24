#!/bin/bash
set -e
cd /home/claude/life-rpg-vite/icon-source
mkdir -p rendered

declare -A LEGACY_SIZES=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
declare -A ADAPTIVE_SIZES=( [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )

for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  bash render_icon.sh ic_launcher_legacy.svg "${LEGACY_SIZES[$density]}" "rendered/ic_launcher_legacy_${density}.png"
done

for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  bash render_icon.sh ic_launcher_background.svg "${ADAPTIVE_SIZES[$density]}" "rendered/ic_launcher_background_${density}.png"
  bash render_icon.sh ic_launcher_foreground.svg "${ADAPTIVE_SIZES[$density]}" "rendered/ic_launcher_foreground_${density}.png"
done

echo "--- all rendered ---"
ls -la rendered/
