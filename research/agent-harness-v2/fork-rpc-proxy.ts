// Copied from the Spartan harness (umututku03/spartan-agent c47d7c3, research/agent-flow-cohorts/fork-rpc-proxy.ts).
// JSON-RPC proxy between the agent (and controls) and the Anvil mainnet fork. It forwards every call,
// journals submitted transactions, and applies the scheduled faults of the active scenario:
//   receipt_hidden:   eth_getTransactionReceipt returns null for the sale tx for HIDE_MS after it mines.
//   price_change_*:   immediately after the sale tx mines, a privileged hook moves the WETH/DAI pool,
//                     before the sale's hash is returned to the caller.
// The sale tx is the first SUCCESSFUL transaction from the agent wallet to the Uniswap V2 router that sends
// native value (v2: any amount, since risk clamps can shrink the 0.1 ETH sale); faults follow that confirmed effect.
// ElizaOS v2 harness change: reset() takes an optional sale-candidate rule, so plan-guard runs, where the sale is
// a DelegationManager redemption that executes the router call, use the same fault trigger.
// WS-R (fault realism): FaultParams.reorgTrigger selects when the emulated reorg fires. "delay" (default, the original
// behaviour) fires on the first proxied call at least reorgDelayMs after the sale receipt was served. "next-send" fires
// immediately before forwarding the agent's next eth_sendRawTransaction once reorgDelayMs has passed since the receipt
// was served; a send that arrives earlier is accepted at once (its hash is returned, as a node does for a pooled
// transaction) and forwarded when the floor is reached, right after the reorg. sale_reorged_reincluded is the same
// reorg, after which the proxy re-submits the orphaned transactions' original raw bytes upstream, so the sale re-mines
// in a later block with the same hash (an orphaned transaction returning from the mempool).
// Workflow tasks (WS-W, tasks-workflows.json): the same rule names the task's CRITICAL transaction instead of the sale
// (A1: the approval of the router; L1: the Aave supply). Every fault, journal field and state name keeps the word "sale"
// and means "the first successful critical transaction"; without a rule the default stays exactly "first sale".
// For the reorg check a task can replace the X balanceOf read with another holder-state read (xBalance.data, e.g.
// the allowance for A1): its value must be restored by the emulated reorg.
// WS-Q (full_quorum): run-v2.ts may start several instances in front of one Anvil; each has its own fault state and
// journal. readCounts() reports the calls an instance served since its last reset (by JSON-RPC method), so the
// verifier can tell that a secondary read endpoint was actually consulted. It is not part of state().
// WS-J (random fault schedules): a Fault may carry a `schedule` (ScheduleEntry list, generated from a seed in run-v2.ts).
// Its kind is then "none", so every branch of the named scenarios above stays inert, and the schedule engine applies the
// entries deterministically. Per target ("critical": the sale/critical transaction; "followup": step 2, recognized by
// fault.followupCandidate), the entries are split, in schedule order, into phases: a drop is a phase of its own and consumes
// the target's next send (never forwarded); a maximal run of hide/stale/reorg entries, ended by a reorg or a drop, binds to
// the target's next send that mines successfully. hide hides that transaction's receipt for windowMs; stale serves every
// read as of (its block - 1) for windowMs; reorg orphans it by the snapshot method above, reorgDelayMs after its receipt was
// served or, when the same phase also hides it or makes reads stale, after the last of those windows ends (trigger "delay"
// or "next-send"; reincluded re-submits the orphans). A phase becomes active only when the previous phase of its target has
// fired (a reorg phase: when its reorg fired). Every fault event carries its entry's faultId and each binding is journalled
// as a fault_armed event, so the verifier can replay the schedule against the journal.
import { createHash } from "node:crypto";
import {
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";

export const HIDE_MS = 200_000; // beyond viem's 180 s default waitForTransactionReceipt timeout

export const LAG_MS = 200_000;
export const REORG_DELAY_MS = 20_000;
export type ReorgTrigger = "delay" | "next-send";
export const REORG_TRIGGER: ReorgTrigger = "delay";
const REORG_KINDS = ["sale_reorged", "sale_reorged_reincluded"];
export type ScheduleEntry = {
  id: number;
  kind: "drop" | "hide" | "stale" | "reorg";
  target: "critical" | "followup";
  windowMs?: number; // hide, stale
  reorgDelayMs?: number; // reorg
  trigger?: ReorgTrigger; // reorg
  reincluded?: boolean; // reorg
};
export type Phase = { entries: ScheduleEntry[]; drop: boolean; reorg: ScheduleEntry | null };
/** Phases of one target, in schedule order (see the header). */
export function schedulePhases(schedule: ScheduleEntry[], target: "critical" | "followup") {
  const phases: Phase[] = [];
  let open: Phase | null = null;
  for (const e of schedule.filter((x) => x.target === target)) {
    if (e.kind === "drop") {
      phases.push({ entries: [e], drop: true, reorg: null });
      open = null;
      continue;
    }
    if (!open) phases.push((open = { entries: [], drop: false, reorg: null }));
    open.entries.push(e);
    if (e.kind === "reorg") {
      open.reorg = e;
      open = null;
    }
  }
  return phases;
}
// ---- Seeded schedule generator (WS-J). Pure; the verifier re-implements it (verify-v2.py generate_schedule) and checks
// every recorded schedule against its seed. Draw i of seed n: the first 8 hex digits of sha256("ws-j-1:<n>:<i>") as an
// integer; a choice among k options takes that integer mod k. Ranges and their grounding:
//   size 1-3 (or --schedule-size); kinds, without repetition per target: critical {drop, hide, stale, reorg}, followup
//   {hide, stale} (control-child-v2.ts cannot recover a dropped or orphaned step 2, so neither is drawn for it);
//   hide/stale windows {12, 30, 60, 120, 200} s (one slot; ~2.5 slots; the wallet's 60 s confirmation timeout; twice it;
//   the original 200 s, beyond viem's 180 s default), restricted to {12, 30, 60, 120} s on the critical transaction when the
//   schedule also has a reorg (so the reorg's clock starts while a client is still waiting); reorg delay {12, 24} s (one
//   or two mainnet slots: observed post-merge reorgs are 1-2 blocks deep); trigger {delay, next-send}; reincluded {no, yes}.
export const SCHEDULE_VERSION = "ws-j-1";
export const SCHEDULE_WINDOWS_S = [12, 30, 60, 120, 200];
export const SCHEDULE_WINDOWS_WITH_REORG_S = [12, 30, 60, 120];
export const SCHEDULE_REORG_DELAYS_S = [12, 24];
export function generateSchedule(seed: number, size?: number) {
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`Bad schedule seed ${seed}`);
  if (size !== undefined && ![1, 2, 3].includes(size)) throw new Error(`Bad schedule size ${size}`);
  let i = 0;
  const draw = (k: number) =>
    parseInt(createHash("sha256").update(`${SCHEDULE_VERSION}:${seed}:${i++}`).digest("hex").slice(0, 8), 16) % k;
  const n = size ?? 1 + draw(3);
  const pairs: [ScheduleEntry["target"], ScheduleEntry["kind"]][] = [
    ["critical", "drop"],
    ["critical", "hide"],
    ["critical", "stale"],
    ["critical", "reorg"],
    ["followup", "hide"],
    ["followup", "stale"],
  ];
  const picked: [ScheduleEntry["target"], ScheduleEntry["kind"]][] = [];
  for (let k = 0; k < n; k++) {
    const left = pairs.filter((p) => !picked.some((q) => q[0] === p[0] && q[1] === p[1]));
    picked.push(left[draw(left.length)]);
  }
  const hasReorg = picked.some((p) => p[1] === "reorg");
  const entries: ScheduleEntry[] = picked.map(([target, kind], id) => {
    if (kind === "drop") return { id, kind, target };
    if (kind === "reorg")
      return {
        id,
        kind,
        target,
        reorgDelayMs: SCHEDULE_REORG_DELAYS_S[draw(2)] * 1000,
        trigger: (["delay", "next-send"] as const)[draw(2)],
        reincluded: draw(2) === 1,
      };
    const w = target === "critical" && hasReorg ? SCHEDULE_WINDOWS_WITH_REORG_S : SCHEDULE_WINDOWS_S;
    return { id, kind, target, windowMs: w[draw(w.length)] * 1000 };
  });
  return { version: SCHEDULE_VERSION, seed, size: n, entries };
}
export type Fault = {
  kind:
    | "none"
    | "receipt_hidden"
    | "price_move"
    | "sale_dropped"
    | "rpc_stale"
    | "sale_reorged"
    | "sale_reorged_reincluded";
  xBalance?: { token: string; wallet: string; data?: Hex };
  onSaleMined?: () => Promise<any>;
  schedule?: ScheduleEntry[];
  followupCandidate?: SaleCandidate;
};
export type FaultParams = {
  lagMs: number;
  reorgDelayMs: number;
  hideMs: number;
  reorgTrigger: ReorgTrigger;
};
const DEFAULT_PARAMS: FaultParams = {
  lagMs: LAG_MS,
  reorgDelayMs: REORG_DELAY_MS,
  hideMs: HIDE_MS,
  reorgTrigger: REORG_TRIGGER,
};
export type SaleCandidate = (tx: {
  from: string;
  to: string;
  value: bigint;
  data: Hex;
}) => boolean;

