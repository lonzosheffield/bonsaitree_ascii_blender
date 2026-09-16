#!/usr/bin/env bash
#
# golden.sh -- produce reference ("golden") cbonsai output from the REAL
#              cbonsai binary. This is the ground truth for the M1 pixel diff.
#
# Contract (docs/BRIEF.md):
#
#   N2  Terminal geometry is an INPUT to the algorithm. Branch length and tree
#       shape are functions of the ncurses window size, so every run here is
#       pinned to COLUMNS=80 LINES=40. stdscr is then 40 rows x 80 cols and
#       cbonsai's treeWin is 36 rows x 80 cols (rows - baseHeight(4),
#       cbonsai.c:232-233). An unpinned run makes the diff meaningless.
#
#   N3  Golden output is PRINT MODE: `cbonsai -p -s <seed>` (cbonsai.c:948,
#       cbonsai.c:1080-1089). printstdscr() walks stdscr cell by cell and
#       writes plain text + SGR colour escapes to stdout. No animation, no
#       scraping of a live TUI.
#
#       CAVEAT, handled below: ncurses itself also writes to stdout (it is the
#       stream initscr() takes), so the RAW capture is
#           <ncurses smcup/draw/rmcup teardown>  <printstdscr grid>
#       The first part is screen control and is NOT golden output. This script
#       keeps the raw capture for audit and cuts the printstdscr grid out of
#       it deterministically, then validates the cut (40 rows x 80 cells).
#
# Output (all under proof/M1/golden/):
#   seed-<N>.txt          CANONICAL GOLDEN: printstdscr grid, SGR colour intact
#   seed-<N>.plain.txt    same grid with SGR stripped: exactly 40 x 80 chars
#   raw/seed-<N>.raw      unmodified stdout of the container, for audit
#   geometry.txt          cbonsai's own report of the window size it drew into
#   manifest.json         sha256 + byte/row/col counts for every file
#   determinism.txt       a second full run, byte-diffed against the first
#
# Usage: tools/golden.sh [--no-build]
#
set -euo pipefail

# --------------------------------------------------------------- locations --
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/cbonsai"
OUT_DIR="${REPO_ROOT}/proof/M1/golden"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile.cbonsai"

IMAGE="bonsai-duet/cbonsai-golden:bookworm"

# ------------------------------------------------------------ pinned input --
# N2 -- do not change these without changing the browser <pre> grid to match.
COLS=80
ROWS=40
SEEDS=(1 42 1337 99999 2147483647)

# Docker under Git Bash / MSYS: stop MSYS mangling container-side arguments.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# ...which also stops it translating HOST paths, so do those two explicitly.
to_host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

log() { printf '[golden] %s\n' "$*" >&2; }
die() { printf '[golden] ERROR: %s\n' "$*" >&2; exit 1; }

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker info >/dev/null 2>&1 || die "docker daemon is not running"
[ -f "${VENDOR_DIR}/cbonsai.c" ] || die "vendored source missing: ${VENDOR_DIR}/cbonsai.c"

PY=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys;sys.exit(0 if sys.version_info[0]==3 else 1)' 2>/dev/null; then
    PY="$cand"; break
  fi
done
[ -n "${PY}" ] || die "python3 is required (byte-exact grid extraction)"

mkdir -p "${OUT_DIR}"

# ------------------------------------------------------------------ build ---
if [ "${BUILD}" -eq 1 ]; then
  log "building ${IMAGE} from ${VENDOR_DIR}"
  docker build -q \
    -f "$(to_host_path "${DOCKERFILE}")" \
    -t "${IMAGE}" \
    "$(to_host_path "${VENDOR_DIR}")" >/dev/null
else
  log "skipping image build (--no-build)"
fi
docker image inspect "${IMAGE}" >/dev/null 2>&1 || die "image ${IMAGE} not present"

