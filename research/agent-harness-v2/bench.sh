#!/usr/bin/env bash
# Benchmark launcher: runs a list of cohorts in N parallel lanes, audits and tamper-tests every cohort, stops on any failure.
#
# Run from the repository root:
#   export ANVIL_BIN=<anvil binary>  FORK_ENV=<.env with MAINNET_FORK_RPC_URL>
#   bash research/agent-harness-v2/bench.sh --cohorts=<file> --tag=<name> [--lanes=2] [--port-base=300] [--port-step=100]
#        [--mode=mock|live]   live also needs BENCH_ALLOW_LIVE=1, --budget-usd=X, --prior-usd=P and the provider keys
#        (environment or KEYS_ENV=<.env file>)
#
# Cohort file: one cohort per line, '#' starts a comment:
#   <task|-> <model> <condition> <scenarios,comma,separated> <reps> [--option=value ...]   ('-' is the frozen development task)
#   WS-J: a scenario token random:A-B (or random:N) runs the random schedule family for seeds A..B (run-v2.ts
#   --scenarios=...,random --schedule-seed=A-B). Optional trailing run-v2.ts options, from a fixed list: --arm=, --mock-agent=,
#   --idle-block-ms=, --schedule-size=, --agent=, --reorg-trigger=. Example: - luna stock random:1-20 1 --arm=full --mock-agent=naive
# Cohort k (from 0, in file order) runs in lane k mod N; each lane runs its cohorts one after another.
#   Ports:  lane i passes --port-base=<port-base + i*port-step> to run-v2.ts. The step must keep the four offset ports
#           (Anvil 18545, fork proxy 18546, LLM proxy 18650, mock gate 18652) disjoint across lanes: 100 does.
#   Costs:  live only. Lane i may spend at most budget/N (a disjoint cap); each cohort's --cohort-cap-usd is its lane's
#           remaining headroom, and a lane with less than $0.15 left stops. Mock runs make no paid calls.
# Each finished cohort needs complete.json, a verify-v2.py PASS and a tamper suite where every case is rejected (at least
# 9). Any failure writes a STOP file: the other lanes finish their running cohort, audit it and start nothing new.
# Results go to research/agent-harness-v2/results-<tag>-<k>-<task>-<model>-<condition>/ (gitignored); logs, audits and
# tamper outputs to results-<tag>-logs/. Nothing is overwritten. No key value is printed.
set -uo pipefail

