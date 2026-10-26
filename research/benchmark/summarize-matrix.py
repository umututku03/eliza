"""Summarize compromised-agent matrix results (matrix-v2/compromised-<task>.json) as Markdown tables.
Usage: python3 -I research/benchmark/summarize-matrix.py research/benchmark/matrix-v2/compromised-{D1,H1,H2,H3}.json
"""
import json
import sys
from collections import defaultdict

LAYERS = ['none', 'per_tx_policy', 'existing_controls', 'pg_floor_only', 'pg_no_floor', 'plan_guard']
STATES = ['calibrated', 'shortfall', 'prefunded', 'price_worse']
runs = [json.load(open(p)) for p in sys.argv[1:]]
tasks = [r['task'] for r in runs]

print(f"Tasks: {', '.join(tasks)}. Each cell: off-plan admitted / legitimate refused.\n")
print('| Layer | ' + ' | '.join(STATES) + ' | all |')
print('|---|' + '---|' * (len(STATES) + 1))
totals = {}
for layer in LAYERS:
    row, a_all, r_all, off_all, in_all = [], 0, 0, 0, 0
    for state in STATES:
        cells = [c for r in runs for c in r['cells'] if c['layer'] == layer and c['state'] == state]
        a = sum(c['offPlanAdmitted'] for c in cells); off = sum(c['offPlanTotal'] for c in cells)
        rf = sum(c['inPlanRefused'] for c in cells); inn = sum(c['inPlanTotal'] for c in cells)
        row.append(f'{a}/{off} · {rf}/{inn}')
        a_all += a; r_all += rf; off_all += off; in_all += inn
    totals[layer] = (a_all, off_all, r_all, in_all)
    print(f'| {layer} | ' + ' | '.join(row) + f' | **{a_all}/{off_all} · {r_all}/{in_all}** |')

print('\nOff-plan actions admitted, by kind (all tasks and states):\n')
kinds = sorted({k['kind'] for r in runs for c in r['cells'] for k in c['cases'] if k['oracle'] == 'off_plan'})
print('| Layer | ' + ' | '.join(kinds) + ' | funds to attacker |')
print('|---|' + '---|' * (len(kinds) + 1))
for layer in LAYERS:
    cnt = defaultdict(int); tot = defaultdict(int); lost = 0
    for r in runs:
        for c in r['cells']:
            if c['layer'] != layer: continue
            lost += c['fundsToAttacker']
            for k in c['cases']:
                if k['oracle'] != 'off_plan': continue
                tot[k['kind']] += 1; cnt[k['kind']] += 1 if k['admitted'] else 0
    print(f'| {layer} | ' + ' | '.join(f'{cnt[k]}/{tot[k]}' for k in kinds) + f' | {lost} |')

print('\nLegitimate-step gas, calibrated state (sale / step 2):\n')
print('| Layer | ' + ' | '.join(tasks) + ' |')
print('|---|' + '---|' * len(tasks))
for layer in LAYERS:
    vals = []
    for r in runs:
        c = next(c for c in r['cells'] if c['layer'] == layer and c['state'] == 'calibrated')
        vals.append(f"{int(c['legitSaleGas']):,} / {int(c['legitStep2Gas']):,}")
    print(f'| {layer} | ' + ' | '.join(vals) + ' |')
