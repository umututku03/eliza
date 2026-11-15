#!/usr/bin/env bash
# Chain-fault pilot (research/notes/pilot-chain-faults-plan.md). Three cohorts in parallel lanes on disjoint ports:
#   ElizaOS luna, ElizaOS haiku, agent2 luna  x  normal + the four 2x2 faults  x  r=2, stock wallet, task D1.
# Run from the repository root on a clean checkout:
#   export ANVIL_BIN=... FORK_ENV=...  KEYS_ENV=<.env holding OPENAI_API_KEY and ANTHROPIC_API_KEY>
#   bash research/agent-harness-v2/pilot-chain-faults.sh
# Rules (fixed before any paid call): no retries, replacements or prompt changes. A missing marker, a run error, an
# audit failure or any accepted tamper case stops the pilot. Budget refusals inside a cohort are results.
set -uo pipefail
PRIOR_USD=11.65867197          # cumulative harness ledger after distinguish1114
SWEEP_CEILING=3.00             # approved by the user on 2026-11-14
TAG=pilot1114
HERE=research/agent-harness-v2
SCEN=normal,receipt_hidden,sale_dropped,rpc_stale,sale_reorged
LOGS="$HERE/results-$TAG-logs"; mkdir -p "$LOGS"; LOG="$LOGS/pilot.log"
die() { echo "STOP: $*" | tee -a "$LOG"; exit 1; }
[ -f "$HERE/run-v2.ts" ] || die "run from the repository root"
[ "$(node --version)" = "v24.15.0" ] || die "need Node 24.15.0"
[ "$(bun --version)" = "1.4.2" ] || die "need Bun 1.4.2"
[ -x "${ANVIL_BIN:-}" ] || die "set ANVIL_BIN"; [ -f "${FORK_ENV:-}" ] || die "set FORK_ENV"; [ -f "${KEYS_ENV:-}" ] || die "set KEYS_ENV"
for k in OPENAI_API_KEY ANTHROPIC_API_KEY; do grep -Eq "^$k=.+" "$KEYS_ENV" || die "$k missing in KEYS_ENV"; done   # values never printed
[ -z "$(git status --porcelain --untracked-files=no -- plugins packages/core research)" ] || die "commit changes first"
echo "pilot $TAG at $(git rev-parse --short=10 HEAD), $(date -u +%FT%TZ)" | tee -a "$LOG"
cumcap=$(python3 -I -c "print(f'{$PRIOR_USD + $SWEEP_CEILING:.8f}')")

# lane: name agent model cap port-base. Caps are disjoint and sum to the sweep ceiling (0.90 + 1.40 + 0.50 = 2.80 <= 3.00 with margin).
lane() {
  local name=$1 agent=$2 model=$3 cap=$4 pb=$5 dest="$PWD/$HERE/results-$TAG-$1"
  [ -e "$dest" ] && { echo "STOP: $dest exists" | tee -a "$LOG"; return 1; }
  echo "== $name: agent $agent, model $model, cap \$$cap, port base $pb" | tee -a "$LOG"
  ANVIL_BIN="$ANVIL_BIN" bun --conditions=eliza-source --env-file="$FORK_ENV" --env-file="$KEYS_ENV" "$HERE/run-v2.ts" --mode=live \
    --agent="$agent" --models="$model" --scenarios="$SCEN" --reps=2 --port-base="$pb" \
    --cohort-cap-usd="$cap" --cumulative-cap-usd="$cumcap" --prior-usd="$PRIOR_USD" --dest="$dest" \
    2>&1 | grep -v -i -E "alchemy|infura|quiknode|https://" > "$LOGS/$name.console.log"
  [ -f "$dest/complete.json" ] || { echo "STOP: $name: no complete marker (see $LOGS/$name.console.log)" | tee -a "$LOG"; return 1; }
  python3 -I "$HERE/verify-v2.py" "$dest" > "$HERE/results-$TAG-$name.audit.json" || { echo "STOP: $name: audit failed" | tee -a "$LOG"; return 1; }
  python3 -I "$HERE/test-verify-v2.py" "$dest" > "$LOGS/$name.tamper.txt" 2>&1; local te=$?
  local acc=$(grep -c "FAIL (accepted)" "$LOGS/$name.tamper.txt"); local rej=$(grep -c "PASS (rejected)" "$LOGS/$name.tamper.txt")
  [ "$te" -eq 0 ] && [ "$acc" -eq 0 ] || { echo "STOP: $name: tamper accepted $acc (exit $te)" | tee -a "$LOG"; return 1; }
  grep -E "^(control|luna|haiku)" "$LOGS/$name.console.log" | tee -a "$LOG"
  echo "   $name: audit PASS, tamper $rej rejected, 0 accepted" | tee -a "$LOG"
}
lane eliza-luna elizaos luna 0.90 4100 & p1=$!
lane eliza-haiku elizaos haiku 1.40 4200 & p2=$!
lane agent2-luna agent2 luna 0.50 4300 & p3=$!
ok=0; for p in $p1 $p2 $p3; do wait $p || ok=1; done
python3 -I - "$HERE" "$TAG" <<'PY' | tee -a "$LOG"
import json, glob, os, sys
here, tag = sys.argv[1:]; total = 0.0
for d in glob.glob(os.path.join(here, f'results-{tag}-*')):
    m = os.path.join(d, 'complete.json') if os.path.exists(os.path.join(d, 'complete.json')) else os.path.join(d, 'run-error.json')
    if os.path.isdir(d) and os.path.exists(m): total += float((json.load(open(m)).get('ledger') or {}).get('newUSD') or 0)
print(f'pilot {tag} new spend ${total:.8f}')
PY
[ $ok -eq 0 ] && echo "pilot $TAG complete" | tee -a "$LOG" || echo "pilot $TAG finished with a STOP (see above)" | tee -a "$LOG"
