import { describe, expect, it } from "vitest";
import crypto from "crypto";
import { sanitizeMirasimBody } from "open-sse/shared/mirasimSanitize.js";
import { deriveIdentity, signatureHeaders, jwtExpiryIso } from "open-sse/shared/mirasimSigner.js";

// A throwaway ed25519 key for signature-shape tests (no relay contact).
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

describe("mirasim sanitizer", () => {
  it("adaptive model: strips temperature!=1, top_p/top_k/service_tier, enabled-thinking", () => {
    const out = sanitizeMirasimBody({
      model: "claude-opus-5",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      service_tier: "auto",
      thinking: { type: "enabled", budget_tokens: 1000 },
      max_tokens: 100,
    });
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.top_k).toBeUndefined();
    expect(out.service_tier).toBeUndefined();
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBe(100);
  });

  it("adaptive model: keeps temperature===1 and adaptive thinking", () => {
    const out = sanitizeMirasimBody({ model: "claude-sonnet-5", temperature: 1, thinking: { type: "adaptive" } });
    expect(out.temperature).toBe(1);
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("fable-5: drops the thinking key entirely", () => {
    const out = sanitizeMirasimBody({ model: "claude-fable-5", thinking: { type: "adaptive" } });
    expect(out.thinking).toBeUndefined();
  });

  it("budget model (haiku): drops adaptive thinking, keeps temperature", () => {
    const out = sanitizeMirasimBody({ model: "claude-haiku-4-5", temperature: 0.5, thinking: { type: "adaptive" } });
    expect(out.thinking).toBeUndefined();
    expect(out.temperature).toBe(0.5);
  });

  it("unknown model (kimi): passthrough", () => {
    const out = sanitizeMirasimBody({ model: "kimi-k3", temperature: 0.3, top_p: undefined });
    expect(out.temperature).toBe(0.3);
  });

  it("all models: never sends temperature and top_p together (drops top_p)", () => {
    const out = sanitizeMirasimBody({ model: "kimi-k3", temperature: 0.3, top_p: 0.8 });
    expect(out.temperature).toBe(0.3);
    expect(out.top_p).toBeUndefined();
  });

  it("[1m] alias → base model + autoCompactWindow", () => {
    const out = sanitizeMirasimBody({ model: "claude-opus-5[1m]", max_tokens: 5 });
    expect(out.model).toBe("claude-opus-5");
    expect(out.metadata.autoCompactWindow).toBe(true);
  });

  it("strips effort sentinels, keeps real effort", () => {
    expect(sanitizeMirasimBody({ model: "claude-opus-5", output_config: { effort: "auto" } }).output_config).toEqual({});
    expect(sanitizeMirasimBody({ model: "claude-opus-5", output_config: { effort: "high" } }).output_config).toEqual({ effort: "high" });
    expect(sanitizeMirasimBody({ model: "claude-opus-5", reasoning_effort: "none" }).reasoning_effort).toBeUndefined();
  });

  it("raises single-token requests above the relay's probe threshold", () => {
    // max_tokens: 1 is rejected with 400 as an "availability probe"
    expect(sanitizeMirasimBody({ model: "claude-opus-5", max_tokens: 1 }).max_tokens).toBe(16);
    expect(sanitizeMirasimBody({ model: "kimi-k3", max_tokens: 4 }).max_tokens).toBe(16);
  });

  it("leaves adequate or absent max_tokens alone", () => {
    expect(sanitizeMirasimBody({ model: "claude-opus-5", max_tokens: 16 }).max_tokens).toBe(16);
    expect(sanitizeMirasimBody({ model: "claude-opus-5", max_tokens: 4096 }).max_tokens).toBe(4096);
    expect(sanitizeMirasimBody({ model: "claude-opus-5" }).max_tokens).toBeUndefined();
  });

  it("does not mutate the input object", () => {
    const input = { model: "claude-opus-5", temperature: 0.2, output_config: { effort: "auto" } };
    sanitizeMirasimBody(input);
    expect(input.temperature).toBe(0.2);
    expect(input.output_config.effort).toBe("auto");
  });
});

describe("mirasim signer", () => {
  it("deriveIdentity is stable and produces a 22-char base64url deviceId", () => {
    const a = deriveIdentity(PEM);
    const b = deriveIdentity(PEM);
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // deviceId = sha256(spkiDerB64).base64url.slice(0,22)
    const expected = crypto.createHash("sha256").update(a.pub).digest("base64url").slice(0, 22);
    expect(a.deviceId).toBe(expected);
  });

  it("signatureHeaders produces a verifiable ed25519 signature over the canonical string", () => {
    const body = JSON.stringify({ model: "claude-opus-5", messages: [] });
    const h = signatureHeaders({ pem: PEM, method: "POST", path: "/v1/messages", body });
    expect(h["x-mirasim-device"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(h["x-mirasim-client"]).toBeTruthy();

    const bodySha = crypto.createHash("sha256").update(Buffer.from(body)).digest("hex");
    const canonical = ["mrs-sig-v1", "POST", "/v1/messages", h["x-mirasim-ts"], h["x-mirasim-nonce"], bodySha].join("\n");
    const ok = crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      crypto.createPublicKey(PEM),
      Buffer.from(h["x-mirasim-sig"], "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("each signature uses a fresh nonce", () => {
    const a = signatureHeaders({ pem: PEM, method: "GET", path: "/v1/models", body: "" });
    const b = signatureHeaders({ pem: PEM, method: "GET", path: "/v1/models", body: "" });
    expect(a["x-mirasim-nonce"]).not.toBe(b["x-mirasim-nonce"]);
  });

  it("jwtExpiryIso decodes exp", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1800000000 })).toString("base64url");
    expect(jwtExpiryIso(`h.${payload}.s`)).toBe(new Date(1800000000 * 1000).toISOString());
    expect(jwtExpiryIso("not-a-jwt")).toBeNull();
  });
});