# -------------------------------------------------------------- run helper --
# Run cbonsai with geometry pinned.
#
# NOTE: `-i`, never `-t`. A pseudo-tty would let the terminal driver, not us,
# decide the window size -- exactly the N2 failure mode. With no tty attached,
# ncurses has no TIOCGWINSZ to consult and uses LINES / COLUMNS.
run_cbonsai() {
  docker run --rm -i \
    -e "COLUMNS=${COLS}" \
    -e "LINES=${ROWS}" \
    -e "TERM=xterm-256color" \
    -e "LC_ALL=C.UTF-8" \
    "${IMAGE}" "$@"
}

# ------------------------------------------------- grid extract + validate ---
# Cut printstdscr()'s grid out of a raw capture and prove the cut is right.
#
# Boundary rule: everything ncurses emits ends with its rmcup teardown
# (`ESC[?1049l ESC[23;0;0t CR ESC[?1l ESC>` for xterm-256color) and contains no
# newline at all. printstdscr()'s very first byte for cell (0,0) is either
# `ESC[1m` or `ESC[0m` (cbonsai.c:731-732). So: seek the last rmcup, then the
# first ESC[0m / ESC[1m after it. The result is then hard-validated as exactly
# ROWS lines of COLS cells followed by the final `ESC[0m` reset line.
#
# args: <raw file> <grid out> <plain out> <rows> <cols>
extract_grid() {
  # The interpreter may be native Windows Python, which cannot read MSYS
  # (/c/...) paths, so hand it host-native paths.
  "${PY}" - "$(to_host_path "$1")" "$(to_host_path "$2")" "$(to_host_path "$3")" "$4" "$5" <<'PYEOF'
import re, sys

raw_path, grid_path, plain_path, rows, cols = sys.argv[1:6]
rows, cols = int(rows), int(cols)
raw = open(raw_path, 'rb').read()

cut = raw.rfind(b'\x1b[?1049l')            # rmcup, emitted by endwin()
if cut == -1:
    cut = 0
m = re.compile(br'\x1b\[[01]m').search(raw, cut)
if m is None:
    sys.exit('no printstdscr() start marker (ESC[0m / ESC[1m) after rmcup')
grid = raw[m.start():]

# cbonsai emits a malformed SGR for default-coloured cells: pair_content()
# returns fg == -1 and cbonsai.c:743 prints "\033[3%him" -> ESC[3-1m. The '-'
# must be inside the strip class or the grid will not measure 80 cells.
plain = re.sub(br'\x1b\[[0-9;-]*m', b'', grid)

lines = plain.split(b'\n')
# printstdscr(): one '\n' per row, then a final "\033[0m\n" -> rows+1 newlines,
# so split() yields rows + 1 reset line + 1 empty tail = rows + 2 parts.
if len(lines) != rows + 2:
    sys.exit('expected %d newline-separated parts, got %d' % (rows + 2, len(lines)))
if lines[rows] != b'' or lines[rows + 1] != b'':
    sys.exit('trailing reset line is not empty after SGR strip')
bad = [(i + 1, len(l)) for i, l in enumerate(lines[:rows]) if len(l) != cols]
if bad:
    sys.exit('rows with wrong cell count (row, width): %r' % (bad[:10],))

open(grid_path, 'wb').write(grid)
open(plain_path, 'wb').write(b'\n'.join(lines[:rows]) + b'\n')
print('%d %d %d' % (len(grid), rows, cols))
PYEOF
}

