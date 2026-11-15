/**
 * Chain-evidence layer for EVM sends (research mode, off by default; `EVM_EVIDENCE_LAYER=1`).
 *
 * Safety for an unresolved operation comes from the chain's nonce: its record pins one nonce, and retries
 * reuse that nonce, so at most one of those transactions can execute. A completed record is not a durable
 * logical-operation ID: a later identical swap may represent a new authorized operation.
 * Progress comes from graded evidence: after a send the layer polls receipts, block hashes, the head, the
 * account nonce and the intent's balance effect, and reports one decision (confirmed, wait, wait_and_recheck,
 * resend_same_nonce, orphaned, landed, ask_user, failed) in a plain sentence the agent can act on.
 *
 * The layer never re-sends on its own: a re-send happens only on the agent's next call for the same intent,
 * which passes the normal confirmation flow. While an intent is unresolved, sends for other intents are refused.
 *
 * `EVM_EVIDENCE_ABLATE` (research ablations): `no_nonce_pin` re-sends with a fresh nonce; `no_grading` reports
 * only a binary success or failure; `no_refusal_decode` keeps plan refusals raw (see plan-guard.ts).
 *
 * `EVM_EVIDENCE_DECISION_LOG=1` (research instrumentation, full layer only): each decision the layer returns to the
 * agent is also written to stderr as one `[evidence-decision] {json}` line (see logDecision). Logging only: no
 * decision, message or record changes, and nothing is written when the flag is unset.
 */
import {
  type Address,
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  formatUnits,
  type Hex,
  http,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { NATIVE_TOKEN_ADDRESS, TX_CONFIRMATION_TIMEOUT_MS } from "./constants";
import { EVMError, EVMErrorCode } from "./types";

/** Fixed constants of the decision table. */
export const EVIDENCE_K = 2; // confirmations (head - receiptBlock + 1)
export const CHECK_INTERVAL_MS = 5_000; // t
export const CHECK_BUDGET_MS = 60_000; // T, equal to TX_CONFIRMATION_TIMEOUT_MS
export const MAX_UNRESOLVED_ROUNDS = 6; // N: check rounds (a send's check loop or one tx_status) without resolution

export type EvidenceAblation = "none" | "no_nonce_pin" | "no_grading" | "no_refusal_decode";
export const EVIDENCE_ABLATIONS: readonly EvidenceAblation[] = ["none", "no_nonce_pin", "no_grading", "no_refusal_decode"];

/**
 * `EVM_EVIDENCE_MODE` selects the send policy (research baselines; unset means the stock path):
 * - `full`: this layer (also selected by the legacy `EVM_EVIDENCE_LAYER=1`);
 * - `nonce_only`: intent ledger and same-nonce re-send only (a wallet's speed-up), stock wording, no guard;
 * - `verify_binary`: one binary check (receipt or balance effect) before re-sending an intent, fresh nonce;
 * - `pace_style`: a stateless pre-signing check (policy and an eth_call simulation) of every call, stock send;
 * - `full_quorum`: the full layer with its evidence reads taken from N >= 2 read endpoints (`EVM_EVIDENCE_READ_URLS`)
 *   and compared, as ethers' FallbackProvider (quorum) and eRPC's consensus mode do; see "quorum reads" below.
 */
export type EvidenceMode = "off" | "full" | "nonce_only" | "verify_binary" | "pace_style" | "full_quorum";
export const EVIDENCE_MODES: readonly Exclude<EvidenceMode, "off">[] = ["full", "nonce_only", "verify_binary", "pace_style", "full_quorum"];
/** The full layer's decisions, guard, tx_status and refusal decoding (full, and full_quorum, which only changes reads). */
const isFullLayer = (mode: EvidenceMode) => mode === "full" || mode === "full_quorum";
export function evidenceMode(): EvidenceMode {
  const raw = process.env.EVM_EVIDENCE_MODE;
  const layer = process.env.EVM_EVIDENCE_LAYER === "1";
  if (raw === undefined || raw === "") return layer ? "full" : "off";
  if (!(EVIDENCE_MODES as readonly string[]).includes(raw)) throw new Error(`Unknown EVM_EVIDENCE_MODE=${raw}`);
  if (layer && raw !== "full") throw new Error(`EVM_EVIDENCE_LAYER=1 is the full layer; it cannot be combined with EVM_EVIDENCE_MODE=${raw}`);
  return raw as EvidenceMode;
}
/** The full layer (graded evidence, guard, tx_status, typed errors, refusal decoding). */
export function evidenceLayerEnabled(): boolean {
  return isFullLayer(evidenceMode());
}
/** Any mode: the send sites route through sendWithEvidence. */
export function evidenceSendsEnabled(): boolean {
  return evidenceMode() !== "off";
}
export function evidenceAblation(): EvidenceAblation {
  const raw = process.env.EVM_EVIDENCE_ABLATE ?? "none";
  if (!(EVIDENCE_ABLATIONS as readonly string[]).includes(raw)) throw new Error(`Unknown EVM_EVIDENCE_ABLATE=${raw}`);
  return raw as EvidenceAblation;
}

export type IntentState = "sent" | "pending" | "included" | "confirmed" | "dropped" | "orphaned" | "refused" | "failed";
export type EvidenceDecision =
  | "confirmed"
  | "wait"
  | "failed"
  | "wait_and_recheck"
  | "resend_same_nonce"
  | "orphaned"
  | "landed"
  | "ask_user";
/** Why a `wait` (or `landed`) is not yet a confirmation. */
export type WaitReason = "confirmations" | "stale_head" | "not_seen" | "no_effect" | "no_quorum" | null;

export type EvidenceEffect =
  | { kind: "balance_increase"; token: Address; holder: Address }
  | { kind: "allowance"; token: Address; owner: Address; spender: Address; amount: bigint };

export interface EvidenceIntent {
  chainId: number;
  sender: Address;
  effectiveTarget: Address;
  selector: Hex;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  label: string;
  effect: EvidenceEffect | null;
}

export interface EvidenceObservation {
  atMs: number;
  head: number;
  hash: Hex | null;
  receiptBlock: number | null;
  receiptBlockHash: Hex | null;
  receiptStatus: "success" | "reverted" | null;
  txKnown: boolean;
  /** Block of the transaction from eth_getTransactionByHash, when the receipt is not visible. */
  txBlock: number | null;
  canonical: boolean | null;
  /** The block at the height of an earlier receipt now has another hash (and the same number). */
  orphanEvidence: boolean;
  confirmations: number;
  nonceLatest: number;
  balanceEffectSeen: boolean;
  /** full_quorum only (absent otherwise): how the read endpoints agreed for this observation. */
  quorum?: QuorumSummary;
}

/** The transaction as first sent; re-sends reuse it with the pinned nonce and a fee bump. */
export interface StoredRequest {
  account: unknown;
  chain: unknown;
  to: Address;
  value: bigint;
  data: Hex;
  gas: bigint | undefined;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  type?: string;
}

export interface IntentRecord {
  key: string;
  intent: EvidenceIntent;
  pinnedNonce: number;
  hashes: Hex[];
  /** Nonce each hash was sent with (differs from pinnedNonce only under the no_nonce_pin ablation). */
  sentNonces: number[];
  snapshot: { effectBefore: string | null };
  state: IntentState;
  decision: EvidenceDecision;
  waitReason: WaitReason;
  observations: EvidenceObservation[];
  rounds: number;
  lastSendAtMs: number;
  headSince: { head: number; atMs: number } | null;
  /** Last positively canonical inclusion from a receipt or transaction lookup. */
  receiptSeen: { hash: Hex; block: number; blockHash: Hex } | null;
  landed: boolean;
  request: StoredRequest;
  /** Baseline modes (nonce_only, verify_binary) only; the full layer never sets it. */
  baseline?: BaselineInfo;
}

/** What a baseline mode records about an intent (no graded decision is derived from it). */
export interface BaselineInfo {
  mode: "nonce_only" | "verify_binary";
  /** The last outcome the wallet reported for this intent, in stock wording; null after an error or no report. */
  reported: "success" | "failed" | null;
  /** nonce_only: the wallet observed the pinned nonce used (receipt, "nonce too low", or the account nonce past it). */
  consumed: boolean;
  /** nonce_only: this intent took a nonce above the node's pending count, behind nonces reserved for others. */
  nonceGap: { nonce: number; pendingCount: number; reserved: number[] } | null;
  /** verify_binary: each check before a re-send. */
  checks: { atMs: number; result: "complete" | "incomplete"; reason: string; hash: Hex | null }[];
}

// ---- clients (structural, so tests can pass plain mocks) -------------------------------------------------
export interface EvidencePublicClient {
  /** full_quorum pins its comparison reads to one height with `blockNumber` (then `blockTag` is absent). */
  getTransactionCount(args: { address: Address; blockTag?: "pending" | "latest"; blockNumber?: bigint }): Promise<number>;
  getTransaction(args: { hash: Hex }): Promise<{ blockNumber: bigint | null; blockHash: Hex | null }>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null; number: bigint | null }>;
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getBalance(args: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  readContract(args: any): Promise<unknown>;
  /** Stock confirmation wait (baseline modes keep the stock wording of its result). */
  waitForTransactionReceipt?(args: { hash: Hex; timeout: number }): Promise<{ status: "success" | "reverted" }>;
  /** eth_call at the head (pace_style simulation). */
  call?(args: { account: any; to: Address; data?: Hex; value?: bigint }): Promise<unknown>;
}
export interface EvidenceWalletClient {
  sendTransaction(args: any): Promise<Hex>;
  prepareTransactionRequest(args: any): Promise<any>;
}
export interface EvidenceDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const realDeps: EvidenceDeps = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// ---- intents ---------------------------------------------------------------------------------------------
const ROUTER_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/**
 * The intent of an effective call (for a plan redemption: the call inside it). Uniswap V2 swaps and ERC-20
 * approvals are decoded; anything else is keyed by target, selector and value. `holder` owns the funds.
 */
export function describeCall(o: { chainId: number; sender: Address; holder: Address; to: Address; value: bigint; data: Hex }): EvidenceIntent {
  const base = { chainId: o.chainId, sender: o.sender, effectiveTarget: o.to, selector: (o.data.slice(0, 10) || "0x") as Hex };
  try {
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: o.data });
    const fn = call.functionName;
    const path = (fn === "swapExactETHForTokens" ? call.args[1] : call.args[2]) as readonly Address[];
    const recipient = (fn === "swapExactETHForTokens" ? call.args[2] : call.args[3]) as Address;
    const tokenOut = fn === "swapExactTokensForETH" ? NATIVE_TOKEN_ADDRESS : path[path.length - 1];
    return {
      ...base,
      tokenIn: fn === "swapExactETHForTokens" ? NATIVE_TOKEN_ADDRESS : path[0],
      tokenOut,
      amountIn: fn === "swapExactETHForTokens" ? o.value : (call.args[0] as bigint),
      label: "swap",
      effect: { kind: "balance_increase", token: tokenOut, holder: recipient },
    };
  } catch {}
  try {
    const call = decodeFunctionData({ abi: ERC20_ABI, data: o.data });
    if (call.functionName === "approve") {
      const [spender, amount] = call.args as readonly [Address, bigint];
      return {
        ...base,
        tokenIn: o.to,
        tokenOut: spender,
        amountIn: amount,
        label: "token approval",
        effect: { kind: "allowance", token: o.to, owner: o.holder, spender, amount },
      };
    }
  } catch {}
  return { ...base, tokenIn: "", tokenOut: "", amountIn: o.value, label: "transaction", effect: null };
}

