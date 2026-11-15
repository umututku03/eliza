---------------------------- MODULE EvidenceLayer ----------------------------
(***************************************************************************)
(* Recovery protocol of the chain-evidence layer for EVM sends              *)
(* (plugins/plugin-wallet/src/chains/evm/evidence.ts), and three baseline   *)
(* send policies, as one model with the policy as a parameter.              *)
(*                                                                          *)
(* One sender account. A chain of blocks (at most one transaction per      *)
(* block), a mempool keyed by nonce, an RPC view that may lag the chain    *)
(* (a past chain prefix, possibly from before a reorg) and may hide        *)
(* receipts, a mempool that may drop a transaction, a node that may lose   *)
(* the acknowledgement of a send, reorgs of bounded depth with or without  *)
(* re-inclusion of the orphaned transactions. An agent issues requests for *)
(* intents, possibly repeating an intent whose last call did not succeed   *)
(* (worst case: a naive re-sender), and may call tx_status (full policy).  *)
(*                                                                          *)
(* Policy = "full"          the evidence layer (sendWithEvidence, decide,    *)
(*                          guard, checkOnce, tx_status)                    *)
(*          "nonce_only"    sendNonceOnly: pinned nonce, stock wording       *)
(*          "verify_binary" sendVerifyBinary: binary check, fresh nonce     *)
(*          "none"          stock send: fresh nonce per call, stock wait    *)
(*                                                                          *)
(* The mapping from every action and operator to evidence.ts is in         *)
(* README.md. Ghost variables record the property-relevant events.        *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Policy,          \* "full" | "nonce_only" | "verify_binary" | "none"
  NI,              \* number of intents
  SharedToken,     \* TRUE: every intent credits the same token (same balance effect)
  Reinclude,       \* TRUE: orphaned transactions return to the mempool (sale_reorged_reincluded)
  MaxNonce,        \* nonces 0..MaxNonce-1
  MaxTx,           \* transactions ever created
  MaxBlocks,       \* blocks ever created (block ids = block hashes)
  MaxReorgs, MaxDepth,
  MaxLag,          \* RPC view lag bound, in blocks behind the canonical head
  MaxDrops, MaxLostAcks, MaxHides,
  MaxReq,          \* requests per intent that reach the send path
  MaxStatus,       \* tx_status calls (full only)
  MaxRecs,         \* ledger records
  K,               \* EVIDENCE_K
  N,               \* MAX_UNRESOLVED_ROUNDS (scaled down)
  AgentStopsOnAsk, \* TRUE: after any ask_user the agent sends nothing else
  AgentSequential, \* TRUE: the agent never returns to an intent once it requested a later one
  PriorityMining,  \* TRUE: an includable mempool transaction is mined before any empty block
  TimelyInclusion  \* TRUE: a stock receipt wait does not time out while its tx is includable

Intents == 1..NI
Nonces  == 0..(MaxNonce - 1)
BlkIds  == 1..MaxBlocks
Tok(i)  == IF SharedToken THEN 1 ELSE i
NoRS    == [h |-> 0, b |-> 0]
NoObs   == [ex |-> FALSE, canon |-> FALSE, confOK |-> FALSE, effect |-> FALSE]
Terminal == {"confirmed", "failed", "orphaned", "resend_same_nonce"}
Max(S)  == CHOOSE x \in S : \A y \in S : x >= y
Min(S)  == CHOOSE x \in S : \A y \in S : x <= y

VARIABLES
  chain,     \* canonical chain: sequence of block ids (index = height)
  blk,       \* block id -> tx id (0 = empty block)
  bh,        \* block id -> height at which it was created
  nextBlk,   \* next fresh block id
  pool,      \* mempool: nonce -> tx id (0 = none)
  txs,       \* tx id -> [intent, nonce]
  view,      \* what the wallet's RPC serves: a (possibly stale) chain prefix
  hidden,    \* tx ids whose receipts the RPC hides
  nDrops, nLost, nReorgs, nHides,
  ledger,    \* the wallet's intent records (full and the two ledger baselines)
  pc,        \* wallet call in progress: idle | poll (check loop) | wait (stock receipt wait)
  done,      \* agent received success / confirmed for the intent
  asked,     \* agent received ask_user for the intent
  stopped,   \* agent received an explicit stop for the intent (verify_binary "already took effect")
  reqs, nStatus, cur,
  falseConfirm,  \* ghost: confirmed reported with no execution in the chain or in the view used
  actOnOrphan,   \* ghost: confirmed reported, or another intent let through, while the
                 \*        intent's only execution is orphaned and the reorg is visible in the view
  dupWitness     \* ghost: how the first duplicate came about (for trace reading only)

chainVars == <<chain, blk, bh, nextBlk, pool, txs, view, hidden, nDrops, nLost, nReorgs, nHides>>
agentVars == <<done, asked, stopped, reqs, nStatus, cur>>
vars == <<chainVars, ledger, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

-----------------------------------------------------------------------------
(* Chain and view helpers *)
Range(s)          == {s[k] : k \in DOMAIN s}
InView(t, V)      == \E k \in DOMAIN V : blk[V[k]] = t
HeightIn(t, V)    == CHOOSE k \in DOMAIN V : blk[V[k]] = t
NonceOf(V)        == Cardinality({k \in DOMAIN V : blk[V[k]] # 0})
ExecutedIn(V, i)  == \E k \in DOMAIN V : blk[V[k]] # 0 /\ txs[blk[V[k]]].intent = i
Executions(i)     == Cardinality({k \in DOMAIN chain : blk[chain[k]] # 0 /\ txs[blk[chain[k]]].intent = i})
Bal(V, tk)        == Cardinality({k \in DOMAIN V : blk[V[k]] # 0 /\ Tok(txs[blk[V[k]]].intent) = tk})
InPool(t)         == \E n \in Nonces : pool[n] = t
ReceiptVisible(t, V) == InView(t, V) /\ t \notin hidden
Includable(t)     == NonceOf(chain) \in Nonces /\ pool[NonceOf(chain)] = t

RECURSIVE Contig(_)
Contig(n) == IF n \in Nonces /\ pool[n] # 0 THEN Contig(n + 1) ELSE n
\* eth_getTransactionCount(pending): a fresh node counts the pool; the stale proxy rewrites it to the lag block
PendingCount(V) == IF V = chain THEN Contig(NonceOf(chain)) ELSE NonceOf(V)

RECURSIVE CPL(_, _, _)
CPL(a, b, k) == IF k <= Len(a) /\ k <= Len(b) /\ a[k] = b[k] THEN CPL(a, b, k + 1) ELSE k - 1
Lag(V, C) == Len(C) - CPL(V, C, 1)

\* The reorg is visible in V: a block that held a tx of i is off the canonical chain and V has
\* another block at its height (V is post-reorg there).
OrphanVisible(V, i) ==
  \E b \in 1..(nextBlk - 1) :
     /\ blk[b] # 0 /\ txs[blk[b]].intent = i
     /\ b \notin Range(chain) /\ b \notin Range(V) /\ bh[b] <= Len(V)
BadOrphan(V, i) == OrphanVisible(V, i) /\ ~ExecutedIn(V, i)

-----------------------------------------------------------------------------
(* The evidence layer: observe, decide, isUnresolved, closeRound, checkOnce *)

\* rank in observe(): 3 = receipt (status 1), 1 = transaction known, 0 = unknown
Rank(t, V) == IF ReceiptVisible(t, V) THEN 3 ELSE IF InView(t, V) \/ InPool(t) THEN 1 ELSE 0
Best(H, V) ==
  IF H = {} THEN 0
  ELSE LET m == Max({Rank(t, V) : t \in H}) IN
       IF m = 0 THEN 0 ELSE Min({t \in H : Rank(t, V) = m})   \* first sent among the best (strict > in code)

\* late: the last poll of a check loop (T elapsed since the round started);
\* mid:  a poll after the first one of the round (less than T after the round started).
Observe(r, V, late, mid) ==
  LET b    == Best(r.hashes, V)
      rcpt == b # 0 /\ Rank(b, V) = 3
      known == b # 0 /\ Rank(b, V) >= 1
      incl == IF b # 0 /\ InView(b, V) THEN HeightIn(b, V) ELSE 0
      head == Len(V)
      conf == IF incl > 0 THEN head - incl + 1 ELSE 0
      eff  == r.before >= 0 /\ Bal(V, Tok(r.intent)) > r.before
      orph == r.rs # NoRS /\ r.rs.h <= Len(V) /\ V[r.rs.h] # r.rs.b   \* positive reorg evidence
      chg  == r.hsHead # head
  IN [rcpt |-> rcpt, known |-> known, incl |-> incl, conf |-> conf, eff |-> eff, orph |-> orph,
      nonceLatest |-> NonceOf(V),
      \* anchor: last canonical inclusion (receipt or tx lookup); kept while an orphan is below K on its new branch
      rs      |-> IF incl > 0 /\ (~orph \/ (conf >= K /\ eff)) THEN [h |-> incl, b |-> V[incl]] ELSE r.rs,
      hsHead  |-> head,
      hsOld   |-> IF chg THEN FALSE ELSE IF late THEN (r.hsOld \/ ~r.hsFresh) ELSE r.hsOld,
      hsFresh |-> IF chg THEN mid ELSE r.hsFresh,
      sendOld |-> IF late THEN TRUE ELSE r.sendOld]

WithObs(r, o) ==
  [r EXCEPT !.rs = o.rs, !.hsHead = o.hsHead, !.hsOld = o.hsOld, !.hsFresh = o.hsFresh,
            !.sendOld = o.sendOld,
            !.landed = IF o.orph THEN FALSE ELSE r.landed,   \* orphan evidence invalidates landed evidence
            !.rep = IF o.orph THEN FALSE ELSE r.rep,         \* ... and a reported completion
            !.lo = [ex |-> TRUE, canon |-> o.incl > 0, confOK |-> o.conf >= K, effect |-> o.eff]]

\* decide(), evidence.ts L372-393 (no reverts in the model: the "failed" row is unreachable)
Decide(r, o) ==
  LET inclState == IF o.incl > 0 THEN "included" ELSE IF o.known THEN "pending" ELSE "sent"
      pendState == IF inclState = "sent" THEN "pending" ELSE inclState
  IN IF o.orph /\ ~(o.incl > 0) THEN [d |-> "orphaned", st |-> "orphaned"]
     ELSE IF r.landed THEN
        IF o.incl > 0 /\ o.conf >= K /\ o.eff /\ r.hashes # {} THEN [d |-> "confirmed", st |-> "confirmed"]
        ELSE [d |-> "landed", st |-> pendState]
     ELSE IF o.rcpt THEN
        IF o.conf >= K /\ o.eff THEN [d |-> "confirmed", st |-> "confirmed"]
        ELSE [d |-> "wait", st |-> "included"]
     ELSE IF o.known \/ o.nonceLatest > r.pinned THEN [d |-> "wait_and_recheck", st |-> pendState]
     ELSE IF r.hsOld THEN [d |-> "wait_stale", st |-> "sent"]
     ELSE IF r.sendOld THEN [d |-> "resend_same_nonce", st |-> "dropped"]
     ELSE [d |-> "wait", st |-> "sent"]

IsUnresolved(r) ==
  \/ r.state \in {"sent", "pending", "dropped", "orphaned"}
  \/ r.state = "included" /\ (~r.lo.ex \/ ~r.lo.canon \/ ~r.lo.confOK \/ ~r.lo.effect)

CloseRound(r) ==
  IF r.decision = "landed" \/ (r.rounds >= N /\ r.decision \notin Terminal)
  THEN [r EXCEPT !.decision = "ask_user"] ELSE r

CheckOnce(r, V, count) ==
  LET r0 == IF count THEN [r EXCEPT !.rounds = @ + 1] ELSE r
      o  == Observe(r0, V, FALSE, FALSE)
      r1 == WithObs(r0, o)
      d  == Decide(r1, o)
      r3 == IF r.state = "confirmed" /\ ~o.orph THEN r1
            ELSE LET r2 == [r1 EXCEPT !.decision = d.d, !.state = d.st]
                 IN IF count THEN CloseRound(r2) ELSE r2
  IN IF count /\ r3.state \in {"confirmed", "failed"} THEN [r3 EXCEPT !.rep = TRUE] ELSE r3

RECURSIVE GuardFold(_, _, _, _, _)
GuardFold(L, idx, i, V, ri) ==
  IF idx > Len(L) THEN [L |-> L, refused |-> FALSE]
  ELSE IF \/ L[idx].intent = i
          \/ ri # 0 /\ L[ri].pinned < L[idx].pinned     \* restoring a lower nonce cannot duplicate a later one
          \/ ~(IsUnresolved(L[idx]) \/ L[idx].state \in {"confirmed", "included"})
       THEN GuardFold(L, idx + 1, i, V, ri)
       ELSE LET r2 == CheckOnce(L[idx], V, FALSE)
                L2 == [L EXCEPT ![idx] = r2]
            IN IF IsUnresolved(r2) THEN [L |-> L2, refused |-> TRUE]
               ELSE GuardFold(L2, idx + 1, i, V, ri)

FindOpenFull(L, i) ==
  LET S == {k \in DOMAIN L : L[k].intent = i /\ L[k].state # "failed" /\ (L[k].state # "confirmed" \/ ~L[k].rep)}
  IN IF S = {} THEN 0 ELSE Max(S)
FindOpenBase(L, i) ==
  LET S == {k \in DOMAIN L : L[k].intent = i /\ L[k].reported = "none"}
  IN IF S = {} THEN 0 ELSE Max(S)
\* guard(): re-check the latest same-key record if confirmed (a reorg resumes its nonce), then the others
GuardFull(L, i, V) ==
  LET sk   == {k \in DOMAIN L : L[k].intent = i}
      prev == IF sk = {} THEN 0 ELSE Max(sk)
      L1   == IF prev # 0 /\ L[prev].state = "confirmed" THEN [L EXCEPT ![prev] = CheckOnce(L[prev], V, FALSE)] ELSE L
  IN GuardFold(L1, 1, i, V, FindOpenFull(L1, i))
LatestIntent(L) ==
  LET U == {k \in DOMAIN L : IsUnresolved(L[k])} IN IF U # {} THEN Max(U) ELSE Len(L)

NewRec(i, n, before) ==
  [intent |-> i, pinned |-> n, hashes |-> {}, state |-> "sent", decision |-> "wait",
   rounds |-> 0, sendOld |-> FALSE, hsHead |-> -1, hsOld |-> FALSE, hsFresh |-> FALSE,
   rs |-> NoRS, landed |-> FALSE, lo |-> NoObs, before |-> before,
   reported |-> "none", consumed |-> FALSE, rep |-> FALSE]

\* What the wallet currently claims about intent j (used for "acting on" another intent)
Believed(j) ==
  CASE Policy = "full" -> \E k \in DOMAIN ledger : ledger[k].intent = j /\ ledger[k].state = "confirmed"
    [] Policy = "none" -> done[j]
    [] OTHER           -> \E k \in DOMAIN ledger : ledger[k].intent = j /\ ledger[k].reported = "success"

-----------------------------------------------------------------------------
(* The node's answer to eth_sendRawTransaction of a new tx with nonce n.   *)
(* bumped: a same-nonce replacement with fees +12.5%; own: the record's     *)
(* hashes (its own pooled tx is always out-bid by its next bump).          *)
Outcomes(n, bumped, own) ==
  IF n < NonceOf(chain) THEN {"too_low"}
  ELSE IF n \notin Nonces THEN {}
  ELSE LET acc == (IF Len(txs) < MaxTx THEN {"ack"} \cup (IF nLost < MaxLostAcks THEN {"lost"} ELSE {}) ELSE {})
       IN IF pool[n] = 0 THEN acc
          ELSE IF ~bumped THEN {"underpriced"}
          ELSE IF pool[n] \in own THEN acc
          ELSE acc \cup {"underpriced"}

\* The record's own transactions at nonce n, acknowledged or not (a lost acknowledgement leaves no hash, but the
\* stored request's fees, bumped on every re-send, still out-bid it).
Own(i, n, H) == H \cup {t \in 1..Len(txs) : txs[t].intent = i /\ txs[t].nonce = n}
NewTx == Len(txs) + 1
ApplySend(i, n, res) ==
  IF res \in {"ack", "lost"}
  THEN /\ txs' = Append(txs, [intent |-> i, nonce |-> n])
       /\ pool' = [pool EXCEPT ![n] = NewTx]
       /\ nLost' = IF res = "lost" THEN nLost + 1 ELSE nLost
  ELSE UNCHANGED <<txs, pool, nLost>>

\* Report a call's result to the agent. extra: an "acting on an orphan" event of this call.
Report(i, d, V, extra) ==
  /\ done' = IF d = "confirmed" THEN [done EXCEPT ![i] = TRUE] ELSE done
  /\ asked' = IF d = "ask_user" THEN [asked EXCEPT ![i] = TRUE] ELSE asked
  /\ falseConfirm' = (falseConfirm \/ (d = "confirmed" /\ ~ExecutedIn(V, i) /\ ~ExecutedIn(chain, i)))
  /\ actOnOrphan' = (actOnOrphan \/ extra \/ (d = "confirmed" /\ BadOrphan(V, i)))
NoReport(extra) ==
  /\ UNCHANGED <<done, asked, falseConfirm>>
  /\ actOnOrphan' = (actOnOrphan \/ extra)

AgentMay(i) ==
  /\ ~done[i] /\ ~stopped[i] /\ reqs[i] < MaxReq
  /\ AgentStopsOnAsk => \A k \in Intents : ~asked[k]
  /\ AgentSequential => i >= cur

AgentTurn(i) == /\ reqs' = [reqs EXCEPT ![i] = @ + 1]
                /\ cur' = i

OtherBelievedOrphan(i, V) == \E j \in Intents : j # i /\ Believed(j) /\ BadOrphan(V, j)

-----------------------------------------------------------------------------
(* Policy "full": sendWithEvidence *)

FullFirstSend(i, L, V, extra) ==
  LET n  == PendingCount(V)
      r0 == NewRec(i, n, Bal(V, Tok(i)))
  IN /\ Len(L) < MaxRecs
     /\ \E res \in Outcomes(n, FALSE, {}) :
          /\ ApplySend(i, n, res)
          /\ IF res = "ack"
             THEN /\ ledger' = Append(L, [r0 EXCEPT !.hashes = {NewTx}, !.rounds = 1])
                  /\ pc' = [k |-> "poll", r |-> Len(L) + 1, mid |-> FALSE]
             ELSE /\ ledger' = Append(L, [r0 EXCEPT !.state = "pending"])   \* EVIDENCE_PENDING, no hash
                  /\ pc' = pc
     /\ NoReport(extra)

FullResend(i, L, oi, extra) ==
  LET r == L[oi]
      n == r.pinned
      reopen == r.state \in {"orphaned", "dropped"}
  IN \E res \in Outcomes(n, TRUE, Own(i, n, r.hashes)) :
       /\ ApplySend(i, n, res)
       /\ IF res = "lost"
          THEN /\ ledger' = L /\ pc' = pc        \* classifySendError = "error": rethrown, no round
          ELSE LET r1 == CASE res = "ack" ->
                                 [r EXCEPT !.hashes = @ \cup {NewTx}, !.landed = FALSE, !.sendOld = FALSE,
                                           !.rs = IF reopen THEN NoRS ELSE r.rs]
                           [] res = "too_low" -> [r EXCEPT !.landed = TRUE]
                           [] OTHER -> r                                     \* "pending"
                   r2 == [r1 EXCEPT !.state = IF reopen THEN "sent" ELSE r.state,
                                    !.rounds = @ + 1, !.hsFresh = FALSE]
               IN /\ ledger' = [L EXCEPT ![oi] = r2]
                  /\ pc' = [k |-> "poll", r |-> oi, mid |-> FALSE]
       /\ NoReport(extra)

FullRequest(i) ==
  /\ Policy = "full" /\ pc.k = "idle" /\ AgentMay(i)
  /\ LET g == GuardFull(ledger, i, view) IN
     IF g.refused
     THEN /\ ledger' = g.L                       \* EVIDENCE_UNRESOLVED; not counted as a request
          /\ UNCHANGED <<chainVars, pc, agentVars, falseConfirm, actOnOrphan>>
     ELSE LET extra == \E k \in DOMAIN g.L : g.L[k].intent # i /\ g.L[k].state = "confirmed"
                                             /\ BadOrphan(view, g.L[k].intent)
              oi == FindOpenFull(g.L, i)
          IN /\ AgentTurn(i)
             /\ IF oi = 0 THEN FullFirstSend(i, g.L, view, extra) ELSE FullResend(i, g.L, oi, extra)
             /\ UNCHANGED <<chain, blk, bh, nextBlk, view, hidden, nDrops, nReorgs, nHides, stopped, nStatus>>
  /\ UNCHANGED dupWitness

\* One poll of the check loop (observe + decide); the loop ends on a terminal decision or at T.
Poll ==
  /\ pc.k = "poll"
  /\ \E late \in (IF pc.mid THEN BOOLEAN ELSE {FALSE}) :
       LET r  == ledger[pc.r]
           o  == Observe(r, view, late, pc.mid)
           r1 == WithObs(r, o)
           d  == Decide(r1, o)
           r2 == [r1 EXCEPT !.decision = d.d, !.state = d.st]
           ends == late \/ d.d \in Terminal
           r3 == IF ~ends THEN r2
                 ELSE LET c == CloseRound(r2) IN
                      IF c.decision \in {"confirmed", "failed"} THEN [c EXCEPT !.rep = TRUE] ELSE c
       IN /\ ledger' = [ledger EXCEPT ![pc.r] = r3]
          /\ IF ends
             THEN /\ pc' = [k |-> "idle"]
                  /\ Report(r3.intent, r3.decision, view, FALSE)
             ELSE /\ pc' = [pc EXCEPT !.mid = TRUE]
                  /\ NoReport(FALSE)
  /\ UNCHANGED <<chainVars, stopped, reqs, nStatus, cur, dupWitness>>

\* tx_status: one counted check round of latestIntent(); read-only on the chain.
TxStatus ==
  /\ Policy = "full" /\ pc.k = "idle" /\ nStatus < MaxStatus /\ Len(ledger) > 0
  /\ AgentStopsOnAsk => \A k \in Intents : ~asked[k]
  /\ LET idx == LatestIntent(ledger)
         r2  == CheckOnce(ledger[idx], view, TRUE)
     IN /\ ledger' = [ledger EXCEPT ![idx] = r2]
        /\ Report(r2.intent, r2.decision, view, FALSE)
  /\ nStatus' = nStatus + 1
  /\ UNCHANGED <<chainVars, pc, stopped, reqs, cur, dupWitness>>

\* Agent-side time passes between calls (at least T): every T-based condition becomes true.
TimePasses ==
  /\ Policy = "full" /\ pc.k = "idle"
  /\ \E k \in DOMAIN ledger : ~ledger[k].sendOld \/ (ledger[k].hsHead # -1 /\ ~ledger[k].hsOld) \/ ledger[k].hsFresh
  /\ ledger' = [k \in DOMAIN ledger |->
                 [ledger[k] EXCEPT !.sendOld = TRUE, !.hsOld = (ledger[k].hsHead # -1), !.hsFresh = FALSE]]
  /\ UNCHANGED <<chainVars, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

-----------------------------------------------------------------------------
(* Baselines *)

Settle(L, k) == [L EXCEPT ![k].reported = "success", ![k].consumed = TRUE, ![k].state = "confirmed"]

\* nonce_only: sendNonceOnly
NORequest(i) ==
  /\ Policy = "nonce_only" /\ pc.k = "idle" /\ AgentMay(i)
  /\ AgentTurn(i)
  /\ LET V == view
         L == ledger
         oi == FindOpenBase(L, i)
         extra == OtherBelievedOrphan(i, V)
     IN IF oi # 0
        THEN LET r == L[oi] IN
             \E res \in Outcomes(r.pinned, TRUE, Own(i, r.pinned, r.hashes)) :
               /\ ApplySend(i, r.pinned, res)
               /\ CASE res = "ack" ->
                         /\ ledger' = [L EXCEPT ![oi].hashes = @ \cup {NewTx}]
                         /\ pc' = [k |-> "wait", r |-> oi, i |-> i, h |-> NewTx]
                         /\ NoReport(extra)
                    [] res = "too_low" /\ r.hashes # {} ->          \* "nonce too low" => success
                         /\ ledger' = Settle([L EXCEPT ![oi].landed = TRUE], oi)
                         /\ pc' = pc
                         /\ Report(i, "confirmed", V, extra)
                    [] res = "underpriced" /\ r.hashes # {} ->      \* still pooled: wait on the last hash
                         /\ ledger' = L
                         /\ pc' = [k |-> "wait", r |-> oi, i |-> i, h |-> Max(r.hashes)]
                         /\ NoReport(extra)
                    [] OTHER ->                                     \* stock error stands
                         /\ ledger' = IF res = "too_low" THEN [L EXCEPT ![oi].landed = TRUE, ![oi].consumed = TRUE] ELSE L
                         /\ pc' = pc
                         /\ NoReport(extra)
        ELSE LET pend == PendingCount(V)
                 L1 == [k \in DOMAIN L |-> IF ~L[k].consumed /\ NonceOf(V) > L[k].pinned
                                            THEN [L[k] EXCEPT !.consumed = TRUE] ELSE L[k]]
                 reserved == {L1[k].pinned : k \in {x \in DOMAIN L1 : ~L1[x].consumed}}
                 n == Min({x \in pend..(pend + Len(L1)) : x \notin reserved})
                 r0 == NewRec(i, n, -1)
             IN /\ Len(L) < MaxRecs
                /\ \E res \in Outcomes(n, FALSE, {}) :
                     /\ ApplySend(i, n, res)
                     /\ IF res = "ack"
                        THEN /\ ledger' = Append(L1, [r0 EXCEPT !.hashes = {NewTx}])
                             /\ pc' = [k |-> "wait", r |-> Len(L1) + 1, i |-> i, h |-> NewTx]
                        ELSE /\ ledger' = Append(L1, r0)            \* reserved before dispatch; error thrown
                             /\ pc' = pc
                     /\ NoReport(extra)
  /\ UNCHANGED <<chain, blk, bh, nextBlk, view, hidden, nDrops, nReorgs, nHides, stopped, nStatus, dupWitness>>

\* verify_binary: sendVerifyBinary (binaryCheck, then a stock send with a fresh nonce)
VBSend(i, L, k, extra) ==
  LET n == PendingCount(view) IN
  \E res \in Outcomes(n, FALSE, {}) :
    /\ ApplySend(i, n, res)
    /\ IF res = "ack"
       THEN /\ ledger' = [L EXCEPT ![k].hashes = @ \cup {NewTx}]
            /\ pc' = [k |-> "wait", r |-> k, i |-> i, h |-> NewTx]
       ELSE /\ ledger' = L /\ pc' = pc
    /\ NoReport(extra)
    /\ stopped' = stopped

VBRequest(i) ==
  /\ Policy = "verify_binary" /\ pc.k = "idle" /\ AgentMay(i)
  /\ AgentTurn(i)
  /\ LET V == view
         L == ledger
         oi == FindOpenBase(L, i)
         extra == OtherBelievedOrphan(i, V)
     IN IF oi # 0
        THEN LET r == L[oi]
                 complete == (\E t \in r.hashes : ReceiptVisible(t, V)) \/ (r.before >= 0 /\ Bal(V, Tok(i)) > r.before)
             IN IF complete /\ r.hashes # {}
                THEN /\ ledger' = Settle(L, oi) /\ pc' = pc /\ Report(i, "confirmed", V, extra)
                     /\ UNCHANGED <<txs, pool, nLost, stopped>>
                ELSE IF complete
                THEN /\ ledger' = L /\ pc' = pc /\ NoReport(extra)   \* "already took effect": explicit stop
                     /\ stopped' = [stopped EXCEPT ![i] = TRUE]
                     /\ UNCHANGED <<txs, pool, nLost>>
                ELSE VBSend(i, L, oi, extra)
        ELSE /\ Len(L) < MaxRecs
             /\ VBSend(i, Append(L, NewRec(i, -1, Bal(V, Tok(i)))), Len(L) + 1, extra)
  /\ UNCHANGED <<chain, blk, bh, nextBlk, view, hidden, nDrops, nReorgs, nHides, nStatus, dupWitness>>

\* none: the stock send (viem fills the nonce from the wallet's RPC), then the stock wait
NoneRequest(i) ==
  /\ Policy = "none" /\ pc.k = "idle" /\ AgentMay(i)
  /\ AgentTurn(i)
  /\ LET n == PendingCount(view) IN
     \E res \in Outcomes(n, FALSE, {}) :
       /\ ApplySend(i, n, res)
       /\ pc' = IF res = "ack" THEN [k |-> "wait", r |-> 0, i |-> i, h |-> NewTx] ELSE pc
       /\ NoReport(OtherBelievedOrphan(i, view))
  /\ UNCHANGED <<chain, blk, bh, nextBlk, view, hidden, nDrops, nReorgs, nHides, ledger, stopped, nStatus, dupWitness>>

\* stock waitForTransactionReceipt on one hash (baselines)
WaitDone ==
  /\ pc.k = "wait" /\ ReceiptVisible(pc.h, view)
  /\ ledger' = IF pc.r # 0 THEN Settle(ledger, pc.r) ELSE ledger
  /\ pc' = [k |-> "idle"]
  /\ Report(pc.i, "confirmed", view, FALSE)
  /\ UNCHANGED <<chainVars, stopped, reqs, nStatus, cur, dupWitness>>
WaitTimeout ==
  /\ pc.k = "wait" /\ ~ReceiptVisible(pc.h, view)
  /\ TimelyInclusion => ~Includable(pc.h)
  /\ pc' = [k |-> "idle"]
  /\ UNCHANGED <<chainVars, ledger, agentVars, falseConfirm, actOnOrphan, dupWitness>>

-----------------------------------------------------------------------------
(* Chain, view and faults *)

FollowView(newChain) == \E nv \in {view, newChain} : view' = nv /\ Lag(nv, newChain) <= MaxLag

MineTx ==
  LET n == NonceOf(chain) IN
  /\ n \in Nonces /\ pool[n] # 0 /\ nextBlk <= MaxBlocks
  /\ chain' = Append(chain, nextBlk)
  /\ blk' = [blk EXCEPT ![nextBlk] = pool[n]]
  /\ bh' = [bh EXCEPT ![nextBlk] = Len(chain) + 1]
  /\ nextBlk' = nextBlk + 1
  /\ pool' = [pool EXCEPT ![n] = 0]
  /\ FollowView(Append(chain, nextBlk))
  /\ dupWitness' = IF dupWitness = "" /\ Executions(txs[pool[n]].intent) = 1
                   THEN "second execution of an intent mined" ELSE dupWitness
  /\ UNCHANGED <<txs, hidden, nDrops, nLost, nReorgs, nHides, ledger, pc, agentVars, falseConfirm, actOnOrphan>>

MineEmpty ==
  /\ nextBlk <= MaxBlocks
  /\ PriorityMining => ~(NonceOf(chain) \in Nonces /\ pool[NonceOf(chain)] # 0)
  /\ chain' = Append(chain, nextBlk)
  /\ bh' = [bh EXCEPT ![nextBlk] = Len(chain) + 1]
  /\ nextBlk' = nextBlk + 1
  /\ FollowView(Append(chain, nextBlk))
  /\ UNCHANGED <<blk, pool, txs, hidden, nDrops, nLost, nReorgs, nHides, ledger, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

\* Emulated reorg (chain-faults spec): the last d blocks are replaced by d empty blocks at the same heights.
Reorg ==
  /\ nReorgs < MaxReorgs
  /\ \E d \in 1..MaxDepth :
     /\ d <= Len(chain) /\ nextBlk + d - 1 <= MaxBlocks
     /\ LET keep    == Len(chain) - d
            orphTx  == {blk[chain[k]] : k \in (keep + 1)..Len(chain)} \ {0}
            newC    == SubSeq(chain, 1, keep) \o [k \in 1..d |-> nextBlk + k - 1]
            ON      == {txs[t].nonce : t \in orphTx}
        IN /\ orphTx # {}
           /\ chain' = newC
           /\ bh' = [b \in BlkIds |-> IF b >= nextBlk /\ b < nextBlk + d THEN keep + (b - nextBlk) + 1 ELSE bh[b]]
           /\ nextBlk' = nextBlk + d
           /\ IF Reinclude
              THEN \E win \in [ON -> BOOLEAN] :     \* a pooled same-nonce tx may win over the returning one
                     pool' = [n \in Nonces |->
                               IF n \in ON /\ (pool[n] = 0 \/ win[n])
                               THEN CHOOSE t \in orphTx : txs[t].nonce = n ELSE pool[n]]
              ELSE pool' = pool
           /\ FollowView(newC)
  /\ nReorgs' = nReorgs + 1
  /\ UNCHANGED <<blk, txs, hidden, nDrops, nLost, nHides, ledger, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

\* The lagging node catches up (fully or partly) with the canonical chain.
ViewSync ==
  /\ view # chain
  /\ \E k \in Len(view)..Len(chain) : view' = SubSeq(chain, 1, k) /\ view' # view
  /\ UNCHANGED <<chain, blk, bh, nextBlk, pool, txs, hidden, nDrops, nLost, nReorgs, nHides, ledger, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

Drop ==
  /\ nDrops < MaxDrops
  /\ \E n \in Nonces : pool[n] # 0 /\ pool' = [pool EXCEPT ![n] = 0]
  /\ nDrops' = nDrops + 1
  /\ UNCHANGED <<chain, blk, bh, nextBlk, txs, view, hidden, nLost, nReorgs, nHides, ledger, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

Hide ==
  /\ nHides < MaxHides
  /\ \E t \in 1..Len(txs) : t \notin hidden /\ hidden' = hidden \cup {t}
  /\ nHides' = nHides + 1
  /\ UNCHANGED <<chain, blk, bh, nextBlk, pool, txs, view, nDrops, nLost, nReorgs, ledger, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

Unhide ==
  /\ \E t \in hidden : hidden' = hidden \ {t}
  /\ UNCHANGED <<chain, blk, bh, nextBlk, pool, txs, view, nDrops, nLost, nReorgs, nHides, ledger, pc, agentVars, falseConfirm, actOnOrphan, dupWitness>>

-----------------------------------------------------------------------------
Init ==
  /\ chain = <<>> /\ blk = [b \in BlkIds |-> 0] /\ bh = [b \in BlkIds |-> 0] /\ nextBlk = 1
  /\ pool = [n \in Nonces |-> 0] /\ txs = <<>> /\ view = <<>> /\ hidden = {}
  /\ nDrops = 0 /\ nLost = 0 /\ nReorgs = 0 /\ nHides = 0
  /\ ledger = <<>> /\ pc = [k |-> "idle"]
  /\ done = [i \in Intents |-> FALSE] /\ asked = [i \in Intents |-> FALSE]
  /\ stopped = [i \in Intents |-> FALSE] /\ reqs = [i \in Intents |-> 0]
  /\ nStatus = 0 /\ cur = 1
  /\ falseConfirm = FALSE /\ actOnOrphan = FALSE /\ dupWitness = ""

Request(i) == FullRequest(i) \/ NORequest(i) \/ VBRequest(i) \/ NoneRequest(i)
Wallet == Poll \/ WaitDone \/ WaitTimeout
Env    == MineTx \/ MineEmpty \/ Reorg \/ ViewSync \/ Drop \/ Hide \/ Unhide

Next == (\E i \in Intents : Request(i)) \/ TxStatus \/ TimePasses \/ Wallet \/ Env

Spec == Init /\ [][Next]_vars

\* Fairness for liveness: the chain keeps producing blocks, the node catches up, hidden receipts
\* reappear, the wallet's own steps run, agent time passes, and the agent keeps re-requesting
\* every intent it may request. Faults have no fairness (each is bounded).
Fairness ==
  /\ WF_vars(MineTx) /\ WF_vars(MineEmpty) /\ WF_vars(ViewSync) /\ WF_vars(Unhide)
  /\ WF_vars(Poll) /\ WF_vars(WaitDone) /\ WF_vars(WaitTimeout) /\ WF_vars(TimePasses)
  /\ \A i \in Intents : WF_vars(Request(i))

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ pc.k \in {"idle", "poll", "wait"}
  /\ \A n \in Nonces : pool[n] \in 0..Len(txs)
  /\ Len(chain) <= MaxBlocks

\* Safety: at most one canonical execution per intent, in every reachable state.
AtMostOnce == \A i \in Intents : Executions(i) <= 1

\* Safety: confirmed is never reported for an intent with no execution in the chain or in the view.
NoFalseConfirm == ~falseConfirm

\* Safety: the layer never reports an intent confirmed, nor lets another intent through on top of
\* it, while its only execution is orphaned and the reorg is visible in the view it read.
NoActOnOrphan == ~actOnOrphan

Resolved(i) == done[i] \/ stopped[i] \/ \E k \in Intents : asked[k]

\* Liveness: every intent eventually reaches confirmed or an explicit ask_user / stop.
EventuallyResolved == \A i \in Intents : <>Resolved(i)

\* Liveness to the correct state: eventually, forever, every intent the agent was told is
\* confirmed has exactly one canonical execution.
EventuallyCorrect == <>[](\A i \in Intents : done[i] => Executions(i) = 1)


-----------------------------------------------------------------------------
(* The fairness of LiveSpec written as []<>(~En \/ <<A>>_vars), with En an explicit state predicate equal to *)
(* ENABLED <<A>>_vars (checked by the invariant EnabledMatches in MC_full_enabled_check.cfg). TLC evaluates     *)
(* ENABLED of these actions very slowly (about 10 states/s); explicit predicates avoid that. Full policy only. *)
EnMineTx    == NonceOf(chain) \in Nonces /\ pool[NonceOf(chain)] # 0 /\ nextBlk <= MaxBlocks
EnMineEmpty == nextBlk <= MaxBlocks /\ (PriorityMining => ~(NonceOf(chain) \in Nonces /\ pool[NonceOf(chain)] # 0))
EnViewSync  == view # chain
EnUnhide    == hidden # {}
EnPoll      == pc.k = "poll"
EnTime      == Policy = "full" /\ pc.k = "idle" /\
               \E k \in DOMAIN ledger : ~ledger[k].sendOld \/ (ledger[k].hsHead # -1 /\ ~ledger[k].hsOld) \/ ledger[k].hsFresh
EnReq(i)    == Policy = "full" /\ pc.k = "idle" /\ AgentMay(i) /\
               LET g == GuardFull(ledger, i, view) IN
               IF g.refused THEN g.L # ledger
               ELSE LET oi == FindOpenFull(g.L, i) IN
                    IF oi = 0 THEN Len(g.L) < MaxRecs /\ Outcomes(PendingCount(view), FALSE, {}) # {}
                    ELSE Outcomes(g.L[oi].pinned, TRUE, Own(i, g.L[oi].pinned, g.L[oi].hashes)) # {}
\* []<>(~En) \/ []<><<A>>_vars  is  []<>(~En \/ <<A>>_vars), i.e. WF_vars(A) when En = ENABLED <<A>>_vars
FairnessFull ==
  /\ ([]<>(~EnMineTx) \/ []<><<MineTx>>_vars)
  /\ ([]<>(~EnMineEmpty) \/ []<><<MineEmpty>>_vars)
  /\ ([]<>(~EnViewSync) \/ []<><<ViewSync>>_vars)
  /\ ([]<>(~EnUnhide) \/ []<><<Unhide>>_vars)
  /\ ([]<>(~EnPoll) \/ []<><<Poll>>_vars)
  /\ ([]<>(~EnTime) \/ []<><<TimePasses>>_vars)
  /\ \A i \in Intents : ([]<>(~EnReq(i)) \/ []<><<FullRequest(i)>>_vars)
LiveSpecFull == Spec /\ FairnessFull

EnabledMatches ==
  /\ EnMineTx = ENABLED <<MineTx>>_vars /\ EnMineEmpty = ENABLED <<MineEmpty>>_vars
  /\ EnViewSync = ENABLED <<ViewSync>>_vars /\ EnUnhide = ENABLED <<Unhide>>_vars
  /\ EnPoll = ENABLED <<Poll>>_vars /\ EnTime = ENABLED <<TimePasses>>_vars
  /\ \A i \in Intents : EnReq(i) = ENABLED <<FullRequest(i)>>_vars

=============================================================================