describe("mirasim provider notice", () => {
  it("surfaces client compatibility in the dashboard notice", async () => {
    const { PROVIDER_DISPLAY } = await import("@/shared/constants/providersDisplay");
    const display = PROVIDER_DISPLAY.mirasim;
    expect(display).toBeDefined();
    // rendered as an info box only when the provider is not deprecated/experimental
    expect(display.deprecated).toBeUndefined();
    expect(display.experimental).toBeUndefined();
    expect(display.notice?.text).toMatch(/Claude Code/);
    expect(display.notice?.text).toMatch(/rejects harnesses it does not recognise/);
    expect(display.notice?.signupUrl).toBe("https://mirasim.ai");
  });
});

describe("mirasim context windows", () => {
  const ctx = async (model) => {
    const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");
    return getCapabilitiesForModel("mirasim", model);
  };

  it("serves Opus and Sonnet tiers at 1M", async () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect((await ctx(model)).contextWindow, model).toBe(1000000);
    }
  });

  it("keeps Haiku at 200k", async () => {
    expect((await ctx("claude-haiku-4-5")).contextWindow).toBe(200000);
  });

  it("leaves gpt-5.6 and kimi on their native windows", async () => {
    expect((await ctx("gpt-5.6-sol")).contextWindow).toBe(400000);
    expect((await ctx("kimi-k3")).contextWindow).toBe(262144);
  });

  it("preserves non-window capabilities through the provider override", async () => {
    // a provider override short-circuits the fallback chain, so these must be restated
    const opus = await ctx("claude-opus-5");
    expect(opus).toMatchObject({ vision: true, search: true, reasoning: true, thinkingFormat: "claude-adaptive" });
    expect((await ctx("claude-opus-4-7")).maxOutput).toBe(128000);
  });

  it("asks the relay for the 1M window on those models", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect(sanitizeMirasimBody({ model }).metadata?.autoCompactWindow, model).toBe(true);
    }
  });

  it("does not ask for it on models without a 1M tier", () => {
    for (const model of ["claude-haiku-4-5", "gpt-5.6-sol", "kimi-k3"]) {
      expect(sanitizeMirasimBody({ model }).metadata?.autoCompactWindow, model).toBeUndefined();
    }
  });

  it("respects an explicit caller override", () => {
    const off = sanitizeMirasimBody({ model: "claude-opus-5", metadata: { autoCompactWindow: false } });
    expect(off.metadata.autoCompactWindow).toBe(false);
  });

  it("keeps other metadata intact when defaulting the window", () => {
    const out = sanitizeMirasimBody({ model: "claude-opus-5", metadata: { user_id: "u1" } });
    expect(out.metadata).toEqual({ user_id: "u1", autoCompactWindow: true });
  });
});

