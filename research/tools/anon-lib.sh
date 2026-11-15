# Sourced by make-anon-artifact.sh and check-anon.sh (bash 3.2 compatible). Not executable on its own.
#
# anon_identity_terms REPO_DIR
#   Prints identity terms (one per line) that must not appear in the artifact. Nothing is hard-coded:
#   the terms come from the local git identity, the GitHub owners of the repo's remotes, the login
#   and full name of the current user, $ANON_EXTRA_TERMS (separated by ':' or ',') and the optional,
#   untracked file research/tools/anon-terms.local (one term per line). The terms are passed to the
#   Perl engine through the environment and never printed by the scripts.

ANON_PUBLIC_OWNERS='^(elizaos|foundry-rs|uniswap|openzeppelin|oven-sh|wevm|paradigmxyz|ethereum|nodejs|microsoft|vitest-dev|anthropics|openai)$'
ANON_COMMON_WORDS='^(root|admin|user|runner|ubuntu|github|git|users|home|test|local|claude|eliza|elizaos)$'

anon_identity_terms() {
  repo=$1
  tools_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  {
    if git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
      git -C "$repo" config user.name 2>/dev/null || true
      email=$(git -C "$repo" config user.email 2>/dev/null || true)
      if [ -n "$email" ]; then
        printf '%s\n' "$email" "${email%%@*}"
      fi
      git -C "$repo" remote -v 2>/dev/null | sed -nE 's#.*github\.com[:/]([A-Za-z0-9_.-]+)/.*#\1#p'
    fi
    id -un 2>/dev/null || true
    full=$(id -F 2>/dev/null || true)
    if [ -n "$full" ]; then
      printf '%s\n' "$full"
      printf '%s\n' "$full" | tr ' ' '\n'
    fi
    printf '%s\n' "$HOME" | sed -nE 's#^/(Users|home)/([^/]+).*#\2#p'
    if [ -n "${ANON_EXTRA_TERMS:-}" ]; then
      printf '%s\n' "$ANON_EXTRA_TERMS" | tr ':,' '\n\n'
    fi
    if [ -f "$tools_dir/anon-terms.local" ]; then
      sed -e 's/#.*//' "$tools_dir/anon-terms.local"
    fi
  } | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | awk 'length($0) >= 3' \
    | { grep -viE "$ANON_PUBLIC_OWNERS" || true; } | { grep -viE "$ANON_COMMON_WORDS" || true; } \
    | sort -u
}
