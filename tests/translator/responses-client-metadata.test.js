import { describe, expect, it } from "vitest";

import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

describe("Responses client metadata privacy", () => {
  it("does not forward Responses-only client_metadata into Chat providers", () => {
    const result = openaiResponsesToOpenAIRequest(
      "example-model",
      {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        client_metadata: {
          device_id: "private-device-id",
          session_id: "private-session-id",
        },
      },
      false,
      {},
    );

    expect(result.client_metadata).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private-device-id");
  });
});
