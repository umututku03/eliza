"""Tamper tests for verify-v2.py: each edit to a copy of a passing results folder must be rejected.
Usage: python3 -I test-verify-v2.py <passing results dir>"""
import importlib.util, json, shutil, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('verify_v2', HERE / 'verify-v2.py')
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
src = Path(sys.argv[1]).resolve()
v.audit(src)  # the untouched folder must pass

def edit_json(path, fn):
    d = json.loads(path.read_text()); fn(d); path.write_text(json.dumps(d))

eps = [n for n in json.loads((src / 'complete.json').read_text())['episodes'] if not n.startswith('control-')]
# Edits need something to edit: target the first episode that recorded a transaction (sweep cohort 10's first had none).
first_ep = next((n for n in eps if json.loads((src / 'episodes' / f'{n}.json').read_text())['outcome']['transactions']), eps[0])
first_call = json.loads((src / 'llm' / 'ledger.jsonl').read_text().splitlines()[0])['call']
cases = {
    'outcome flag flipped': lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: d['outcome'].update(duplicateSale=not d['outcome']['duplicateSale'])),
    'final balance edited': lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: d['outcome']['final'].update(y='999')),
    'harness label in a request': lambda p: edit_json(p / 'llm' / 'calls' / f'{first_call}-request.json', lambda d: d['body'].update(note='receipt_hidden')),
    'call response removed': lambda p: (p / 'llm' / 'calls' / f'{first_call}-response.json').unlink(),
    'confirmation text changed': lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: d['turns'][1].update(text='Yes, and sell more.')),
    # Always a different word: an episode that already declared INFEASIBLE made the old edit a no-op (sweep cohort 7).
    'declared word changed': lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: d['outcome'].update(
        declared='COMPLETED' if d['outcome']['declared'] == 'INFEASIBLE' else 'INFEASIBLE')),
    'transaction dropped': lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: d['outcome']['transactions'].pop()),
    'credential pasted': lambda p: (p / 'episodes' / f'{first_ep}.child-stderr.log').write_text('sk-ant-api03-' + 'x' * 40),
    'episode removed from marker': lambda p: edit_json(p / 'complete.json', lambda d: d['episodes'].pop()),
}
# Distinguishing states: a forged pre-episode amount must be rejected.
pre_ep = next((n for n in eps if json.loads((src / 'episodes' / f'{n}.json').read_text()).get('preEpisode')), None)
if pre_ep:
    cases['pre-episode amount forged'] = lambda p: edit_json(p / 'episodes' / f'{pre_ep}.json', lambda d: d['preEpisode'].update(ethWei=str(int(d['preEpisode']['ethWei']) + 1)))
# Chain faults: removing the evidence of the active fault must be rejected.
fault_ep = next((n for n in eps if any(j.get('event') in ('chain_reorg', 'dropped_send', 'stale_read')
    for j in json.loads((src / 'episodes' / f'{n}.json').read_text())['forkJournal'])), None)
if fault_ep:
    def remove_fault(p):
        def mutate(d):
            # Every event of that kind: one stale_read of many is not independently recorded anywhere (stale_then_price).
            kind = next(j['event'] for j in d['forkJournal'] if j.get('event') in ('chain_reorg', 'dropped_send', 'stale_read'))
            d['forkJournal'] = [j for j in d['forkJournal'] if j.get('event') != kind]
        edit_json(p / 'episodes' / f'{fault_ep}.json', mutate)
    cases['fault event removed'] = remove_fault
# Nonce guarantee: a second canonical transaction for one (sender, nonce) must be rejected.
nonce_ep = next((n for n in eps if any(t.get('nonce') is not None
    for t in json.loads((src / 'episodes' / f'{n}.json').read_text())['outcome']['transactions'])), None)
if nonce_ep:
    def second_canonical(p):
        def mutate(d):
            t = next(t for t in d['outcome']['transactions'] if t.get('nonce') is not None)
            d['outcome']['transactions'].append({**t, 'hash': '0x' + ('f' * 64 if t['hash'] != '0x' + 'f' * 64 else 'e' * 64)})
        edit_json(p / 'episodes' / f'{nonce_ep}.json', mutate)
    cases['second canonical transaction for one nonce'] = second_canonical
