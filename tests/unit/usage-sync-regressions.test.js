import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  convertResponsesStreamToJson: vi.fn(),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: mocks.appendRequestLog,
  saveRequestDetail: mocks.saveRequestDetail,
  saveRequestUsage: mocks.saveRequestUsage,
  trackPendingRequest: mocks.trackPendingRequest,
}));
vi.mock("../../open-sse/transformer/streamToJsonConverter.js", () => ({
  convertResponsesStreamToJson: mocks.convertResponsesStreamToJson,
}));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { logUsage } from "../../open-sse/utils/usageTracking.js";

describe("upstream usage accounting regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes cached Responses tokens in forced-SSE Chat usage and request details", async () => {
    mocks.convertResponsesStreamToJson.mockResolvedValue({
      id: "resp-cache",
      model: "codex-model",
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "cached answer" }],
      }],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 5,
      },
    });

    const result = await handleForcedSSEToJson({
      providerResponse: new Response("", {
        headers: { "Content-Type": "text/event-stream" },
      }),
      sourceFormat: FORMATS.OPENAI,
      provider: "codex",
      model: "codex-model",
      body: { messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });
    const responseBody = await result.response.json();

    expect(responseBody.usage).toEqual({
      prompt_tokens: 57,
      completion_tokens: 3,
      total_tokens: 60,
      prompt_tokens_details: {
        cached_tokens: 40,
        cache_creation_tokens: 5,
      },
    });
    expect(mocks.saveRequestDetail).toHaveBeenCalledWith(expect.objectContaining({
      tokens: { prompt_tokens: 57, completion_tokens: 3 },
    }));
  });

  it("keeps logUsage side-effect free for persistence", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logUsage("codex", {
      prompt_tokens: 10,
      completion_tokens: 2,
      cache_read_input_tokens: 8,
    }, "codex-model", "connection-a", "client-key");

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
    expect(mocks.appendRequestLog).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
