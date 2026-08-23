import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { getApiKeyStatsKey, maskApiKey } from "../../src/lib/db/repos/usageRepo.js";
import { __test__ as oauthServer } from "../../src/lib/oauth/utils/server.js";

// ============================================================
// AUDIT-002 (#1962): API key masking in usage stats
// ============================================================
describe("AUDIT-002: API key masking", () => {
  it("masks keys without returning the original secret", () => {
    expect(maskApiKey("sk-example-secret-value")).toBe("sk-examp***");
    expect(maskApiKey("short")).toBe("s***");
    expect(maskApiKey(null)).toBeNull();
  });

  it("getUsageHistory should use apiKeyMasked instead of apiKey", () => {
    const source = fs.readFileSync(
      path.resolve("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // The REST response should use apiKeyMasked
    expect(source).toContain("apiKeyMasked: maskApiKey(r.apiKey)");
    // The return mapping in getUsageHistory should not have raw apiKey
    // (The internal ring buffer still uses apiKey: r.apiKey for internal state - that's fine)
    const historyReturn = source.match(/return rows\.map\(\(r\)\s*=>\s*\(\{[\s\S]*?\}\)\);/);
    expect(historyReturn).not.toBeNull();
    expect(historyReturn[0]).toContain("apiKeyMasked");
    expect(historyReturn[0]).not.toContain("apiKey: r.apiKey");
  });

  it("uses a masked response key for every stats period", () => {
    const rawKey = "sk-example-secret-value";
    const statsKey = getApiKeyStatsKey(rawKey, "gpt-5", "openai");

    expect(statsKey).toBe("sk-examp***|gpt-5|openai");
    expect(statsKey).not.toContain(rawKey);
  });
});

// ============================================================
// AUDIT-003 (#1961): Proxy URL validation
// ============================================================
describe("AUDIT-003: Proxy URL validation", () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NINE_ROUTER_PROXY_MANAGED;
    delete process.env.NINE_ROUTER_PROXY_URL;
    delete process.env.NINE_ROUTER_NO_PROXY;
    delete process.env.NO_PROXY;
  });

  it("source should contain validateProxyUrl function", () => {
    const source = fs.readFileSync(
      path.resolve("src/lib/network/outboundProxy.js"),
      "utf-8"
    );
    expect(source).toContain("function validateProxyUrl");
    expect(source).toContain("ALLOWED_PROXY_SCHEMES");
  });

  it("should accept valid http proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080",
    });
    // new URL().href normalizes (adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("http://proxy.example.com:8080");
    expect(process.env.HTTPS_PROXY).toContain("http://proxy.example.com:8080");
  });

  it("should accept valid https proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "https://proxy.example.com:443",
    });
    // new URL().href normalizes (drops default port 443, adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("https://proxy.example.com");
  });

  it("should accept valid socks5 proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "socks5://proxy.example.com:1080",
    });
    expect(process.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
  });

  it("should reject URLs with shell metacharacters (newline)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080\nmalicious",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (backtick)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://`whoami`.example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (dollar)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://$(whoami).example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (file://)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "file:///etc/passwd",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (javascript:)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "javascript:alert(1)",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});

// ============================================================
// AUDIT-018 (#1972): XSS escaping in OAuth callback
// ============================================================
describe("AUDIT-018: XSS escaping in OAuth callback", () => {
  it("escapes attacker-controlled callback text", () => {
    expect(oauthServer.escapeHtml(`<img src=x onerror="alert('x')"> &`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;"
    );
  });

  it("renders escaped callback text instead of executable markup", () => {
    const page = oauthServer.renderCodexResultPage(false, "<script>alert(1)</script>");

    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("<script>alert(1)</script>");
  });
});

// ============================================================
// AUDIT-004 (#1963): TOCTOU race - atomic lock file
// ============================================================
describe("AUDIT-004: Atomic lock file for MITM startup", () => {
  it("manager.js should define LOCK_FILE constant", () => {
    const source = fs.readFileSync(
      path.resolve("src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain("LOCK_FILE");
    expect(source).toContain(".mitm.lock");
  });

  it("should use O_EXCL flag (wx) for atomic creation", () => {
    const source = fs.readFileSync(
      path.resolve("src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain('"wx"');
    expect(source).toContain("EEXIST");
  });

  it("should clean up lock file on all exit paths", () => {
    const source = fs.readFileSync(
      path.resolve("src/mitm/manager.js"),
      "utf-8"
    );
    const matches = source.match(/unlinkSync\(LOCK_FILE\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// AUDIT-001 (#1965): Race condition in retry tracking
// ============================================================
describe("AUDIT-001: Synchronous restart guard", () => {
  it("mitmIsRestarting should be set before first await expression", () => {
    const source = fs.readFileSync(
      path.resolve("src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    expect(funcStart).toBeGreaterThan(-1);

    const funcBody = source.substring(funcStart, funcStart + 2000);

    const guardCheckIdx = funcBody.indexOf("if (mitmIsRestarting) return;");
    expect(guardCheckIdx).toBeGreaterThan(-1);

    const afterGuard = funcBody.substring(guardCheckIdx);

    // Strip line comments to avoid matching "await" in comment text
    const noComments = afterGuard.replace(/\/\/.*$/gm, "");

    // Find the first actual await expression
    const firstAwaitIdx = noComments.search(/\bawait\s+/);
    expect(firstAwaitIdx).toBeGreaterThan(-1);

    // Find mitmIsRestarting = true
    const setFlagIdx = noComments.indexOf("mitmIsRestarting = true");

    expect(setFlagIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(setFlagIdx).toBeLessThan(firstAwaitIdx);
  });

  it("mitmIsRestarting should be reset on max-restarts early return", () => {
    const source = fs.readFileSync(
      path.resolve("src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    const funcBody = source.substring(funcStart, funcStart + 2000);

    const maxRestartsIdx = funcBody.indexOf("Max restart attempts reached");
    expect(maxRestartsIdx).toBeGreaterThan(-1);

    const afterMax = funcBody.substring(maxRestartsIdx, maxRestartsIdx + 200);
    expect(afterMax).toContain("mitmIsRestarting = false");
  });
});
