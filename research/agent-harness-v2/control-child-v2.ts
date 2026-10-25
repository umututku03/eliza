// Deterministic control (no model) in its own process: the frozen task through stock v2's WALLET router with
// oracle-computed amounts and conventional reconciliation, against the fork RPC fault proxy. Each step is
// confirmed the way a user does (a first call, then "yes" with the same parameters).
// Usage (repo root): bun --conditions=eliza-source research/agent-harness-v2/control-child-v2.ts <spec.json> <out.json>
import {readFileSync, writeFileSync} from 'node:fs';
import {createPublicClient, formatUnits, http, parseUnits, type Address} from 'viem';
import {mainnet} from 'viem/chains';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
Object.assign(process.env, {ELIZA_BENCH_DISABLE_DOTENV: '1', SECRET_SALT: 'agent-harness-v2-fixed-salt'});
const {AgentRuntime, stringToUuid} = await import('@elizaos/core');
const {createAssistantPlugin} = await import('@elizaos/plugin-assistant');
const sqlPlugin = (await import('@elizaos/plugin-sql')).default;
const openaiPlugin = (await import('@elizaos/plugin-openai')).default;
const {walletPlugin, walletRouterAction} = await import('@elizaos/plugin-wallet');
const {minimalUsdcFor, balance} = await import('./fork-oracle');

const pub = createPublicClient({chain: mainnet, transport: http(spec.forkProxyUrl, {retryCount: 0})});
const runtime = new AgentRuntime({
  agentId: stringToUuid(`control-${spec.scenario}`),
  character: {name: 'Agent', bio: ['A wallet assistant.'], settings: {chains: {evm: ['mainnet']}, secrets: {
    EVM_PRIVATE_KEY: spec.privateKey, ETHEREUM_PROVIDER_MAINNET: spec.forkProxyUrl,
    EVM_SWAP_UNISWAP_V2_ROUTER: spec.router, EVM_SWAP_AGGREGATORS: 'uniswapV2',
    ELIZA_WALLET_BACKEND: 'local', SOLANA_NO_ACTIONS: 'true', OPENAI_API_KEY: 'unused', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    PGLITE_DATA_DIR: `memory://control-${spec.scenario}-${Date.now()}`}}} as any,
  plugins: [createAssistantPlugin(), sqlPlugin, openaiPlugin, walletPlugin as any],
  logLevel: 'error',
});
await runtime.initialize();
await runtime.getServiceLoadPromise('wallet-backend' as any);
const entityId = stringToUuid('control-user'), roomId = stringToUuid(`control-room-${spec.scenario}`);
const msg = (text: string) => ({id: crypto.randomUUID(), entityId, agentId: runtime.agentId, roomId, content: {text}, createdAt: Date.now()}) as any;
const confirmed = async (parameters: Record<string, unknown>) => {
  const first = await walletRouterAction.handler(runtime, msg('please do this swap'), undefined, {parameters} as any);
  if (!first?.data?.requiresConfirmation) throw new Error(`expected a confirmation request: ${JSON.stringify(first?.data).slice(0, 200)}`);
  return walletRouterAction.handler(runtime, msg('yes, confirm'), undefined, {parameters} as any);
};
const brief = (r: any) => ({success: r?.success, error: r?.data?.error ?? null, text: String(r?.text ?? '').slice(0, 300)});

const steps: any[] = [];
let declared = 'INFEASIBLE', error: string | null = null;
try {
  const sale = await confirmed({action: 'swap', target: 'mainnet', fromToken: 'ETH', toToken: spec.usdc, amount: spec.saleEth, slippageBps: 300});
  steps.push({sale: brief(sale)});
  if (sale?.success !== true) {
    // Reconcile: the transaction may be mined with its receipt hidden. Wait until the proceeds are visible.
    for (let i = 0; i < spec.reconcileSeconds; i++) {
      if (await balance(pub, spec.usdc as Address, spec.wallet) > 0n) { steps.push({reconciled: 'proceeds visible', afterSeconds: i}); break; }
      await Bun.sleep(1000);
    }
  }
  const amount = await minimalUsdcFor(pub, parseUnits(spec.goalDai, 18), BigInt(spec.budgetUsdcUnits));
  steps.push({oracleStep2Usdc: amount === null ? null : formatUnits(amount, 6)});
  if (amount !== null) {
    const swap = await confirmed({action: 'swap', target: 'mainnet', fromToken: spec.usdc, toToken: spec.dai, amount: formatUnits(amount, 6), slippageBps: 300});
    steps.push({swap: brief(swap)});
    if (swap?.success !== true) throw new Error(`control step 2 failed: ${brief(swap).text}`);
    declared = 'COMPLETED';
  }
} catch (e) { error = (e as Error).message; }
writeFileSync(process.argv[3], JSON.stringify({steps, declared, error}, null, 2));
await runtime.stop?.().catch(() => {});
process.exit(0);
