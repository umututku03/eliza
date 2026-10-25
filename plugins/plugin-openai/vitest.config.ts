/** Adapter integration checks; live and keyless-runtime suites have dedicated configs. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

export default defineConfig({
	resolve: {
    conditions: ["eliza-source", "node"],
    alias: buildWorkspaceSourceAliases(),
	},
	test: {
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fsModuleCache: true,
		environment: "node",
		include: [
			"__tests__/**/*.test.ts",
			"models/**/*.test.ts",
			"src/**/*.test.ts",
		],
		// `*.real.test.ts` are kept in: they self-skip keyless (describe.skipIf)
		// and run live only in the nightly external-api-live-drift lane.
		// `*.real.test.ts` boot a real PGLite runtime and need the workspace
		// source aliases from vitest.real-runtime.config.ts — run via `test:real-runtime`.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			// #9310 §E: the guarded live suites (trajectory + cerebras-refusal +
			// cerebras-config self-skip without their required credentials / the
			// opt-in gate) are invocable only in the post-merge lane, where
			// run-all-tests.ts prints a named skip accounting. The unguarded
			// live files stay excluded in every lane.
			...(process.env.VITEST_LANE === "post-merge"
				? [
						"__tests__/cloud-streaming.live.test.ts",
						"__tests__/native-plumbing.live.test.ts",
						"__tests__/openai.live.test.ts",
					]
				: ["**/*.live.test.ts"]),
			"**/*.real.test.ts",
		],
	},
});
