import { describe, it, expect } from "vitest";
import { detectRequiredCapabilities } from "../../open-sse/services/combo.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Hermes Vision Image Detection", () => {
  it("detects vision from Ollama / Hermes images array", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Please analyze this image from Hermes",
          images: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="],
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("detects vision from Vercel AI SDK / Hermes experimental_attachments", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Describe this attachment",
          experimental_attachments: [
            {
              contentType: "image/png",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          ],
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("detects vision from Hermes attachments array", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Look at this photo",
          attachments: [
            {
              mediaType: "image/jpeg",
              url: "https://example.com/photo.jpg",
            },
          ],
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("scans attachments when experimental_attachments is an empty array", () => {
    const caps = detectRequiredCapabilities({
      messages: [{
        role: "user",
        content: "Look at this photo",
        experimental_attachments: [],
        attachments: [{ mediaType: "image/jpeg", url: "https://example.com/photo.jpg" }],
      }],
    });

    expect(caps.has("vision")).toBe(true);
  });

  it("detects vision from embedded data:image URI in string content", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Here is an inline image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("strips msg.images and attachments when model does not support vision", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Test text",
          images: ["base64..."],
          experimental_attachments: [{ contentType: "image/png", url: "data:image/png;base64,..." }],
          attachments: [{ mediaType: "image/jpeg", url: "https://example.com/photo.jpg" }],
          image_url: "https://example.com/direct.jpg",
          audio_url: "https://example.com/direct.wav",
        },
      ],
    };
    const noVisionCaps = { vision: false, pdf: false, audioInput: false };

    stripUnsupportedModalities(body, FORMATS.OPENAI, noVisionCaps);

    expect(body.messages[0].images).toBeUndefined();
    expect(body.messages[0].experimental_attachments).toHaveLength(0);
    expect(body.messages[0].attachments).toHaveLength(0);
    expect(body.messages[0].image_url).toBeUndefined();
    expect(body.messages[0].audio_url).toBeUndefined();
  });

  it("strips unsupported data URIs from string content", () => {
    const body = {
      messages: [{
        role: "user",
        content: "image=data:image/png;base64,AAAA audio=data:audio/wav;base64,BBBB keep=text",
      }],
    };

    stripUnsupportedModalities(body, FORMATS.OPENAI, {
      vision: false,
      audioInput: false,
    });

    expect(body.messages[0].content).toBe("image= audio= keep=text");
  });
});
