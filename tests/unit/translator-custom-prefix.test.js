import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectFormat: vi.fn(() => "openai"),
  getModelInfo: vi.fn(),
  getTargetFormat: vi.fn(() => "openai"),
  translateRequest: vi.fn((_source, _target, model, body) => ({ ...body, model })),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("../../open-sse/services/provider.js", () => ({
  detectFormat: mocks.detectFormat,
  getTargetFormat: mocks.getTargetFormat,
}));
vi.mock("../../open-sse/translator/index.js", () => ({
  translateRequest: mocks.translateRequest,
}));
vi.mock("@/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(async () => []),
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

import { POST } from "../../src/app/api/translator/translate/route.js";

async function postStep(step, body) {
  return POST(new Request("https://9router.local/api/translator/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step, body }),
  }));
}

describe("translator custom provider prefix resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelInfo.mockImplementation(async (modelId) => {
      if (modelId.startsWith("my-prefix/")) {
        return {
          provider: "openai-compatible-chat-abc123",
          model: modelId.slice("my-prefix/".length),
        };
      }
      if (modelId.startsWith("acme/")) {
        return {
          provider: "anthropic-compatible-claude-xyz",
          model: modelId.slice("acme/".length),
        };
      }
      const [provider, model] = modelId.split("/");
      return { provider, model: model || provider };
    });
  });

  it("uses the application model resolver in debug step 1", async () => {
    const response = await postStep(1, {
      model: "my-prefix/gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getModelInfo).toHaveBeenCalledWith("my-prefix/gpt-4");
    expect(payload.result).toMatchObject({
      provider: "openai-compatible-chat-abc123",
      model: "gpt-4",
    });
  });

  it("passes the resolved provider and model through debug step 2", async () => {
    const clientBody = {
      model: "acme/claude-3",
      messages: [{ role: "user", content: "hello" }],
    };
    const response = await postStep(2, clientBody);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getModelInfo).toHaveBeenCalledWith("acme/claude-3");
    expect(mocks.translateRequest).toHaveBeenCalledWith(
      "openai",
      "openai",
      "claude-3",
      clientBody,
      true,
      null,
      "anthropic-compatible-claude-xyz",
    );
    expect(payload.result.body.model).toBe("claude-3");
  });

  it("keeps ordinary provider/model IDs working", async () => {
    const response = await postStep(1, { model: "openai/gpt-4", messages: [] });
    const payload = await response.json();

    expect(payload.result).toMatchObject({ provider: "openai", model: "gpt-4" });
  });
});
