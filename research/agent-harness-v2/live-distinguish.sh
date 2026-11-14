#!/usr/bin/env bash
# Live runs in the distinguishing market states (research/notes/live-distinguish-2026-11-14-plan.md).
# Six cohorts (luna, haiku x plan_guard, existing_controls, checkpoint_approx), each 3 states x 2 reps.
#
# Run from the repository root, on a clean checkout of the commit that adds this file:
#   export ANVIL_BIN=<anvil binary>  FORK_ENV=<.env with MAINNET_FORK_RPC_URL>
#   export OPENAI_API_KEY=... ANTHROPIC_API_KEY=...      (or KEYS_ENV=<.env file holding both>)
#   bash research/agent-harness-v2/live-distinguish.sh
#
# Rules (fixed before any paid call): no retries, replacements or prompt changes. A missing marker, a run
# error, an audit failure, fewer than 10 tamper rejections, or a cohort that cannot get at least $0.15 of
# provider headroom stops the sweep. Budget refusals inside a cohort are results. No key value is printed.
set -uo pipefail

PRIOR_USD=8.96693885                 # cumulative harness ledger before this sweep (dev sweep, 2026-10-26)
SWEEP_CEILING=4.20                   # new spend, all providers
# Plain functions, not associative arrays: macOS ships bash 3.2.
provider_of() { case $1 in luna) echo openai ;; haiku) echo anthropic ;; esac; }
provider_ceiling() { case $1 in openai) echo 1.80 ;; anthropic) echo 2.40 ;; esac; }
cohort_cap() { case $1 in luna) echo 0.70 ;; haiku) echo 0.95 ;; esac; }   # ~1.8x Oct per-episode cost x 6, for reservations
COHORTS=("luna plan_guard" "luna existing_controls" "luna checkpoint_approx" "haiku plan_guard" "haiku existing_controls" "haiku checkpoint_approx")
SCENARIOS=pre_sale_shortfall,prefunded,price_worse
TAG=distinguish1114
HERE=research/agent-harness-v2
LOGS="$HERE/results-$TAG-logs"; mkdir -p "$LOGS"        # results-*/ is gitignored
LOG="$LOGS/sweep.log"

die() { echo "STOP: $*" | tee -a "$LOG"; exit 1; }
[ -f "$HERE/run-v2.ts" ] || die "run from the repository root"
[ "$(node --version)" = "v24.15.0" ] || die "need Node 24.15.0 on PATH (README: Reproduce)"
[ "$(bun --version)" = "1.4.2" ] || die "need Bun 1.4.2 on PATH (README: Reproduce)"
[ -x "${ANVIL_BIN:-}" ] || die "set ANVIL_BIN to an anvil binary"
[ -f "${FORK_ENV:-}" ] || die "set FORK_ENV to the .env holding MAINNET_FORK_RPC_URL"
[ -z "$(git status --porcelain -- plugins packages/core research/agent-harness-v2 research/benchmark ':!research/agent-harness-v2/results-*')" ] \
  || die "commit or stash changes first: live runs must match the committed harness and sources"
ENV_ARGS=(--env-file="$FORK_ENV"); [ -n "${KEYS_ENV:-}" ] && ENV_ARGS+=(--env-file="$KEYS_ENV")
has_key() { # true if the key is set in the environment or in KEYS_ENV (value never printed)
  [ -n "${!1:-}" ] && return 0
  [ -n "${KEYS_ENV:-}" ] && grep -Eq "^$1=.+" "$KEYS_ENV"
}
echo "sweep $TAG at $(git rev-parse --short=10 HEAD), $(date -u +%FT%TZ)" | tee -a "$LOG"

spent() { # new USD so far: total, or one provider's, from completed cohort markers
  python3 -I - "$HERE" "$TAG" "${1:-all}" <<'PY'
import json, sys, glob, os
here, tag, which = sys.argv[1:]
total = 0.0
for d in glob.glob(os.path.join(here, f'results-{tag}-*')):
    if not os.path.isdir(d) or not os.path.exists(os.path.join(d, 'manifest.json')): continue
    marker = next((os.path.join(d, f) for f in ('complete.json', 'run-error.json') if os.path.exists(os.path.join(d, f))), None)
    if not marker: continue
    led = json.load(open(marker)).get('ledger') or {}
    provider = json.load(open(os.path.join(d, 'manifest.json')))['models'][0]['provider']
    if which in ('all', provider): total += float(led.get('newUSD') or 0)
print(f'{total:.8f}')
PY
}

for cohort in "${COHORTS[@]}"; do
  read -r model condition <<<"$cohort"
  provider=$(provider_of "$model")
  dest="$HERE/results-$TAG-$model-$condition"
  [ -e "$dest" ] && die "$dest exists; never overwrite (resume by removing finished cohorts from COHORTS in a committed edit)"
  key=$([ "$provider" = openai ] && echo OPENAI_API_KEY || echo ANTHROPIC_API_KEY)
  has_key "$key" || die "$key is not set"
  total=$(spent all); mine=$(spent "$provider")
  cap=$(python3 -I -c "print(f'{max(0.0, min($(cohort_cap "$model"), $(provider_ceiling "$provider") - $mine, $SWEEP_CEILING - $total)):.2f}')")
  if python3 -I -c "import sys; sys.exit(0 if $cap < 0.15 else 1)"; then die "$model/$condition: headroom \$$cap < \$0.15 (spent $provider \$$mine, all \$$total)"; fi
  prior=$(python3 -I -c "print(f'{$PRIOR_USD + $total:.8f}')"); cumcap=$(python3 -I -c "print(f'{$PRIOR_USD + $SWEEP_CEILING:.8f}')")
  echo "== $model $condition: cohort cap \$$cap, prior \$$prior, cumulative cap \$$cumcap" | tee -a "$LOG"
  ANVIL_BIN="$ANVIL_BIN" bun --conditions=eliza-source "${ENV_ARGS[@]}" "$HERE/run-v2.ts" --mode=live --models="$model" --condition="$condition" \
    --scenarios="$SCENARIOS" --reps=2 --cohort-cap-usd="$cap" --cumulative-cap-usd="$cumcap" --prior-usd="$prior" --dest="$dest" \
    2>&1 | grep -v -i -E "alchemy|infura|quiknode|https://" | tee -a "$LOG"
  [ -f "$dest/complete.json" ] || { [ -f "$dest/run-error.json" ] && die "$model/$condition: run error (see $dest/run-error.json)"; die "$model/$condition: no marker"; }
  python3 -I "$HERE/verify-v2.py" "$dest" > "$HERE/results-$TAG-$model-$condition.audit.json" || die "$model/$condition: audit failed"
  python3 -I "$HERE/test-verify-v2.py" "$dest" > "$LOGS/$model-$condition.tamper.txt" 2>&1; tamper_exit=$?
  rejected=$(grep -c "PASS (rejected)" "$LOGS/$model-$condition.tamper.txt")
  [ "$tamper_exit" -eq 0 ] && [ "$rejected" -ge 10 ] || die "$model/$condition: tamper suite $rejected/10 (exit $tamper_exit)"
  echo "   audit PASS, tamper $rejected/10, new spend now \$$(spent all)" | tee -a "$LOG"
done
echo "sweep $TAG complete: new spend \$$(spent all) (openai \$$(spent openai), anthropic \$$(spent anthropic))" | tee -a "$LOG"