arg() { local k=$1 d=${2-}; for a in ${ARGS[@]+"${ARGS[@]}"}; do case $a in --$k=*) echo "${a#--$k=}"; return ;; esac; done; echo "$d"; }
ARGS=("$@")
MODE=$(arg mode mock); TAG=$(arg tag); COHORTS=$(arg cohorts); LANES=$(arg lanes 2)
PORT_BASE=$(arg port-base 300); PORT_STEP=$(arg port-step 100); BUDGET=$(arg budget-usd); PRIOR=$(arg prior-usd)
HERE=research/agent-harness-v2
die() { echo "STOP: $*" >&2; exit 1; }
[ -f "$HERE/run-v2.ts" ] || die "run from the repository root"
[ -n "$TAG" ] && [[ "$TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || die "pass --tag=<name> (letters, digits, . _ -)"
[ -f "$COHORTS" ] || die "pass --cohorts=<file>"
[[ "$LANES" =~ ^[1-9][0-9]*$ ]] && [[ "$PORT_BASE" =~ ^[0-9]+$ ]] && [[ "$PORT_STEP" =~ ^[1-9][0-9]*$ ]] || die "bad --lanes, --port-base or --port-step"
[ $((PORT_STEP % 100)) -eq 0 ] || die "--port-step must be a multiple of 100 (keeps lane ports disjoint)"
[ $((18652 + PORT_BASE + (LANES - 1) * PORT_STEP)) -le 65535 ] || die "ports above 65535"
case $MODE in
  mock) ;;
  live)
    [ "${BENCH_ALLOW_LIVE:-}" = 1 ] || die "live mode is refused unless BENCH_ALLOW_LIVE=1 (set only after the user approves a budget)"
    [[ "$BUDGET" =~ ^[0-9]+(\.[0-9]+)?$ ]] && [[ "$PRIOR" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "live mode needs --budget-usd and --prior-usd"
    [ -z "$(git status --porcelain -- plugins packages/core research/agent-harness-v2 research/benchmark ':!research/agent-harness-v2/results-*')" ] \
      || die "commit or stash changes first: live runs must match the committed harness and sources" ;;
  *) die "--mode must be mock or live" ;;
esac
[ "$(node --version)" = "v24.15.0" ] || die "need Node 24.15.0 on PATH (README: Reproduce)"
[ "$(bun --version)" = "1.4.2" ] || die "need Bun 1.4.2 on PATH (README: Reproduce)"
[ -x "${ANVIL_BIN:-}" ] || die "set ANVIL_BIN to an anvil binary"
[ -f "${FORK_ENV:-}" ] || die "set FORK_ENV to the .env holding MAINNET_FORK_RPC_URL"
ENV_ARGS=(--env-file="$FORK_ENV"); [ "$MODE" = live ] && [ -n "${KEYS_ENV:-}" ] && ENV_ARGS+=(--env-file="$KEYS_ENV")
has_key() { [ -n "${!1:-}" ] && return 0; [ -n "${KEYS_ENV:-}" ] && grep -Eq "^$1=.+" "$KEYS_ENV"; }

# Parse and check every cohort before anything runs.
LINES=()
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%%#*}; [ -z "${line//[[:space:]]/}" ] && continue
  read -r task model condition scenarios reps extra <<<"$line"
  [ -n "$reps" ] && [[ "$reps" =~ ^[1-9][0-9]*$ ]] || die "bad cohort line: $line"
  [[ "$task$model$condition" =~ ^[A-Za-z0-9_,-]+$ ]] && [[ "$scenarios" =~ ^[A-Za-z0-9_,:-]+$ ]] || die "bad cohort line: $line"
  for o in ${extra:-}; do [[ "$o" =~ ^--(arm|mock-agent|idle-block-ms|schedule-size|agent|reorg-trigger)=[A-Za-z0-9_-]+$ ]] || die "bad option $o in cohort line: $line"; done
  n_random=$(tr ',' '\n' <<<"$scenarios" | grep -c '^random'); [ "$n_random" -le 1 ] || die "one random token per cohort line: $line"
  if [ "$n_random" -eq 1 ]; then tr ',' '\n' <<<"$scenarios" | grep -Eq '^random:[0-9]+(-[0-9]+)?$' || die "random needs a seed range (random:A-B): $line"; fi
  LINES+=("$task $model $condition $scenarios $reps${extra:+ $extra}")
done < "$COHORTS"
[ ${#LINES[@]} -gt 0 ] || die "no cohorts in $COHORTS"
dest_of() { read -r task model condition _ <<<"${LINES[$1]}"; echo "$PWD/$HERE/results-$TAG-$1-${task/-/frozen}-$model-$condition"; }
for k in "${!LINES[@]}"; do
  d=$(dest_of "$k"); [ -e "$d" ] && die "$d exists; never overwrite (use a new --tag)"
  if [ "$MODE" = live ]; then
    read -r _ model _ <<<"${LINES[$k]}"
    case $model in luna|sol|mini41) key=OPENAI_API_KEY ;; *) key=ANTHROPIC_API_KEY ;; esac
    has_key "$key" || die "$key is not set (cohort $k)"
  fi
done
LOGS="$HERE/results-$TAG-logs"; mkdir -p "$LOGS"; STOPFILE="$LOGS/STOP"; rm -f "$STOPFILE"
echo "bench $TAG ($MODE) at $(git rev-parse --short=10 HEAD), $(date -u +%FT%TZ): ${#LINES[@]} cohorts, $LANES lanes" | tee -a "$LOGS/bench.log"

spent() { # new USD recorded by the given folders' markers
  python3 -I - "$@" <<'PY'
import json, os, sys
total = 0.0
for d in sys.argv[1:]:
    for f in ('complete.json', 'run-error.json'):
        if os.path.exists(os.path.join(d, f)): total += float((json.load(open(os.path.join(d, f))).get('ledger') or {}).get('newUSD') or 0)
print(f'{total:.8f}')
PY
}
all_dests() { for k in "${!LINES[@]}"; do dest_of "$k"; done; }

run_cohort() { # lane k
  local lane=$1 k=$2 base=$3 task model condition scenarios reps opts dest log seeds="" scen=""
  read -r task model condition scenarios reps opts <<<"${LINES[$k]}"
  dest=$(dest_of "$k"); log="$LOGS/$k.console.log"
  # random:A-B -> --scenarios=...,random --schedule-seed=A-B
  local tok; for tok in ${scenarios//,/ }; do
    case $tok in random:*) seeds=${tok#random:}; tok=random ;; esac
    scen=${scen:+$scen,}$tok
  done
  local run=(--mode="$MODE" --models="$model" --condition="$condition" --scenarios="$scen" --reps="$reps" --port-base="$base" --dest="$dest")
  [ -n "$seeds" ] && run+=(--schedule-seed="$seeds")
  local o; for o in ${opts:-}; do run+=("$o"); done
  [ "$task" != - ] && run+=(--task="$task")
  if [ "$MODE" = live ]; then
    local mine=() j
    for j in "${!LINES[@]}"; do [ $((j % LANES)) -eq "$lane" ] && [ "$j" -lt "$k" ] && mine+=("$(dest_of "$j")"); done
    local lane_spent cap total
    lane_spent=$(spent "${mine[@]+"${mine[@]}"}"); total=$(spent $(all_dests))
    cap=$(python3 -I -c "print(f'{max(0.0, $BUDGET / $LANES - $lane_spent):.2f}')")
    python3 -I -c "import sys; sys.exit(0 if $cap >= 0.15 else 1)" || { echo "lane $lane: headroom \$$cap < \$0.15" > "$STOPFILE"; return 1; }
    run+=(--cohort-cap-usd="$cap" --cumulative-cap-usd="$(python3 -I -c "print(f'{$PRIOR + $BUDGET:.8f}')")" --prior-usd="$(python3 -I -c "print(f'{$PRIOR + $total:.8f}')")")
  fi
  echo "== lane $lane cohort $k: $task $model $condition $scenarios x$reps, port base $base" | tee -a "$LOGS/bench.log"
  bun --conditions=eliza-source "${ENV_ARGS[@]}" "$HERE/run-v2.ts" "${run[@]}" 2>&1 | grep -v -i -E "alchemy|infura|quiknode|https://" > "$log"
  local fail=""
  if [ ! -f "$dest/complete.json" ]; then fail="run error or no marker (see $log)"
  elif ! python3 -I "$HERE/verify-v2.py" "$dest" > "$LOGS/$k.audit.json" 2> "$LOGS/$k.audit.err"; then fail="audit failed (see $LOGS/$k.audit.err)"
  else
    python3 -I "$HERE/test-verify-v2.py" "$dest" > "$LOGS/$k.tamper.txt" 2>&1; local tx=$?
    local rejected accepted
    rejected=$(grep -c "^PASS (rejected)" "$LOGS/$k.tamper.txt"); accepted=$(grep -c "^FAIL (accepted)" "$LOGS/$k.tamper.txt")
    { [ "$tx" -eq 0 ] && [ "$accepted" -eq 0 ] && [ "$rejected" -ge 9 ]; } || fail="tamper suite: $rejected rejected, $accepted accepted, exit $tx"
  fi
  grep -E "^(control-|[a-z0-9]+-[a-z0-9]+-)" "$log" | sed "s/^/   [$k] /" | tee -a "$LOGS/bench.log" >/dev/null
  if [ -n "$fail" ]; then echo "lane $lane cohort $k: $fail" | tee -a "$LOGS/bench.log" > "$STOPFILE"; return 1; fi
  echo "   cohort $k: audit PASS, tamper $rejected/$rejected rejected, new spend \$$(spent "$dest")" | tee -a "$LOGS/bench.log"
}

lane() {
  local i=$1 base=$((PORT_BASE + $1 * PORT_STEP)) k
  for k in "${!LINES[@]}"; do
    [ $((k % LANES)) -eq "$i" ] || continue
    [ -f "$STOPFILE" ] && return 1
    run_cohort "$i" "$k" "$base" || return 1
  done
}
PIDS=()
for ((i = 0; i < LANES; i++)); do lane "$i" & PIDS+=($!); done
status=0
for p in "${PIDS[@]}"; do wait "$p" || status=1; done
[ -f "$STOPFILE" ] && status=1
done_dests=(); for d in $(all_dests); do [ -f "$d/manifest.json" ] && done_dests+=("$d"); done
[ ${#done_dests[@]} -gt 0 ] && python3 -I "$HERE/scorecard.py" "${done_dests[@]}" > "$LOGS/scorecard.md" 2>&1
if [ "$status" -ne 0 ]; then echo "bench $TAG STOPPED: $(cat "$STOPFILE" 2>/dev/null)" | tee -a "$LOGS/bench.log"; exit 1; fi
echo "bench $TAG complete: ${#LINES[@]} cohorts audited and tamper-tested, new spend \$$(spent $(all_dests)); scorecard in $LOGS/scorecard.md" | tee -a "$LOGS/bench.log"
