import { describe, expect, it } from "vitest";

import { mapZedLiveModels } from "../../src/app/api/v1/models/zedModels.js";

describe("Zed live model route mapping", () => {
  it("filters disabled models and preserves tool capability", () => {
    const mapped = mapZedLiveModels({
      models: [
        { id: "claude-sonnet", name: "Claude Sonnet", supportsTools: true },
        { id: "retired", name: "Retired", isDisabled: true },
        { id: "gemini-flash", name: "Gemini Flash", supportsTools: false },
      ],
    });

    expect(mapped).toEqual({
      models: [
        { id: "claude-sonnet", name: "Claude Sonnet", capabilities: { tools: true } },
        { id: "gemini-flash", name: "Gemini Flash", capabilities: undefined },
      ],
    });
  });

  it("returns null when discovery has no usable catalog", () => {
    expect(mapZedLiveModels(null)).toBeNull();
    expect(mapZedLiveModels({ models: [] })).toBeNull();
  });
});
