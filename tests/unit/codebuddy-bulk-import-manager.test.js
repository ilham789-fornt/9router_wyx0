import { describe, expect, it } from "vitest";
import { CodeBuddyBulkImportManager, __test__ } from "../../src/lib/oauth/services/codebuddyBulkImportManager.js";

function createFakeBrowser() {
  const fakePage = {
    on() {},
    off() {},
    url() {
      return "about:blank";
    },
    bringToFront: async () => null,
    context() {
      return {};
    },
  };

  return {
    async newContext() {
      return {
        async newPage() {
          return fakePage;
        },
        on() {},
        off() {},
        async close() {
          return null;
        },
      };
    },
    async close() {
      return null;
    },
  };
}

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

describe("CodeBuddyBulkImportManager", () => {
  it("runs bulk GSuite accounts through CodeBuddy polling and saves connections", async () => {
    const saved = [];
    const manager = new CodeBuddyBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "state-1",
        verification_uri: "https://copilot.tencent.com/login",
      }),
      pollToken: async () => ({
        success: true,
        tokens: {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresIn: 86400,
        },
      }),
      createApiKeyTokens: async ({ tokens, email }) => ({
        ...tokens,
        apiKey: `cb-key-${email}`,
        providerSpecificData: {
          ...(tokens.providerSpecificData || {}),
          authKind: "api_key",
        },
      }),
      saveConnection: async ({ tokens, email }) => {
        saved.push({ tokens, email });
        return {
          connection: { id: `conn-${email}` },
        };
      },
      googleAutomation: async ({ successPromise }) => ({
        status: "success",
        ...(await successPromise),
      }),
    });

    const startedJob = await manager.startJob({
      accounts: [
        "user1@example.com|pw1",
        "user2@example.com|pw2",
      ],
      concurrency: 2,
    });

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(finishedJob.summary.success).toBe(2);
    expect(saved.map((entry) => entry.email).sort()).toEqual([
      "user1@example.com",
      "user2@example.com",
    ]);
    expect(saved.map((entry) => entry.tokens.apiKey).sort()).toEqual([
      "cb-key-user1@example.com",
      "cb-key-user2@example.com",
    ]);
    expect(saved.every((entry) => entry.tokens.isActive === false)).toBe(true);
    expect(finishedJob.accounts.every((account) => account.connectionId)).toBe(true);
  });

  it("retries transient CodeBuddy token request failures before saving", async () => {
    let attempts = 0;
    const manager = new CodeBuddyBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "state-1",
        verification_uri: "https://www.codebuddy.ai/login?platform=CLI&state=state-1",
      }),
      pollToken: async () => {
        attempts += 1;
        if (attempts < 3) {
          return {
            success: false,
            error: "request_failed",
            errorDescription: "temporary 502",
          };
        }
        return {
          success: true,
          tokens: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresIn: 86400,
          },
        };
      },
      createApiKeyTokens: async ({ tokens }) => ({
        ...tokens,
        apiKey: "cb-key-user1",
      }),
      saveConnection: async ({ email }) => ({
        connection: { id: `conn-${email}` },
      }),
      pollIntervalMs: 10,
      googleAutomation: async ({ successPromise }) => ({
        status: "success",
        ...(await successPromise),
      }),
    });

    const startedJob = await manager.startJob({
      accounts: ["user1@example.com|pw1"],
      concurrency: 1,
    });

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(attempts).toBe(3);
    expect(finishedJob.summary.success).toBe(1);
  });
});