export class ForkRpcProxy {
  journal: any[] = [];
  private server: any;
  private fault: Fault = { kind: "none" };
  private wallet = "";
  private router = "";
  private saleCandidate: SaleCandidate | null = null;
  private saleHash: string | null = null;
  private hiddenUntil = 0;
  private saleHookResult: any = null;
  private id = 0;
  private dropped: any = null;
  private lagBlock: number | null = null;
  private lagUntil = 0;
  private saleBlock: number | null = null;
  private preSaleSnap: string | null = null;
  private preSaleX: string | null = null;
  private oldSaleBlockHash: string | null = null;
  private receiptServedAt = 0;
  private reorg: any = null;
  private queue: Promise<unknown> = Promise.resolve();
  private deferred: Promise<unknown> = Promise.resolve();
  private raw = new Map<string, Hex>(); // forwarded raw transactions by hash (re-inclusion after a reorg)
  private params: FaultParams = { ...DEFAULT_PARAMS };
  private reads: Record<string, number> = {};
  // Schedule engine state (null unless fault.schedule is set).
  private sched: {
    phases: Record<"critical" | "followup", Phase[]>;
    cursor: Record<"critical" | "followup", number>;
    hidden: Map<string, { until: number; faultId: number }>;
    lagFault: number | null;
    reorg: { entry: ScheduleEntry; hash: string; block: number; blockHash: string; windowsEnd: number } | null;
    snapTaken: boolean;
  } | null = null;

