import { describe, expect, it } from "vitest";

import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("Gemini JSON Schema cleanup", () => {
  it("removes unsupported modern and array keywords recursively", () => {
    const schema = {
      type: "object",
      unevaluatedProperties: false,
      properties: {
        tags: {
          type: "array",
          uniqueItems: true,
          contains: { type: "string" },
          items: {
            type: "number",
            multipleOf: 2,
          },
        },
      },
    };

    expect(cleanJSONSchemaForAntigravity(schema)).toEqual({
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "number" },
        },
      },
    });
  });
});
