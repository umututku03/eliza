import { describe, expect, it } from "vitest";
import {
	projectCompleteToolValueForModel,
	projectToolDiagnosticValue,
	TOOL_DIAGNOSTIC_MASK,
} from "../src/security/tool-diagnostics.ts";

const identity = (text: string) => text;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// Shape of a WALLET_SWAP result recorded on a pinned mainnet fork: the model
// received fromToken/toToken as "[REDACTED]" and sent that literal back as the
// next swap's fromToken.
const swapResult = {
	success: true,
	data: {
		actionName: "WALLET_SWAP",
		subaction: "swap",
		fromToken: USDC,
		toToken: DAI,
		amount: "59.406476",
		handler: {
			chain: "mainnet",
			tokens: [
				{
					symbol: "ETH",
					address: "0x0000000000000000000000000000000000000000",
				},
			],
		},
		holdings: [
			{ chain: "mainnet", symbol: "USDC", amount: "237.636476", token: USDC },
		],
	},
};

describe("tool projection keeps public chain assets visible", () => {
	for (const [name, project] of [
		["model", projectCompleteToolValueForModel],
		["diagnostic", projectToolDiagnosticValue],
	] as const) {
		it(`keeps token addresses, mints and symbols (${name})`, () => {
			const out = project(swapResult, identity) as typeof swapResult;
			expect(out.data.fromToken).toBe(USDC);
			expect(out.data.toToken).toBe(DAI);
			expect(out.data.handler.tokens).toEqual(swapResult.data.handler.tokens);
			expect(out.data.holdings[0].token).toBe(USDC);
			const symbols = project(
				{
					fromToken: "ETH",
					toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				},
				identity,
			);
			expect(symbols).toEqual({
				fromToken: "ETH",
				toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			});
		});

		it(`still masks credentials under token-named keys (${name})`, () => {
			const out = project(
				{
					token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
					accessToken: USDC,
					fromToken: "sk-live-0123456789abcdefghij",
					tokens: { access_token: "abc.def.ghi", symbol: "USDC" },
					apiKey: "ETH",
				},
				identity,
			) as Record<string, unknown>;
			expect(out.token).toBe(TOOL_DIAGNOSTIC_MASK);
			expect(out.accessToken).toBe(TOOL_DIAGNOSTIC_MASK);
			expect(out.fromToken).toBe(TOOL_DIAGNOSTIC_MASK);
			expect(out.tokens).toEqual({
				access_token: TOOL_DIAGNOSTIC_MASK,
				symbol: "USDC",
			});
			expect(out.apiKey).toBe(TOOL_DIAGNOSTIC_MASK);
		});
	}
});
