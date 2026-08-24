// Normalize an Anthropic Messages body so the Mirasim relay accepts it.
//
// The relay rejects (HTTP 400) parameter combinations that the public Anthropic API
// tolerates. The rules are model-CLASS dependent, not model-name dependent:
//
//   adaptive  (opus-5, sonnet-5, opus-4-8/4-7, fable-5, gpt-5.6-*):
//       - temperature must be 1 (drop it otherwise)
//       - top_p / top_k / service_tier rejected at ANY value → drop
//       - thinking:{type:"enabled"} rejected (fixed budget) → drop the thinking block
//       - fable-5 additionally rejects the `thinking` key entirely
//   budget    (haiku-4-5):
//       - thinking:{type:"adaptive"} is meaningless → drop
//   none      (kimi-k3) / unknown:
//       - passthrough
//
//   all models: never send temperature AND top_p together (drop top_p)
//   all models: effort sentinels "auto"/"none"/"disabled" mean "let the model decide",
//       which the relay expresses by OMITTING the field — sending them literally is 400.
//
// `[1m]` aliases → base model + metadata.autoCompactWindow:true (the alias only exists in
// proxy model lists; upstream 404s on it).

const IMPLICIT_EFFORTS = new Set(["auto", "none", "disabled"]);

const ADAPTIVE = new Set([
  "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5",
  "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra",
]);
const BUDGET = new Set(["claude-haiku-4-5"]);
const NO_THINKING_KEY = new Set(["claude-fable-5"]);

function baseModel(model) {
  return typeof model === "string" ? model.replace(/\[1m\]$/, "") : model;
}

function modelClass(model) {
  const m = baseModel(model);
  if (ADAPTIVE.has(m)) return "adaptive";
  if (BUDGET.has(m)) return "budget";
  return "other";
}

function stripSentinelEffort(obj, key) {
  if (obj && typeof obj === "object" && typeof obj[key] === "string" && IMPLICIT_EFFORTS.has(obj[key])) {
    delete obj[key];
  }
}

// Mutates and returns a shallow-cloned body safe to send to the relay.
export function sanitizeMirasimBody(input) {
  if (!input || typeof input !== "object") return input;
  const body = { ...input };
  if (body.metadata) body.metadata = { ...body.metadata };
  if (body.output_config) body.output_config = { ...body.output_config };

  // [1m] alias → base model + autoCompactWindow
  if (typeof body.model === "string" && /\[1m\]$/.test(body.model)) {
    body.model = baseModel(body.model);
    body.metadata = { ...(body.metadata || {}), autoCompactWindow: true };
  }

  const cls = modelClass(body.model);

  if (cls === "adaptive") {
    if (body.temperature !== undefined && body.temperature !== 1) delete body.temperature;
    delete body.top_k;
    delete body.service_tier;
    // top_p handled by the mutual-exclusion rule below; for adaptive it's always dropped.
    delete body.top_p;
    if (body.thinking && typeof body.thinking === "object" && body.thinking.type === "enabled") {
      delete body.thinking;
    }
    if (NO_THINKING_KEY.has(baseModel(body.model))) delete body.thinking;
  } else if (cls === "budget") {
    if (body.thinking && typeof body.thinking === "object" && body.thinking.type === "adaptive") {
      delete body.thinking;
    }
  }

  // Protocol-level: temperature and top_p are mutually exclusive — drop top_p.
  if (body.temperature !== undefined && body.top_p !== undefined) delete body.top_p;

  // Effort sentinels → omit (all models).
  stripSentinelEffort(body, "reasoning_effort");
  stripSentinelEffort(body, "effort");
  stripSentinelEffort(body.output_config, "effort");

  return body;
}

export const _internal = { modelClass, baseModel, IMPLICIT_EFFORTS };
