import { afterEach, describe, expect, it } from "vitest";

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
    ]));
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

    const response = await fetch(`${proxy.callbackUrl}?refreshToken=attacker-token`, {
      headers: { Origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-origin callback rejected");
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