  constructor(
    public anvilUrl: string,
    public port: number,
  ) {}

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  reset(
    wallet: string,
    router: string,
    fault: Fault,
    saleCandidate?: SaleCandidate,
    params?: Partial<FaultParams>,
  ) {
    this.params = { ...DEFAULT_PARAMS, ...(params ?? {}) };
    this.wallet = wallet.toLowerCase();
    this.router = router.toLowerCase();
    this.fault = fault;
    this.journal = [];
    this.saleCandidate = saleCandidate ?? null;
    this.saleHash = null;
    this.hiddenUntil = 0;
    this.saleHookResult = null;
    this.dropped = null;
    this.lagBlock = null;
    this.lagUntil = 0;
    this.saleBlock = null;
    this.preSaleSnap = null;
    this.preSaleX = null;
    this.oldSaleBlockHash = null;
    this.receiptServedAt = 0;
    this.reorg = null;
    this.queue = Promise.resolve();
    this.deferred = Promise.resolve();
    this.raw = new Map();
    this.reads = {};
    this.sched = fault.schedule
      ? {
          phases: {
            critical: schedulePhases(fault.schedule, "critical"),
            followup: schedulePhases(fault.schedule, "followup"),
          },
          cursor: { critical: 0, followup: 0 },
          hidden: new Map(),
          lagFault: null,
          reorg: null,
          snapTaken: false,
        }
      : null;
  }

  /** Schedule mode: when the bound reorg's clock started (0 if not yet), its delay and trigger; null without one. */
  private schedReorgClock() {
    const r = this.sched?.reorg;
    if (!r) return null;
    return {
      start: r.windowsEnd || this.receiptServedAt,
      delay: r.entry.reorgDelayMs!,
      trigger: r.entry.trigger!,
      from: r.windowsEnd ? "windows_end" : "receipt_served",
    };
  }

  readCounts() {
    return { ...this.reads };
  }