export function intentKey(i: EvidenceIntent): string {
  return [i.chainId, i.sender, i.effectiveTarget, i.selector, i.tokenIn, i.tokenOut, i.amountIn.toString()]
    .map((x) => String(x).toLowerCase())
    .join("|");
}

// ---- ledger (in memory, one per chain and sender in this process) ----------------------------------------
const ledgers = new Map<string, IntentRecord[]>();
// A guard may learn completion without reporting it to the operation caller.
const reportedOutcomes = new WeakSet<IntentRecord>();
const sendQueues = new Map<string, Promise<void>>();
/** Serialize nonce allocation, reservation and dispatch for one sender, not the polling loop. */
async function serializeSend<T>(intent: EvidenceIntent, run: () => Promise<T>): Promise<T> {
  const key = ledgerKey(intent.chainId, intent.sender);
  const previous = sendQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => held);
  sendQueues.set(key, tail);
  await previous;
  try { return await run(); }
  finally {
    release();
    if (sendQueues.get(key) === tail) sendQueues.delete(key);
  }
}
const ledgerKey = (chainId: number, sender: string) => `${chainId}|${sender.toLowerCase()}`;
export function evidenceLedger(chainId: number, sender: string): IntentRecord[] {
  const k = ledgerKey(chainId, sender);
  let l = ledgers.get(k);
  if (!l) ledgers.set(k, (l = []));
  return l;
}
/** Test helper. */
export function resetEvidenceLedgers(): void {
  ledgers.clear();
  sendQueues.clear();
  announced = null;
  lastQuorumLog = "";
  envQuorum = null;
}

/** Unresolved reservations include dropped operations until they are retried or explicitly resolved. */
export function isUnresolved(r: IntentRecord): boolean {
  if (r.state === "sent" || r.state === "pending" || r.state === "dropped" || r.state === "orphaned") return true;
  // A hidden receipt may still have positive canonical inclusion and balance evidence.
  if (r.state === "included") {
    const o = r.observations[r.observations.length - 1];
    return !o || o.canonical !== true || o.confirmations < EVIDENCE_K || !o.balanceEffectSeen;
  }
  return false;
}
/** A record a repeated request for the same intent re-sends (with the pinned nonce) instead of starting anew. */
export function findOpenIntent(intent: EvidenceIntent): IntentRecord | undefined {
  const key = intentKey(intent);
  const mode = evidenceMode();
  if (mode === "pace_style") return undefined; // stateless: no ledger
  // Baselines: an intent stays open until the wallet has reported its outcome (success or a revert).
  const open = evidenceLayerEnabled()
    ? (r: IntentRecord) => r.state !== "failed" && (r.state !== "confirmed" || !reportedOutcomes.has(r))
    : (r: IntentRecord) => r.baseline?.reported == null;
  return [...evidenceLedger(intent.chainId, intent.sender)].reverse().find((r) => r.key === key && open(r));
}
/** Surface a positively orphaned nonce gap first; otherwise the latest unresolved record, then latest record. */
export function latestIntent(chainId: number, sender: string): IntentRecord | undefined {
  const l = evidenceLedger(chainId, sender);
  const orphan = l.filter((r) => r.state === "orphaned").sort((a, b) => a.pinnedNonce - b.pinnedNonce)[0];
  return orphan ?? [...l].reverse().find(isUnresolved) ?? l[l.length - 1];
}

// ---- evidence ----------------------------------------------------------------------------------------------
async function readEffect(pub: EvidencePublicClient, e: EvidenceEffect | null): Promise<bigint | null> {
  if (!e) return null;
  if (e.kind === "allowance")
    return (await pub.readContract({ address: e.token, abi: ERC20_ABI, functionName: "allowance", args: [e.owner, e.spender], authorizationList: undefined })) as bigint;
  if (e.token.toLowerCase() === NATIVE_TOKEN_ADDRESS) return pub.getBalance({ address: e.holder });
  return (await pub.readContract({ address: e.token, abi: ERC20_ABI, functionName: "balanceOf", args: [e.holder], authorizationList: undefined })) as bigint;
}
function effectSeen(r: IntentRecord, now: bigint | null): boolean {
  const e = r.intent.effect;
  if (!e || now === null) return false;
  if (e.kind === "allowance") return now >= e.amount;
  return r.snapshot.effectBefore !== null && now > BigInt(r.snapshot.effectBefore);
}

/** One observation of every hash of the intent. Read-only. */
export async function observe(pub: EvidencePublicClient, r: IntentRecord, deps: EvidenceDeps = realDeps): Promise<EvidenceObservation> {
  if (isQuorumClient(pub)) return observeQuorum(pub, r, deps);
  let best: { hash: Hex; receipt: any; tx: any } | null = null;
  for (const hash of r.hashes) {
    const [receipt, tx] = await Promise.all([pub.getTransactionReceipt({ hash }).catch(() => null), pub.getTransaction({ hash }).catch(() => null)]);
    const rank = (x: typeof best) => (!x ? 0 : x.receipt?.status === "success" ? 3 : x.receipt ? 2 : x.tx ? 1 : 0);
    const cand = { hash, receipt, tx };
    if (rank(cand) > rank(best)) best = cand;
  }
  const head = Number(await pub.getBlockNumber({ cacheTime: 0 }));
  const nonceLatest = Number(await pub.getTransactionCount({ address: r.intent.sender, blockTag: "latest" }));
  const effectNow = await readEffect(pub, r.intent.effect).catch(() => null);
  const receipt = best?.receipt ?? null;
  const tx = best?.tx ?? null;
  const blockOf = async (n: number) => pub.getBlock({ blockNumber: BigInt(n) }).catch(() => null);
  let canonical: boolean | null = null;
  let included: number | null = null;
  if (receipt) {
    included = Number(receipt.blockNumber);
    const b = await blockOf(included);
    canonical = b ? b.hash === receipt.blockHash && Number(b.number) === included : null;
  } else if (tx?.blockNumber !== null && tx?.blockNumber !== undefined) {
    included = Number(tx.blockNumber);
    const b = await blockOf(included);
    canonical = b ? b.hash === tx.blockHash && Number(b.number) === included : null;
  }
  let orphanEvidence = false;
  if (r.receiptSeen) {
    const b = await blockOf(r.receiptSeen.block);
    orphanEvidence = !!b && Number(b.number) === r.receiptSeen.block && b.hash !== r.receiptSeen.blockHash;
  }
  const balanceEffectSeen = effectSeen(r, effectNow);
  if (orphanEvidence) {
    r.landed = false;
    reportedOutcomes.delete(r);
  }
  const blockHash = receipt?.blockHash ?? tx?.blockHash;
  // Keep the old anchor while an orphaned transaction is still below K on its new branch.
  if (canonical === true && included !== null && blockHash && best?.hash &&
      (!receipt || receipt.status === "success") &&
      (!orphanEvidence || (head - included + 1 >= EVIDENCE_K && balanceEffectSeen))) {
    r.receiptSeen = { hash: best.hash, block: included, blockHash };
  }
  const o: EvidenceObservation = {
    atMs: deps.now(),
    head,
    hash: best?.hash ?? r.hashes[r.hashes.length - 1] ?? null,
    receiptBlock: receipt ? Number(receipt.blockNumber) : null,
    receiptBlockHash: receipt?.blockHash ?? null,
    receiptStatus: receipt ? receipt.status : null,
    txKnown: !!tx,
    txBlock: !receipt && included !== null ? included : null,
    canonical,
    orphanEvidence,
    confirmations: included !== null && canonical === true ? Math.max(0, head - included + 1) : 0,
    nonceLatest,
    balanceEffectSeen,
  };
  if (!r.headSince || r.headSince.head !== head) r.headSince = { head, atMs: o.atMs };
  r.observations.push(o);
  return o;
}

// ---- quorum reads (EVM_EVIDENCE_MODE=full_quorum) ---------------------------------------------------------
// Standard practice, not a new mechanism: multi-provider quorum reads as in ethers' FallbackProvider (quorum mode),
// eRPC's consensus mode and, with stronger (verified) guarantees, the Helios light client. full_quorum applies them
// inside the evidence layer so that a stale or lying read node cannot by itself produce "landed" evidence. Everything
// else (decision table, guard, re-send rule, messages, tx_status, refusal decoding) is the full layer unchanged.
//
// Agreement rule (one observation; N configured read endpoints, quorum q = floor(N/2) + 1, every endpoint weight 1):
//  1. View. Each endpoint reports its head h_i and the hash of its block h_i; an endpoint that errors or does not
//     answer within the stall timeout abstains. Two endpoints i, j with h_i <= h_j are consistent when j's block at
//     height h_i has i's hash (the lower view is a prefix of the higher one). The agreeing set S is the largest set of
//     pairwise-consistent endpoints (ties: the higher maximum head, then lower indices). A quorum exists when
//     |S| >= q, counted against all N configured endpoints (an abstaining endpoint counts against it).
//  2. Most advanced consistent view. The chosen endpoint is the member of S with the highest head (ties: lowest
//     index); the observation's head is its head. A member more than the lag tolerance (default 1 block) below it is
//     recorded as lagging (stale). A lagging member still counts toward the quorum (it agrees with the chosen view's
//     history) but is never asked about anything above its own head.
//  3. Facts. A claim about block B (a receipt in B, a transaction mined in B) is decided by the members that can see B
//     (head >= B): supporters return the same (status, block, block hash); deniers return "not found" or another value.
//     A strict majority of the members whose head reaches B must support or deny the claim; abstentions count
//     against both sides. Otherwise the fact is unresolved (e.g. two endpoints at one head, one shows a receipt and the other says not found). Nonce and
//     balance are read at the chosen head (blockNumber pinned) from the members whose head reaches it; the strict
//     majority value is used, a tie is unresolved. A pending (not mined) transaction known to any member counts as
//     known (it can only lead to "do not send again"). Block hashes for the canonical check come from the chosen
//     endpoint, whose history S already agreed on.
//  4. No quorum, or any unresolved fact: the observation carries no evidence; the decision is wait (reason
//     no_quorum), and after N unresolved rounds ask_user, as for any other unresolved intent. A first send whose
//     nonce read finds no quorum is not sent.
// Differences from ethers v6 FallbackProvider: its default quorum is ceil(total weight / 2), so 1 of 2 providers,
// while here a strict majority is required (2 of 2); its block number tolerates +-1 block between providers and
// otherwise fails quorum, while here a consistent lagging endpoint is outvoted by height (claims above its head are
// decided by the endpoints that can see them); its stallTimeout starts the next provider early, while here every
// endpoint is asked at once and the stall timeout only bounds how long an endpoint may take before it abstains.
// Limitation: with N = 2 and one endpoint lagging, a claim above the lagging head rests on the advanced endpoint
// alone, so an endpoint that lies AND reports a higher head than the honest one is not caught (Helios-style header
// verification would be needed for that).
export const QUORUM_LAG_TOLERANCE = 1; // blocks; ethers' FallbackProvider tolerates +-1 on getBlockNumber
export const QUORUM_STALL_MS = 2_000; // per endpoint read, before it abstains (ethers' default stallTimeout is 400 ms)

