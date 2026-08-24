// Mirasim (relay.mirasim.ai) — Mirasim Pro subscription, reached app-less via device signing.
// Auth + per-request signature are handled entirely by MirasimExecutor (see
// executors/mirasim.js + shared/mirasimSigner.js), so no static auth descriptor is declared.

export default {
  id: "mirasim",
  priority: 15,
  alias: "mm",
  uiAlias: "mm",
  display: {
    name: "Mirasim",
    icon: "hub",
    // 8-digit hex → rendered as a solid background (see AutomationProviderIcon),
    // which the white Mirasim mark needs. Brand is monochrome black/white.
    color: "#000000ff",
    textIcon: "MM",
    website: "https://mirasim.ai",
    notice: {
      signupUrl: "https://mirasim.ai",
    },
  },
  category: "oauth",
  transport: {
    baseUrl: "https://relay.mirasim.ai/v1/messages",
    format: "claude",
    headers: {
      "anthropic-version": "2023-06-01",
    },
  },
  models: [
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "kimi-k3", name: "Kimi K3" },
  ],
  features: {
    usage: true,
  },
};
