import { describe, expect, it } from "vitest";

import ZedExecutor, { __test__ } from "../../open-sse/executors/zed.js";

describe("ZedExecutor", () => {
  it("preserves failed stream status as a terminal error frame", async () => {
    const upstream = new Response(
      `${JSON.stringify({ status: { failed: { message: "quota exhausted" } } })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );

    const response = __test__.wrapZedCompletionStream(upstream, "OpenAi", "gpt-5");
    const body = await response.text();

    expect(body).toContain('"type":"zed_error"');
    expect(body).toContain("quota exhausted");
    expect(body).not.toContain('"finish_reason":"stop"');
    expect(body).not.toContain('"choices"');
    expect(body).toContain("data: [DONE]");
  });

  it("returns structured trial-blocked errors for fallback handling", () => {
    const executor = new ZedExecutor();
    const parsed = executor.parseError(
      new Response(null, { status: 403, statusText: "Forbidden" }),
      JSON.stringify({ code: "trial_blocked", message: "enable billing" }),
    );

    expect(parsed.status).toBe(403);
    expect(parsed.message).toContain("trial access is blocked");
    expect(parsed.message).toContain("enable billing");
  });
});
