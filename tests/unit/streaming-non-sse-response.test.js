import { describe, expect, it, vi } from "vitest";

const usageDbMocks = vi.hoisted(() => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => usageDbMocks);

import { FORMATS } from "../../open-sse/translator/formats.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import {
  buildOnStreamComplete,
  handleStreamingResponse,
} from "../../open-sse/handlers/chatCore/streamingHandler.js";

function openAIStreamResponse(content, completionTokens) {
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "codebuddy-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "codebuddy-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: completionTokens,
        total_tokens: 20 + completionTokens,
      },
    },
  ];
  const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function streamController() {
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => true,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
    handleDisconnect: vi.fn(),
    abort: vi.fn(),
  };
}

describe("streaming upstream content type", () => {
  it("returns a generic JSON error instead of piping provider HTML", async () => {
    const handleError = vi.fn();
    const onRequestSuccess = vi.fn();
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
      onRequestSuccess,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain("non-SSE");
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.text()).not.toContain("secret provider detail");
    expect(handleError).toHaveBeenCalledOnce();
    expect(onRequestSuccess).not.toHaveBeenCalled();
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

  it("rejects a streaming response with no Content-Type", async () => {
    const result = await handleStreamingResponse({
      providerResponse: {
        status: 200,
        headers: new Headers(),
        body: null,
      },
      provider: "example",
      model: "example-model",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      requestStartTime: Date.now(),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});

describe("CodeBuddy streaming preservation", () => {
  it("retries a tiny completion before exposing bytes to the client", async () => {
    usageDbMocks.saveRequestDetail.mockClear();
    usageDbMocks.saveRequestUsage.mockClear();
    const controller = streamController();
    const retryProviderResponse = vi.fn().mockResolvedValue({
      response: openAIStreamResponse("This is the complete retried answer.", 12),
    });
    const requestStartTime = Date.now();
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
      provider: "codebuddy",
      model: "codebuddy-model",
      connectionId: "connection-a",
      requestStartTime,
      body: { messages: [] },
      stream: true,
    });

    const result = await handleStreamingResponse({
      providerResponse: openAIStreamResponse("Short", 2),
      provider: "codebuddy",
      model: "codebuddy-model",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { messages: [] },
      stream: true,
      requestStartTime,
      streamController: controller,
      onStreamComplete,
      streamDetailId,
      retryProviderResponse,
    });
    const responseText = await result.response.text();

    expect(retryProviderResponse).toHaveBeenCalledOnce();
    expect(responseText).toContain("This is the complete retried answer.");
    expect(responseText).not.toContain("Short");
    expect(controller.handleComplete).toHaveBeenCalledOnce();
    expect(usageDbMocks.saveRequestDetail).toHaveBeenCalledTimes(2);
    const details = usageDbMocks.saveRequestDetail.mock.calls.map(([detail]) => detail);
    const detailIds = details.map((detail) => detail.id);
    expect(new Set(detailIds)).toEqual(new Set([streamDetailId]));
    expect(details[0].response.content).toBe("[Streaming in progress...]");
    expect(details[1]).toEqual(expect.objectContaining({
      providerResponse: "This is the complete retried answer.",
      tokens: expect.objectContaining({ completion_tokens: 12 }),
    }));
  });

  it("does not retry a normal completion", async () => {
    const retryProviderResponse = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: openAIStreamResponse("A normal response that is already complete.", 12),
      provider: "codebuddy",
      model: "codebuddy-model",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { messages: [] },
      stream: true,
      requestStartTime: Date.now(),
      streamController: streamController(),
      onStreamComplete: vi.fn(),
      streamDetailId: "detail-normal",
      retryProviderResponse,
    });

    expect(await result.response.text()).toContain("A normal response that is already complete.");
    expect(retryProviderResponse).not.toHaveBeenCalled();
  });

  it("returns the buffered original when the retry is not an SSE success", async () => {
    const retryProviderResponse = vi.fn().mockResolvedValue({
      response: new Response("provider maintenance", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await handleStreamingResponse({
      providerResponse: openAIStreamResponse("Short", 2),
      provider: "codebuddy",
      model: "codebuddy-model",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { messages: [] },
      stream: true,
      requestStartTime: Date.now(),
      streamController: streamController(),
      onStreamComplete: vi.fn(),
      streamDetailId: "detail-retry-fallback",
      retryProviderResponse,
    });

    expect(await result.response.text()).toContain("Short");
    expect(retryProviderResponse).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("returns the buffered original when reading the retry stream fails", async () => {
    const retryBody = new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      },
    });
    const retryProviderResponse = vi.fn().mockResolvedValue({
      response: new Response(retryBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    });
    const controller = streamController();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await handleStreamingResponse({
      providerResponse: openAIStreamResponse("Short", 2),
      provider: "codebuddy",
      model: "codebuddy-model",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { messages: [] },
      stream: true,
      requestStartTime: Date.now(),
      streamController: controller,
      onStreamComplete: vi.fn(),
      streamDetailId: "detail-retry-read-fallback",
      retryProviderResponse,
    });

    expect(await result.response.text()).toContain("Short");
    expect(retryProviderResponse).toHaveBeenCalledOnce();
    expect(controller.handleError).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("cancels only a stalled retry probe before replaying the original", async () => {
    const originalStallTimeout = PROVIDERS.codebuddy.stallTimeoutMs;
    PROVIDERS.codebuddy.stallTimeoutMs = 10;
    let retryCancelled = false;
    const retryBody = new ReadableStream({
      cancel() {
        retryCancelled = true;
      },
    });
    const retryProviderResponse = vi.fn().mockResolvedValue({
      response: new Response(retryBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    });
    const controller = streamController();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await handleStreamingResponse({
        providerResponse: openAIStreamResponse("Short", 2),
        provider: "codebuddy",
        model: "codebuddy-model",
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        body: { messages: [] },
        stream: true,
        requestStartTime: Date.now(),
        streamController: controller,
        onStreamComplete: vi.fn(),
        streamDetailId: "detail-retry-stall-fallback",
        retryProviderResponse,
      });

      expect(await result.response.text()).toContain("Short");
      expect(retryCancelled).toBe(true);
      expect(controller.abort).not.toHaveBeenCalled();
      expect(controller.handleError).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      if (originalStallTimeout === undefined) delete PROVIDERS.codebuddy.stallTimeoutMs;
      else PROVIDERS.codebuddy.stallTimeoutMs = originalStallTimeout;
      warnSpy.mockRestore();
    }
  });
});
