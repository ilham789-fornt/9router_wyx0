import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
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

import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { logUsage } from "../../open-sse/utils/usageTracking.js";

function responsesStream(events) {
  const body = events.map(({ event, data }) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  )).join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("upstream usage accounting regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes cached Responses tokens in forced-SSE Chat usage and request details", async () => {
    const result = await handleForcedSSEToJson({
      providerResponse: responsesStream([
        {
          event: "response.created",
          data: { response: { id: "resp-cache", created_at: 1 } },
        },
        {
          event: "response.output_item.done",
          data: {
            output_index: 0,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "cached answer" }],
            },
          },
        },
        {
          event: "response.completed",
          data: {
            response: {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
                total_tokens: 15,
                cache_read_input_tokens: 40,
                cache_creation_input_tokens: 5,
              },
            },
          },
        },
      ]),
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
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      tokens: {
        prompt_tokens: 12,
        completion_tokens: 3,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 5,
        reasoning_tokens: 0,
      },
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

  it("retains OpenAI usage details in the single persistence write", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    saveUsageStats({
      provider: "codex",
      model: "codex-model",
      tokens: {
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 35, cache_creation_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 6 },
      },
    });

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      tokens: {
        prompt_tokens: 50,
        completion_tokens: 10,
        cache_read_input_tokens: 35,
        cache_creation_input_tokens: 4,
        reasoning_tokens: 6,
      },
    }));
    consoleSpy.mockRestore();
  });
});