export interface QuorumEndpoint {
  /** A label for logs and records (never the URL, which may carry a key). */
  role: string;
  client: EvidencePublicClient;
}
export interface QuorumOptions {
  lagTolerance: number;
  stallMs: number;
}
export interface QuorumSummary {
  ok: boolean;
  /** Why ok is false; null when ok. */
  reason: string | null;
  roles: string[];
  heads: (number | null)[];
  quorum: number;
  members: string[];
  chosen: string | null;
  lagging: string[];
  /** Facts on which members disagreed (resolved by majority, or unresolved when ok is false). */
  disagreements: string[];
}
/** A read client that is N endpoints. Its own methods answer from the chosen endpoint of a fresh view. */
export interface QuorumClient extends EvidencePublicClient {
  readonly quorumEndpoints: readonly QuorumEndpoint[];
  readonly quorumOptions: QuorumOptions;
}
export function isQuorumClient(pub: unknown): pub is QuorumClient {
  return !!pub && Array.isArray((pub as QuorumClient).quorumEndpoints);
}

type Read<T> = { kind: "value"; v: T } | { kind: "null" } | { kind: "abstain" };
const NOT_FOUND = /NotFound|not found|could not be found/i;
/** One endpoint read bounded by the stall timeout; "not found" is an answer, any other error abstains. */
async function bounded<T>(stallMs: number, f: () => Promise<T | null>): Promise<Read<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<Read<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "abstain" }), stallMs);
  });
  const read = (async (): Promise<Read<T>> => {
    try {
      const v = await f();
      return v === null || v === undefined ? { kind: "null" } : { kind: "value", v };
    } catch (e) {
      const text = `${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? ""}`;
      return NOT_FOUND.test(text) ? { kind: "null" } : { kind: "abstain" };
    }
  })();
  try {
    return await Promise.race([read, stall]);
  } finally {
    clearTimeout(timer);
  }
}

interface QuorumView {
  ok: boolean;
  reason: string | null;
  heads: (number | null)[];
  hashes: (Hex | null)[];
  members: number[];
  chosen: number;
  lagging: number[];
}
async function selectView(q: QuorumClient): Promise<QuorumView> {
  const eps = q.quorumEndpoints;
  const { stallMs, lagTolerance } = q.quorumOptions;
  const need = Math.floor(eps.length / 2) + 1;
  const tops = await Promise.all(
    eps.map(async (e) => {
      const h = await bounded(stallMs, async () => Number(await e.client.getBlockNumber({ cacheTime: 0 })));
      if (h.kind !== "value") return null;
      const b = await bounded(stallMs, () => e.client.getBlock({ blockNumber: BigInt(h.v) }));
      return b.kind === "value" && b.v.hash ? { head: h.v, hash: b.v.hash } : null;
    }),
  );
  const heads = tops.map((t) => t?.head ?? null);
  const hashes = tops.map((t) => t?.hash ?? null);
  const live = tops.flatMap((t, i) => (t ? [i] : []));
  // Pairwise consistency: the higher endpoint's block at the lower head has the lower endpoint's hash.
  const consistent = new Map<string, boolean>();
  for (const i of live)
    for (const j of live) {
      if (j <= i) continue;
      const [lo, hi] = heads[i]! <= heads[j]! ? [i, j] : [j, i];
      let same: boolean;
      if (heads[lo] === heads[hi]) same = hashes[lo] === hashes[hi];
      else {
        const b = await bounded(stallMs, () => eps[hi].client.getBlock({ blockNumber: BigInt(heads[lo]!) }));
        same = b.kind === "value" && b.v.hash === hashes[lo] && Number(b.v.number) === heads[lo];
      }
      consistent.set(`${i}|${j}`, same);
    }
  const ok2 = (i: number, j: number) => consistent.get(i < j ? `${i}|${j}` : `${j}|${i}`) === true;
  let best: number[] = [];
  const maxHead = (s: number[]) => Math.max(-1, ...s.map((i) => heads[i]!));
  for (let mask = 1; mask < 1 << live.length; mask++) {
    const s = live.filter((_, k) => mask & (1 << k));
    if (!s.every((i, a) => s.slice(a + 1).every((j) => ok2(i, j)))) continue;
    if (s.length > best.length || (s.length === best.length && maxHead(s) > maxHead(best))) best = s;
  }
  if (best.length < need) {
    const reason =
      live.length < need
        ? `${eps.length - live.length} of ${eps.length} endpoints did not answer`
        : `the endpoints report different blocks at the same height`;
    return { ok: false, reason, heads, hashes, members: best, chosen: -1, lagging: [] };
  }
  const chosen = best.reduce((a, i) => (heads[i]! > heads[a]! ? i : a), best[0]);
  const lagging = best.filter((i) => heads[i]! < heads[chosen]! - lagTolerance);
  return { ok: true, reason: null, heads, hashes, members: best, chosen, lagging };
}

/** Rule 3 for claims about a block: supporters vs deniers among the members whose head reaches the block. */
function agreeOnBlockClaim<T>(
  view: QuorumView,
  reads: Read<T>[],
  blockOf: (v: T) => number | null,
  key: (v: T) => string,
): { value: T | null; disagreed: boolean; unresolved: boolean } {
  const claims = new Map<string, { v: T; block: number; by: number[] }>();
  view.members.forEach((i, k) => {
    const x = reads[k];
    if (x.kind !== "value") return;
    const block = blockOf(x.v);
    if (block === null || view.heads[i]! < block) return;
    const id = key(x.v);
    const c = claims.get(id) ?? { v: x.v, block, by: [] };
    c.by.push(i);
    claims.set(id, c);
  });
  if (!claims.size) {
    const answered = reads.filter((x) => x.kind !== "abstain").length;
    return { value: null, disagreed: false, unresolved: answered * 2 <= view.members.length };
  }
  const accepted: T[] = [];
  let disagreed = false,
    unresolved = false;
  for (const [id, c] of claims) {
    const deniers = view.members.filter((i, k) => {
      const x = reads[k];
      if (view.heads[i]! < c.block || x.kind === "abstain") return false;
      return x.kind === "null" || (blockOf(x.v) === null ? true : key(x.v) !== id);
    }).length;
    if (deniers > 0) disagreed = true;
    const eligible = view.members.filter((i) => view.heads[i]! >= c.block).length;
    if (c.by.length * 2 > eligible) accepted.push(c.v);
    else if (deniers * 2 <= eligible) unresolved = true;
  }
  if (accepted.length > 1) return { value: null, disagreed: true, unresolved: true };
  return { value: accepted[0] ?? null, disagreed, unresolved };
}
/** Rule 3 for state at the chosen head: the strict-majority value among the members whose head reaches it. */
function majorityValue<T>(view: QuorumView, reads: Read<T>[], key: (v: T) => string, at = view.heads[view.chosen]!): { value: T | null; disagreed: boolean; unresolved: boolean } {
  const tally = new Map<string, { v: T; n: number }>();
  const eligible = view.members.filter((i) => view.heads[i]! >= at).length;
  view.members.forEach((i, k) => {
    const x = reads[k];
    if (view.heads[i]! < at || x.kind !== "value") return;
    const id = key(x.v);
    const t = tally.get(id) ?? { v: x.v, n: 0 };
    t.n++;
    tally.set(id, t);
  });
  const top = [...tally.values()].sort((a, b) => b.n - a.n);
  if (!top.length) return { value: null, disagreed: false, unresolved: true };
  return { value: top[0].n * 2 > eligible ? top[0].v : null, disagreed: tally.size > 1, unresolved: top[0].n * 2 <= eligible };
}

async function readEffectAt(pub: EvidencePublicClient, e: EvidenceEffect, at: bigint): Promise<bigint> {
  if (e.kind === "allowance")
    return (await pub.readContract({ address: e.token, abi: ERC20_ABI, functionName: "allowance", args: [e.owner, e.spender], blockNumber: at, authorizationList: undefined })) as bigint;
  if (e.token.toLowerCase() === NATIVE_TOKEN_ADDRESS) return pub.getBalance({ address: e.holder, blockNumber: at });
  return (await pub.readContract({ address: e.token, abi: ERC20_ABI, functionName: "balanceOf", args: [e.holder], blockNumber: at, authorizationList: undefined })) as bigint;
}

/** The latest view's lagging/agreement state, logged to stderr when it changes (a run's logs show what the wallet saw). */
let lastQuorumLog = "";
function logQuorum(s: QuorumSummary) {
  const line = s.ok
    ? `agreed: chosen ${s.chosen}, heads ${s.roles.map((r, i) => `${r}=${s.heads[i] ?? "none"}`).join(" ")}${s.lagging.length ? `; lagging (stale): ${s.lagging.join(",")}` : ""}${s.disagreements.length ? `; outvoted on ${s.disagreements.join(",")}` : ""}`
    : `no quorum (${s.reason}): heads ${s.roles.map((r, i) => `${r}=${s.heads[i] ?? "none"}`).join(" ")}`;
  // Heads advance every block; log only when the agreement itself changes.
  const key = JSON.stringify([s.ok, s.reason, s.chosen, s.members, s.lagging, s.disagreements]);
  if (key === lastQuorumLog) return;
  lastQuorumLog = key;
  console.warn(`[evidence] quorum ${line}`);
}
function summarize(q: QuorumClient, view: QuorumView, disagreements: string[], unresolved: string[]): QuorumSummary {
  const roles = q.quorumEndpoints.map((e) => e.role);
  const ok = view.ok && unresolved.length === 0;
  const s: QuorumSummary = {
    ok,
    reason: !view.ok ? view.reason : unresolved.length ? `no majority on ${unresolved.join(", ")}` : null,
    roles,
    heads: view.heads,
    quorum: Math.floor(roles.length / 2) + 1,
    members: view.members.map((i) => roles[i]),
    chosen: view.ok ? roles[view.chosen] : null,
    lagging: view.lagging.map((i) => roles[i]),
    disagreements,
  };
  logQuorum(s);
  return s;
}

