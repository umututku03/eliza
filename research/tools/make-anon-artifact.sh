#!/usr/bin/env bash
# Build an anonymized copy of the research artifact for double-blind review (bash 3.2 compatible).
#
#   research/tools/make-anon-artifact.sh [OUT_DIR]
#
# OUT_DIR must not exist or be empty, and must lie outside the repository; default: a new folder
# under $TMPDIR. The repository is only read (git archive / git diff); nothing in it is modified.
#
# Output layout:
#   OUT_DIR/artifact/            the anonymized artifact (upload candidate) incl. MANIFEST.sha256
#   OUT_DIR/SCRUB-REPORT.txt     every replacement (file, line, pattern class), exclusions and the
#                                manual-review list; values are never printed. Do not upload.
#
# Environment (all optional):
#   ANON_SRC             repository root to read from (default: the repo containing this script)
#   ANON_REF             git ref to export (default: HEAD)
#   ANON_NOTES           space-separated research/notes files to include
#   ANON_FRAMEWORK_BASE  upstream ElizaOS commit the framework diff is taken against (default 6b6df2f254)
#   ANON_EXTRA_TERMS     extra identity terms (':' or ',' separated); see anon-lib.sh
#
# Exit status: 0 built; 1 usage/environment error; 2 secret-looking value found (output removed).
set -eu
set -o pipefail

TOOLS_DIR=$(cd "$(dirname "$0")" && pwd)
. "$TOOLS_DIR/anon-lib.sh"

SRC=${ANON_SRC:-$(git -C "$TOOLS_DIR" rev-parse --show-toplevel 2>/dev/null || true)}
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "make-anon: cannot find the source repository (set ANON_SRC)" >&2; exit 1; }
SRC=$(cd "$SRC" && pwd -P)
REF=${ANON_REF:-HEAD}
FRAMEWORK_BASE=${ANON_FRAMEWORK_BASE:-6b6df2f254}
NOTES=${ANON_NOTES:-"research/notes/chain-faults-spec.md research/notes/evidence-layer-spec.md research/notes/framework-changes.md"}
ARTIFACT_PATHS="research/agent-harness-v2 research/benchmark research/plan-guard research/README.md $NOTES"

