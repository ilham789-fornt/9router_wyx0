import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

vi.mock("@/sse/services/codexGateway.js", () => ({
  buildCodexGatewayModelEntries: vi.fn(() => []),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("OpenAI model token-limit metadata", () => {
  beforeEach(() => {
    mocks.getProviderConnections.mockResolvedValue([
      { provider: "anthropic", isActive: true, providerSpecificData: {} },
    ]);
  });

  it("exposes numeric snake_case limits for active LLM models", async () => {
    const models = await buildModelsList(["llm"]);
    const model = models.find((entry) => entry.owned_by === "anthropic");

    expect(model).toBeDefined();
    expect(model.context_length).toBeTypeOf("number");
    expect(model.max_completion_tokens).toBeTypeOf("number");
  });
});
