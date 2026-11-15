#!/usr/bin/env bash
# Scan an artifact directory for residual identifying text and secret-looking values (bash 3.2).
#
#   research/tools/check-anon.sh ARTIFACT_DIR [ALLOW_FILE]
#
# Prints one "file:line:class" per finding (values are never printed) and a count per class.
# Classes: identity, owner-repo, codename, repo-url, email, home-path, scratch-path, attribution,
# copyright, forbidden-file, and the secret classes (anthropic-key, openai-key, github-token,
# aws-key, rpc-url-key, pem-private-key, env-secret, hex-private-key).
# ALLOW_FILE (optional) lists findings that were reviewed and accepted, one "file:line:class" per
# line; keep it outside the artifact. Identity terms are derived as in anon-lib.sh.
#
# Exit status: 0 clean; 1 findings; 2 usage error.
set -eu
set -o pipefail

TOOLS_DIR=$(cd "$(dirname "$0")" && pwd)
. "$TOOLS_DIR/anon-lib.sh"

if [ $# -lt 1 ] || [ ! -d "$1" ]; then
  echo "usage: check-anon.sh ARTIFACT_DIR [ALLOW_FILE]" >&2; exit 2
fi
DIR=$(cd "$1" && pwd -P)
ALLOW=${2:-}

REPO=$(git -C "$TOOLS_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$TOOLS_DIR")
ANON_TERMS=$(anon_identity_terms "$REPO")
export ANON_TERMS
nterms=$(printf '%s\n' "$ANON_TERMS" | grep -c . || true)

set +e
findings=$(perl "$TOOLS_DIR/anon.pl" check "$DIR" "$ALLOW")
rc=$?
set -e
if [ "$rc" -gt 1 ]; then echo "check-anon: scanner error (exit $rc)" >&2; exit 2; fi

if [ -z "$findings" ]; then
  echo "check-anon: clean ($DIR; $nterms identity terms checked)"
  exit 0
fi
printf '%s\n' "$findings"
echo "check-anon: $(printf '%s\n' "$findings" | grep -c .) finding(s) in $DIR; per class:"
printf '%s\n' "$findings" | awk -F: '{print $NF}' | LC_ALL=C sort | uniq -c | sed 's/^/  /'
exit 1
