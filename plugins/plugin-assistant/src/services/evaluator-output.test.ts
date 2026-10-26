import { describe, expect, it } from "vitest";
import { coerceObjectOutput } from "./evaluator";

describe("evaluator output coercion", () => {
  it("accepts an object wrapped in one markdown fence", () => {
    // claude-haiku-5-5 post-turn evaluation, sent without an enforced format.
    const raw =
      '```json\n{\n  "factMemory": {\n    "facts": []\n  },\n  "success": {\n    "success": false\n  }\n}\n```';
    expect(coerceObjectOutput(raw)).toEqual({
      factMemory: { facts: [] },
      success: { success: false },
    });
  });

  it("still rejects prose around a fence and non-object JSON", () => {
    for (const raw of [
      'Here is the result:\n```json\n{"success": {"success": true}}\n```',
      "```json\n[1, 2]\n```",
      "```json\n{not json}\n```",
    ]) {
      expect(coerceObjectOutput(raw)).toBeNull();
    }
  });
});
