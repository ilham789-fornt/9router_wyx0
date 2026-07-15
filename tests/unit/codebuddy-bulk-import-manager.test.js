import { describe, expect, it } from "vitest";
import { CodeBuddyBulkImportManager } from "../../src/lib/oauth/services/codebuddyBulkImportManager.js";

function createFakeBrowser({ onGoto, cookies = [], evaluate = async () => null, initialUrl = "about:blank", urlRef = null } = {}) {
  let currentUrl = initialUrl;
  const fakePage = {
    on() {},
    off() {},
    url() {
      return urlRef?.value || currentUrl;
    },
    bringToFront: async () => null,
    goto: async (url) => {
      currentUrl = url;
      onGoto?.(url);
      return null;
    },
    evaluate,
    waitForTimeout: async () => null,
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
        async cookies() {
          return cookies;
        },
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

  it("wraps Global OAuth through a visible proxy without Google automation or API-key creation", async () => {
    const openedUrls = [];
    const launchCalls = [];
    const saved = [];
    let googleCalls = 0;
    let apiKeyCalls = 0;
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async ({ proxyPoolId }) => ({
        proxyUrl: "socks5://user:pass@127.0.0.1:1080",
        proxyPoolId,
        proxySource: "pool",
        proxyMode: "single",
        error: null,
      }),
      browserLauncher: async (browser, options) => {
        launchCalls.push({ browser, options });
        return createFakeBrowser({
          onGoto: (url) => openedUrls.push(url),
          cookies: [{ name: "session", value: "cookie-1", domain: ".codebuddy.ai" }],
        });
      },
      requestDeviceCodeFn: async (providerId) => {
        expect(providerId).toBe("codebuddy");
        return {
          device_code: "global-state-1",
          verification_uri: "https://www.codebuddy.ai/login?platform=CLI&state=global-state-1",
        };
      },
      pollToken: async (providerId) => {
        expect(providerId).toBe("codebuddy");
        return {
          success: true,
          tokens: { accessToken: "access-global", refreshToken: "refresh-global" },
        };
      },
      googleAutomation: async () => {
        googleCalls += 1;
        throw new Error("Google automation must not run");
      },
      createApiKeyTokens: async () => {
        apiKeyCalls += 1;
        throw new Error("API-key creation must not run");
      },
      saveConnection: async (payload) => {
        saved.push(payload);
        return { connection: { id: "conn-wrap-global" } };
      },
      pollIntervalMs: 1,
    });

    const startedJob = await manager.startJob({ wrapLogin: true, proxyPoolId: "pool-global" });
    const finishedJob = await waitFor(() => {
      const current = manager.getJob(startedJob.jobId);
      return current?.status === "completed" ? current : null;
    });

    expect(finishedJob.summary.success).toBe(1);
    expect(launchCalls).toEqual([expect.objectContaining({
      options: { headless: false, proxy: "socks5://user:pass@127.0.0.1:1080" },
    })]);
    expect(openedUrls).toEqual(["https://www.codebuddy.ai/login?platform=CLI&state=global-state-1"]);
    expect(googleCalls).toBe(0);
    expect(apiKeyCalls).toBe(0);
    expect(saved).toEqual([expect.objectContaining({
      wrapLogin: true,
      proxyPoolId: "pool-global",
      proxySource: "pool",
      tokens: expect.objectContaining({
        accessToken: "access-global",
        refreshToken: "refresh-global",
        webCookie: "session=cookie-1",
      }),
    })]);
    expect(JSON.stringify(finishedJob)).not.toContain("127.0.0.1");
    expect(JSON.stringify(finishedJob)).not.toContain("user:pass");
  });

  it("completes the Global /started callback when a web session exists while OAuth is pending", async () => {
    const openedUrls = [];
    const callbackRequests = [];
    let polls = 0;
    const urlRef = { value: "" };
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrl: "http://127.0.0.1:8080",
        proxyPoolId: "pool-started",
        proxySource: "pool",
        proxyMode: "single",
        error: null,
      }),
      browserLauncher: async () => createFakeBrowser({
        urlRef,
        onGoto: (url) => openedUrls.push(url),
        evaluate: async (_callback) => {
          callbackRequests.push("/console/auth/login?platform=CLI&state=global-state-2&domain=www.codebuddy.ai");
          return { action: "authorized", domain: "www.codebuddy.ai" };
        },
      }),
      requestDeviceCodeFn: async () => ({
        device_code: "global-state-2",
        verification_uri: "https://www.codebuddy.ai/home",
      }),
      pollToken: async () => {
        polls += 1;
        if (polls === 1) {
          urlRef.value = "https://www.codebuddy.ai/home";
          return { success: false, pending: true, error: "authorization_pending" };
        }
        return { success: true, tokens: { accessToken: "access-2", refreshToken: "refresh-2" } };
      },
      saveConnection: async () => ({ connection: { id: "conn-started" } }),
      pollIntervalMs: 1,
    });

    const started = await manager.startJob({ wrapLogin: true, proxyPoolId: "pool-started" });
    const finished = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "completed" ? current : null;
    });

    expect(finished.summary.success).toBe(1);
    expect(openedUrls).toContain("https://www.codebuddy.ai/started?platform=CLI&state=global-state-2");
    expect(callbackRequests).toEqual(["/console/auth/login?platform=CLI&state=global-state-2&domain=www.codebuddy.ai"]);
    expect(polls).toBe(2);
    expect(finished.activity.map((entry) => entry.step)).toEqual(expect.arrayContaining([
      "codebuddy_token_pending",
      "codebuddy_web_session_detected",
      "completing_codebuddy_oauth",
      "authorizing_codebuddy_cli_state",
      "polling_after_codebuddy_callback",
      "codebuddy_token_received",
    ]));
    expect(JSON.stringify(finished.activity)).not.toContain("global-state-2");
  });
});
