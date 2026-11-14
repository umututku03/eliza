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
import {
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";

export const HIDE_MS = 200_000; // beyond viem's 180 s default waitForTransactionReceipt timeout

export const LAG_MS = 200_000;
export const REORG_DELAY_MS = 20_000;
export type Fault = {
  kind:
    | "none"
    | "receipt_hidden"
    | "price_move"
    | "sale_dropped"
    | "rpc_stale"
    | "sale_reorged";
  xBalance?: { token: string; wallet: string };
  onSaleMined?: () => Promise<any>;
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
  ) {
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
        data: `0x70a08231${config.wallet.slice(2).padStart(64, "0")}`,
      },
      "latest",
    ]);
  }

  private async maybeReorg() {
    if (
      this.fault.kind !== "sale_reorged" ||
      this.reorg ||
      !this.receiptServedAt ||
      Date.now() < this.receiptServedAt + REORG_DELAY_MS
    )
      return;
    const h = Number(await this.rpc("eth_blockNumber"));
    const depth = h - this.saleBlock! + 1;
    const droppedHashes: string[] = [];
    for (const send of this.journal.filter(
      (j) => j.event === "send" && j.hash,
    )) {
      const r = await this.rpc("eth_getTransactionReceipt", [send.hash]);
      if (r && Number(r.blockNumber) >= this.saleBlock!)
        droppedHashes.push(send.hash);
    }
    if (!(await this.rpc("evm_revert", [this.preSaleSnap])))
      throw new Error("Pre-sale snapshot revert failed");
    await this.rpc("anvil_mine", [depth]);
    const receipt = await this.rpc("eth_getTransactionReceipt", [
      this.saleHash,
    ]);
    const block = await this.rpc("eth_getBlockByNumber", [
      `0x${this.saleBlock!.toString(16)}`,
      false,
    ]);
    const pool = await this.rpc("txpool_status");
    const restoredX = await this.xBalance();
    if (
      receipt !== null ||
      block.hash === this.oldSaleBlockHash ||
      Number(pool.pending) ||
      Number(pool.queued) ||
      BigInt(restoredX) !== BigInt(this.preSaleX!)
    )
      throw new Error("Emulated reorg verification failed");
    this.reorg = {
      at: Date.now(),
      event: "chain_reorg",
      method: "snapshot_revert",
      depth,
      oldHead: h,
      saleBlock: this.saleBlock,
      oldSaleBlockHash: this.oldSaleBlockHash,
      newSaleBlockHash: block.hash,
      saleHash: this.saleHash,
      droppedHashes,
      receipt,
      preSaleX: this.preSaleX,
      restoredX,
      pool,
      restoredHead: Number(await this.rpc("eth_blockNumber")),
      receiptServedAt: this.receiptServedAt,
    };
    this.journal.push(this.reorg);
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
      });
    const result: any = await this.upstream(request);
    if (
      this.fault.kind === "sale_reorged" &&
      !this.receiptServedAt &&
      call.method === "eth_getTransactionReceipt" &&
      String(call.params?.[0]).toLowerCase() === this.saleHash &&
      result.result?.status === "0x1"
    )
      this.receiptServedAt = Date.now();
    return result;
  }

  private async handle(call: any) {
    await this.maybeReorg();
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
    if (candidate && this.fault.kind === "sale_reorged" && !this.preSaleSnap) {
      this.preSaleX = await this.xBalance();
      this.preSaleSnap = await this.rpc("evm_snapshot");
    }
    const result = await this.upstream(call);
    const hash = result?.result as string | undefined;
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
        this.lagUntil = Date.now() + LAG_MS;
        entry.lagBlock = this.lagBlock;
      }
      if (this.fault.kind === "receipt_hidden") {
        this.hiddenUntil = Date.now() + HIDE_MS;
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

  start() {
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      idleTimeout: 255,
      fetch: async (req) => {
        const payload = await req.json();
        // Serialize new-fault calls, including batch members, so snapshots and one-shot triggers cannot race.
        const dispatch = (c: any) => {
          if (
            !["sale_dropped", "rpc_stale", "sale_reorged"].includes(
              this.fault.kind,
            )
          )
            return this.handle(c);
          const result = this.queue.then(() => this.handle(c));
          this.queue = result.catch(() => {});
          return result;
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
