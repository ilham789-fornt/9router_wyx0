import { describe, expect, it } from "vitest";

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runPassthrough(input) {
  const output = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  }).pipeThrough(createPassthroughStreamWithLogger("openai", null, "test-model"));

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("SSE passthrough hardening", () => {
  it("does not duplicate an upstream DONE sentinel", async () => {
    const output = await runPassthrough(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    );

    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("does not duplicate DONE when the provider omits the final newline", async () => {
    const output = await runPassthrough(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]',
    );

    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("drops malformed non-JSON data payloads", async () => {
    const output = await runPassthrough("data: upstream gateway failure\n\n");

    expect(output).not.toContain("upstream gateway failure");
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});
