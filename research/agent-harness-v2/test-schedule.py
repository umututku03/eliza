"""Unit tests for the WS-J schedule generator (fork-rpc-proxy.ts generateSchedule; verify-v2.py generate_schedule).
Usage: python3 -I test-schedule.py   (needs bun on PATH for the TypeScript/Python parity test)
Checks: determinism per seed; parameter bounds and the documented ranges; no repeated (target, kind); no drop or reorg on
step 2; the reorg-dependent window restriction; sizes; the TypeScript generator and phase splitter equal the Python ones."""
import importlib.util, json, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('verify_v2', HERE / 'verify-v2.py')
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
fails = []
def check(cond, *why):
    if not cond: fails.append(why); print('FAIL', *why)

SEEDS = range(0, 1000)
for seed in SEEDS:
    a, b = v.generate_schedule(seed), v.generate_schedule(seed)
    check(a == b, 'determinism', seed)
    es = a['entries']
    check(1 <= a['size'] == len(es) <= 3 and a['version'] == 'ws-j-1' and a['seed'] == seed, 'size/version', seed)
    pairs = [(e['target'], e['kind']) for e in es]
    check(len(set(pairs)) == len(pairs), 'repeated (target, kind)', seed)
    check([e['id'] for e in es] == list(range(len(es))), 'ids', seed)
    has_reorg = any(e['kind'] == 'reorg' for e in es)
    for e in es:
        check(e['target'] in ('critical', 'followup'), 'target', seed)
        if e['target'] == 'followup': check(e['kind'] in ('hide', 'stale'), 'step-2 kind', seed, e)
        if e['kind'] in ('hide', 'stale'):
            allowed = v.SCHEDULE_WINDOWS_WITH_REORG_S if e['target'] == 'critical' and has_reorg else v.SCHEDULE_WINDOWS_S
            check(set(e) == {'id', 'kind', 'target', 'windowMs'} and e['windowMs'] in [x * 1000 for x in allowed], 'window bounds', seed, e)
        elif e['kind'] == 'reorg':
            check(set(e) == {'id', 'kind', 'target', 'reorgDelayMs', 'trigger', 'reincluded'} and e['reorgDelayMs'] in (12000, 24000)
                  and e['trigger'] in ('delay', 'next-send') and isinstance(e['reincluded'], bool), 'reorg bounds', seed, e)
        else: check(set(e) == {'id', 'kind', 'target'}, 'drop fields', seed, e)
for size in (1, 2, 3):
    check(all(v.generate_schedule(s, size)['size'] == size for s in range(200)), 'fixed size', size)
# Seeds differ; every kind, target, window, delay, trigger and re-inclusion value occurs over 1000 seeds.
check(len({json.dumps(v.generate_schedule(s)['entries']) for s in SEEDS}) > 300, 'too few distinct schedules')
flat = [e for s in SEEDS for e in v.generate_schedule(s)['entries']]
check({(e['target'], e['kind']) for e in flat} == set(v.SCHEDULE_PAIRS), 'pair coverage')
check({e['windowMs'] for e in flat if 'windowMs' in e} == {x * 1000 for x in v.SCHEDULE_WINDOWS_S}, 'window coverage')
check({(e['reorgDelayMs'], e['trigger'], e['reincluded']) for e in flat if e['kind'] == 'reorg'} ==
      {(d, t, r) for d in (12000, 24000) for t in ('delay', 'next-send') for r in (False, True)}, 'reorg parameter coverage')
check({len(v.generate_schedule(s)['entries']) for s in SEEDS} == {1, 2, 3}, 'size coverage')
# Phases: a drop alone; a hide/stale/reorg run ends at a reorg or a drop.
E = lambda i, k, t='critical', **kw: dict(id=i, kind=k, target=t, **kw)
ph = v.schedule_phases([E(0, 'hide'), E(1, 'reorg'), E(2, 'drop'), E(3, 'stale'), E(4, 'hide', 'followup')], 'critical')
check([[e['id'] for e in p['entries']] for p in ph] == [[0, 1], [2], [3]] and [p['drop'] for p in ph] == [False, True, False]
      and ph[0]['reorg']['id'] == 1 and ph[2]['reorg'] is None, 'phase split', ph)
check(len(v.schedule_phases([E(0, 'reorg'), E(1, 'hide')], 'critical')) == 2, 'reorg closes its phase')
# Parity with the TypeScript generator and phase splitter.
bun = shutil.which('bun')
if bun:
    js = ("import {generateSchedule, schedulePhases} from './fork-rpc-proxy.ts';"
          "const out=[]; for (let s=0;s<300;s++) for (const z of [undefined,1,2,3]) { const g=generateSchedule(s,z);"
          " out.push([s, z ?? null, g, ['critical','followup'].map(t=>schedulePhases(g.entries,t).map(p=>p.entries.map(e=>e.id)))]); }"
          "console.log(JSON.stringify(out));")
    r = subprocess.run([bun, '-e', js], cwd=HERE, capture_output=True, text=True, timeout=120)
    check(r.returncode == 0, 'bun generator run', r.stderr[-300:])
    if r.returncode == 0:
        for s, z, g, phs in json.loads(r.stdout):
            py = v.generate_schedule(s, z)
            check(g == py, 'TS/Python generator differ', s, z)
            check(phs == [[[e['id'] for e in p['entries']] for p in v.schedule_phases(py['entries'], t)] for t in ('critical', 'followup')], 'TS/Python phases differ', s, z)
else: print('SKIP TypeScript parity (no bun on PATH)')
print('generator tests:', 'FAIL' if fails else 'PASS', f'({len(fails)} failures)')
sys.exit(1 if fails else 0)
