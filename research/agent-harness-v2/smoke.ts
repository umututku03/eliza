// Phase 0 smoke test: a headless stock ElizaOS v2 runtime (assistant, SQL, OpenAI and wallet plugins) boots
// against the pinned mainnet fork, and its EVM wallet is the funded fork test key. The model endpoint is a
// local stub, so no model provider is contacted.
// Usage (repo root): bun --conditions=eliza-source --env-file=<fork .env> research/agent-harness-v2/smoke.ts
import { AgentRuntime, ChannelType, createMessageMemory, stringToUuid, type UUID } from '@elizaos/core';
import { createAssistantPlugin } from '@elizaos/plugin-assistant';
import sqlPlugin from '@elizaos/plugin-sql';
import openaiPlugin from '@elizaos/plugin-openai';
import { walletPlugin } from '@elizaos/plugin-wallet';
import { initWalletProvider } from '../../plugins/plugin-wallet/src/chains/evm/providers/wallet';
import { formatEther } from 'viem';
import { AGENT, AGENT_KEY, fundAgent, startAnvil, ANVIL_PORT } from './fork-oracle';
import frozen from './frozen-task.json';

const STUB_PORT = 18651;
const requests: string[] = [];
const stub = Bun.serve({
  port: STUB_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    const body: any = await req.json().catch(() => ({}));
    if (path.endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: body.model, data: inputs.map((_: unknown, i: number) => ({ object: 'embedding', index: i, embedding: Array(1536).fill(0.01) })), usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    return Response.json({ id: 'stub', object: 'chat.completion', created: 0, model: body.model ?? 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  },
});

const anvil = await startAnvil(frozen.block);
try {
  await fundAgent(anvil);
  const agentId = stringToUuid('smoke-agent');
  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: 'Agent',
      bio: ['A wallet assistant.'],
      settings: {
        chains: { evm: ['mainnet'] },
        secrets: {
          EVM_PRIVATE_KEY: AGENT_KEY,
          ETHEREUM_PROVIDER_MAINNET: `http://127.0.0.1:${ANVIL_PORT}`,
          ELIZA_WALLET_BACKEND: 'local',
          SOLANA_NO_ACTIONS: 'true',
          OPENAI_API_KEY: 'stub-key',
          OPENAI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
          PGLITE_DATA_DIR: `memory://smoke-${Date.now()}`,
        },
      },
    } as any,
    plugins: [createAssistantPlugin(), sqlPlugin, openaiPlugin, walletPlugin as any],
    logLevel: 'warn',
  });
  const t0 = Date.now();
  await runtime.initialize();
  const wallet = await initWalletProvider(runtime);
  const address = wallet.getAddress();
  const balance = await wallet.getPublicClient('mainnet' as any).getBalance({ address });
  const chainId = await wallet.getPublicClient('mainnet' as any).getChainId();
  console.log(JSON.stringify({ booted: true, initMs: Date.now() - t0, address, expected: AGENT, matches: address.toLowerCase() === AGENT.toLowerCase(),
    chainId, balanceEth: formatEther(balance), actions: runtime.actions.map(a => a.name).filter(n => n.startsWith('WALLET')),
    stubRequests: requests.length }));
  void ChannelType; void createMessageMemory; void (null as unknown as UUID);
  await runtime.stop?.();
} finally {
  anvil.proc.kill();
  stub.stop(true);
}
