import { describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

describe("streaming upstream content type", () => {
  it("returns a generic JSON error instead of piping provider HTML", async () => {
    const handleError = vi.fn();
    const providerResponse = new Response(
      "<html><title>secret provider detail</title></html>",
      { status: 503, headers: { "Content-Type": "text/html" } },
    );

    const result = await handleStreamingResponse({
      providerResponse,
      provider: "example",
      model: "example-model",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      requestStartTime: Date.now(),
      streamController: { handleError },
    });

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.text()).not.toContain("secret provider detail");
    expect(handleError).toHaveBeenCalledOnce();
  });

  it("normalizes a successful HTML response to bad gateway", async () => {
    const result = await handleStreamingResponse({
      providerResponse: new Response("maintenance", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
      provider: "example",
      model: "example-model",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      requestStartTime: Date.now(),
    });

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });
});
