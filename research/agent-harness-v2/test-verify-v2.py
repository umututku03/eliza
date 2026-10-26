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

first_ep = next(n for n in json.loads((src / 'complete.json').read_text())['episodes'] if not n.startswith('control-'))
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
