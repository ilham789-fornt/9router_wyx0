import { afterEach, describe, expect, it, vi } from "vitest";
import { publicEncrypt, constants as cryptoConstants } from "node:crypto";

import {
  exchangeTokens,
  generateAuthData,
  getProviderNames,
} from "../../src/lib/oauth/providers.js";
import {
  __test__,
  clearTraeSession,
  clearWindsurfSession,
  getWindsurfSessionStatus,
  registerTraeSession,
  registerWindsurfSession,
  startTraeProxy,
  startWindsurfProxy,
  stopTraeProxy,
  stopWindsurfProxy,
} from "../../src/lib/oauth/utils/server.js";
import {
  createZedNativeAuthData,
  decryptZedAccessToken,
} from "../../open-sse/shared/zedAuth.js";

afterEach(() => {
  stopTraeProxy();
  stopWindsurfProxy();
  clearTraeSession();
  clearWindsurfSession();
});

describe("Trae and Windsurf provider integration", () => {
  it("adds IDE providers without replacing either WYx0 CodeBuddy identity", () => {
    expect(getProviderNames()).toEqual(expect.arrayContaining([
      "codebuddy",
      "codebuddy-cn",
      "trae",
      "windsurf",
      "zed",
    ]));
  });

  it("keeps the Zed RSA verifier and system id bound to one authorization", async () => {
    const auth = await generateAuthData("zed", "http://127.0.0.1:58443/");
    const url = new URL(auth.authUrl);

    expect(auth.codeVerifier).toMatch(/^zed-rsa-pkcs1:/);
    expect(auth.state).toBe(url.searchParams.get("system_id"));
    expect(url.searchParams.get("native_app_port")).toBe("58443");
  });

  it("decrypts a Zed callback token with the generated private verifier", () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 58443 });
    const encrypted = publicEncrypt({
      key: Buffer.from(auth.publicKey, "base64url"),
      format: "der",
      type: "pkcs1",
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, Buffer.from("zed-secret-token"));

    expect(decryptZedAccessToken(encrypted.toString("base64url"), auth.privateKeyVerifier)).toBe("zed-secret-token");
  });

  it("builds a state-bound Windsurf browser URL", async () => {
    const auth = await generateAuthData("windsurf", "http://127.0.0.1:43210/windsurf-auth-callback");
    const url = new URL(auth.authUrl);

    expect(url.hostname).toBe("www.windsurf.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:43210/windsurf-auth-callback");
    expect(url.searchParams.get("state")).toBe(auth.state);
  });

  it("imports long-lived IDE credentials without running browser discovery", async () => {
    const trae = await exchangeTokens("trae", "Cloud-IDE-JWT trae-token");
    const windsurf = await exchangeTokens("windsurf", "sk-ws-test-key");

    expect(trae.accessToken).toBe("trae-token");
    expect(trae.providerSpecificData.authMethod).toBe("imported");
    expect(windsurf.accessToken).toBe("sk-ws-test-key");
    expect(windsurf.providerSpecificData.authMethod).toBe("imported");
  });

  it("rejects a callback-supplied Windsurf API origin outside the HTTPS allowlist", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        apiKey: "sk-ws-attacker",
        apiServerUrl: "http://127.0.0.1:8080",
      }),
    });

    try {
      await expect(exchangeTokens("windsurf", "firebase-jwt-value")).rejects.toThrow("untrusted apiServerUrl");
      expect(global.fetch).toHaveBeenCalledOnce();
      expect(global.fetch.mock.calls[0][0]).toContain("https://register.windsurf.com/");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("IDE callback proxy hardening", () => {
  it("accepts only absent or loopback HTTP origins", () => {
    expect(__test__.isLoopbackOrigin(undefined)).toBe(true);
    expect(__test__.isLoopbackOrigin("http://127.0.0.1:20129")).toBe(true);
    expect(__test__.isLoopbackOrigin("http://localhost:20129")).toBe(true);
    expect(__test__.isLoopbackOrigin("https://attacker.example")).toBe(false);
  });

  it("rejects a cross-origin Trae callback before token exchange", async () => {
    const proxy = await startTraeProxy();
    registerTraeSession({ state: "expected-state" });

    const callback = new URL(proxy.callbackUrl);
    callback.searchParams.set("refreshToken", "attacker-token");

    const response = await fetch(callback, {
      headers: { Origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-origin callback rejected");
  });

  it("rejects a Trae callback that does not retain its callback state", async () => {
    const proxy = await startTraeProxy();
    registerTraeSession({ state: "polling-state" });
    const callback = new URL(proxy.callbackUrl);
    callback.searchParams.set("state", "wrong-state");
    callback.searchParams.set("refreshToken", "attacker-token");

    const response = await fetch(callback);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Trae callback state mismatch");
  });

  it("rejects a Windsurf callback with a mismatched state", async () => {
    const proxy = await startWindsurfProxy();
    registerWindsurfSession({ state: "expected-state" });

    const response = await fetch(`${proxy.callbackUrl}?access_token=fake&state=wrong-state`);
    const session = getWindsurfSessionStatus("expected-state");

    expect(response.status).toBe(200);
    expect(session.status).toBe("error");
    expect(session.error).toContain("state mismatch");
  });
});