if [ $# -ge 1 ] && [ -n "$1" ]; then
  OUT=$1
  case "$OUT" in /*) abs=$OUT ;; *) abs="$PWD/$OUT" ;; esac
  case "$abs/" in
    "$SRC"/*) echo "make-anon: output must be outside the repository ($SRC)" >&2; exit 1 ;;
  esac
  if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
    echo "make-anon: $OUT exists and is not empty; choose a new directory" >&2; exit 1
  fi
  mkdir -p "$OUT"
else
  OUT=$(mktemp -d "${TMPDIR:-/tmp}/anon-artifact.XXXXXX")
fi
OUT=$(cd "$OUT" && pwd -P)
case "$OUT/" in
  "$SRC"/*) rmdir "$OUT" 2>/dev/null || true
            echo "make-anon: output must be outside the repository ($SRC)" >&2; exit 1 ;;
esac

ART="$OUT/artifact"
WORK="$OUT/.work"
mkdir -p "$ART" "$WORK"
fail_clean() { rm -rf "$OUT"; }

# ------------------------------------------------------------------ 1. copy (read-only export)
IS_GIT=0
if git -C "$SRC" rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then IS_GIT=1; fi
present=""
for p in $ARTIFACT_PATHS; do
  if [ "$IS_GIT" = 1 ]; then
    if [ -n "$(git -C "$SRC" ls-tree --name-only "$REF" -- "$p")" ]; then present="$present $p"; else echo "make-anon: warning: $p not in $REF" >&2; fi
  else
    if [ -e "$SRC/$p" ]; then present="$present $p"; else echo "make-anon: warning: $p missing" >&2; fi
  fi
done
[ -n "$present" ] || { echo "make-anon: none of the artifact paths exist" >&2; fail_clean; exit 1; }

if [ "$IS_GIT" = 1 ]; then
  # Tracked files only, exactly as committed: untracked .env files, logs and node_modules never enter.
  # shellcheck disable=SC2086
  git -C "$SRC" archive --format=tar "$REF" -- $present | tar -x -C "$ART"
else
  for p in $present; do
    mkdir -p "$ART/$(dirname "$p")"
    cp -R "$SRC/$p" "$ART/$(dirname "$p")/"
  done
fi

# Remove anything that must never ship (also guards the non-git fallback).
: > "$WORK/excluded.txt"
find "$ART" \( -name 'results-*' -o -name node_modules -o -name '.env*' -o -name '*.log' -o -name '.git' \
     -o -name '.DS_Store' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name '__pycache__' \
     -o -name 'test-results' -o -name build \) -prune -print \
  | sed "s#^$ART/##" | LC_ALL=C sort > "$WORK/excluded.txt"
while IFS= read -r x; do rm -rf "$ART/$x"; done < "$WORK/excluded.txt"

# ------------------------------------------------------------------ 2. framework file list and diff
FW_NOTE="framework diff: skipped (no git or base commit $FRAMEWORK_BASE not found)"
if [ "$IS_GIT" = 1 ] && git -C "$SRC" rev-parse --verify --quiet "$FRAMEWORK_BASE^{commit}" >/dev/null; then
  base_full=$(git -C "$SRC" rev-parse "$FRAMEWORK_BASE^{commit}")
  mkdir -p "$ART/framework"
  {
    echo "ElizaOS framework files the harness depends on"
    echo "================================================"
    echo
    echo "Upstream base: elizaOS/eliza commit $base_full (public upstream)."
    echo "Apply framework-changes.patch to that commit (git apply) to obtain the framework the harness ran on."
    echo
    echo "Packages imported by the harness (research/agent-harness-v2, research/benchmark, research/plan-guard):"
    grep -rhoE "(from|import\\()[[:space:]]*['\"](@elizaos/[A-Za-z0-9_-]+|\\.\\./\\.\\./(packages|plugins)/[^'\"]+)['\"]" \
      "$ART/research" --include='*.ts' 2>/dev/null \
      | sed -E "s/^(from|import\\()[[:space:]]*['\"]//; s/['\"]$//" | LC_ALL=C sort -u | sed 's/^/  /' || true
    echo
    echo "Changed framework files (added<TAB>deleted<TAB>path), packages/ and plugins/ only:"
    git -C "$SRC" diff --numstat "$base_full" "$REF" -- packages plugins
  } > "$ART/framework/FRAMEWORK-FILES.txt"
  # Blob ids ("index" lines) are dropped: they are not needed by git apply and could be looked up.
  git -C "$SRC" diff --no-color --no-ext-diff "$base_full" "$REF" -- packages plugins \
    | grep -v '^index [0-9a-f]' > "$ART/framework/framework-changes.patch" || true
  nfw=$(git -C "$SRC" diff --name-only "$base_full" "$REF" -- packages plugins | wc -l | tr -d ' ')
  FW_NOTE="framework diff: $nfw files against upstream $FRAMEWORK_BASE"
fi

# ------------------------------------------------------------------ 3. secret scan (fail closed)
if ! perl "$TOOLS_DIR/anon.pl" secrets "$ART" > "$WORK/secrets.txt"; then
  echo "make-anon: FAILED: secret-looking values found (file:line:class; values not shown):" >&2
  grep -v -- '-fixture$' "$WORK/secrets.txt" | sed 's/^/  /' >&2
  echo "make-anon: output removed; fix the source and rerun." >&2
  fail_clean
  exit 2
fi

# ------------------------------------------------------------------ 4. scrub
ANON_TERMS=$(anon_identity_terms "$SRC")
export ANON_TERMS
nterms=$(printf '%s\n' "$ANON_TERMS" | grep -c . || true)
perl "$TOOLS_DIR/anon.pl" scrub "$ART" "$WORK/replacements.txt" "$WORK/manual.txt"
# Synthetic credential fixtures (sequential/repeated bodies) need a human to confirm they are fake.
{ grep -- '-fixture$' "$WORK/secrets.txt" || true; } | sed 's/$/ (synthetic-looking credential in a test fixture; confirm it is fake)/' >> "$WORK/manual.txt"

# ------------------------------------------------------------------ 5. manifest
perl "$TOOLS_DIR/anon.pl" manifest "$ART" > "$WORK/manifest.txt"
mv "$WORK/manifest.txt" "$ART/MANIFEST.sha256"
nfiles=$(grep -c . "$ART/MANIFEST.sha256" || true)

# ------------------------------------------------------------------ 6. residual check
set +e
"$TOOLS_DIR/check-anon.sh" "$ART" > "$WORK/check.txt" 2>&1
check_rc=$?
set -e

# ------------------------------------------------------------------ 7. report
REPORT="$OUT/SCRUB-REPORT.txt"
{
  echo "SCRUB REPORT (keep private; do not upload)"
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source ref: $REF ($(git -C "$SRC" rev-parse --short=10 "$REF" 2>/dev/null || echo n/a))"
  echo "artifact:   $ART"
  echo "files:      $nfiles (see artifact/MANIFEST.sha256)"
  echo "identity terms used: $nterms (values not shown)"
  echo "$FW_NOTE"
  echo
  echo "== Replacements per pattern class (occurrences)"
  awk -F: '{n[$3]+=$4} END {for (c in n) printf "  %-14s %d\n", c, n[c]}' "$WORK/replacements.txt" | LC_ALL=C sort
  echo "  total          $(awk -F: '{s+=$4} END {print s+0}' "$WORK/replacements.txt")"
  echo
  echo "== Replacements (file:line:class:count)"
  sed 's/^/  /' "$WORK/replacements.txt"
  echo
  echo "== Excluded paths"
  if [ -s "$WORK/excluded.txt" ]; then sed 's/^/  /' "$WORK/excluded.txt"; else echo "  (none)"; fi
  echo
  echo "== Manual review ($(grep -c . "$WORK/manual.txt" || true) items; nothing below was changed)"
  if [ -s "$WORK/manual.txt" ]; then sed 's/^/  /' "$WORK/manual.txt"; else echo "  (none)"; fi
  echo
  echo "== check-anon.sh on the artifact: exit $check_rc"
  sed 's/^/  /' "$WORK/check.txt"
} > "$REPORT"
rm -rf "$WORK"

echo "make-anon: artifact  $ART ($nfiles files)"
echo "make-anon: report    $REPORT"
echo "make-anon: replacements $(awk '/^== Replacements per/{f=1;next} f&&/ total /{print $2; exit}' "$REPORT")"
if [ "$check_rc" -ne 0 ]; then
  echo "make-anon: check-anon.sh reports residual findings (exit $check_rc); resolve the manual-review items in the report before upload"
else
  echo "make-anon: check-anon.sh clean"
fi
exit 0