/** observe() for full_quorum: the same observation, built from the agreement rule above. Read-only. */
async function observeQuorum(q: QuorumClient, r: IntentRecord, deps: EvidenceDeps): Promise<EvidenceObservation> {
  const view = await selectView(q);
  const stall = q.quorumOptions.stallMs;
  const prev = r.observations[r.observations.length - 1];
  const blank = (summary: QuorumSummary): EvidenceObservation => {
    const o: EvidenceObservation = {
      atMs: deps.now(),
      head: prev?.head ?? 0,
      hash: r.hashes[r.hashes.length - 1] ?? null,
      receiptBlock: null,
      receiptBlockHash: null,
      receiptStatus: null,
      txKnown: false,
      txBlock: null,
      canonical: null,
      orphanEvidence: false,
      confirmations: 0,
      nonceLatest: r.pinnedNonce,
      balanceEffectSeen: false,
      quorum: summary,
    };
    r.observations.push(o);
    return o;
  };
  if (!view.ok) return blank(summarize(q, view, [], []));
  const members = view.members.map((i) => q.quorumEndpoints[i].client);
  const chosen = q.quorumEndpoints[view.chosen].client;
  const head = view.heads[view.chosen]!;
  const disagreements: string[] = [];
  const unresolved: string[] = [];
  const note = (fact: string, x: { disagreed: boolean; unresolved: boolean }) => {
    if (x.disagreed && !disagreements.includes(fact)) disagreements.push(fact);
    if (x.unresolved && !unresolved.includes(fact)) unresolved.push(fact);
  };
  let best: { hash: Hex; receipt: any; tx: any } | null = null;
  // Per hash: facts disputed without a majority. They are moot when another hash of the intent, sent with the same
  // nonce, has an undisputed success receipt (two transactions with one nonce cannot both execute).
  const disputed: Hex[] = [];
  let settledBy: Hex | null = null;
  for (const hash of r.hashes) {
    const [receipts, txs] = await Promise.all([
      Promise.all(members.map((c) => bounded(stall, () => c.getTransactionReceipt({ hash })))),
      Promise.all(members.map((c) => bounded(stall, () => c.getTransaction({ hash })))),
    ]);
    const rc = agreeOnBlockClaim(view, receipts, (v) => Number(v.blockNumber), (v) => `${v.status}|${v.blockNumber}|${v.blockHash}`);
    note("receipt", { ...rc, unresolved: false });
    const mined = agreeOnBlockClaim(view, txs, (v) => (v.blockNumber === null ? null : Number(v.blockNumber)), (v) => `${v.blockNumber}|${v.blockHash}`);
    note("transaction", { ...mined, unresolved: false });
    if (rc.unresolved || mined.unresolved) disputed.push(hash);
    else if (rc.value?.status === "success" && !rc.disagreed) settledBy = hash;
    const pendingKnown = txs.some((x) => x.kind === "value" && x.v.blockNumber === null);
    const tx = mined.value ?? (pendingKnown ? { blockNumber: null, blockHash: null } : null);
    const rank = (x: typeof best) => (!x ? 0 : x.receipt?.status === "success" ? 3 : x.receipt ? 2 : x.tx ? 1 : 0);
    const cand = { hash, receipt: rc.value, tx };
    if (rank(cand) > rank(best)) best = cand;
  }
  const oneNonce = new Set(r.sentNonces).size <= 1;
  if (disputed.length && !(settledBy && oneNonce)) unresolved.push(`the ${r.intent.label}'s receipt or inclusion`);
  const at = BigInt(head);
  const nonces = await Promise.all(members.map((c, k) => view.heads[view.members[k]]! < head
    ? Promise.resolve({ kind: "abstain" } as Read<number>)
    : bounded(stall, async () => Number(await c.getTransactionCount({ address: r.intent.sender, blockNumber: at })))));
  const nonce = majorityValue(view, nonces, String);
  note("nonce", nonce);
  let effectNow: bigint | null = null;
  if (r.intent.effect) {
    const effect = r.intent.effect;
    const effects = await Promise.all(members.map((c, k) => view.heads[view.members[k]]! < head
      ? Promise.resolve({ kind: "abstain" } as Read<bigint>)
      : bounded(stall, () => readEffectAt(c, effect, at))));
    const e = majorityValue(view, effects, String);
    note("balance", e);
    effectNow = e.value;
  }
  const summary = summarize(q, view, disagreements, unresolved);
  if (!summary.ok) return blank(summary);
  const receipt = best?.receipt ?? null;
  const tx = best?.tx ?? null;
  const blockOf = async (n: number) => chosen.getBlock({ blockNumber: BigInt(n) }).catch(() => null);
  let canonical: boolean | null = null;
  let included: number | null = null;
  if (receipt) {
    included = Number(receipt.blockNumber);
    const b = await blockOf(included);
    canonical = b ? b.hash === receipt.blockHash && Number(b.number) === included : null;
  } else if (tx?.blockNumber !== null && tx?.blockNumber !== undefined) {
    included = Number(tx.blockNumber);
    const b = await blockOf(included);
    canonical = b ? b.hash === tx.blockHash && Number(b.number) === included : null;
  }
  let orphanEvidence = false;
  if (r.receiptSeen && r.receiptSeen.block <= head) {
    const b = await blockOf(r.receiptSeen.block);
    orphanEvidence = !!b && Number(b.number) === r.receiptSeen.block && b.hash !== r.receiptSeen.blockHash;
  }
  const balanceEffectSeen = effectSeen(r, effectNow);
  if (orphanEvidence) {
    r.landed = false;
    reportedOutcomes.delete(r);
  }
  const blockHash = receipt?.blockHash ?? tx?.blockHash;
  // Keep the old anchor while an orphaned transaction is still below K on its new branch.
  if (canonical === true && included !== null && blockHash && best?.hash &&
      (!receipt || receipt.status === "success") &&
      (!orphanEvidence || (head - included + 1 >= EVIDENCE_K && balanceEffectSeen))) {
    r.receiptSeen = { hash: best.hash, block: included, blockHash };
  }
  const o: EvidenceObservation = {
    atMs: deps.now(),
    head,
    hash: best?.hash ?? r.hashes[r.hashes.length - 1] ?? null,
    receiptBlock: receipt ? Number(receipt.blockNumber) : null,
    receiptBlockHash: receipt?.blockHash ?? null,
    receiptStatus: receipt ? receipt.status : null,
    txKnown: !!tx,
    txBlock: !receipt && included !== null ? included : null,
    canonical,
    orphanEvidence,
    confirmations: included !== null && canonical === true ? Math.max(0, head - included + 1) : 0,
    nonceLatest: nonce.value ?? r.pinnedNonce,
    balanceEffectSeen,
    quorum: summary,
  };
  if (!r.headSince || r.headSince.head !== head) r.headSince = { head, atMs: o.atMs };
  r.observations.push(o);
  return o;
}

/** A quorum read client over `endpoints`. Its direct methods (the first send's nonce and snapshot) use a fresh view. */
export function quorumClient(endpoints: QuorumEndpoint[], options: Partial<QuorumOptions> = {}): QuorumClient {
  if (endpoints.length < 2) throw new Error(`full_quorum needs at least 2 read endpoints (got ${endpoints.length})`);
  const q: QuorumClient = {
    quorumEndpoints: endpoints,
    quorumOptions: { lagTolerance: options.lagTolerance ?? QUORUM_LAG_TOLERANCE, stallMs: options.stallMs ?? QUORUM_STALL_MS },
    getTransactionCount: async (a) => state("nonce", (c, at) => c.getTransactionCount(a.blockTag === "pending"
      ? { address: a.address, blockTag: "pending" }
      : { address: a.address, blockNumber: a.blockNumber ?? at }), a.blockNumber),
    getTransaction: async (a) => (await pick()).getTransaction(a),
    getTransactionReceipt: async (a) => (await pick()).getTransactionReceipt(a),
    getBlock: async (a) => (await pick()).getBlock(a),
    getBlockNumber: async (a) => (await pick()).getBlockNumber(a),
    getBalance: async (a) => state("balance", (c, at) => c.getBalance({ ...a, blockNumber: a.blockNumber ?? at }), a.blockNumber),
    readContract: async (a) => state("balance", (c, at) => c.readContract({ ...a, blockNumber: a.blockNumber ?? at }), a.blockNumber),
  };
  async function state<T>(fact: string, read: (c: EvidencePublicClient, at: bigint) => Promise<T>, requested?: bigint): Promise<T> {
    const view = await selectView(q);
    if (!view.ok) { summarize(q, view, [], []); throw unavailable(fact, view.reason); }
    const at = requested ?? BigInt(view.heads[view.chosen]!);
    const values: Read<T>[] = await Promise.all(view.members.map((i) => view.heads[i]! < Number(at)
      ? Promise.resolve({ kind: "abstain" } as Read<T>)
      : bounded(q.quorumOptions.stallMs, () => read(endpoints[i].client, at))));
    const vote = majorityValue(view, values, (v) => String(JSON.stringify(bigintSafe(v))), Number(at));
    summarize(q, view, vote.disagreed ? [fact] : [], vote.unresolved ? [fact] : []);
    if (vote.value === null) throw unavailable(fact);
    return vote.value;
  }
  function unavailable(fact: string, reason: string | null = null) {
    return new EVMError(EVMErrorCode.NETWORK_ERROR,
      `Nothing was sent: the wallet's read endpoints have no majority on ${fact}${reason ? ` (${reason})` : ""}. Wait and try again.`);
  }
  async function pick(): Promise<EvidencePublicClient> {
    const view = await selectView(q);
    summarize(q, view, [], []);
    if (!view.ok)
      throw new EVMError(
        EVMErrorCode.NETWORK_ERROR,
        `Nothing was sent: the wallet's RPC endpoints disagree about the chain (${view.reason}), so the account's state cannot be trusted. Wait and try again.`,
      );
    return endpoints[view.chosen].client;
  }
  return q;
}

