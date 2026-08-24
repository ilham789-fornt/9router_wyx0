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
