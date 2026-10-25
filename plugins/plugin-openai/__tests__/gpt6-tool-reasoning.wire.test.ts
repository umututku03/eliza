/** Real SDK serialization against a loopback provider; no live model calls. */
import { createServer, type Server } from "node:http";
import type { IAgentRuntime, ToolDefinition } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleActionPlanner } from "../models/text";

interface WireRequest {
  model: string;
  stream?: boolean;
  tools?: unknown[];
  reasoning_effort?: string;
}

let server: Server;
let baseUrl: string;
const requests: WireRequest[] = [];
let replyWithToolCall = false;
const tools: ToolDefinition[] = [
  {
    name: "READ_BALANCE",
    description: "Read the current test balance.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

beforeAll(async () => {
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(text) as WireRequest;
      requests.push(body);
      const base = { id: "chatcmpl-fixture", created: 0, model: body.model };
      const toolCall = {
        id: "balance-call",
        type: "function",
        function: { name: "READ_BALANCE", arguments: "{}" },
      };
      const finishReason = replyWithToolCall ? "tool_calls" : "stop";
      if (body.stream) {
        const delta = replyWithToolCall
          ? { tool_calls: [{ index: 0, ...toolCall }] }
          : { content: "done" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
            "data: [DONE]\n\n"
        );
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: replyWithToolCall ? null : "done",
                  ...(replyWithToolCall ? { tool_calls: [toolCall] } : {}),
                },
                finish_reason: finishReason,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  requests.length = 0;
  vi.stubEnv("ELIZA_PROVIDER", "openai");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("OPENAI_REASONING_EFFORT", undefined);
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

afterEach(() => vi.unstubAllEnvs());

async function invoke(
  options: {
    model?: string;
    stream?: boolean;
    tools?: ToolDefinition[];
    setting?: string;
    callerEffort?: "none" | "high";
    expectToolCall?: boolean;
  } = {}
) {
  replyWithToolCall = options.expectToolCall ?? false;
  const runtime = {
    getSetting: (name: string) =>
      name === "OPENAI_REASONING_EFFORT" ? options.setting : undefined,
    character: { name: "Fixture", system: "Read the balance when requested." },
    emitEvent: async () => {},
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
  const result = await handleActionPlanner(runtime, {
    model: options.model ?? "gpt-6-luna",
    messages: [{ role: "user", content: "Read the test balance." }],
    tools: options.tools ?? tools,
    stream: options.stream ?? false,
    ...(options.callerEffort
      ? { providerOptions: { openai: { reasoningEffort: options.callerEffort } } }
      : {}),
  });
  if (result && typeof result === "object" && "textStream" in result) {
    for await (const _chunk of result.textStream) {
      /* drain the real SDK stream */
    }
    await result.text;
  }
  if (options.expectToolCall) {
    if (!result || typeof result !== "object" || !("toolCalls" in result)) {
      throw new Error("expected native tool-call result");
    }
    expect(await result.toolCalls).toEqual([
      { id: "balance-call", name: "READ_BALANCE", arguments: {} },
    ]);
  }
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe("GPT-6 Chat Completions tool reasoning", () => {
  it.each([false, true])("returns the provider's tool call intact (stream=%s)", async (stream) => {
    const body = await invoke({ stream, expectToolCall: true });
    expect(body.reasoning_effort).toBe("none");
  });
  for (const model of ["gpt-6-luna", "gpt-6-sol"]) {
    for (const stream of [false, true]) {
      it(`defaults ${model} tool requests to none (stream=${stream})`, async () => {
        const body = await invoke({ model, stream });
        expect(body.tools).toHaveLength(1);
        expect(body.reasoning_effort).toBe("none");
      });
    }
  }

  it("forwards an explicit runtime none setting on a text-only request", async () => {
    expect((await invoke({ setting: " NONE ", tools: [] })).reasoning_effort).toBe("none");
  });

  it("reads the reasoning setting from the environment when runtime config is absent", async () => {
    vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
    expect((await invoke({ tools: [] })).reasoning_effort).toBe("none");
  });

  it("leaves ordinary text-only requests at the provider default", async () => {
    expect(await invoke({ tools: [] })).not.toHaveProperty("reasoning_effort");
  });

  it("preserves an explicit operator effort rather than silently lowering it", async () => {
    expect((await invoke({ setting: "high" })).reasoning_effort).toBe("high");
  });

  it("preserves the caller's precedence over the runtime setting", async () => {
    expect((await invoke({ setting: "none", callerEffort: "high" })).reasoning_effort).toBe("high");
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna-preview", "gpt-4.1"])(
    "does not add an unsupported default to %s",
    async (model) => {
      expect(await invoke({ model })).not.toHaveProperty("reasoning_effort");
    }
  );

  it("does not infer OpenAI defaults for a Cerebras endpoint", async () => {
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");
    expect(await invoke()).not.toHaveProperty("reasoning_effort");
  });

  it("does not infer OpenAI defaults for an EvoLink endpoint", async () => {
    vi.stubEnv("ELIZA_PROVIDER", "evolink");
    expect(await invoke()).not.toHaveProperty("reasoning_effort");
  });
});