# ------------------------------------------------- geometry confirmation -----
# `cbonsai -v` prints the ACTUAL treeWin dimensions it is drawing into
# (cbonsai.c:699-706). That is the proof the env vars were honoured and that
# cbonsai did not fall back to asking a tty.
log "confirming cbonsai honours COLUMNS=${COLS} LINES=${ROWS}"
GEOM_TMP="${OUT_DIR}/.geom.raw"
run_cbonsai -p -v -s 1 > "${GEOM_TMP}"
GEOM_LINE="$("${PY}" -c '
import re, sys
raw = open(sys.argv[1], "rb").read()
plain = re.sub(br"\x1b\[[0-9;-]*m", b"", raw).decode("utf-8", "replace")
m = re.search(r"maxX: (\d{3}), maxY: (\d{3})", plain)
print(m.group(0) if m else "")
' "$(to_host_path "${GEOM_TMP}")")"
rm -f "${GEOM_TMP}"
[ -n "${GEOM_LINE}" ] || die "could not read cbonsai's self-reported geometry"

GEOM_X=$(( 10#$(printf '%s' "${GEOM_LINE}" | sed -e 's/.*maxX: \([0-9]*\).*/\1/') ))
GEOM_Y=$(( 10#$(printf '%s' "${GEOM_LINE}" | sed -e 's/.*maxY: \([0-9]*\).*/\1/') ))

# treeWin = newwin(rows - baseHeight, cols, 0, 0); baseType 1 => baseHeight 4.
EXPECT_TREE_ROWS=$(( ROWS - 4 ))
[ "${GEOM_X}" = "${COLS}" ] \
  || die "N2 VIOLATED: cbonsai reports treeWin cols=${GEOM_X}, expected ${COLS}"
[ "${GEOM_Y}" = "${EXPECT_TREE_ROWS}" ] \
  || die "N2 VIOLATED: cbonsai reports treeWin rows=${GEOM_Y}, expected ${EXPECT_TREE_ROWS}"

{
  echo "cbonsai geometry confirmation (BRIEF N2)"
  echo "generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo
  echo "environment passed to the container:"
  echo "  COLUMNS=${COLS}"
  echo "  LINES=${ROWS}"
  echo "  TERM=xterm-256color"
  echo "  docker run -i   (NO -t: no pseudo-tty is allocated, so there is no"
  echo "                   tty window size for ncurses to prefer over the"
  echo "                   LINES/COLUMNS environment variables)"
  echo
  echo "cbonsai -p -v -s 1 self-report (cbonsai.c:699-706, drawn into treeWin):"
  echo "  ${GEOM_LINE}"
  echo
  echo "interpretation:"
  echo "  stdscr   = ${ROWS} rows x ${COLS} cols   <- LINES x COLUMNS, honoured"
  echo "  baseWin  = 4 rows x 31 cols              <- baseType 1 (cbonsai.c:213)"
  echo "  treeWin  = ${GEOM_Y} rows x ${GEOM_X} cols   <- newwin(rows-4, cols) (cbonsai.c:233)"
  echo
  echo "RESULT: cbonsai HONOURS the COLUMNS/LINES environment variables."
  echo "        ncurses setupterm() consults them and cbonsai never calls"
  echo "        use_env(FALSE), so NO 'script'/pty wrapper is needed and none"
  echo "        is used. Every golden file below is a true 40x80 grid."
} > "${OUT_DIR}/geometry.txt"
log "geometry confirmed: stdscr ${ROWS}x${COLS}, treeWin ${GEOM_Y}x${GEOM_X}"

# ---------------------------------------------------------- golden output ---
# $1 = destination directory. Emits seed-<N>.txt, seed-<N>.plain.txt, raw/.
emit_goldens() {
  local dest="$1"
  mkdir -p "${dest}/raw"
  local seed
  for seed in "${SEEDS[@]}"; do
    log "  cbonsai -p -s ${seed}"
    run_cbonsai -p -s "${seed}" > "${dest}/raw/seed-${seed}.raw"
    [ -s "${dest}/raw/seed-${seed}.raw" ] || die "empty output for seed ${seed}"
    extract_grid \
      "${dest}/raw/seed-${seed}.raw" \
      "${dest}/seed-${seed}.txt" \
      "${dest}/seed-${seed}.plain.txt" \
      "${ROWS}" "${COLS}" >/dev/null \
      || die "seed ${seed}: print-mode grid failed validation (see message above)"
  done
}

log "run 1: emitting golden text for seeds: ${SEEDS[*]}"
emit_goldens "${OUT_DIR}"
log "shape validated: every golden is ${ROWS} rows x ${COLS} cells"

# ------------------------------------------------------------- manifest -----
log "writing manifest.json"
sha() { sha256sum "$1" | awk '{print $1}'; }
bytes() { wc -c < "$1" | tr -d ' '; }

{
  echo '{'
  echo '  "generator": "tools/golden.sh",'
  echo '  "source": "vendor/cbonsai/cbonsai.c (real cbonsai, compiled from the vendored source)",'
  echo '  "image": "'"${IMAGE}"'",'
  echo '  "mode": "print mode -p (BRIEF N3, cbonsai.c:948)",'
  echo '  "generated_utc": "'"$(date -u '+%Y-%m-%dT%H:%M:%SZ')"'",'
  echo '  "geometry": {'
  echo '    "columns": '"${COLS}"','
  echo '    "lines": '"${ROWS}"','
  echo '    "stdscr_rows": '"${ROWS}"','
  echo '    "stdscr_cols": '"${COLS}"','
  echo '    "treewin_rows": '"${GEOM_Y}"','
  echo '    "treewin_cols": '"${GEOM_X}"','
  echo '    "basewin_rows": 4,'
  echo '    "basewin_cols": 31,'
  echo '    "pinned_via": "COLUMNS/LINES environment variables, honoured by ncurses setupterm(); no pty wrapper used",'
  echo '    "golden_grid": "'"${ROWS}"' rows x '"${COLS}"' cells"'
  echo '  },'
  echo '  "files": ['
  n=${#SEEDS[@]}
  i=0
  for seed in "${SEEDS[@]}"; do
    i=$(( i + 1 ))
    g="${OUT_DIR}/seed-${seed}.txt"
    p="${OUT_DIR}/seed-${seed}.plain.txt"
    r="${OUT_DIR}/raw/seed-${seed}.raw"
    comma=','
    [ "${i}" -eq "${n}" ] && comma=''
    echo '    {'
    echo '      "seed": '"${seed}"','
    echo '      "command": "cbonsai -p -s '"${seed}"'",'
    echo '      "file": "seed-'"${seed}"'.txt",'
    echo '      "sha256": "'"$(sha "${g}")"'",'
    echo '      "bytes": '"$(bytes "${g}")"','
    echo '      "grid_rows": '"${ROWS}"','
    echo '      "grid_cols": '"${COLS}"','
    echo '      "plain_file": "seed-'"${seed}"'.plain.txt",'
    echo '      "plain_sha256": "'"$(sha "${p}")"'",'
    echo '      "plain_bytes": '"$(bytes "${p}")"','
    echo '      "raw_file": "raw/seed-'"${seed}"'.raw",'
    echo '      "raw_sha256": "'"$(sha "${r}")"'",'
    echo '      "raw_bytes": '"$(bytes "${r}")"
    echo '    }'"${comma}"
  done
  echo '  ]'
  echo '}'
} > "${OUT_DIR}/manifest.json"

"${PY}" -c 'import json,sys; json.load(open(sys.argv[1])); print("manifest.json parses")' \
  "$(to_host_path "${OUT_DIR}/manifest.json")" >/dev/null || die "manifest.json is not valid JSON"

# ---------------------------------------------------------- determinism -----
# Re-run every seed in fresh containers and byte-diff against run 1.
RUN2_DIR="${OUT_DIR}/.run2"
rm -rf "${RUN2_DIR}"
log "run 2: re-running every seed for the determinism proof"
emit_goldens "${RUN2_DIR}"

DET="${OUT_DIR}/determinism.txt"
{
  echo "cbonsai golden-output determinism proof"
  echo "generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo
  echo "method:   tools/golden.sh ran 'cbonsai -p -s <seed>' twice, each time in"
  echo "          a fresh container, and byte-diffed run 1 against run 2."
  echo "geometry: COLUMNS=80 LINES=40, pinned (BRIEF N2) -- grid is ${ROWS}x${COLS}"
  echo "mode:     print mode -p (BRIEF N3)"
  echo "image:    ${IMAGE}"
  echo
  printf '%-12s %-64s %-8s %s\n' "SEED" "SHA256 OF seed-<N>.txt (run 1)" "BYTES" "RUN1 vs RUN2"
  printf '%-12s %-64s %-8s %s\n' \
    "------------" \
    "----------------------------------------------------------------" \
    "--------" "---------------"
} > "${DET}"

FAIL=0
for seed in "${SEEDS[@]}"; do
  a="${OUT_DIR}/seed-${seed}.txt"
  b="${RUN2_DIR}/seed-${seed}.txt"
  sa="$(sha "${a}")"; sb="$(sha "${b}")"
  if cmp -s "${a}" "${b}" && [ "${sa}" = "${sb}" ]; then
    printf '%-12s %-64s %-8s %s\n' "${seed}" "${sa}" "$(bytes "${a}")" "IDENTICAL" >> "${DET}"
  else
    FAIL=1
    printf '%-12s %-64s %-8s %s\n' "${seed}" "${sa}" "$(bytes "${a}")" "*** DIFFERS ***" >> "${DET}"
    printf '%-12s %-64s %-8s %s\n' "" "${sb}" "" "(run 2 sha256)" >> "${DET}"
  fi
done

{
  echo
  echo "raw stdout streams (ncurses teardown + grid, unmodified) also compared:"
} >> "${DET}"
for seed in "${SEEDS[@]}"; do
  a="${OUT_DIR}/raw/seed-${seed}.raw"
  b="${RUN2_DIR}/raw/seed-${seed}.raw"
  if cmp -s "${a}" "${b}"; then
    echo "    raw/seed-${seed}.raw -> IDENTICAL ($(sha "${a}"))" >> "${DET}"
  else
    FAIL=1
    echo "    raw/seed-${seed}.raw -> *** DIFFERS ***" >> "${DET}"
  fi
done

{
  echo
  echo "verbatim diff output (empty == byte identical):"
  echo "  \$ diff proof/M1/golden/seed-<N>.txt <run2>/seed-<N>.txt ; echo \$?"
} >> "${DET}"
for seed in "${SEEDS[@]}"; do
  if out="$(diff "${OUT_DIR}/seed-${seed}.txt" "${RUN2_DIR}/seed-${seed}.txt" 2>&1)"; then
    echo "    seed-${seed}.txt        -> (no output; exit 0)" >> "${DET}"
  else
    echo "    seed-${seed}.txt        -> ${out}" >> "${DET}"
  fi
  if out="$(diff "${OUT_DIR}/seed-${seed}.plain.txt" "${RUN2_DIR}/seed-${seed}.plain.txt" 2>&1)"; then
    echo "    seed-${seed}.plain.txt  -> (no output; exit 0)" >> "${DET}"
  else
    FAIL=1
    echo "    seed-${seed}.plain.txt  -> ${out}" >> "${DET}"
  fi
done

{
  echo
  if [ "${FAIL}" -eq 0 ]; then
    echo "RESULT: DETERMINISTIC."
    echo "        All ${#SEEDS[@]} seeds are byte-identical across two independent runs,"
    echo "        for the coloured grid, the plain grid, and the raw stdout stream."
  else
    echo "RESULT: NON-DETERMINISTIC -- see the differing entries above."
  fi
} >> "${DET}"

rm -rf "${RUN2_DIR}"

[ "${FAIL}" -eq 0 ] || die "determinism check FAILED -- see ${DET}"

log "determinism proof written to ${DET}"
log "done. artifacts in ${OUT_DIR}"