describe("mirasim thinking effort", () => {
  const capsFor = async (model) => {
    const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");
    return getCapabilitiesForModel("mirasim", model);
  };

  it("classifies the adaptive tiers as claude-adaptive", async () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect((await capsFor(model)).thinkingFormat, model).toBe("claude-adaptive");
    }
  });

  it("keeps Haiku on the budget format the relay accepts for it", async () => {
    expect((await capsFor("claude-haiku-4-5")).thinkingFormat).toBe("claude-budget");
  });

  it("delivers low/high as output_config.effort on adaptive models", async () => {
    const { applyThinking } = await import("open-sse/translator/concerns/thinkingUnified.js");
    for (const level of ["low", "medium", "high"]) {
      const body = { model: "claude-opus-5", max_tokens: 100, reasoning_effort: level };
      applyThinking("claude", "claude-opus-5", body, "mirasim");
      const out = sanitizeMirasimBody(body);
      // survives the sanitizer rather than being stripped as a fixed budget
      expect(out.output_config, level).toEqual({ effort: level });
      expect(out.thinking).toBeUndefined();
    }
  });

  it("still sends Haiku a token budget", async () => {
    const { applyThinking } = await import("open-sse/translator/concerns/thinkingUnified.js");
    const body = { model: "claude-haiku-4-5", max_tokens: 100, reasoning_effort: "high" };
    applyThinking("claude", "claude-haiku-4-5", body, "mirasim");
    const out = sanitizeMirasimBody(body);
    expect(out.thinking?.type).toBe("enabled");
    expect(out.thinking?.budget_tokens).toBeGreaterThan(0);
  });

  it("maps efforts outside the relay's enum onto supported levels", () => {
    expect(sanitizeMirasimBody({ model: "claude-opus-5", output_config: { effort: "minimal" } }).output_config)
      .toEqual({ effort: "low" });
    expect(sanitizeMirasimBody({ model: "claude-opus-5", output_config: { effort: "xhigh" } }).output_config)
      .toEqual({ effort: "high" });
    // real enum values are untouched
    for (const eff of ["low", "medium", "high", "max"]) {
      expect(sanitizeMirasimBody({ model: "claude-opus-5", output_config: { effort: eff } }).output_config)
        .toEqual({ effort: eff });
    }
  });
});

describe("mirasim usage", () => {
  it("is advertised as a usage-capable provider", async () => {
    const { USAGE_SUPPORTED_PROVIDERS } = await import("@/shared/constants/providers");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("mirasim");
  });

  it("reports a clear message instead of throwing when the device key is missing", async () => {
    const { getMirasimUsage } = await import("open-sse/services/usage/mirasim.js");
    const usage = await getMirasimUsage({ accessToken: "t", providerSpecificData: {} });
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toMatch(/device key/i);
  });

  it("labels relay windows readably", async () => {
    const { _internal } = await import("open-sse/services/usage/mirasim.js");
    expect(_internal.labelForWindow("5h")).toBe("session (5h)");
    expect(_internal.labelForWindow("7d")).toBe("weekly (7d)");
    expect(_internal.labelForWindow("7d_fable")).toBe("weekly fable (7d)");
    expect(_internal.labelForWindow("30d")).toBe("30d"); // unknown → passthrough
  });

  it("maps a relay window onto a quota object", async () => {
    const { _internal } = await import("open-sse/services/usage/mirasim.js");
    const q = _internal.buildQuota({ name: "5h", used: 100.4, budget: 400, reset_at: 1787593570 });
    expect(q).toMatchObject({ used: 100, total: 400, remaining: 300, unlimited: false });
    expect(q.remainingPercentage).toBeCloseTo(74.9, 1);
    expect(q.resetAt).toBe(new Date(1787593570 * 1000).toISOString());
  });

  it("treats a zero budget as unlimited instead of dividing by zero", async () => {
    const { _internal } = await import("open-sse/services/usage/mirasim.js");
    const q = _internal.buildQuota({ name: "7d", used: 50, budget: 0 });
    expect(q).toMatchObject({ unlimited: true, remainingPercentage: 100 });
    expect(Number.isNaN(q.remainingPercentage)).toBe(false);
  });
});

describe("mirasim envelope decrypt (aes-256-gcm)", () => {
  it("round-trips an mrs1: envelope with a known key", async () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const plaintext = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const envelope = "mrs1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");

    // Replicate decryptField's layout: [12B IV][16B tag][ct]
    const buf = Buffer.from(envelope.slice("mrs1:".length), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const out = d.update(buf.subarray(28)) + d.final("utf8");
    expect(out).toBe(plaintext);
  });
});