let envQuorum: { key: string; client: QuorumClient } | null = null;
/**
 * The client evidence reads go through: unchanged unless EVM_EVIDENCE_MODE=full_quorum, which reads from
 * EVM_EVIDENCE_READ_URLS (comma-separated, N >= 2; roles from EVM_EVIDENCE_READ_ROLES, default read0..readN-1;
 * EVM_EVIDENCE_QUORUM_LAG blocks, EVM_EVIDENCE_QUORUM_STALL_MS). A QuorumClient passed in is used as it is.
 */
export function evidenceReadClient(pub: EvidencePublicClient): EvidencePublicClient {
  if (evidenceMode() !== "full_quorum" || isQuorumClient(pub)) return pub;
  const urls = (process.env.EVM_EVIDENCE_READ_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const roles = (process.env.EVM_EVIDENCE_READ_ROLES ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const lag = Number(process.env.EVM_EVIDENCE_QUORUM_LAG ?? QUORUM_LAG_TOLERANCE);
  const stall = Number(process.env.EVM_EVIDENCE_QUORUM_STALL_MS ?? QUORUM_STALL_MS);
  const key = [urls.join(","), roles.join(","), lag, stall].join("|");
  if (envQuorum?.key === key) return envQuorum.client;
  if (urls.length < 2) throw new Error(`EVM_EVIDENCE_MODE=full_quorum needs EVM_EVIDENCE_READ_URLS with at least 2 endpoints (got ${urls.length})`);
  if (roles.length && roles.length !== urls.length) throw new Error("EVM_EVIDENCE_READ_ROLES must name every read endpoint");
  if (!Number.isInteger(lag) || lag < 0 || !Number.isInteger(stall) || stall <= 0) throw new Error("Bad EVM_EVIDENCE_QUORUM_LAG or EVM_EVIDENCE_QUORUM_STALL_MS");
  const client = quorumClient(
    urls.map((url, i) => ({
      role: roles[i] ?? `read${i}`,
      client: createPublicClient({ transport: http(url, { retryCount: 0, timeout: stall }) }) as unknown as EvidencePublicClient,
    })),
    { lagTolerance: lag, stallMs: stall },
  );
  envQuorum = { key, client };
  announceMode("full_quorum");
  console.warn(`[evidence] quorum endpoints: ${client.quorumEndpoints.map((e) => e.role).join(", ")} (quorum ${Math.floor(urls.length / 2) + 1} of ${urls.length}, lag tolerance ${lag}, stall ${stall} ms)`);
  return client;
}

/** The decision table, applied to the latest observation (and the intent's history). */
export function decide(r: IntentRecord, now: number): { decision: EvidenceDecision; waitReason: WaitReason; state: IntentState } {
  const o = r.observations[r.observations.length - 1];
  if (!o) return { decision: "wait", waitReason: "not_seen", state: "sent" };
  // full_quorum: no majority of the read endpoints agreed, so this observation carries no evidence either way.
  if (o.quorum && !o.quorum.ok) return { decision: "wait", waitReason: "no_quorum", state: "pending" };
  const included = (o.receiptStatus === "success" || o.txBlock !== null) && o.canonical !== false;
  const inclState: IntentState = included ? "included" : o.txKnown ? "pending" : "sent";
  if (o.receiptStatus === "reverted") return { decision: "failed", waitReason: null, state: "failed" };
  const canonicalEffect = o.canonical === true && o.confirmations >= EVIDENCE_K && o.balanceEffectSeen;
  if (o.orphanEvidence && o.canonical !== true) return { decision: "orphaned", waitReason: null, state: "orphaned" };
  if (r.landed) {
    // The node rejected a same-nonce replacement as "nonce too low": the pinned nonce is used. Verify the effect.
    // A lost acknowledgement can leave us with no hash. Do not fabricate a successful receipt identity.
    if (canonicalEffect && r.hashes.length > 0 && (o.receiptStatus === "success" || o.txBlock !== null)) return { decision: "confirmed", waitReason: null, state: "confirmed" };
    return { decision: "landed", waitReason: "no_effect", state: inclState === "sent" ? "pending" : inclState };
  }
  if (o.receiptStatus === "success" && o.canonical !== false) {
    if (o.canonical === true && o.confirmations >= EVIDENCE_K && o.balanceEffectSeen) return { decision: "confirmed", waitReason: null, state: "confirmed" };
    return { decision: "wait", waitReason: o.confirmations < EVIDENCE_K ? "confirmations" : "no_effect", state: "included" };
  }
  if (o.txKnown || o.nonceLatest > r.pinnedNonce) return { decision: "wait_and_recheck", waitReason: null, state: inclState === "sent" ? "pending" : inclState };
  if (r.headSince && now - r.headSince.atMs >= CHECK_BUDGET_MS) return { decision: "wait", waitReason: "stale_head", state: "sent" };
  if (now - r.lastSendAtMs >= CHECK_BUDGET_MS) return { decision: "resend_same_nonce", waitReason: null, state: "dropped" };
  return { decision: "wait", waitReason: "not_seen", state: "sent" };
}

const TERMINAL: readonly EvidenceDecision[] = ["confirmed", "failed", "orphaned", "resend_same_nonce"];
function apply(r: IntentRecord, d: ReturnType<typeof decide>) {
  r.decision = d.decision;
  r.waitReason = d.waitReason;
  r.state = d.state;
}
/** After a check round: "still unresolved after N checks" and "landed, but the effect never appeared" ask the user. */
function closeRound(r: IntentRecord) {
  if (r.decision === "landed" || (r.rounds >= MAX_UNRESOLVED_ROUNDS && !TERMINAL.includes(r.decision))) r.decision = "ask_user";
}

/** One check round (one observation), as tx_status and the guard run it. Read-only. */
export async function checkOnce(pub: EvidencePublicClient, r: IntentRecord, deps: EvidenceDeps = realDeps, countRound = true): Promise<IntentRecord> {
  pub = evidenceReadClient(pub);
  if (countRound) r.rounds++;
  await observe(pub, r, deps);
  const wasConfirmed = r.state === "confirmed";
  const d = decide(r, deps.now());
  // A confirmed intent changes only on positive reorg evidence, never on a (possibly stale) missing read.
  const observation = r.observations[r.observations.length - 1];
  const reorgVisible = observation?.orphanEvidence === true;
  const quorumUnknown = observation?.quorum?.ok === false;
  if (quorumUnknown) reportedOutcomes.delete(r);
  if (!(wasConfirmed && !reorgVisible && !quorumUnknown)) {
    apply(r, d);
    if (countRound) closeRound(r);
  }
  if (countRound && (r.state === "confirmed" || r.state === "failed")) reportedOutcomes.add(r);
  if (countRound) logDecision("check", r, deps);

  return r;
}

// ---- messages ----------------------------------------------------------------------------------------------
/** One plain sentence (or two) built from the decision: what the agent reads. */
export function evidenceMessage(r: IntentRecord): string {
  const what = `Your ${r.intent.label}`;
  const o = r.observations[r.observations.length - 1];
  const hash = o?.hash ?? r.hashes[r.hashes.length - 1];
  const block = o?.receiptBlock ?? o?.txBlock ?? r.receiptSeen?.block;
  const tail = hash ? ` Hash: ${hash}` : "";
  const T = CHECK_BUDGET_MS / 1000;
  switch (r.decision) {
    case "confirmed":
      return `${what} is confirmed in block ${block}.${tail}`;
    case "failed":
      return `${what} was mined in block ${block} but did not succeed; it had no effect.${tail}`;
    case "wait_and_recheck":
      if (o && o.nonceLatest <= r.pinnedNonce && o.receiptBlock === null && o.txBlock === null)
        return `${what} is pending at the node, but has not been observed in a canonical block and its reserved nonce is not confirmed as used. Do not send it again; check its status with tx_status.${tail}`;
      return `${what} was probably included (the account's nonce moved) but its receipt is not visible yet. Do not send it again; check its status with tx_status.${tail}`;
    case "resend_same_nonce":
      return `${what} was not found on chain and the account nonce is unchanged, so it was dropped. Repeating the same ${r.intent.label} is safe: it reuses the same nonce, so at most one can execute.${tail}`;
    case "orphaned":
      return `${what} was observed in block ${r.receiptSeen?.block}, but that block is no longer part of the chain (reorg). The ${r.intent.label} is not on chain now. Repeating the same ${r.intent.label} is safe (same nonce).${tail}`;
    case "landed":
      return `The reserved nonce has been used, but I cannot confirm ${what.toLowerCase()} from canonical transaction evidence yet. Check its status with tx_status.${tail}`;
    case "ask_user": {
      const facts = [
        o?.receiptStatus ? `receipt ${o.receiptStatus} in block ${o.receiptBlock} (${o.confirmations} confirmation${o.confirmations === 1 ? "" : "s"})` : "no receipt visible",
        o ? (o.nonceLatest > r.pinnedNonce ? "the account nonce moved past it" : "the account nonce has not moved") : "nothing observed",
        o?.balanceEffectSeen ? "its balance change is visible" : "its balance change is not visible",
      ];
      return `I could not confirm your ${r.intent.label} after ${r.rounds} checks. Known: ${facts.join("; ")}. Please decide how to proceed before anything else is sent.${tail}`;
    }
    default:
      if (r.waitReason === "no_quorum")
        return `${what} cannot be checked right now: the wallet's RPC endpoints disagree about the chain (${o?.quorum?.reason ?? "no majority"}), so no answer can be trusted yet. Do not send it again; wait and check its status with tx_status.${tail}`;
      if (r.waitReason === "stale_head")
        return `Your node has not advanced for ${T} s; balances read now may be out of date. Wait and check the status again before acting.${tail}`;
      if (r.waitReason === "confirmations")
        return `${what} was included in block ${block} but has ${o?.confirmations ?? 0} of ${EVIDENCE_K} confirmations so far. Do not send it again; check its status with tx_status.${tail}`;
      if (r.waitReason === "no_effect")
        return `${what} was included in block ${block}, but its balance change is not visible yet. Do not send it again; check its status with tx_status.${tail}`;
      return `${what} was sent but is not visible on chain yet. Do not send it again; check its status with tx_status.${tail}`;
  }
}

const bigintSafe = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(bigintSafe) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bigintSafe(x)])) : v;
/** The record without the signer and chain objects, JSON-safe. */
export function evidenceSnapshot(r: IntentRecord): Record<string, unknown> {
  const { account: _a, chain: _c, ...request } = r.request;
  return bigintSafe({ ...r, request, message: evidenceMessage(r) }) as Record<string, unknown>;
}

// ---- decision log (EVM_EVIDENCE_DECISION_LOG=1; logging only) ------------------------------------------------
/** Where a decision reached the agent: the end of a send's check loop, an unacknowledged send, a guard refusal (the
 *  decision of the earlier, unresolved intent), or a tx_status check. */
