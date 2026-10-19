#!/usr/bin/env bash
# Regenerates public/packs/default/clips/*.webp (the built-in placeholder pet). Needs ImageMagick 7.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/packs/default/clips
TMP=$(mktemp -d)
mkdir -p "$OUT"
S=384                       # frame size
BODY='#b9aec9'; SHADE='#a497b6'; INK='#3f3848'; CHEEK='#d9b8c4'

# body(file, squash, eyes-draw-args...)
body() {
  local f=$1 sq=$2; shift 2
  local rx=$(( 150 + sq )) ry=$(( 132 - sq ))
  local cy=$(( S - 20 - ry ))
  magick -size ${S}x${S} xc:none \
    -fill "$SHADE" -draw "ellipse $((S/2 - 70)),$((S - 22)) 34,16 0,360" -draw "ellipse $((S/2 + 70)),$((S - 22)) 34,16 0,360" \
    -fill "$BODY" -draw "ellipse $((S/2)),$cy $rx,$ry 0,360" \
    -fill "$CHEEK" -draw "ellipse $((S/2 - 88)),$((cy + 34)) 20,11 0,360" -draw "ellipse $((S/2 + 88)),$((cy + 34)) 20,11 0,360" \
    -fill "$INK" -stroke "$INK" "$@" "$f"
}
EY=$(( S - 20 - 132 ))       # eye baseline
L=$(( S/2 - 52 )); R=$(( S/2 + 52 ))

EYES_OPEN=(-draw "ellipse $L,$EY 13,20 0,360" -draw "ellipse $R,$EY 13,20 0,360")

# idle: 12 frames, gentle squash + one blink
frames=()
for i in $(seq 0 11); do
  sq=$(node -e "console.log(Math.round(Math.sin($i/12*Math.PI*2)*5))")
  if [ "$i" = 9 ] || [ "$i" = 10 ]; then
    body "$TMP/idle-$i.png" "$sq" -strokewidth 6 -draw "line $((L-13)),$EY $((L+13)),$EY" -draw "line $((R-13)),$EY $((R+13)),$EY"
  else
    body "$TMP/idle-$i.png" "$sq" "${EYES_OPEN[@]}"
  fi
  frames+=("$TMP/idle-$i.png")
done
magick "${frames[@]}" +append -define webp:lossless=true "$OUT/idle.webp"

# stills
body "$TMP/focus.png" 0 -strokewidth 7 -draw "line $((L-15)),$EY $((L+15)),$((EY-4))" -draw "line $((R-15)),$((EY-4)) $((R+15)),$EY"
body "$TMP/think.png" 0 -draw "ellipse $((L+8)),$((EY-12)) 11,16 0,360" -draw "ellipse $((R+8)),$((EY-12)) 11,16 0,360" \
  -stroke none -draw "circle $((S/2 + 150)),70 $((S/2 + 160)),70" -draw "circle $((S/2 + 120)),104 $((S/2 + 126)),104"
body "$TMP/wait.png" -6 -draw "ellipse $L,$EY 17,24 0,360" -draw "ellipse $R,$EY 17,24 0,360" \
  -stroke none -draw "roundrectangle $((S/2 + 140)),20 $((S/2 + 160)),80 8,8" -draw "circle $((S/2 + 150)),100 $((S/2 + 150)),110"
body "$TMP/happy.png" 6 -fill none -strokewidth 7 -draw "arc $((L-16)),$((EY-10)) $((L+16)),$((EY+18)) 180,360" -draw "arc $((R-16)),$((EY-10)) $((R+16)),$((EY+18)) 180,360"
body "$TMP/oops.png" 0 -strokewidth 7 -draw "line $((L-14)),$((EY-12)) $((L+12)),$EY" -draw "line $((L+12)),$EY $((L-14)),$((EY+12))" \
  -draw "line $((R+14)),$((EY-12)) $((R-12)),$EY" -draw "line $((R-12)),$EY $((R+14)),$((EY+12))"
for n in focus think wait happy oops; do magick "$TMP/$n.png" -define webp:lossless=true "$OUT/$n.webp"; done
rm -rf "$TMP"
ls -la "$OUT"
