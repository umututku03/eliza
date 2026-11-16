---- MODULE MCWitness ----
EXTENDS EvidenceLayer
\* Expected to be VIOLATED: witnesses that the post-dispatch recheck (e1c82ae7a3) is reachable.
\* W1: a Poll step changes a ledger record other than the polled one (the guard's re-check persisted).
W1 == [][Poll => \A k \in DOMAIN ledger : k # pc.r => ledger'[k] = ledger[k]]_vars
\* W2: a Poll step ends the call and turns another record into "orphaned" (the guard refuses: EVIDENCE_UNRESOLVED).
W2 == [][~(Poll /\ pc'.k = "idle" /\ \E k \in DOMAIN ledger : k # pc.r /\ ledger[k].state # "orphaned" /\ ledger'[k].state = "orphaned")]_vars
====