export type DecisionSite = "send" | "send_unacknowledged" | "guard" | "check";
export const DECISION_LOG_PREFIX = "[evidence-decision] ";
export const DECISION_LOG_VERSION = 1;
export function decisionLogEnabled(): boolean {
  return process.env.EVM_EVIDENCE_DECISION_LOG === "1";
}
/**
 * The logged fields: the decision, the intent key and effect, every hash, and the latest observation (block numbers,
 * block hash, confirmations, wall-clock time). Public chain data only: no signer, request, calldata or message text.
 */
export function decisionLogEntry(site: DecisionSite, r: IntentRecord, atMs: number): Record<string, unknown> {
  const o = r.observations[r.observations.length - 1];
  return bigintSafe({
    v: DECISION_LOG_VERSION,
    site,
    atMs,
    decision: r.decision,
    waitReason: r.waitReason,
    state: r.state,
    key: r.key,
    label: r.intent.label,
    chainId: r.intent.chainId,
    sender: r.intent.sender,
    effect: r.intent.effect,
    pinnedNonce: r.pinnedNonce,
    hashes: r.hashes,
    rounds: r.rounds,
    landed: r.landed,
    receiptSeen: r.receiptSeen,
    observations: r.observations.length,
    lastObservation: o
      ? {
          atMs: o.atMs,
          head: o.head,
          hash: o.hash,
          receiptBlock: o.receiptBlock,
          receiptBlockHash: o.receiptBlockHash,
          receiptStatus: o.receiptStatus,
          txKnown: o.txKnown,
          txBlock: o.txBlock,
          canonical: o.canonical,
          orphanEvidence: o.orphanEvidence,
          confirmations: o.confirmations,
          nonceLatest: o.nonceLatest,
          balanceEffectSeen: o.balanceEffectSeen,
        }
      : null,
  }) as Record<string, unknown>;
}
/** Writes one decision line when EVM_EVIDENCE_DECISION_LOG=1; never throws and never changes the record. */
function logDecision(site: DecisionSite, r: IntentRecord, deps: EvidenceDeps) {
  if (!decisionLogEnabled()) return;
  try {
    process.stderr.write(`${DECISION_LOG_PREFIX}${JSON.stringify(decisionLogEntry(site, r, deps.now()))}\n`);
  } catch {}
}

export type EvidenceErrorCode = "EVIDENCE_PENDING" | "EVIDENCE_UNRESOLVED";
/** An EVMError whose code is one of the layer's codes; `data.evidence` carries the full record. */
export class EvidenceError extends EVMError {
  readonly data: { evidence: Record<string, unknown> };
  constructor(code: EvidenceErrorCode, message: string, record: IntentRecord) {
    super(code as unknown as EVMErrorCode, message);
    this.data = { evidence: evidenceSnapshot(record) };
  }
}

// ---- sending ---------------------------------------------------------------------------------------------
/** "nonce too low" on a same-nonce replacement is landed evidence; "underpriced"/"already known" mean pending. */
export function classifySendError(error: unknown): "landed" | "pending" | "error" {
  const parts: string[] = [];
  for (let e: any = error, i = 0; e && i < 8; e = e.cause, i++) parts.push(String(e.name ?? ""), String(e.message ?? ""), String(e.details ?? ""), String(e.shortMessage ?? ""));
  const text = parts.join(" ");
  if (/NonceTooLowError|nonce too low|lower than the current nonce/i.test(text)) return "landed";
  if (/replacement (transaction )?underpriced|already known|already imported|known transaction/i.test(text)) return "pending";
  return "error";
}

const bump = (x: bigint | undefined) => (x === undefined ? undefined : (x * 9n) / 8n + 1n); // +12.5%, at least the node's 10%
function fees(req: StoredRequest) {
  return req.gasPrice !== undefined && req.maxFeePerGas === undefined
    ? { gasPrice: req.gasPrice }
    : { maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas };
}

/** Recheck reservations before new sends; permit an existing earlier pinned nonce to repair a gap. */
async function guard(pub: EvidencePublicClient, intent: EvidenceIntent, deps: EvidenceDeps, afterDispatch = false) {
  const key = intentKey(intent);
  const ledger = evidenceLedger(intent.chainId, intent.sender);
  const previous = [...ledger].reverse().find((r) => r.key === key);
  // A same-key call after a visible reorg resumes its old nonce, rather than becoming a new operation.
  if (previous?.state === "confirmed") await checkOnce(pub, previous, deps, false);
  const retry = findOpenIntent(intent);
  for (const r of ledger) {
    if (r.key === key) continue;
    // Restoring a lower nonce cannot duplicate a later queued operation; it unblocks its inclusion.
    if (retry && evidenceAblation() !== "no_nonce_pin" && retry.pinnedNonce < r.pinnedNonce) continue;
    if (!isUnresolved(r) && r.state !== "confirmed" && r.state !== "included") continue;
    await checkOnce(pub, r, deps, false);
    if (isUnresolved(r)) {
      const msg =
        evidenceAblation() === "no_grading"
          ? `Transaction failed: an earlier ${r.intent.label} is not settled.`
          : afterDispatch
            ? `Your ${intent.label} was submitted, but an earlier ${r.intent.label} is unresolved: ${evidenceMessage(r)} No further transaction is sent. Check its status with tx_status first.`
            : `An earlier ${r.intent.label} is not resolved yet, so nothing else is sent: ${evidenceMessage(r)} Check its status with tx_status first.`;
      logDecision("guard", r, deps);
      throw new EvidenceError("EVIDENCE_UNRESOLVED", msg, r);
    }
  }
}

export interface SendWithEvidenceResult {
  hash: Hex;
  decision: "confirmed" | "failed";
  /** Null under pace_style, which keeps no state. */
  record: IntentRecord | null;
}

/**
 * Sends `request` for `intent` with the evidence layer: a first send pins the nonce; a repeated request for an
 * open intent re-sends with the pinned nonce and a fee bump. Then checks for up to CHECK_BUDGET_MS.
 * Returns on `confirmed` or `failed` (the caller keeps its revert error); otherwise throws EVIDENCE_PENDING.
 */
export async function sendWithEvidence(o: {
  walletClient: EvidenceWalletClient;
  publicClient: EvidencePublicClient;
  request: { account: any; chain?: any; to: Address; value?: bigint; data?: Hex };
  intent: EvidenceIntent;
  deps?: EvidenceDeps;
  /** pace_style: the call the policy is checked against (a plan redemption's inner call); defaults to `request`. */
  effectiveCall?: { to: Address; value: bigint; data: Hex };
  /** pace_style: the account whose balances the policy reads (the plan account); defaults to the sender. */
  holder?: Address;
}): Promise<SendWithEvidenceResult> {
  const deps = o.deps ?? realDeps;
  const mode = evidenceMode();
  if (!isFullLayer(mode)) {
    if (evidenceAblation() !== "none") throw new Error(`EVM_EVIDENCE_ABLATE applies to the full layer only (mode ${mode})`);
    announceMode(mode);
    if (mode === "nonce_only") return sendNonceOnly(o, deps);
    if (mode === "verify_binary") return sendVerifyBinary(o, deps);
    if (mode === "pace_style") return sendPaceStyle(o);
    throw new Error(`sendWithEvidence called with EVM_EVIDENCE_MODE unset`);
  }
  const ablation = evidenceAblation();
  const pub = evidenceReadClient(o.publicClient);
  const r = await serializeSend(o.intent, async () => {
    await guard(pub, o.intent, deps);
    let r = findOpenIntent(o.intent);
    if (!r) {
      const pinnedNonce = Number(await pub.getTransactionCount({ address: o.intent.sender, blockTag: "pending" }));
      const before = isQuorumClient(pub) ? await readEffect(pub, o.intent.effect) : await readEffect(pub, o.intent.effect).catch(() => null);
      const base = { account: o.request.account, chain: o.request.chain, to: o.request.to, value: o.request.value ?? 0n, data: o.request.data ?? "0x" };
      const prepared = await o.walletClient.prepareTransactionRequest({ ...base, nonce: pinnedNonce });
      const request: StoredRequest = {
        ...base,
        data: base.data as Hex,
        gas: prepared.gas,
        maxFeePerGas: prepared.maxFeePerGas,
        maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
        gasPrice: prepared.maxFeePerGas === undefined ? prepared.gasPrice : undefined,
        type: prepared.type,
      };
      r = {
        key: intentKey(o.intent),
        intent: o.intent,
        pinnedNonce,
        hashes: [],
        sentNonces: [],
        snapshot: { effectBefore: before === null ? null : before.toString() },
        state: "sent",
        decision: "wait",
        waitReason: "not_seen",
        observations: [],
        rounds: 0,
        lastSendAtMs: deps.now(),
        headSince: null,
        receiptSeen: null,
        landed: false,
        request,
      };
      // Reserve before dispatch: an RPC error does not establish that broadcast failed.
      evidenceLedger(o.intent.chainId, o.intent.sender).push(r);
      try {
        const hash = await o.walletClient.sendTransaction({ ...base, nonce: pinnedNonce, gas: request.gas, ...fees(request) });
        r.hashes.push(hash);
        r.sentNonces.push(pinnedNonce);
      } catch {
        r.state = "pending";
        const message = ablation === "no_grading"
          ? "Transaction failed: submission was not acknowledged."
          : `Your ${o.intent.label} could not be acknowledged and may have been submitted. Do not start another transaction; check its status with tx_status. Retrying this same operation keeps its nonce.`;
        logDecision("send_unacknowledged", r, deps);
        throw new EvidenceError("EVIDENCE_PENDING", message, r);
      }
    } else {
      // Re-send rule: same calldata, the pinned nonce (fresh under no_nonce_pin), fees bumped by at least 10%.
      const req = r.request;
      const bumped: StoredRequest = { ...req, maxFeePerGas: bump(req.maxFeePerGas), maxPriorityFeePerGas: bump(req.maxPriorityFeePerGas), gasPrice: bump(req.gasPrice) };
      const nonce = ablation === "no_nonce_pin" ? Number(await pub.getTransactionCount({ address: o.intent.sender, blockTag: "pending" })) : r.pinnedNonce;
      try {
        const hash = await o.walletClient.sendTransaction({
          account: req.account,
          chain: req.chain,
          to: req.to,
          value: req.value,
          data: req.data,
          nonce,
          gas: req.gas,
          ...fees(bumped),
        });
        r.hashes.push(hash);
        r.sentNonces.push(nonce);
        // Accepted replacement: discard nonce-consumption evidence from the orphaned chain.
        r.landed = false;
        r.request = bumped;
        r.lastSendAtMs = deps.now();
        if (r.state === "orphaned" || r.state === "dropped") r.receiptSeen = null;
      } catch (error) {
        const c = classifySendError(error);
        if (c === "error") throw error;
        if (c === "landed") r.landed = true;
        r.request = bumped;
      }
      if (r.state === "orphaned" || r.state === "dropped") r.state = "sent";
    }
    return r;
  });
  // Check loop: poll every CHECK_INTERVAL_MS for at most CHECK_BUDGET_MS; stop early on a decision that ends it.
  r.rounds++;
  const start = deps.now();
  for (;;) {
    await observe(pub, r, deps);
    apply(r, decide(r, deps.now()));
    if (TERMINAL.includes(r.decision) || deps.now() - start >= CHECK_BUDGET_MS) break;
    await deps.sleep(CHECK_INTERVAL_MS);
  }
  // A next-send reorg can fire inside dispatch, after the pre-send guard. A queued transaction above
  // the canonical nonce cannot establish its earlier dependencies: recheck them before returning its
  // result. The existing guard surfaces/reopens a positively orphaned operation; it never resends it.
  const last = r.observations[r.observations.length - 1];
  if (last && last.receiptBlock === null && last.txBlock === null && last.nonceLatest < r.pinnedNonce)
    await guard(pub, r.intent, deps, true);
  closeRound(r);
  logDecision("send", r, deps);
  const hash = (r.observations[r.observations.length - 1]?.hash ?? r.hashes[r.hashes.length - 1]) as Hex;
  if (r.decision === "confirmed" || r.decision === "failed") {
    reportedOutcomes.add(r);
    return { hash, decision: r.decision, record: r };
  }
  if (ablation === "no_grading")
    throw new EvidenceError("EVIDENCE_PENDING", hash ? `Timed out while waiting for transaction with hash "${hash}" to be confirmed.` : "Transaction failed: confirmation could not be established.", r);
  throw new EvidenceError("EVIDENCE_PENDING", evidenceMessage(r), r);
}

