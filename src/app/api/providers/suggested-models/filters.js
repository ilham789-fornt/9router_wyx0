// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // Alibaba DashScope /models — keep only image-generation models.
  // Matches: wan*, wanx*, qwen-image*, qwen-image-edit*, z-image*
  // Excludes: chat, embedding, vl, asr, tts, omni, mt, coder models.
  "alibaba-image": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => {
        const id = (m.id || "").toLowerCase();
        return (
          id.startsWith("wan") ||
          id.startsWith("wanx") ||
          id.startsWith("qwen-image") ||
          id.startsWith("z-image")
        );
      })
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),

  // Alibaba DashScope /models — passthrough all chat/reasoning models.
  // Used by alicode-intl's modelsFetcher for auto-detect. Returns all models
  // except image-gen (handled by alibaba-image filter), embedding, and ASR/TTS.
  "alicode-intl": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => {
        const id = (m.id || "").toLowerCase();
        // Exclude image-gen, embedding, asr, tts, omni-realtime, mt, captioner
        if (id.startsWith("wan") || id.startsWith("wanx") || id.startsWith("z-image")) return false;
        if (id.startsWith("qwen-image")) return false;
        if (id.startsWith("text-embedding")) return false;
        if (id.includes("asr-") || id.includes("tts-") || id.includes("-tts")) return false;
        if (id.includes("omni") && id.includes("realtime")) return false;
        if (id.startsWith("qwen-mt-")) return false;
        if (id.includes("captioner")) return false;
        if (id.includes("s2s-")) return false;
        if (id.includes("livetranslate")) return false;
        if (id.includes("tingwu")) return false;
        return true;
      })
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
};