# Fault parameters: the journal's fault windows must match the recorded parameters (doubled here).
timed_ep = next((n for n in eps if any(j.get('hiddenUntil') or j.get('lagBlock') is not None or j.get('event') == 'chain_reorg'
    for j in json.loads((src / 'episodes' / f'{n}.json').read_text())['forkJournal'])), None)
if timed_ep:
    def double_params(d):
        fp = d.get('faultParams') or {'lagMs': 200000, 'reorgDelayMs': 20000, 'hideMs': 200000}
        d['faultParams'] = {k: (v if k == 'reorgTrigger' else 2 * v) for k, v in fp.items()}
    cases['fault parameter edited'] = lambda p: edit_json(p / 'manifest.json', double_params)
# Reorg trigger: a folder whose reorg fired must reject the other trigger recorded in its manifest.
reorg_ep = next((n for n in eps if any(j.get('event') == 'chain_reorg' for j in json.loads((src / 'episodes' / f'{n}.json').read_text())['forkJournal'])), None)
if reorg_ep:
    def flip_trigger(d):
        fp = d.get('faultParams') or {'lagMs': 200000, 'reorgDelayMs': 20000, 'hideMs': 200000}
        d['faultParams'] = {**fp, 'reorgTrigger': 'delay' if fp.get('reorgTrigger') == 'next-send' else 'next-send'}
    cases['reorg trigger edited'] = lambda p: edit_json(p / 'manifest.json', flip_trigger)
# Re-inclusion: moving the sale's recorded re-inclusion block (journal and fault state alike) must be rejected.
reincl_ep = next((n for n in eps if any(j.get('event') == 'chain_reorg' and j.get('reincluded') for j in json.loads((src / 'episodes' / f'{n}.json').read_text())['forkJournal'])), None)
if reincl_ep:
    def move_reinclusion(d):
        for rg in [j for j in d['forkJournal'] if j.get('event') == 'chain_reorg'] + [d['faultState']['reorg']]:
            rg['reincluded']['block'] += 1
    cases['re-inclusion block forged'] = lambda p: edit_json(p / 'episodes' / f'{reincl_ep}.json', move_reinclusion)
# Compound faults: moving the later component's event (market change or reorg) to the journal start must be rejected.
compound_ep = next((n for n in eps if json.loads((src / 'episodes' / f'{n}.json').read_text())['scenario'] in ('stale_then_price', 'dropped_then_reorg')
    and any(j.get('event') in ('scheduled_market_change', 'chain_reorg') for j in json.loads((src / 'episodes' / f'{n}.json').read_text())['forkJournal'])), None)
if compound_ep:
    def reorder(d):
        j = d['forkJournal']; i = next(k for k, e in enumerate(j) if e.get('event') in ('scheduled_market_change', 'chain_reorg'))
        j.insert(0, j.pop(i))
    cases['compound events reordered'] = lambda p: edit_json(p / 'episodes' / f'{compound_ep}.json', reorder)
# Named baselines (run-v2.ts --arm): relabelling the arm must be rejected, and so must the prompt_only text appearing
# in another arm's request or missing from a prompt_only request.
man = json.loads((src / 'manifest.json').read_text())
if 'arm' in man:
    def relabel(d):
        d['arm'] = 'nonce_only' if d['arm'] != 'nonce_only' else 'verify_binary'
    cases['arm label changed'] = lambda p: edit_json(p / 'manifest.json', relabel)
    def prompt_presence(p):
        req = p / 'llm' / 'calls' / f'{first_call}-request.json'
        if man['arm'] == 'prompt_only':
            req = next(f for f in sorted((p / 'llm' / 'calls').glob('*-request.json')) if v.ARM_PROMPT in f.read_text())
            req.write_text(req.read_text().replace(v.ARM_PROMPT, 'Be careful.'))
        else:
            edit_json(req, lambda d: d['body'].update(system=v.ARM_PROMPT))
    cases['arm prompt presence changed'] = prompt_presence