// ---- baselines (EVM_EVIDENCE_MODE=nonce_only | verify_binary | pace_style) ---------------------------------
// Each keeps the stock confirmation wait (waitForTransactionReceipt, TX_CONFIRMATION_TIMEOUT_MS) and passes its
// result and errors through unchanged, so the agent reads stock wording; only the stated difference is added.
type SendArgs = Parameters<typeof sendWithEvidence>[0];

/** Written once per process, to stderr, so a run's logs show which send policy the wallet actually used. */
let announced: EvidenceMode | null = null;
function announceMode(mode: EvidenceMode) {
  if (announced === mode) return;
  announced = mode;
  console.warn(`[evidence] EVM_EVIDENCE_MODE=${mode}`);
}

async function stockWait(pub: EvidencePublicClient, hash: Hex) {
  if (!pub.waitForTransactionReceipt) throw new Error("waitForTransactionReceipt is not available on this client");
  return pub.waitForTransactionReceipt({ hash, timeout: TX_CONFIRMATION_TIMEOUT_MS });
}

function baselineRecord(o: SendArgs, mode: BaselineInfo["mode"], pinnedNonce: number, request: StoredRequest, before: bigint | null, deps: EvidenceDeps): IntentRecord {
  return {
    key: intentKey(o.intent),
    intent: o.intent,
    pinnedNonce,
    hashes: [],
    sentNonces: [],
    snapshot: { effectBefore: before === null ? null : before.toString() },
    state: "sent",
    decision: "wait",
    waitReason: "not_seen",
    observations: [],
    rounds: 0,
    lastSendAtMs: deps.now(),
    headSince: null,
    receiptSeen: null,
    landed: false,
    request,
    baseline: { mode, reported: null, consumed: false, nonceGap: null, checks: [] },
  };
}

/** The wallet reports the outcome (stock wording at the call site); the intent is then closed. */
function settle(r: IntentRecord, hash: Hex, status: "success" | "reverted"): SendWithEvidenceResult {
  const b = r.baseline!;
  b.reported = status === "success" ? "success" : "failed";
  b.consumed = true;
  r.state = status === "success" ? "confirmed" : "failed";
  r.decision = status === "success" ? "confirmed" : "failed";
  r.waitReason = null;
  return { hash, decision: r.decision, record: r };
}

/**
 * nonce_only: what a wallet's speed-up or cancel gives. The intent ledger and the same-nonce re-send are those of
 * the full layer (same intent key; the pinned nonce read once; a re-send reuses the stored calldata with fees
 * +12.5%). "nonce too low" on a re-send means an earlier attempt landed and is reported as success. There is no
 * grading, no guard and no refusal decoding: results and errors keep stock's wording.
 * Reservation: a pinned nonce stays reserved for its intent until the wallet observes it consumed (a receipt,
 * "nonce too low", or the account's latest nonce past it). A different intent meanwhile takes the next free nonce
 * (the node's pending count, skipping reserved nonces); a resulting gap is recorded on the record and logged.
 */
async function sendNonceOnly(o: SendArgs, deps: EvidenceDeps): Promise<SendWithEvidenceResult> {
  const pub = o.publicClient;
  const sender = o.intent.sender;
  const step = await serializeSend(o.intent, async (): Promise<{ r: IntentRecord; wait?: Hex; landed?: Hex }> => {
    const open = findOpenIntent(o.intent);
    if (open) {
      const req = open.request;
      const bumped: StoredRequest = { ...req, maxFeePerGas: bump(req.maxFeePerGas), maxPriorityFeePerGas: bump(req.maxPriorityFeePerGas), gasPrice: bump(req.gasPrice) };
      try {
        const hash = await o.walletClient.sendTransaction({
          account: req.account,
          chain: req.chain,
          to: req.to,
          value: req.value,
          data: req.data,
          nonce: open.pinnedNonce,
          gas: req.gas,
          ...fees(bumped),
        });
        open.hashes.push(hash);
        open.sentNonces.push(open.pinnedNonce);
        open.request = bumped;
        open.lastSendAtMs = deps.now();
        return { r: open, wait: hash };
      } catch (error) {
        const c = classifySendError(error);
        const last = open.hashes[open.hashes.length - 1];
        open.request = bumped;
        if (c === "landed") {
          open.landed = true;
          open.baseline!.consumed = true;
          // Success needs a hash to report; with none known (a lost acknowledgement) the stock error stands.
          if (last) return { r: open, landed: last };
        }
        if (c === "pending" && last) return { r: open, wait: last }; // the earlier attempt is still in the pool
        throw error;
      }
    }
    const ledger = evidenceLedger(o.intent.chainId, sender);
    const pendingCount = Number(await pub.getTransactionCount({ address: sender, blockTag: "pending" }));
    const unconsumed = ledger.filter((r) => !r.baseline?.consumed);
    if (unconsumed.length) {
      const latest = Number(await pub.getTransactionCount({ address: sender, blockTag: "latest" }));
      for (const r of unconsumed) if (latest > r.pinnedNonce) r.baseline!.consumed = true;
    }
    const reserved = ledger.filter((r) => !r.baseline?.consumed).map((r) => r.pinnedNonce);
    let nonce = pendingCount;
    while (reserved.includes(nonce)) nonce++;
    const base = { account: o.request.account, chain: o.request.chain, to: o.request.to, value: o.request.value ?? 0n, data: o.request.data ?? "0x" };
    const prepared = await o.walletClient.prepareTransactionRequest({ ...base, nonce });
    const request: StoredRequest = {
      ...base,
      data: base.data as Hex,
      gas: prepared.gas,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
      gasPrice: prepared.maxFeePerGas === undefined ? prepared.gasPrice : undefined,
      type: prepared.type,
    };
    const r = baselineRecord(o, "nonce_only", nonce, request, null, deps);
    if (nonce > pendingCount) {
      const gap = reserved.filter((n) => n >= pendingCount && n < nonce).sort((a, b) => a - b);
      r.baseline!.nonceGap = { nonce, pendingCount, reserved: gap };
      console.warn(`[evidence] nonce gap: ${o.intent.label} sent with nonce ${nonce} while the node's pending count is ${pendingCount}; nonce(s) ${gap.join(", ")} stay reserved for unresolved intents`);
    }
    // Reserve before dispatch, as the full layer does: an RPC error does not establish that broadcast failed.
    ledger.push(r);
    const hash = await o.walletClient.sendTransaction({ ...base, nonce, gas: request.gas, ...fees(request) });
    r.hashes.push(hash);
    r.sentNonces.push(nonce);
    return { r, wait: hash };
  });
  if (step.landed) return settle(step.r, step.landed, "success");
  const receipt = await stockWait(pub, step.wait!);
  return settle(step.r, step.wait!, receipt.status);
}

/**
 * verify_binary (Verified Tool Calls-style verify-before-retry): before re-sending an intent the wallet has not
 * reported, one binary check: "complete" if a receipt with status 1 exists for an earlier hash, or the intent's
 * balance effect is visible against the pre-send snapshot (read through the wallet's RPC); "incomplete" otherwise,
 * including an inconclusive read. Complete: report success, do not send. Incomplete: send again exactly as stock
 * does, with no nonce, so the node picks a fresh one. The confirmation threshold is one receipt (stock's wait).
 */
async function sendVerifyBinary(o: SendArgs, deps: EvidenceDeps): Promise<SendWithEvidenceResult> {
  const pub = o.publicClient;
  const step = await serializeSend(o.intent, async (): Promise<{ r: IntentRecord; wait?: Hex; done?: Hex }> => {
    let r = findOpenIntent(o.intent);
    if (r) {
      const check = await binaryCheck(pub, r, deps);
      r.baseline!.checks.push(check);
      if (check.result === "complete") {
        if (check.hash) return { r, done: check.hash };
        throw new EVMError(EVMErrorCode.INVALID_PARAMS, `The earlier ${r.intent.label} already took effect, so it was not sent again.`);
      }
    } else {
      const before = await readEffect(pub, o.intent.effect).catch(() => null);
      const req = o.request;
      r = baselineRecord(o, "verify_binary", -1, { account: req.account, chain: req.chain, to: req.to, value: req.value ?? 0n, data: (req.data ?? "0x") as Hex, gas: undefined }, before, deps);
      evidenceLedger(o.intent.chainId, o.intent.sender).push(r);
    }
    const hash = await o.walletClient.sendTransaction(o.request);
    r.hashes.push(hash);
    r.lastSendAtMs = deps.now();
    return { r, wait: hash };
  });
  if (step.done) return settle(step.r, step.done, "success");
  const receipt = await stockWait(pub, step.wait!);
  return settle(step.r, step.wait!, receipt.status);
}

