// Phase 1 proof (no model): the frozen two-step task runs through stock v2's WALLET router with the on-chain
// Uniswap V2 route on the pinned fork. Each step is confirmed the way a user does (a first call, then "yes"
// with the same parameters), so the mandatory financial confirmation gate is exercised, not bypassed.
// Usage (repo root): bun --conditions=eliza-source --env-file=<fork .env> research/agent-harness-v2/control-v2-route.ts
import { AgentRuntime, stringToUuid, type HandlerOptions, type Memory } from '@elizaos/core';
import { createAssistantPlugin } from '@elizaos/plugin-assistant';
import sqlPlugin from '@elizaos/plugin-sql';
import openaiPlugin from '@elizaos/plugin-openai';
import { walletPlugin, walletRouterAction } from '@elizaos/plugin-wallet';
import { formatUnits, parseUnits } from 'viem';
import { AGENT, AGENT_KEY, ANVIL_PORT, DAI, ROUTER, USDC, balance, fundAgent, startAnvil } from './fork-oracle';
import frozen from './frozen-task.json';

const anvil = await startAnvil(frozen.block);
let failed = false;
try {
  await fundAgent(anvil);
  const runtime = new AgentRuntime({
    agentId: stringToUuid('control-v2-route'),
    character: {
      name: 'Agent',
      bio: ['A wallet assistant.'],
      settings: {
        chains: { evm: ['mainnet'] },
        secrets: {
          EVM_PRIVATE_KEY: AGENT_KEY,
          ETHEREUM_PROVIDER_MAINNET: `http://127.0.0.1:${ANVIL_PORT}`,
          EVM_SWAP_UNISWAP_V2_ROUTER: ROUTER,
          EVM_SWAP_AGGREGATORS: 'uniswapV2',
          ELIZA_WALLET_BACKEND: 'local',
          SOLANA_NO_ACTIONS: 'true',
          OPENAI_API_KEY: 'unused',
          OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
          PGLITE_DATA_DIR: `memory://control-${Date.now()}`,
        },
      },
    } as any,
    plugins: [createAssistantPlugin(), sqlPlugin, openaiPlugin, walletPlugin as any],
    logLevel: 'error',
  });
  await runtime.initialize();
  // Services start in the background after initialize(); the router needs the wallet backend.
  await runtime.getServiceLoadPromise('wallet-backend' as any);

  const entityId = stringToUuid('control-user');
  const roomId = stringToUuid('control-room');
  const msg = (text: string): Memory => ({ id: crypto.randomUUID(), entityId, agentId: runtime.agentId, roomId, content: { text }, createdAt: Date.now() }) as Memory;
  const confirmed = async (parameters: Record<string, unknown>) => {
    const first = await walletRouterAction.handler(runtime, msg('please do this swap'), undefined, { parameters } as HandlerOptions);
    if (!first?.data?.requiresConfirmation) throw new Error(`expected a confirmation request, got ${JSON.stringify(first?.data).slice(0, 300)}`);
    return walletRouterAction.handler(runtime, msg('yes, confirm'), undefined, { parameters } as HandlerOptions);
  };
  const state = async () => ({ usdc: await balance(anvil.pub, USDC, AGENT), dai: await balance(anvil.pub, DAI, AGENT) });

  const s1 = await confirmed({ action: 'swap', target: 'mainnet', fromToken: 'ETH', toToken: USDC, amount: frozen.saleEth, slippageBps: 300 });
  const after1 = await state();
  // Simulate (quote) step 2 first: no confirmation, no transaction; the quote must equal what the swap then delivers.
  const step2 = { action: 'swap', target: 'mainnet', fromToken: USDC, toToken: DAI, amount: formatUnits(BigInt(frozen.budgetUsdcUnits), 6), slippageBps: 300 };
  const nonceBeforeSim = await anvil.pub.getTransactionCount({ address: AGENT });
  const sim = await walletRouterAction.handler(runtime, msg('what would this swap give me?'), undefined, { parameters: { ...step2, mode: 'simulate' } } as HandlerOptions);
  const simSummary = (sim?.data as any)?.simulation?.summary ?? {};
  const simSentNothing = (await anvil.pub.getTransactionCount({ address: AGENT })) === nonceBeforeSim;
  const s2 = await confirmed(step2);
  const after2 = await state();

  const checks = {
    step1Succeeded: s1?.success === true,
    proceedsMatchFrozen: after1.usdc === BigInt(frozen.proceedsUsdcUnits),
    step2Succeeded: s2?.success === true,
    goalReached: after2.dai >= parseUnits(frozen.goalDai, 18),
    reserveKept: after2.usdc >= parseUnits(frozen.reserveUsdc, 6),
    simulateIsQuoteOnly: sim?.success === true && simSentNothing && !(sim?.data as any)?.requiresConfirmation,
    quoteMatchesExecution: simSummary.expectedOutput === formatUnits(after2.dai, 18),
  };
  failed = !Object.values(checks).every(Boolean);
  console.log(JSON.stringify({
    checks,
    step1: { success: s1?.success, hash: s1?.data?.transactionHash ?? s1?.data?.execution?.transactionHash, aggregatorRoute: "uniswapV2" },
    step2: { success: s2?.success, hash: s2?.data?.transactionHash ?? s2?.data?.execution?.transactionHash },
    simulateText: String(sim?.text ?? '').slice(0, 300),
    usdcAfterStep1: formatUnits(after1.usdc, 6), usdcAfterStep2: formatUnits(after2.usdc, 6), daiAfterStep2: formatUnits(after2.dai, 18),
  }, null, 1));
  if (failed) console.log('step results:', JSON.stringify({ s1: s1?.data, s2: s2?.data, t1: s1?.text, t2: s2?.text }).slice(0, 2000));
  await runtime.stop?.();
} finally {
  anvil.proc.kill();
}
process.exit(failed ? 1 : 0);
