import { describe, expect, it } from "vitest";

const { openaiToOpenAIResponsesRequest } =
  await import("../../open-sse/translator/request/openai-responses.js");

describe("Responses service tier translation", () => {
  it("preserves an explicit service tier", () => {
    const result = openaiToOpenAIResponsesRequest(
      "example-model",
      {
        messages: [{ role: "user", content: "hello" }],
        service_tier: "priority",
      },
      true,
      {},
    );

    expect(result.service_tier).toBe("priority");
  });

  it("does not invent a service tier", () => {
    const result = openaiToOpenAIResponsesRequest(
      "example-model",
      { messages: [{ role: "user", content: "hello" }] },
      true,
      {},
    );

    expect(result.service_tier).toBeUndefined();
  });
});
