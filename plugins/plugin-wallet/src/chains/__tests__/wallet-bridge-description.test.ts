/** Replay the contradictory bridge metadata shown with dev2/dev3 wrong-tool calls. */
import { buildPlannerToolsFromActions, validateToolArgs } from "@elizaos/core";
import { expect, it } from "vitest";
import { evmPlugin } from "../evm/index";
import recordedCalls from "./fixtures/h9-bridge.json";

it.each(recordedCalls)(
  "pins bridge examples and keeps the recorded $params.action call rejected",
  ({ params, archivedDiscriminator }) => {
    expect(archivedDiscriminator.enum).toEqual(["bridge"]);
    expect(archivedDiscriminator.description).toContain("swap");
    const bridge = evmPlugin.actions?.find(
      (action) => action.name === "WALLET_BRIDGE",
    );
    if (!bridge) throw new Error("Missing bridge action");
    const tool = buildPlannerToolsFromActions([bridge])[0];
    expect(tool.description).toContain("Cross-chain token transfer");
    const discriminator = tool.parameters?.properties?.action as {
      description: string;
      enum: string[];
    };
    expect(discriminator.enum).toEqual(["bridge"]);
    expect(discriminator.description).not.toMatch(
      /swap|token_info|transfer|gov/,
    );
    expect(validateToolArgs(bridge, params).errors.length).toBeGreaterThan(0);
    const valid = validateToolArgs(bridge, {
      action: "bridge",
      target: "mainnet",
      toChain: "base",
      fromToken: "USDC",
      amount: "1",
    });
    expect(valid.errors).toEqual([]);
  },
);
