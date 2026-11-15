#!/usr/bin/env bash
# Run TLC on model configs:  ./run.sh MC_full_hidden.cfg [more.cfg ...]
# Safety configs: all INVARIANTS are checked together; when one is violated its (shortest, BFS) trace is kept,
# it is dropped, and TLC is re-run on the rest, until the remaining invariants hold on the full state space.
# Liveness configs: each PROPERTIES entry is checked in its own run (one worker).
# Output: one result line per property on stdout (also appended to results.txt), the TLC log in
# logs/<cfg>__<prop>.log and a condensed trace (trace_summary.py) in traces/<cfg>__<prop>.trace.
# Needs a JDK 11+ and tla2tools.jar; defaults match the README's install under $HOME/tools/tla.
set -euo pipefail
cd "$(dirname "$0")"
JAVA="${JAVA:-$HOME/tools/tla/jdk-21.0.13+9/Contents/Home/bin/java}"
TLA2TOOLS="${TLA2TOOLS:-$HOME/tools/tla/tla2tools.jar}"
META="${TLC_META:-${TMPDIR:-/tmp}/tlc-evidence-layer}"
WORKERS="${TLC_WORKERS:-10}"
mkdir -p "$META" logs traces

tlc() { # cfgfile workers log
  "$JAVA" -XX:+UseParallelGC -Xmx12g -cp "$TLA2TOOLS" tlc2.TLC -config "$1" -workers "$2" \
    -metadir "$META/run$$" -cleanup -nowarning EvidenceLayer.tla > "$3" 2>&1 || true
}
stats() { grep -E 'distinct states found' "$1" | tail -1 | sed -E 's/^.*generated, ([0-9,]+) distinct.*$/\1 distinct/'; }

for cfg in "$@"; do
  name="$(basename "$cfg" .cfg)"
  body="$(grep -v -E '^(INVARIANTS|PROPERTIES) ' "$cfg")"
  invs=$(sed -n 's/^INVARIANTS //p' "$cfg")
  props=$(sed -n 's/^PROPERTIES //p' "$cfg")
  remaining=" $invs "
  while [ -n "${remaining// /}" ]; do
    tmp="$META/$name.cfg"; printf '%s\nINVARIANTS%s\n' "$body" "$remaining" > "$tmp"
    log="logs/$name.inv.log"; s=$(date +%s); tlc "$tmp" "$WORKERS" "$log"; t=$(( $(date +%s) - s ))
    v=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$log" | head -1)
    if [ -n "$v" ]; then
      cp "$log" "logs/${name}__$v.log"; python3 -I trace_summary.py "$log" > "traces/${name}__$v.trace"
      len=$(grep -c '^State [0-9]*:' "$log")
      line="$name | $v | VIOLATED (trace $len states) | $(stats "$log") explored | ${t} s"
      remaining="${remaining/ $v / }"
    elif grep -q 'No error has been found' "$log"; then
      for p in $remaining; do line="$name | $p | holds | $(stats "$log") | ${t} s"; echo "$line" | tee -a results.txt; done
      cp "$log" "logs/${name}__holds.log"; line=""; remaining=""
    else
      line="$name | ${remaining} | TLC ERROR (see $log) | | ${t} s"; remaining=""
    fi
    [ -n "$line" ] && echo "$line" | tee -a results.txt
  done
  for p in $props; do
    tmp="$META/$name.$p.cfg"; printf '%s\nPROPERTIES %s\n' "$body" "$p" > "$tmp"
    log="logs/${name}__$p.log"; s=$(date +%s); tlc "$tmp" 1 "$log"; t=$(( $(date +%s) - s ))
    if grep -q 'violated' "$log"; then
      python3 -I trace_summary.py "$log" > "traces/${name}__$p.trace"
      len=$(grep -c '^State [0-9]*:' "$log")
      line="$name | $p | VIOLATED (lasso $len states) | $(stats "$log") explored | ${t} s"
    elif grep -q 'No error has been found' "$log"; then
      line="$name | $p | holds | $(stats "$log") | ${t} s"
    else
      line="$name | $p | TLC ERROR (see $log) | | ${t} s"
    fi
    echo "$line" | tee -a results.txt
  done
done
