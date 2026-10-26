import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createPlannerToolDiscoveryAction } from "./tool-discovery.ts";

const runtime = {} as IAgentRuntime;
const message = { content: { text: "Read the wallet balance." } } as Memory;

function fixture(admitted = true) {
  const execute = vi.fn();
  const action: Action = {
    name: "READ_BALANCE",
    description: "Read the wallet balance.",
    contexts: ["wallet"],
    handler: execute,
  };
  const load = vi.fn();
  const refresh = vi.fn(async () => (admitted ? [action] : []));
  const discovery = createPlannerToolDiscoveryAction([action], load, refresh);
  return {
    execute,
    load,
    refresh,
    call: (parameters: Record<string, unknown>) =>
      discovery.handler?.(runtime, message, undefined, { parameters }),
  };
}

describe("nullable discovery selectors from strict tool schemas", () => {
  it.each([
    { mode: "load", names: [], query: "wallet balance", contexts: null },
    { mode: "load", names: null, query: "wallet balance", contexts: null },
    { mode: "load", names: ["READ_BALANCE"], query: null, contexts: null },
    { mode: null, names: null, query: null, contexts: null },
  ])(
    "loads authorized tools with empty optional selectors: %j",
    async (parameters) => {
      const f = fixture();
      const result = await f.call(parameters);
      expect(result?.success).toBe(true);
      expect(result?.data?.loadedTools).toContain("READ_BALANCE");
      expect(f.load).toHaveBeenCalledOnce();
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps a nullable full-catalog describe read-only", async () => {
    const f = fixture();
    const result = await f.call({
      mode: "describe",
      names: [],
      query: null,
      contexts: null,
    });
    expect(result?.success).toBe(true);
    expect(result?.data?.catalog).toBeDefined();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([
    { names: ["READ_BALANCE"], query: "wallet balance", contexts: null },
    { names: ["READ_BALANCE"], query: null, contexts: ["wallet"] },
    { names: [], query: "wallet balance", contexts: [] },
  ])(
    "still rejects conflicting or invalid selectors: %j",
    async (parameters) => {
      const f = fixture();
      expect((await f.call(parameters))?.success).toBe(false);
      expect(f.load).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps unknown explicit contexts restrictive", async () => {
    const f = fixture();
    const result = await f.call({
      names: [],
      query: "wallet balance",
      contexts: ["unknown"],
    });
    expect(result?.success).toBe(true);
    expect(result?.data?.selectedCount).toBe(0);
    expect(f.load).not.toHaveBeenCalled();
  });

  it("does not expose stale tools when query permissions are revoked", async () => {
    const f = fixture(false);
    const result = await f.call({
      names: [],
      query: "wallet balance",
      contexts: null,
    });
    expect(result?.success).toBe(true);
    expect(result?.data?.selectedCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain("READ_BALANCE");
    expect(f.load).not.toHaveBeenCalled();
  });

  it("does not load revoked exact names after normalizing nulls", async () => {
    const f = fixture(false);
    expect(
      (await f.call({ names: ["READ_BALANCE"], query: null, contexts: null }))
        ?.success,
    ).toBe(false);
    expect(f.load).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
});
