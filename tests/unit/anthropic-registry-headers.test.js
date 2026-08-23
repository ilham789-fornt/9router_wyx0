import { describe, expect, it } from "vitest";

import anthropic from "../../open-sse/providers/registry/anthropic.js";

describe("Anthropic registry headers", () => {
  it("uses one lowercase anthropic-version key", () => {
    expect(anthropic.transport.headers["anthropic-version"]).toBe("2023-06-01");
    expect(anthropic.transport.headers["Anthropic-Version"]).toBeUndefined();
  });
});
