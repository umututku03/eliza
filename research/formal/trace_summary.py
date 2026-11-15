#!/usr/bin/env python3
"""Condense a TLC error trace of EvidenceLayer.tla into one line per state.

Usage: python3 -I trace_summary.py logs/MC_full.log
"""
import re
import sys

KEYS = ["chain", "view", "pool", "txs", "hidden", "pc", "done", "asked", "stopped", "ledger"]


def blocks(text):
    parts = re.split(r"^State (\d+): <([^>]*)>\s*$", text, flags=re.M)
    # parts = [pre, n, action, body, n, action, body, ...]
    for k in range(1, len(parts) - 2, 3):
        yield int(parts[k]), parts[k + 1].split(" line")[0], parts[k + 2]


def var(body, name):
    m = re.search(r"^/\\ " + name + r" = (.*?)(?=^/\\ |\Z)", body, flags=re.M | re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else "?"


def short_ledger(s):
    out = []
    for rec in re.findall(r"\[ ?intent \|->.*?consumed \|-> \w+ ?\]", s):
        f = lambda k: (re.search(k + r" \|-> (\"?[\w-]+\"?|\{[^}]*\}|\[[^\]]*\])", rec) or [None, "?"])[1].strip('"')
        extra = (" landed" if f("landed") == "TRUE" else "") + (f" rep={f('reported')}" if f("reported") != "none" else "")
        rs = f("rs")
        rs = "" if "h |-> 0" in rs else " rs=" + re.sub(r"[\[\] ]|\|->", "", rs)
        out.append(f"i{f('intent')}:n{f('pinned')}{f('hashes')}{f('state')}/{f('decision')} r{f('rounds')}{rs}{extra}")
    return "[" + "; ".join(out) + "]"


def main(path):
    text = open(path).read()
    head = re.search(r"Error: (.*?)\n", text)
    print(head.group(1) if head else "no error")
    for n, action, body in blocks(text):
        v = {k: var(body, k) for k in KEYS}
        txs = re.findall(r"intent \|-> (\d+), nonce \|-> (\d+)", v["txs"])
        txs_s = ",".join(f"t{j + 1}=i{a}@n{b}" for j, (a, b) in enumerate(txs))
        pool = ",".join(f"n{a}:t{b}" for a, b in re.findall(r"(\d+) :> (\d+)", v["pool"]) if b != "0")
        print(f"{n:>2} {action:<12} chain={v['chain']} view={v['view']} pool={{{pool}}} txs={{{txs_s}}} "
              f"hidden={v['hidden']} pc={v['pc']} done={v['done']} asked={v['asked']} ledger={short_ledger(v['ledger'])}")


if __name__ == "__main__":
    main(sys.argv[1])
