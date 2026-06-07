#!/usr/bin/env bash
#
# fetch-soar-assets.sh — populate fsr_src/ with the FortiSOAR app shell assets
# the harness needs to RENDER widgets in a browser (required for e2e tests).
#
# These assets (the app bundle + the angular template cache) are Fortinet's
# platform JS — we do NOT redistribute them. Each developer fetches them from
# their OWN licensed FortiSOAR instance (the box FSR_BASE_URL points at). Unit
# tests (jest) do NOT need this; only e2e (Playwright) does.
#
# What it does:
#   1. Authenticate to FSR_BASE_URL (POST /auth/authenticate, user/pass from .env)
#   2. Parse the SOAR index.html for js/app.min.<hash>.js + js/templates.min.<hash>.js
#   3. Download them into fsr_src/ (app bundle saved as app.unmin.js — the harness
#      parses it by string/regex, so the minified bundle works)
#   4. Extract the template cache into fsr_src/templates-extracted/
#
# Usage:  npm run assets        (or: bash scripts/fetch-soar-assets.sh)
#
# Reads creds from .env (FSR_BASE_URL, FSR_USERNAME, FSR_PASSWORD). Point that at
# a TRUSTED LAB box you're licensed to use.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the harness root
ENV_FILE="${FSR_ENV_FILE:-$REPO_DIR/.env}"
EXTRACTOR="$REPO_DIR/scripts/extract-templates.js"
# Match server.js: monorepo sibling ../fsr_src when present, else inside-harness.
if [ -d "$REPO_DIR/../fsr_src" ]; then
  OUT="$(cd "$REPO_DIR/.." && pwd)/fsr_src"
else
  OUT="$REPO_DIR/fsr_src"
fi

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no .env at $ENV_FILE — copy .env.example to .env and fill it in"
[ -f "$EXTRACTOR" ] || die "missing $EXTRACTOR"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE" 2>/dev/null || true; set +a

RAW="${FSR_BASE_URL:-${FORTISOAR_HOST:-}}"
[ -n "$RAW" ] || die "FSR_BASE_URL not set in $ENV_FILE"
HOST="https://${RAW#http*://}"; HOST="${HOST%/}"
FSR_USER="${FSR_USERNAME:-}"; FSR_PASS="${FSR_PASSWORD:-}"
[ -n "$FSR_USER" ] && [ -n "$FSR_PASS" ] || die "FSR_USERNAME / FSR_PASSWORD not set in $ENV_FILE"

# TLS: verify by default — this request transmits credentials. Skipping
# verification must be explicit, via FSR_VERIFY_SSL=false (or FSR_INSECURE_TLS=1),
# and only for a trusted lab box with a self-signed cert. Prefer the lab CA:
# FSR_CA_CERT=/path/to/lab-ca.pem.
CURL_TLS=()
if [ -n "${FSR_CA_CERT:-}" ]; then
  CURL_TLS=(--cacert "$FSR_CA_CERT")
elif [ "${FSR_VERIFY_SSL:-true}" = "false" ] || [ "${FSR_INSECURE_TLS:-0}" = "1" ]; then
  CURL_TLS=(-k)
  warn "TLS verification DISABLED (FSR_VERIFY_SSL=false) — only acceptable for a trusted lab box; credentials are sent over this connection"
fi

say "host: $HOST"
say "authenticating as $FSR_USER..."
TOKEN="$(curl -s "${CURL_TLS[@]}" --max-time 30 -X POST "$HOST/auth/authenticate" \
  -H "Content-Type: application/json" \
  -d "{\"credentials\":{\"loginid\":\"$FSR_USER\",\"password\":\"$FSR_PASS\"}}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)"
[ -n "$TOKEN" ] || die "authentication failed (check creds / box reachable)"
ok "authenticated"

say "reading SOAR index.html for bundle paths..."
HTML="$(curl -s "${CURL_TLS[@]}" --max-time 30 "$HOST/" -H "Authorization: Bearer $TOKEN")"
APP="$(printf '%s' "$HTML" | grep -oE 'js/app\.min\.[a-f0-9]+\.js' | head -1)"
TPL="$(printf '%s' "$HTML" | grep -oE 'js/templates\.min\.[a-f0-9]+\.js' | head -1)"
[ -n "$APP" ] || die "could not find js/app.min.<hash>.js in index.html"
[ -n "$TPL" ] || die "could not find js/templates.min.<hash>.js in index.html"
say "app:       $APP"
say "templates: $TPL"

mkdir -p "$OUT"
TPL_FILE="$OUT/$(basename "$TPL")"

say "downloading app bundle → ${OUT##*/}/app.unmin.js"
curl -s "${CURL_TLS[@]}" --max-time 120 "$HOST/$APP" -H "Authorization: Bearer $TOKEN" -o "$OUT/app.unmin.js"
grep -q 'angular.module("cybersponse"' "$OUT/app.unmin.js" \
  || die "downloaded app bundle doesn't look like the SOAR cybersponse bundle"

say "downloading template cache → ${OUT##*/}/$(basename "$TPL")"
curl -s "${CURL_TLS[@]}" --max-time 120 "$HOST/$TPL" -H "Authorization: Bearer $TOKEN" -o "$TPL_FILE"

say "extracting templates → ${OUT##*/}/templates-extracted/"
( cd "$OUT" && node "$EXTRACTOR" "$TPL_FILE" )

ok "SOAR assets ready in $OUT. e2e tests can now render widgets:"
echo "    npm run test:e2e"