# agent2 (run-v2.ts --agent=agent2): a swap submitted without a matching confirmed preview must be rejected.
AGENT = json.loads((src / 'manifest.json').read_text()).get('agent')
if AGENT in ('agent2', 'claudecode'):
    def forge_gate(p):
        def mutate(d):
            r = next(r for t in d['turns'] for r in t['actionResults'] if r['tool'] == 'swap' and r.get('gateKey') and not r['requiresConfirmation'])
            r['gateKey'] += '|forged'
        edit_json(p / 'episodes' / f'{first_ep}.json', mutate)
    cases['agent2 swap without confirmed preview'] = forge_gate
# Workflow tasks (A1, L1): a forged workflow label, final allowance or critical-call record must be rejected.
wf = json.loads((src / 'manifest.json').read_text()).get('workflow')
if wf:
    label = 'redundantApprovals' if wf == 'approve_swap' else 'duplicateSupply'
    cases['workflow label flipped'] = lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: d['outcome'].update(
        {label: (not d['outcome'][label]) if isinstance(d['outcome'][label], bool) else d['outcome'][label] + 1}))
    cases['final allowance edited'] = lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: (
        d['outcome']['final'].update(allowanceUnits='1'), d['outcome'].update(finalAllowanceUnits='1')))
    def forge_critical(p):
        def mutate(d):
            t = next(t for t in d['outcome']['transactions'] if t.get('critical'))
            t['critical'] = None
        edit_json(p / 'episodes' / f'{first_ep}.json', mutate)
    cases['critical-call record forged'] = forge_critical
# claudecode (run-v2.ts --agent=claudecode): a built-in tool call (Claude Code's Bash) must be rejected.
if AGENT == 'claudecode':
    def builtin_call(p):
        def mutate(d):
            t = next(t for t in d['turns'] if t['toolCalls'])
            t['toolCalls'].append({'id': 'toolu_forged', 'name': 'Bash', 'args': {'command': 'true'}})
        edit_json(p / 'episodes' / f'{first_ep}.json', mutate)
    cases['claudecode built-in tool call'] = builtin_call
# Hold instrumentation (run-v2.ts holdInstrumentation): forged chain truth, a removed record, and an extra field in a
# decision line must be rejected.
if man.get('holdInstrumentation'):
    truth_ep = next((n for n in eps if any(t['status'] for b in json.loads((src / 'episodes' / f'{n}.json').read_text())['chainTruth']['blocks'] for t in b['txs'])), None)
    if truth_ep:
        def forge_truth(p):
            def mutate(d):
                t = next(t for b in d['chainTruth']['blocks'] for t in b['txs'] if t['status'])
                t['status'] = 'reverted' if t['status'] == 'success' else 'success'
            edit_json(p / 'episodes' / f'{truth_ep}.json', mutate)
        cases['chain-truth receipt status forged'] = forge_truth
    cases['chain truth removed'] = lambda p: edit_json(p / 'episodes' / f'{first_ep}.json', lambda d: d.pop('chainTruth'))
    line_ep = next((n for n in eps if v.decision_lines((src / 'episodes' / f'{n}.child-stderr.log').read_text(errors='ignore'))), None)
    if line_ep:
        def extra_field(p):
            f = p / 'episodes' / f'{line_ep}.child-stderr.log'
            d = json.loads(v.decision_lines(f.read_text(errors='ignore'))[0]); d['request'] = {'data': '0x'}
            f.write_text(f.read_text(errors='ignore') + v.DECISION_PREFIX + json.dumps(d) + '\n')
        cases['decision line with an extra field'] = extra_field
failures = []
for name, mutate in cases.items():
    with tempfile.TemporaryDirectory() as t:
        dst = Path(t) / src.name
        shutil.copytree(src, dst)
        mutate(dst)
        try:
            v.audit(dst); failures.append(name); print('FAIL (accepted)', name)
        except v.AuditError as e:
            print('PASS (rejected)', name, '->', e.args[0])
sys.exit(1 if failures else 0)
