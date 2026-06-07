#!/usr/bin/env bash
#
# new-widget.sh — scaffold a new widget from the widget-template/.
#
# Copies the template and replaces every placeholder form — camelCase name,
# kebab-case testids/classes, and the display title — across the widget AND its
# test, so the widget builds, mounts, and tests pass immediately. (For renaming
# an EXISTING widget, use `node scripts/widget.js rename` instead.)
#
# Usage:
#   scripts/new-widget.sh <camelCaseName> ["Display Title"]
#
# Example:
#   scripts/new-widget.sh incidentSummary "Incident Summary"
#   npm test            # unit (or: make test-unit WIDGET=incidentSummary in the monorepo)
#   npm run test:e2e    # e2e (needs `npm run assets` once)
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the harness root
TEMPLATE="$REPO_DIR/widget-template"
WIDGETS_DIR="${WIDGETS_SRC:-$REPO_DIR/widgets-src}"
HARNESS_E2E="$REPO_DIR/tests/e2e"
NAME="${1:-}"
TITLE="${2:-}"

[ -n "$NAME" ] || { echo "usage: scripts/new-widget.sh <camelCaseName> [\"Display Title\"]" >&2; exit 2; }
case "$NAME" in
  [a-z]*) : ;;
  *) echo "ERROR: name must be camelCase starting with a lowercase letter (e.g. incidentSummary)" >&2; exit 2 ;;
esac
[ -d "$TEMPLATE" ] || { echo "ERROR: template not found at $TEMPLATE" >&2; exit 1; }

DEST="$WIDGETS_DIR/$NAME"
[ -e "$DEST" ] && { echo "ERROR: $DEST already exists" >&2; exit 1; }

# Derived forms. KEBAB (myWidget -> my-widget) for testids/CSS; PASCAL
# (myWidget -> MyWidget) for the edit-controller name convention
# edit<PascalName><version>DevCtrl. Portable upper-first (BSD sed has no \U;
# macOS bash 3.2 has no ${x^}).
KEBAB="$(printf '%s' "$NAME" | sed -E 's/([a-z0-9])([A-Z])/\1-\2/g' | tr '[:upper:]' '[:lower:]')"
PASCAL="$(printf '%s' "${NAME%"${NAME#?}"}" | tr '[:lower:]' '[:upper:]')${NAME#?}"
if [ -z "$TITLE" ]; then
  spaced="$(printf '%s' "$NAME" | sed -E 's/([a-z0-9])([A-Z])/\1 \2/g')"
  TITLE="$(printf '%s' "${spaced%"${spaced#?}"}" | tr '[:lower:]' '[:upper:]')${spaced#?}"
fi

mkdir -p "$WIDGETS_DIR"
cp -R "$TEMPLATE" "$DEST"
rm -f "$DEST/README.md"   # the template README is not part of a real widget

# Replace placeholders (Title first so it isn't touched by the name swaps).
find "$DEST" -type f -print0 | while IFS= read -r -d '' f; do
  sed -i.bak \
    -e "s/My Widget/$TITLE/g" \
    -e "s/MyWidget/$PASCAL/g" \
    -e "s/myWidget/$NAME/g" \
    -e "s/my-widget/$KEBAB/g" \
    "$f"
  rm -f "$f.bak"
done

# Rename any placeholder-named file inside the widget folder.
find "$DEST" -depth -name '*myWidget*' | while IFS= read -r p; do
  mv "$p" "$(dirname "$p")/$(basename "$p" | sed "s/myWidget/$NAME/g")"
done

# Relocate the e2e spec into the harness tests/e2e/ — Playwright's testDir is the
# harness and does NOT crawl the widgets-src symlink, so a spec left in the
# widget folder is never discovered. The jest UNIT test stays with the widget.
SRC_SPEC="$DEST/tests/e2e/$NAME.spec.js"
if [ -f "$SRC_SPEC" ] && [ -d "$HARNESS_E2E" ]; then
  mv "$SRC_SPEC" "$HARNESS_E2E/$NAME.spec.js"
  rmdir "$DEST/tests/e2e" 2>/dev/null || true
  echo "  e2e spec → tests/e2e/$NAME.spec.js"
fi

echo "✓ created ${DEST} (title: \"$TITLE\", kebab: $KEBAB)"
echo "  next:"
echo "    npm test                 # jest unit"
echo "    npm run dev              # then pick \"$TITLE\" at http://localhost:14400"
echo "    npm run assets           # once, to fetch the SOAR app shell for e2e"
echo "    npm run test:e2e         # Playwright"