describe("defaultCreateCodeBuddyApiKeyTokens 401 fallback", () => {
  const apis401Page = () => ({
    async evaluate(fn, { url }) {
      // Session-prep endpoints succeed, api-keys endpoint is blocked by APISIX.
      if (String(url).includes("/console/api/client/v1/api-keys")) {
        return {
          status: 401,
          text: "<html><body>401 Authorization Required openresty Powered by APISIX</body></html>",
          json: null,
        };
      }
      if (String(url).includes("/console/accounts")) {
        return {
          status: 200,
          text: JSON.stringify({ code: 0, data: { accounts: [{ uid: "uid-1", userEnterpriseId: "ent-1" }] } }),
          json: { code: 0, data: { accounts: [{ uid: "uid-1", userEnterpriseId: "ent-1" }] } },
        };
      }
      return { status: 200, text: "{}", json: {} };
    },
  });

  const tokensWithRefresh = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresIn: 86400,
    providerSpecificData: { domain: "www.codebuddy.ai" },
  };

  function makeBackend401Fetch() {
    return async (url) => {
      if (String(url).includes("/v2/plugin/accounts")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { accounts: [{ uid: "uid-1", enterpriseId: "ent-1", userEnterpriseId: "ent-1", lastLogin: true }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // api-keys backend call → APISIX 401
      return new Response(
        "<html><body>401 Authorization Required openresty Powered by APISIX</body></html>",
        { status: 401, headers: { "Content-Type": "text/html" } }
      );
    };
  }

  it("falls back to OAuth token pair when browser and backend key creation both hit 401", async () => {
    const steps = [];
    const result = await __test__.defaultCreateCodeBuddyApiKeyTokens({
      page: apis401Page(),
      tokens: tokensWithRefresh,
      fetchImpl: makeBackend401Fetch(),
      onStep: (step) => steps.push(step),
    });

    expect(result.apiKey).toBeNull();
    expect(result.refreshToken).toBe("refresh-1");
    expect(result.accessToken).toBe("access-1");
    expect(result.providerSpecificData.authKind).toBe("access_token");
    expect(result.providerSpecificData.apiKeySource).toBe("oauth_fallback_401");
    expect(result.providerSpecificData.userEnterpriseId).toBe("ent-1");
    expect(result.providerSpecificData.codeBuddyUserId).toBe("uid-1");
    expect(steps).toContain("codebuddy_api_key_401_oauth_fallback");
  });

  it("does not fall back when there is no refresh token", async () => {
    await expect(
      __test__.defaultCreateCodeBuddyApiKeyTokens({
        page: apis401Page(),
        tokens: { accessToken: "access-1", providerSpecificData: {} },
        fetchImpl: makeBackend401Fetch(),
      })
    ).rejects.toThrow(/CodeBuddy/);
  });

  it("does not fall back for non-401 failures", async () => {
    const browser500Page = () => ({
      async evaluate(fn, { url }) {
        if (String(url).includes("/console/api/client/v1/api-keys")) {
          return { status: 500, text: JSON.stringify({ code: 500, msg: "internal error" }), json: { code: 500, msg: "internal error" } };
        }
        if (String(url).includes("/console/accounts")) {
          return {
            status: 200,
            text: JSON.stringify({ code: 0, data: { accounts: [{ uid: "uid-1", userEnterpriseId: "ent-1" }] } }),
            json: { code: 0, data: { accounts: [{ uid: "uid-1", userEnterpriseId: "ent-1" }] } },
          };
        }
        return { status: 200, text: "{}", json: {} };
      },
    });
    const backend500Fetch = async (url) => {
      if (String(url).includes("/v2/plugin/accounts")) {
        return new Response(JSON.stringify({ code: 0, data: { accounts: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 500, msg: "internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    };

    await expect(
      __test__.defaultCreateCodeBuddyApiKeyTokens({
        page: browser500Page(),
        tokens: tokensWithRefresh,
        fetchImpl: backend500Fetch,
      })
    ).rejects.toThrow();
  });

  it("detects the APISIX 401 signature", () => {
    expect(__test__.isCodeBuddyApiKeyGateway401(new Error("CodeBuddy API key creation failed (401): 401 Authorization Required openresty Powered by APISIX"))).toBe(true);
    expect(__test__.isCodeBuddyApiKeyGateway401(new Error("some other failure (403): forbidden"))).toBe(false);
    expect(__test__.isCodeBuddyApiKeyGateway401(new Error("some other failure (403): forbidden"), "401 Authorization Required")).toBe(true);
  });

  it("extracts refresh token from multiple token shapes", () => {
    expect(__test__.getCodeBuddyRefreshToken({ refreshToken: "r1" })).toBe("r1");
    expect(__test__.getCodeBuddyRefreshToken({ refresh_token: "r2" })).toBe("r2");
    expect(__test__.getCodeBuddyRefreshToken({ providerSpecificData: { rawAuth: { refreshToken: "r3" } } })).toBe("r3");
    expect(__test__.getCodeBuddyRefreshToken({})).toBe("");
  });
});
