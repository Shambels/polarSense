#!/usr/bin/env bash
# Turn a screen recording into a README-sized GIF.
#
#   ./scripts/make-gif.sh recording.mov assets/demo.gif [start] [duration]
#
# Example — skip the first 2s of fumbling, keep 11s:
#   ./scripts/make-gif.sh ~/Desktop/rec.mov assets/demo.gif 2 11
#
# Two passes: build a palette from the clip's own colours, then apply it.
# A single-pass GIF is limited to a generic 256-colour palette and looks muddy,
# which matters here because the whole point is legible text in a popup.
set -euo pipefail

IN="${1:?usage: make-gif.sh <input.mov> <output.gif> [start-seconds] [duration-seconds]}"
OUT="${2:?usage: make-gif.sh <input.mov> <output.gif> [start-seconds] [duration-seconds]}"
START="${3:-0}"
DURATION="${4:-}"

FPS="${FPS:-12}"        # 12 is plenty for typing; every frame costs bytes
WIDTH="${WIDTH:-900}"   # Marketplace renders the README around 900px wide

command -v ffmpeg >/dev/null || { echo "ffmpeg not found — brew install ffmpeg"; exit 1; }

TRIM=(-ss "$START")
[ -n "$DURATION" ] && TRIM+=(-t "$DURATION")

PALETTE="$(mktemp -t polarsense-palette.XXXXXX).png"
trap 'rm -f "$PALETTE"' EXIT

FILTER="fps=${FPS},scale=${WIDTH}:-2:flags=lanczos"

echo "→ pass 1/2: sampling colours"
ffmpeg -v error -y "${TRIM[@]}" -i "$IN" \
  -vf "${FILTER},palettegen=stats_mode=diff" "$PALETTE"

echo "→ pass 2/2: encoding"
mkdir -p "$(dirname "$OUT")"
ffmpeg -v error -y "${TRIM[@]}" -i "$IN" -i "$PALETTE" \
  -lavfi "${FILTER}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
DIMS=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
  -of csv=p=0:s=x "$OUT" 2>/dev/null || echo "?")
echo "✓ $OUT — $SIZE, $DIMS, ${FPS}fps"
echo
echo "Under 5 MB is comfortable for a README. If it isn't:"
echo "  FPS=10 WIDTH=800 $0 $IN $OUT $START ${DURATION:-}"