  /** Resolves once every deferred send (next-send trigger) has been forwarded and recorded. */
  async settle() {
    await this.deferred.catch(() => {});
    await this.queue.catch(() => {});
  }

  private get reorgKind() {
    return REORG_KINDS.includes(this.fault.kind);
  }

  state() {
    return {
      saleHash: this.saleHash,
      hiddenUntil: this.hiddenUntil,
      saleHookResult: this.saleHookResult,
      fault: this.fault.kind,
      dropped: this.dropped,
      lagBlock: this.lagBlock,
      lagUntil: this.lagUntil,
      saleBlock: this.saleBlock,
      receiptServedAt: this.receiptServedAt,
      reorg: this.reorg,
      ...(this.sched
        ? (() => {
            const c = this.schedReorgClock();
            return {
              scheduleCursor: { ...this.sched.cursor },
              reorgFloor: c && c.start && !this.reorg ? c.start + c.delay : null,
              reorgTrigger: c ? c.trigger : null,
            };
          })()
        : {}),
    };
  }

  private async upstream(payload: any) {
    const r = await fetch(this.anvilUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.json();
  }

  private async rpc(method: string, params: any[] = []) {
    const r: any = await this.upstream({
      jsonrpc: "2.0",
      id: ++this.id,
      method,
      params,
    });
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  }

  private async xBalance() {
    const config = this.fault.xBalance;
    if (!config)
      throw new Error("Reorg requires holder X balance configuration");
    return this.rpc("eth_call", [
      {
        to: config.token,
        data:
          config.data ?? `0x70a08231${config.wallet.slice(2).padStart(64, "0")}`,
      },
      "latest",
    ]);
  }

  private async maybeReorg(call: any) {
    const sc = this.schedReorgClock();
    if (sc) {
      if (
        this.reorg ||
        !sc.start ||
        Date.now() < sc.start + sc.delay ||
        (sc.trigger === "next-send" && call.method !== "eth_sendRawTransaction")
      )
        return;
    } else if (
      !this.reorgKind ||
      this.reorg ||
      !this.receiptServedAt ||
      Date.now() < this.receiptServedAt + this.params.reorgDelayMs ||
      (this.params.reorgTrigger === "next-send" &&
        call.method !== "eth_sendRawTransaction")
    )
      return;
    // The orphaned instance: the first sale, or (schedule mode) the critical transaction the reorg entry bound to.
    const sr = this.sched?.reorg;
    const saleHash = sr ? sr.hash : this.saleHash;
    const saleBlock = sr ? sr.block : this.saleBlock;
    const oldSaleBlockHash = sr ? sr.blockHash : this.oldSaleBlockHash;
    const reincludes = sr ? !!sr.entry.reincluded : this.fault.kind === "sale_reorged_reincluded";
    const h = Number(await this.rpc("eth_blockNumber"));
    const depth = h - saleBlock! + 1;
    const droppedHashes: string[] = [];
    for (const send of this.journal.filter(
      (j) => j.event === "send" && j.hash,
    )) {
      const r = await this.rpc("eth_getTransactionReceipt", [send.hash]);
      if (r && Number(r.blockNumber) >= saleBlock!)
        droppedHashes.push(send.hash);
    }
    if (!(await this.rpc("evm_revert", [this.preSaleSnap])))
      throw new Error("Pre-sale snapshot revert failed");
    await this.rpc("anvil_mine", [depth]);
    const receipt = await this.rpc("eth_getTransactionReceipt", [
      saleHash,
    ]);
    const block = await this.rpc("eth_getBlockByNumber", [
      `0x${saleBlock!.toString(16)}`,
      false,
    ]);
    const pool = await this.rpc("txpool_status");
    const restoredX = await this.xBalance();
    const restoredHead = Number(await this.rpc("eth_blockNumber"));
    if (
      receipt !== null ||
      block.hash === oldSaleBlockHash ||
      Number(pool.pending) ||
      Number(pool.queued) ||
      BigInt(restoredX) !== BigInt(this.preSaleX!)
    )
      throw new Error("Emulated reorg verification failed");
    // Re-inclusion: every orphaned transaction returns from the mempool, in its original order, so the sale (and any
    // later orphan) re-mines with the same hash in a block after the replacement blocks.
    let reincluded: any = null;
    const reincludedOthers: any[] = [];
    if (reincludes) {
      for (const orphan of droppedHashes) {
        const raw = this.raw.get(orphan);
        if (!raw) throw new Error(`No raw transaction to re-include for ${orphan}`);
        const sent: any = await this.upstream({
          jsonrpc: "2.0",
          id: ++this.id,
          method: "eth_sendRawTransaction",
          params: [raw],
        });
        let r: any = null;
        for (let i = 0; i < 200 && !r; i++) {
          r = await this.rpc("eth_getTransactionReceipt", [orphan]);
          if (!r) await Bun.sleep(50);
        }
        const rec = {
          hash: orphan,
          block: r ? Number(r.blockNumber) : null,
          status: r?.status ?? null,
          blockHash: r?.blockHash ?? null,
          error: sent?.error ?? null,
        };
        if (orphan === saleHash) reincluded = rec;
        else reincludedOthers.push(rec);
      }
      if (!reincluded || reincluded.status !== "0x1")
        throw new Error("Re-inclusion of the orphaned sale failed");
    }
    this.reorg = {
      at: Date.now(),
      event: "chain_reorg",
      method: "snapshot_revert",
      trigger: this.params.reorgTrigger,
      triggerMethod: call.method,
      depth,
      oldHead: h,
      saleBlock: saleBlock,
      oldSaleBlockHash: oldSaleBlockHash,
      newSaleBlockHash: block.hash,
      saleHash: saleHash,
      droppedHashes,
      receipt,
      preSaleX: this.preSaleX,
      restoredX,
      pool,
      restoredHead,
      receiptServedAt: this.receiptServedAt,
      ...(reincludes
        ? { reincluded, reincludedOthers }
        : {}),
      ...(sr && sc
        ? { faultId: sr.entry.id, trigger: sc.trigger, reorgDelayMs: sc.delay, clockFrom: sc.from, clockStart: sc.start }
        : {}),
    };
    this.journal.push(this.reorg);
    if (sr) this.sched!.cursor.critical++; // the reorg phase fired: the next critical phase becomes active
  }

  private lagTag() {
    return this.sched && this.sched.lagFault !== null ? { faultId: this.sched.lagFault } : {};
  }

  private async read(call: any) {
    let request = call;
    let stale = false;
    if (this.lagBlock !== null && Date.now() < this.lagUntil) {
      const hex = `0x${this.lagBlock.toString(16)}`;
      const indices: Record<string, number> = {
        eth_getBalance: 1,
        eth_call: 1,
        eth_getTransactionCount: 1,
        eth_getCode: 1,
        eth_getStorageAt: 2,
        eth_getBlockByNumber: 0,
        eth_estimateGas: 1,
      };
      if (call.method === "eth_blockNumber") {
        this.journal.push({
          at: Date.now(),
          event: "stale_read",
          method: call.method,
          servedBlock: this.lagBlock,
          ...this.lagTag(),
        });
        return { jsonrpc: "2.0", id: call.id, result: hex };
      }
      const index = indices[call.method];
      if (index !== undefined) {
        const params = [...(call.params ?? [])];
        const tag = params[index];
        if (
          call.method === "eth_estimateGas" ||
          tag === undefined ||
          tag === "latest" ||
          tag === "pending" ||
          (typeof tag === "string" &&
            /^0x[0-9a-f]+$/i.test(tag) &&
            Number(tag) > this.lagBlock)
        ) {
          params[index] = hex;
          request = { ...call, params };
          stale = true;
        }
      }
      if (
        call.method === "eth_getTransactionReceipt" ||
        call.method === "eth_getTransactionByHash"
      ) {
        const r: any = await this.upstream(call);
        if (
          r.result?.blockNumber &&
          Number(r.result.blockNumber) > this.lagBlock
        ) {
          this.journal.push({
            at: Date.now(),
            event: "stale_read",
            method: call.method,
            servedBlock: this.lagBlock,
            ...this.lagTag(),
          });
          return { ...r, result: null };
        }
        return r;
      }
    }
    if (stale)
      this.journal.push({
        at: Date.now(),
        event: "stale_read",
        method: call.method,
        servedBlock: this.lagBlock,
        ...this.lagTag(),
      });
    const result: any = await this.upstream(request);
    if (
      this.sched?.reorg &&
      !this.receiptServedAt &&
      call.method === "eth_getTransactionReceipt" &&
      String(call.params?.[0]).toLowerCase() === this.sched.reorg.hash &&
      result.result?.status === "0x1"
    )
      this.receiptServedAt = Date.now();
    if (
      this.reorgKind &&
      !this.receiptServedAt &&
      call.method === "eth_getTransactionReceipt" &&
      String(call.params?.[0]).toLowerCase() === this.saleHash &&
      result.result?.status === "0x1"
    )
      this.receiptServedAt = Date.now();
    return result;
  }

  private async handle(call: any) {
    this.reads[call.method] = (this.reads[call.method] ?? 0) + 1;
    await this.maybeReorg(call);
    if (this.sched) return this.handleScheduled(call);
    if (
      call.method === "eth_getTransactionReceipt" &&
      this.saleHash &&
      String(call.params?.[0]).toLowerCase() === this.saleHash &&
      Date.now() < this.hiddenUntil
    ) {
      this.journal.push({
        at: Date.now(),
        event: "receipt_hidden",
        hash: this.saleHash,
      });
      return { jsonrpc: "2.0", id: call.id, result: null };
    }
    if (call.method !== "eth_sendRawTransaction") return this.read(call);
    const rawTx = call.params[0] as Hex;
    let from = "",
      to = "",
      value = "0",
      data: Hex = "0x";
    try {
      const tx: any = parseTransaction(rawTx);
      from = (
        await recoverTransactionAddress({ serializedTransaction: rawTx as any })
      ).toLowerCase();
      to = String(tx.to ?? "").toLowerCase();
      value = String(tx.value ?? 0n);
      data = (tx.data ?? "0x") as Hex;
    } catch {}
    const candidate = this.saleCandidate
      ? this.saleCandidate({ from, to, value: BigInt(value), data })
      : from === this.wallet && to === this.router && BigInt(value) > 0n;
    if (candidate && this.fault.kind === "sale_dropped" && !this.dropped) {
      const hash = keccak256(rawTx).toLowerCase();
      this.dropped = {
        at: Date.now(),
        event: "dropped_send",
        hash,
        from,
        to,
        value,
      };
      this.journal.push(
        {
          at: Date.now(),
          event: "send",
          from,
          to,
          value,
          data,
          candidate,
          hash,
          dropped: true,
          error: null,
        },
        this.dropped,
      );
      return { jsonrpc: "2.0", id: call.id, result: hash };
    }
    if (candidate && this.reorgKind && !this.preSaleSnap) {
      this.preSaleX = await this.xBalance();
      this.preSaleSnap = await this.rpc("evm_snapshot");
    }
    const { deferredFrom: _, ...request } = call;
    const result = await this.upstream(request);
    const hash = result?.result as string | undefined;
    if (hash && this.reorgKind) this.raw.set(hash.toLowerCase(), rawTx);
    const entry: any = {
      at: Date.now(),
      event: "send",
      from,
      to,
      value,
      data,
      candidate,
      hash: hash?.toLowerCase() ?? null,
      error: result?.error ?? null,
      ...(call.deferredFrom ? { deferredFrom: call.deferredFrom } : {}),
    };
    this.journal.push(entry);
    let mined: any = null;
    if (hash && candidate && !this.saleHash) {
      // Anvil can return the hash just before the receipt is queryable: poll briefly (up to 10 s).
      for (let i = 0; i < 200 && !mined; i++) {
        mined =
          (
            await this.upstream({
              jsonrpc: "2.0",
              id: `sale-check-${++this.id}`,
              method: "eth_getTransactionReceipt",
              params: [hash],
            })
          )?.result ?? null;
        if (!mined) await Bun.sleep(50);
      }
      entry.saleCandidateReceiptStatus =
        mined?.status ?? "not_mined_within_10s";
    }
    const isSale = mined?.status === "0x1";
    if (isSale) {
      this.saleHash = hash!.toLowerCase();
      entry.sale = true;
      this.saleBlock = Number(mined.blockNumber);
      entry.saleBlock = this.saleBlock;
      this.oldSaleBlockHash = mined.blockHash;
      if (this.fault.kind === "rpc_stale") {
        this.lagBlock = this.saleBlock - 1;
        this.lagUntil = Date.now() + this.params.lagMs;
        entry.lagBlock = this.lagBlock;
      }
      if (this.fault.kind === "receipt_hidden") {
        this.hiddenUntil = Date.now() + this.params.hideMs;
        entry.hiddenUntil = this.hiddenUntil;
      }
      if (this.fault.kind === "price_move" && this.fault.onSaleMined) {
        this.saleHookResult = await this.fault.onSaleMined(); // runs before the hash is returned
        this.journal.push({
          at: Date.now(),
          event: "scheduled_market_change",
          result: this.saleHookResult,
        });
      }
    }
    return result;
  }

  /** Schedule mode (fault.schedule): receipt hiding per bound hash, drops and phase binding on sends. */
  private async handleScheduled(call: any) {
    const sc = this.sched!;
    if (call.method === "eth_getTransactionReceipt") {
      const h = String(call.params?.[0]).toLowerCase();
      const hid = sc.hidden.get(h);
      if (hid && Date.now() < hid.until) {
        this.journal.push({ at: Date.now(), event: "receipt_hidden", hash: h, faultId: hid.faultId });
        return { jsonrpc: "2.0", id: call.id, result: null };
      }
    }
    if (call.method !== "eth_sendRawTransaction") return this.read(call);
    const rawTx = call.params[0] as Hex;
    let from = "",
      to = "",
      value = "0",
      data: Hex = "0x";
    try {
      const tx: any = parseTransaction(rawTx);
      from = (
        await recoverTransactionAddress({ serializedTransaction: rawTx as any })
      ).toLowerCase();
      to = String(tx.to ?? "").toLowerCase();
      value = String(tx.value ?? 0n);
      data = (tx.data ?? "0x") as Hex;
    } catch {}
    const fields = { from, to, value: BigInt(value), data };
    const candidate = this.saleCandidate
      ? this.saleCandidate(fields)
      : from === this.wallet && to === this.router && BigInt(value) > 0n;
    const followup = !candidate && !!this.fault.followupCandidate?.(fields);
    const target: "critical" | "followup" | null = candidate ? "critical" : followup ? "followup" : null;
    // A bound reorg phase stays current until its reorg fires; it binds once, so meanwhile no critical phase is active.
    const pending = target === "critical" && !!sc.reorg && !this.reorg;
    const phase = target && !pending ? sc.phases[target][sc.cursor[target]] : undefined;
    const hash = keccak256(rawTx).toLowerCase();
    if (phase?.drop) {
      const e = phase.entries[0];
      const dropped = { at: Date.now(), event: "dropped_send", hash, from, to, value, faultId: e.id, target };
      if (target === "critical" && !this.dropped) this.dropped = dropped;
      this.journal.push(
        { at: Date.now(), event: "send", from, to, value, data, candidate, followup, hash, dropped: true, error: null },
        dropped,
      );
      sc.cursor[target!]++;
      return { jsonrpc: "2.0", id: call.id, result: hash };
    }
    // A reorg phase snapshots the chain before the first send that may bind it.
    if (target === "critical" && phase?.reorg && !sc.snapTaken) {
      this.preSaleX = await this.xBalance();
      this.preSaleSnap = await this.rpc("evm_snapshot");
      sc.snapTaken = true;
    }
    const { deferredFrom: _, ...request } = call;
    const result = await this.upstream(request);
    const sent = (result?.result as string | undefined)?.toLowerCase();
    if (sent) this.raw.set(sent, rawTx);
    const entry: any = {
      at: Date.now(),
      event: "send",
      from,
      to,
      value,
      data,
      candidate,
      followup,
      hash: sent ?? null,
      error: result?.error ?? null,
      ...(call.deferredFrom ? { deferredFrom: call.deferredFrom } : {}),
    };
    this.journal.push(entry);
    // Poll the receipt of every target send (up to 10 s), so the first successful one is known.
    let mined: any = null;
    if (sent && target && (phase || (target === "critical" && !this.saleHash))) {
      for (let i = 0; i < 200 && !mined; i++) {
        mined =
          (
            await this.upstream({
              jsonrpc: "2.0",
              id: `sale-check-${++this.id}`,
              method: "eth_getTransactionReceipt",
              params: [sent],
            })
          )?.result ?? null;
        if (!mined) await Bun.sleep(50);
      }
      entry.receiptStatus = mined?.status ?? "not_mined_within_10s";
      if (mined) entry.minedBlock = Number(mined.blockNumber);
    }
    if (mined?.status !== "0x1") return result;
    if (target === "critical" && !this.saleHash) {
      this.saleHash = sent!;
      entry.sale = true;
      this.saleBlock = Number(mined.blockNumber);
      entry.saleBlock = this.saleBlock;
      this.oldSaleBlockHash = mined.blockHash;
    }
    if (!phase) return result;
    // Bind the active phase to this mined transaction.
    const block = Number(mined.blockNumber);
    const now = Date.now();
    let windowsEnd = 0;
    for (const e of phase.entries) {
      const armed: any = { at: now, event: "fault_armed", faultId: e.id, kind: e.kind, target, hash: sent, block };
      if (e.kind === "hide") {
        armed.until = now + e.windowMs!;
        sc.hidden.set(sent!, { until: armed.until, faultId: e.id });
        windowsEnd = Math.max(windowsEnd, armed.until);
      } else if (e.kind === "stale") {
        armed.until = now + e.windowMs!;
        armed.lagBlock = block - 1;
        this.lagBlock = block - 1;
        this.lagUntil = armed.until;
        sc.lagFault = e.id;
        windowsEnd = Math.max(windowsEnd, armed.until);
      }
      this.journal.push(armed);
    }
    if (phase.reorg) {
      sc.reorg = { entry: phase.reorg, hash: sent!, block, blockHash: mined.blockHash, windowsEnd };
    } else sc.cursor[target!]++;
    return result;
  }

  start() {
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      idleTimeout: 255,
      fetch: async (req) => {
        const payload = await req.json();
        // Serialize new-fault calls, including batch members, so snapshots and one-shot triggers cannot race.
        const enqueue = (c: any) => {
          const result = this.queue.then(() => this.handle(c));
          this.queue = result.catch(() => {});
          return result;
        };
        const dispatch = (c: any) => {
          if (
            !this.sched &&
            ![
              "sale_dropped",
              "rpc_stale",
              "sale_reorged",
              "sale_reorged_reincluded",
            ].includes(this.fault.kind)
          )
            return this.handle(c);
          // Schedule mode: the same deferral, from the bound reorg's clock and trigger.
          const sc = this.schedReorgClock();
          if (
            sc &&
            sc.trigger === "next-send" &&
            c?.method === "eth_sendRawTransaction" &&
            sc.start &&
            !this.reorg &&
            Date.now() < sc.start + sc.delay
          ) {
            const floor = sc.start + sc.delay;
            const hash = keccak256(c.params[0] as Hex).toLowerCase();
            const note = { at: Date.now(), event: "deferred_send", hash, forwardAt: floor };
            this.journal.push(note);
            this.deferred = this.deferred.then(async () => {
              if (floor > Date.now()) await Bun.sleep(floor - Date.now());
              await enqueue({ ...c, deferredFrom: note.at }).catch(() => {});
            });
            return Promise.resolve({ jsonrpc: "2.0", id: c.id, result: hash });
          }
          // next-send trigger: a send that arrives after the sale receipt was served but before the floor is pooled:
          // its hash is returned now and it is forwarded (in arrival order) at the floor, after the reorg it triggers.
          const floor = this.receiptServedAt + this.params.reorgDelayMs;
          if (
            this.reorgKind &&
            this.params.reorgTrigger === "next-send" &&
            c?.method === "eth_sendRawTransaction" &&
            this.receiptServedAt &&
            !this.reorg &&
            Date.now() < floor
          ) {
            const hash = keccak256(c.params[0] as Hex).toLowerCase();
            const note = {
              at: Date.now(),
              event: "deferred_send",
              hash,
              forwardAt: floor,
            };
            this.journal.push(note);
            this.deferred = this.deferred.then(async () => {
              if (floor > Date.now()) await Bun.sleep(floor - Date.now());
              await enqueue({ ...c, deferredFrom: note.at }).catch(() => {});
            });
            return Promise.resolve({ jsonrpc: "2.0", id: c.id, result: hash });
          }
          return enqueue(c);
        };
        const out = Array.isArray(payload)
          ? await Promise.all(payload.map(dispatch))
          : await dispatch(payload);
        return Response.json(out);
      },
    });
  }

  stop() {
    this.server?.stop(true);
  }
}