/** The binary check of verify_binary. Read-only; any failed read counts as no evidence. */
export async function binaryCheck(pub: EvidencePublicClient, r: IntentRecord, deps: EvidenceDeps = realDeps): Promise<BaselineInfo["checks"][number]> {
  const atMs = deps.now();
  for (const hash of [...r.hashes].reverse()) {
    const receipt = await pub.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt?.status === "success") return { atMs, result: "complete", reason: "receipt with status 1", hash };
  }
  let now: bigint | null;
  try {
    now = await readEffect(pub, r.intent.effect);
  } catch {
    return { atMs, result: "incomplete", reason: "inconclusive: the balance read failed", hash: null };
  }
  if (effectSeen(r, now)) return { atMs, result: "complete", reason: "balance effect visible", hash: r.hashes[r.hashes.length - 1] ?? null };
  if (r.intent.effect && r.intent.effect.kind !== "allowance" && r.snapshot.effectBefore === null)
    return { atMs, result: "incomplete", reason: "inconclusive: no pre-send snapshot", hash: null };
  return { atMs, result: "incomplete", reason: "no receipt and no balance effect", hash: null };
}

/**
 * pace_style's declared policy (`EVM_PACE_POLICY`, JSON): the router, and per token pair (native ETH is the zero
 * address) an optional maximum input, an optional input-token reserve the holder must keep after the call, and an
 * optional minimum output. Raw base units, decimal strings.
 */
export interface PacePolicy {
  router: Address;
  rules: { tokenIn: string; tokenOut: string; maxAmountIn: string | null; keepAtLeastIn: string | null; minAmountOut: string | null }[];
}
export function pacePolicy(): PacePolicy {
  const raw = process.env.EVM_PACE_POLICY;
  if (!raw) throw new Error("EVM_EVIDENCE_MODE=pace_style needs EVM_PACE_POLICY");
  return JSON.parse(raw) as PacePolicy;
}
const lower = (x: string) => x.toLowerCase();
async function heldBy(pub: EvidencePublicClient, token: string, holder: Address): Promise<bigint> {
  if (lower(token) === NATIVE_TOKEN_ADDRESS) return pub.getBalance({ address: holder });
  return (await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [holder], authorizationList: undefined })) as bigint;
}
const shortError = (e: unknown) => {
  const x = e as { shortMessage?: string; details?: string; message?: string };
  return String(x?.details || x?.shortMessage || x?.message || e).split("\n")[0].slice(0, 200);
};

/**
 * PACE-style pre-signing check (a reimplementation of the described design, PACE section 4.4: a pure, stateless
 * function of the call and the head state; PACE's own code is not public). Policy first (target router, token
 * pair, amount bounds, a declared minimum output), then an eth_call simulation of the transaction at the head.
 * Returns null to approve, else the refusal reason. Nothing is remembered between calls.
 */
export async function paceCheck(
  pub: EvidencePublicClient,
  policy: PacePolicy,
  o: { account: unknown; holder: Address; request: { to: Address; value?: bigint; data?: Hex }; effectiveCall: { to: Address; value: bigint; data: Hex } }
): Promise<string | null> {
  const call = o.effectiveCall;
  let swap: { functionName: string; args: readonly unknown[] } | null = null;
  try {
    swap = decodeFunctionData({ abi: ROUTER_ABI, data: call.data });
  } catch {}
  const i = describeCall({ chainId: 0, sender: o.holder, holder: o.holder, ...call });
  if (swap) {
    if (lower(call.to) !== lower(policy.router)) return `the target ${call.to} is not the declared router`;
    const rule = policy.rules.find((x) => lower(x.tokenIn) === lower(i.tokenIn) && lower(x.tokenOut) === lower(i.tokenOut));
    if (!rule) return `the pair ${i.tokenIn} -> ${i.tokenOut} is not declared`;
    if (rule.maxAmountIn !== null && i.amountIn > BigInt(rule.maxAmountIn))
      return `the input ${await tokenAmount(pub, i.tokenIn, i.amountIn)} exceeds the declared maximum ${await tokenAmount(pub, i.tokenIn, BigInt(rule.maxAmountIn))}`;
    if (rule.keepAtLeastIn !== null) {
      const held = await heldBy(pub, i.tokenIn, o.holder);
      if (held - i.amountIn < BigInt(rule.keepAtLeastIn))
        return `spending ${await tokenAmount(pub, i.tokenIn, i.amountIn)} would leave less than the declared ${await tokenAmount(pub, i.tokenIn, BigInt(rule.keepAtLeastIn))}`;
    }
    const minOut = (swap.functionName === "swapExactETHForTokens" ? swap.args[0] : swap.args[1]) as bigint;
    if (minOut <= 0n) return "the call sets no minimum output";
    if (rule.minAmountOut !== null && minOut < BigInt(rule.minAmountOut))
      return `the minimum output ${await tokenAmount(pub, i.tokenOut, minOut)} is below the declared ${await tokenAmount(pub, i.tokenOut, BigInt(rule.minAmountOut))}`;
  } else if (i.label === "token approval") {
    if (lower(i.tokenOut) !== lower(policy.router)) return `the approval spender ${i.tokenOut} is not the declared router`;
    const rule = policy.rules.find((x) => lower(x.tokenIn) === lower(i.tokenIn));
    if (!rule) return `approving ${i.tokenIn} is not declared`;
    if (rule.maxAmountIn !== null && i.amountIn > BigInt(rule.maxAmountIn)) return "the approval exceeds the declared maximum input";
    if (rule.keepAtLeastIn !== null && (await heldBy(pub, i.tokenIn, o.holder)) - i.amountIn < BigInt(rule.keepAtLeastIn))
      return "the approval exceeds what the declared reserve leaves spendable";
  } else return "the call is not a declared operation";
  if (!pub.call) return "the simulation is unavailable";
  try {
    await pub.call({ account: o.account, to: o.request.to, data: o.request.data, value: o.request.value });
  } catch (error) {
    return `the simulation at the head failed (${shortError(error)})`;
  }
  return null;
}

/** pace_style: check, then send and wait exactly as stock does. No nonce pinning, no grading, no state. */
async function sendPaceStyle(o: SendArgs): Promise<SendWithEvidenceResult> {
  const pub = o.publicClient;
  const reason = await paceCheck(pub, pacePolicy(), {
    account: o.request.account,
    holder: o.holder ?? o.intent.sender,
    request: o.request,
    effectiveCall: o.effectiveCall ?? { to: o.request.to, value: o.request.value ?? 0n, data: (o.request.data ?? "0x") as Hex },
  });
  if (reason) throw new EVMError(EVMErrorCode.INVALID_PARAMS, `Refused by the pre-signing check: ${reason}.`);
  const hash = await o.walletClient.sendTransaction(o.request);
  const receipt = await stockWait(pub, hash);
  return { hash, decision: receipt.status === "success" ? "confirmed" : "failed", record: null };
}

// ---- plan refusals ---------------------------------------------------------------------------------------
const DELEGATIONS = parseAbiParameters("(address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)[]");
/** The caveats (terms) of the first delegation in a permission context. */
export function caveatTerms(permissionContext: Hex): Hex[] {
  const [delegations] = decodeAbiParameters(DELEGATIONS, permissionContext) as unknown as [readonly (readonly [Address, Address, Hex, readonly (readonly [Address, Hex, Hex])[], bigint, Hex])[]];
  return (delegations[0]?.[3] ?? []).map((c) => c[1]);
}
const bytesLen = (h: Hex) => (h.length - 2) / 2;
async function tokenAmount(pub: EvidencePublicClient, token: string, raw: bigint): Promise<string> {
  if (token.toLowerCase() === NATIVE_TOKEN_ADDRESS) return `${formatUnits(raw, 18)} ETH`;
  try {
    const [decimals, symbol] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals", authorizationList: undefined }),
      pub.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol", authorizationList: undefined }),
    ]);
    return `${formatUnits(raw, Number(decimals))} ${String(symbol)}`;
  } catch {
    return `${raw} base units of ${token}`;
  }
}
/** Amount and input token of the call the agent asked for, when it is a Uniswap V2 swap or an approval. */
function asked(call: { to: Address; value: bigint; data: Hex }): { token: string; amount: bigint } | null {
  const i = describeCall({ chainId: 0, sender: NATIVE_TOKEN_ADDRESS, holder: NATIVE_TOKEN_ADDRESS, ...call });
  return i.label === "transaction" ? null : { token: i.tokenIn, amount: i.amountIn };
}

/**
 * One sentence that turns an enforcer refusal into the bound the signed step allows, decoded from the step's
 * caveat terms (MetaMask v1.3 ERC20BalanceChange: type(1) token(20) recipient(20) amount(32); AllowedCalldata:
 * startIndex(32) value; BalanceFloor: token(20) min(32)). Null when the reason or terms are not recognised.
 */
export async function decodeRefusalSentence(
  pub: EvidencePublicClient,
  permissionContext: Hex,
  reason: string,
  call: { to: Address; value: bigint; data: Hex }
): Promise<string | null> {
  if (reason.startsWith("PlanStepEnforcer:")) return "This step is not allowed now: prerequisite not done, or already done.";
  const terms = caveatTerms(permissionContext);
  const ask = asked(call);
  if (reason === "ERC20BalanceChangeEnforcer:exceeded-balance-decrease" || reason === "ERC20BalanceChangeEnforcer:insufficient-balance-increase") {
    const decrease = reason.endsWith("decrease");
    const t = terms.find((x) => bytesLen(x) === 73 && Number.parseInt(x.slice(2, 4), 16) === (decrease ? 1 : 0));
    if (!t) return null;
    const token = `0x${t.slice(4, 44)}`;
    const amount = BigInt(`0x${t.slice(84, 148)}`);
    if (!decrease) return `This step must yield at least ${await tokenAmount(pub, token, amount)}.`;
    const askedText = ask && ask.token.toLowerCase() === token.toLowerCase() ? await tokenAmount(pub, token, ask.amount) : null;
    return `This step may spend at most ${await tokenAmount(pub, token, amount)}${askedText ? `; you asked for ${askedText}` : ""}.`;
  }
  if (reason === "AllowedCalldataEnforcer:invalid-calldata") {
    const t = terms.find((x) => bytesLen(x) === 64 && BigInt(x.slice(0, 66)) === 4n);
    if (!t) return null;
    const amount = BigInt(`0x${t.slice(66, 130)}`);
    return `This step only accepts amount ${ask ? await tokenAmount(pub, ask.token, amount) : amount.toString()}.`;
  }
  if (reason.startsWith("BalanceFloorEnforcer:")) {
    const floors = terms.filter((x) => bytesLen(x) === 52);
    if (!floors.length) return null;
    const parts = await Promise.all(floors.map((x) => tokenAmount(pub, `0x${x.slice(2, 42)}`, BigInt(`0x${x.slice(42, 106)}`))));
    return `After this step the account must still hold at least ${parts.join(" and at least ")}.`;
  }
  return null;
}
