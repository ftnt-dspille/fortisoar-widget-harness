#!/usr/bin/env bash
# ship.sh — bulletproof harness (re)start + widget push.
#
# The historical failure: a stale harness from a prior session keeps holding
# the port. A plain `node server.js` then dies on EADDRINUSE *silently in the
# background*, leaving the OLD server (pointed at the wrong SOAR box) answering
# 200. `widget.js push` prints the host from its OWN env, but the install is
# done by that stale server, so it hits the wrong box (EHOSTUNREACH ...).
#
# This script removes that whole class of bug by ALWAYS starting a fresh server
# on a guaranteed-free port and verifying the listening PID is the one we
# launched (so the env we sourced is definitely the env doing the install).
#
# Usage:
#   scripts/ship.sh [widgetId] [--bump patch|minor|major] [--no-push] [--restart]
#
# Env (all optional, sensible defaults):
#   FSR_ENV_FILE   path to the .env to source   (default: fsr_core .env)
#   PORT           harness port                  (default: 14400)
#   WIDGETS_SRC    widgets source dir            (default: ../widgets-src)
#
# Examples:
#   scripts/ship.sh fsrPlaybookBuilder
#   scripts/ship.sh fsrPlaybookBuilder --bump patch
#   scripts/ship.sh --restart            # just (re)start the harness, no push
set -euo pipefail

# ---- locate ourselves / repo ------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$HARNESS_DIR/.." && pwd)"

# ---- config -----------------------------------------------------------------
PORT="${PORT:-14400}"
FSR_ENV_FILE="${FSR_ENV_FILE:-${HOME}/PycharmProjects/FSRPlaybookYaml/.env}"
WIDGETS_SRC="${WIDGETS_SRC:-$REPO_DIR/widgets-src}"
LOG_FILE="$HARNESS_DIR/.harness.$PORT.log"
PID_FILE="$HARNESS_DIR/.harness.$PORT.pid"

WIDGET_ID=""
BUMP=""
DO_PUSH=1
FORCE_RESTART=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bump)     BUMP="${2:-}"; shift 2 ;;
    --no-push)  DO_PUSH=0; shift ;;
    --restart)  FORCE_RESTART=1; DO_PUSH=0; shift ;;
    --*)        echo "unknown flag: $1" >&2; exit 2 ;;
    *)          WIDGET_ID="$1"; shift ;;
  esac
done

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 1. sanity: env file ----------------------------------------------------
[ -f "$FSR_ENV_FILE" ] || die "env file not found: $FSR_ENV_FILE"

# Source it so THIS process — and the server we spawn — share the same env.
set -a
# shellcheck disable=SC1090
. "$FSR_ENV_FILE" 2>/dev/null || true
set +a

# Derive the host the server WILL target, the same way lib/soarEnv.js does:
# FSR_BASE_URL (scheme optional, trailing slash + port stripped), legacy fallback.
RAW_HOST="${FSR_BASE_URL:-${FORTISOAR_HOST:-}}"
[ -n "$RAW_HOST" ] || die "neither FSR_BASE_URL nor FORTISOAR_HOST set in $FSR_ENV_FILE"
EXPECTED_HOST="$(printf '%s' "$RAW_HOST" | sed -E 's#^https?://##; s#/.*$##; s#:[0-9]+$##')"

say "env:    $FSR_ENV_FILE"
say "target: $EXPECTED_HOST   (port $PORT)"

# ---- 2. free the port (kill ANY listener, ours or stale) --------------------
listeners() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true; }

existing="$(listeners)"
if [ -n "$existing" ]; then
  warn "port $PORT already held by PID(s): $(echo "$existing" | tr '\n' ' ')— killing for a clean, known-good start"
  echo "$existing" | xargs -r kill 2>/dev/null || true
  for _ in 1 2 3 4 5; do [ -z "$(listeners)" ] && break; sleep 1; done
  still="$(listeners)"
  if [ -n "$still" ]; then
    warn "still up, sending SIGKILL: $(echo "$still" | tr '\n' ' ')"
    echo "$still" | xargs -r kill -9 2>/dev/null || true
    for _ in 1 2 3 4 5; do [ -z "$(listeners)" ] && break; sleep 1; done
  fi
  [ -z "$(listeners)" ] || die "could not free port $PORT — investigate manually (lsof -iTCP:$PORT)"
  ok "port $PORT freed"
fi

# ---- 3. start a fresh server, record its PID --------------------------------
# `( exec node ... ) &` makes the subshell BECOME node, so $! is node's exact
# PID (no off-by-one from an intermediate shell/nohup).
say "starting fresh harness → $LOG_FILE"
( cd "$HARNESS_DIR" && exec env PORT="$PORT" WIDGETS_SRC="$WIDGETS_SRC" \
    node server.js ) >"$LOG_FILE" 2>&1 &
SRV_PID=$!
echo "$SRV_PID" >"$PID_FILE"
say "launched PID $SRV_PID"

# ---- 4. wait for readiness AND prove the listener is OUR process ------------
# The port was provably free in step 2, so whoever listens now is the server we
# just launched. We still assert the listening PID is SRV_PID (or a child of it)
# and is a node process running THIS harness's server.js — belt and suspenders.
is_ours() {
  local pid="$1"
  [ "$pid" = "$SRV_PID" ] && return 0
  # child of our launched process?
  [ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$SRV_PID" ] && return 0
  # last resort: a node server.js process from our harness dir
  ps -p "$pid" -o command= 2>/dev/null | grep -q "node .*server.js" && return 0
  return 1
}
ready=0
for i in $(seq 1 30); do
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "----- harness log (tail) -----"; tail -n 30 "$LOG_FILE" || true
    die "harness process $SRV_PID exited during startup (see log above)"
  fi
  if curl -sf -o /dev/null "http://localhost:$PORT/_fsr/widgets"; then
    owner="$(listeners | head -n1)"
    if is_ours "$owner"; then ready=1; ok "harness ready after ${i}s (listener PID $owner, launched $SRV_PID)"; break; fi
    die "PID $owner holds :$PORT but is not our launched server ($SRV_PID) — aborting to avoid pushing through a foreign server"
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "----- harness log (tail) -----"; tail -n 30 "$LOG_FILE" || true; die "harness did not become ready in 30s"; }

# Confirm the started server actually resolved the host we expect.
if grep -qiE "EHOSTUNREACH|ECONNREFUSED|EADDRINUSE" "$LOG_FILE"; then
  echo "----- harness log (tail) -----"; tail -n 20 "$LOG_FILE" || true
  die "harness log shows a connection/bind error — do not push"
fi

if [ "$FORCE_RESTART" = 1 ]; then
  ok "harness (re)started on :$PORT → $EXPECTED_HOST. PID $SRV_PID. Log: $LOG_FILE"
  exit 0
fi

# ---- 5. push ----------------------------------------------------------------
[ -n "$WIDGET_ID" ] || { warn "no widgetId given — harness is up, nothing to push."; exit 0; }
[ "$DO_PUSH" = 1 ] || { ok "harness up; --no-push set, done."; exit 0; }

PUSH_ARGS=(push "$WIDGET_ID")
[ -n "$BUMP" ] && PUSH_ARGS=(push "$WIDGET_ID" --bump "$BUMP")

say "pushing $WIDGET_ID → $EXPECTED_HOST (via PID $SRV_PID)"
# Same sourced env + explicit HARNESS_URL so widget.js targets THIS server.
HARNESS_URL="http://localhost:$PORT" node "$HARNESS_DIR/scripts/widget.js" "${PUSH_ARGS[@]}"
ok "push complete — $WIDGET_ID → $EXPECTED_HOST"
