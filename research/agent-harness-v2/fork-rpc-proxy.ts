// Copied from the Spartan harness (umututku03/spartan-agent c47d7c3, research/agent-flow-cohorts/fork-rpc-proxy.ts).
// JSON-RPC proxy between the agent (and controls) and the Anvil mainnet fork. It forwards every call,
// journals submitted transactions, and applies the scheduled faults of the active scenario:
//   receipt_hidden:   eth_getTransactionReceipt returns null for the sale tx for HIDE_MS after it mines.
//   price_change_*:   immediately after the sale tx mines, a privileged hook moves the WETH/DAI pool,
//                     before the sale's hash is returned to the caller.
// The sale tx is the first SUCCESSFUL transaction from the agent wallet to the Uniswap V2 router that sends
// native value (v2: any amount, since risk clamps can shrink the 0.1 ETH sale); faults follow that confirmed effect.
import {parseTransaction, recoverTransactionAddress, type Hex} from 'viem';

export const HIDE_MS = 200_000; // beyond viem's 180 s default waitForTransactionReceipt timeout

export type Fault = {kind: 'none' | 'receipt_hidden' | 'price_move'; onSaleMined?: () => Promise<any>};

export class ForkRpcProxy {
  journal: any[] = [];
  private server: any;
  private fault: Fault = {kind: 'none'};
  private wallet = '';
  private router = '';
  private saleHash: string | null = null;
  private hiddenUntil = 0;
  private saleHookResult: any = null;
  private id = 0;

  constructor(public anvilUrl: string, public port: number) {}

  get url() { return `http://127.0.0.1:${this.port}`; }

  reset(wallet: string, router: string, fault: Fault) {
    this.wallet = wallet.toLowerCase(); this.router = router.toLowerCase(); this.fault = fault; this.journal = [];
    this.saleHash = null; this.hiddenUntil = 0; this.saleHookResult = null;
  }

  state() { return {saleHash: this.saleHash, hiddenUntil: this.hiddenUntil, saleHookResult: this.saleHookResult, fault: this.fault.kind}; }

  private async upstream(payload: any) {
    const r = await fetch(this.anvilUrl, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
    return r.json();
  }

  private async handle(call: any) {
    if (call.method === 'eth_getTransactionReceipt' && this.saleHash && String(call.params?.[0]).toLowerCase() === this.saleHash
        && Date.now() < this.hiddenUntil) {
      this.journal.push({at: Date.now(), event: 'receipt_hidden', hash: this.saleHash});
      return {jsonrpc: '2.0', id: call.id, result: null};
    }
    if (call.method !== 'eth_sendRawTransaction') return this.upstream(call);
    const rawTx = call.params[0] as Hex;
    let from = '', to = '', value = '0';
    try {
      const tx: any = parseTransaction(rawTx);
      from = (await recoverTransactionAddress({serializedTransaction: rawTx as any})).toLowerCase();
      to = String(tx.to ?? '').toLowerCase(); value = String(tx.value ?? 0n);
    } catch {}
    const result = await this.upstream(call);
    const hash = result?.result as string | undefined;
    const entry: any = {at: Date.now(), event: 'send', from, to, value, hash: hash?.toLowerCase() ?? null, error: result?.error ?? null};
    this.journal.push(entry);
    let mined: any = null;
    if (hash && from === this.wallet && to === this.router && !this.saleHash && BigInt(value) > 0n) {
      // Anvil can return the hash just before the receipt is queryable: poll briefly (up to 10 s).
      for (let i = 0; i < 200 && !mined; i++) {
        mined = (await this.upstream({jsonrpc: '2.0', id: `sale-check-${++this.id}`, method: 'eth_getTransactionReceipt', params: [hash]}))?.result ?? null;
        if (!mined) await Bun.sleep(50);
      }
      entry.saleCandidateReceiptStatus = mined?.status ?? 'not_mined_within_10s';
    }
    const isSale = mined?.status === '0x1';
    if (isSale) {
      this.saleHash = hash!.toLowerCase(); entry.sale = true;
      if (this.fault.kind === 'receipt_hidden') { this.hiddenUntil = Date.now() + HIDE_MS; entry.hiddenUntil = this.hiddenUntil; }
      if (this.fault.kind === 'price_move' && this.fault.onSaleMined) {
        this.saleHookResult = await this.fault.onSaleMined();   // runs before the hash is returned
        this.journal.push({at: Date.now(), event: 'scheduled_market_change', result: this.saleHookResult});
      }
    }
    return result;
  }

  start() {
    this.server = Bun.serve({
      port: this.port, hostname: '127.0.0.1', idleTimeout: 255,
      fetch: async (req) => {
        const payload = await req.json();
        const out = Array.isArray(payload) ? await Promise.all(payload.map((c: any) => this.handle(c))) : await this.handle(payload);
        return Response.json(out);
      },
    });
  }

  stop() { this.server?.stop(true); }
}
