/** Replays the same-turn stale wallet snapshot in dev4 Haiku stock, call 22. */
import {
  AgentRuntime,
  type ContextObject,
  type Memory,
  type PlannerToolResult,
} from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import sale from "../../../../plugin-wallet/src/chains/__tests__/fixtures/h8-sale.json";
import { runPlannerLoop } from "../planner-loop.ts";

it.each([true, false])(
  "refreshes explicitly changed wallet context, never prose-only claims (submitted: %s)",
  async (submitted) => {
    const before: ContextObject = {
      id: "h8-replay",
      events: [
        {
          id: "wallet",
          type: "provider",
          name: "evm-wallet",
          source: "composeState",
          text: sale.beforeText,
        },
        {
          id: "clock",
          type: "provider",
          name: "CURRENT_TIME",
          source: "composeState",
          text: "cached clock",
        },
      ],
    };
    const afterText = sale.beforeText
      .replace("1 ETH", "0.899863606673511392 ETH")
      .replace("0 USDC", "237.636476 USDC");
    const cacheRuntime = new AgentRuntime({ character: { name: "H8 replay" } });
    await initializeTestRuntime(cacheRuntime, { skipMigrations: true });
    let walletText = sale.beforeText;
    const walletRead = vi.fn(async () => ({ text: walletText }));
    const clockRead = vi.fn(async () => ({ text: "cached clock" }));
    cacheRuntime.registerProvider({
      name: "evm-wallet",
      cacheScope: "turn",
      get: walletRead,
    });
    cacheRuntime.registerProvider({
      name: "CURRENT_TIME",
      cacheScope: "turn",
      get: clockRead,
    });
    const message = {
      id: "11111111-1111-1111-1111-111111111111",
      roomId: "22222222-2222-2222-2222-222222222222",
      entityId: cacheRuntime.agentId,
      content: { text: "Yes, confirm." },
    } as Memory;
    await cacheRuntime.composeState(
      message,
      ["evm-wallet", "CURRENT_TIME"],
      true,
      false,
      [],
    );
    const restore = vi.fn(
      async (context: ContextObject, names?: readonly string[]) => {
        expect(names).toEqual(["evm-wallet"]);
        const state = await cacheRuntime.composeState(
          message,
          ["evm-wallet", "CURRENT_TIME"],
          true,
          false,
          [...(names ?? [])],
        );
        const providers = state.data.providers as Record<
          string,
          { text: string }
        >;
        return {
          ...context,
          events: context.events.map((event) =>
            event.id === "wallet"
              ? { ...event, text: providers["evm-wallet"].text }
              : event,
          ),
        };
      },
    );
    let calls = 0;
    await runPlannerLoop({
      context: before,
      tools: [{ name: "WALLET_SWAP" }, { name: "REPLY" }],
      runtime: {
        restoreProviderContext: restore,
        useModel: async (_type, params) => {
          if (++calls === 1)
            return {
              text: "",
              toolCalls: [
                {
                  id: "sale",
                  name: "WALLET_SWAP",
                  arguments: { eliza_turn_scope: "more_work_pending" },
                },
              ],
            };
          const wire = JSON.stringify(params);
          expect(wire).toContain(
            submitted ? "237.636476 USDC" : "mainnet: 0 USDC",
          );
          if (submitted) expect(wire).not.toContain("mainnet: 0 USDC");
          expect(wire).toContain("cached clock");
          return {
            text: "",
            toolCalls: [
              {
                id: "reply",
                name: "REPLY",
                arguments: {
                  text: "Read complete.",
                  eliza_turn_scope: "final",
                },
              },
            ],
          };
        },
      },
      executeToolCall: async (call) => {
        if (call.name === "REPLY")
          return { success: true, userFacingText: "Read complete." };
        walletText = afterText;
        return {
          success: submitted,
          text: "Submitted swap; balances changed.",
          ...(submitted ? { refreshProviders: ["evm-wallet"] } : {}),
        } as PlannerToolResult;
      },
      evaluate: async ({ trajectory }) => {
        const wallet = trajectory.context.events.find(
          (event) => event.id === "wallet",
        );
        expect(wallet?.text).toBe(submitted ? afterText : sale.beforeText);
        return {
          success: true,
          decision: calls > 1 ? "FINISH" : "CONTINUE",
          messageToUser: "Read complete.",
        };
      },
      config: { maxIterations: 2 },
    });
    expect(restore).toHaveBeenCalledTimes(submitted ? 1 : 0);
    expect(walletRead).toHaveBeenCalledTimes(submitted ? 2 : 1);
    expect(clockRead).toHaveBeenCalledTimes(1);
    await cacheRuntime.stop();
  },
);
