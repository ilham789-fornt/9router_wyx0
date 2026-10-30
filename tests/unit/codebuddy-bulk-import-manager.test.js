import { describe, expect, it } from "vitest";
import {
  CodeBuddyBulkImportManager,
  describeCodeBuddyProxyHandshakeError,
} from "../../src/lib/oauth/services/codebuddyBulkImportManager.js";

function createFakeBrowser({ onGoto, cookies = [], evaluate = async () => null, initialUrl = "about:blank", urlRef = null, regionPageCount = 0 } = {}) {
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
    locator(selector) {
      return {
        first() {
          return {
            count: async () => (selector === ".page-region" ? regionPageCount : 0),
          };
        },
      };
    },
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
  it("turns opaque proxy handshake failures into actionable credential guidance", () => {
    const error = new TypeError("fetch failed", {
      cause: new Error("CONNECT tunnel failed, response 407 NO_USER"),
    });

    expect(describeCodeBuddyProxyHandshakeError(error)).toBe(
      "The selected proxy rejected authentication (HTTP 407). Add valid proxy credentials or choose another proxy pool."
    );
  });

  it("sanitizes generic and non-407 proxy handshake failures", () => {
    const transportError = new TypeError("fetch failed", {
      cause: new Error("CONNECT proxy.private.example:8443 failed with ECONNRESET for user:secret"),
    });
    const unknownError = new Error("proxy http://user:secret@proxy.private.example rejected an unexpected protocol");

    expect(describeCodeBuddyProxyHandshakeError(transportError)).toBe(
      "The selected proxy could not reach the CodeBuddy OAuth endpoint over HTTPS. Verify HTTP CONNECT port 443 support, proxy credentials, and the proxy allowlist."
    );
    expect(describeCodeBuddyProxyHandshakeError(unknownError)).toBe(
      "CodeBuddy OAuth handshake through the selected proxy failed. Verify the proxy configuration or choose another proxy pool."
    );
    expect(describeCodeBuddyProxyHandshakeError(unknownError)).not.toContain("secret");
    expect(describeCodeBuddyProxyHandshakeError(unknownError)).not.toContain("proxy.private.example");
  });

  it("marks a proxy OAuth job failed when its device handshake cannot start", async () => {
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrl: "http://user:secret@proxy.example:8080",
        proxyUrls: ["http://user:secret@proxy.example:8080"],
        proxyPoolId: "pool-failing",
        proxySource: "pool",
        error: null,
      }),
      proxyBrowserPicker: async ({ proxyUrls, browserLauncher }) => ({
        browser: await browserLauncher("camofox", { headless: false, proxy: proxyUrls[0] }),
        proxyUrl: proxyUrls[0],
        checked: 1,
        error: null,
      }),
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("CONNECT tunnel failed, response 407 NO_USER"),
        });
      },
    });

    const started = await manager.startJob({ wrapLogin: true, proxyPoolId: "pool-failing" });
    const failed = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "failed" ? current : null;
    });

    expect(failed.summary.failed).toBe(1);
    expect(failed.error).toContain("HTTP 407");
    expect(failed.accounts[0].currentStep).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(JSON.stringify(failed)).not.toContain("proxy.example");
  });

  it("attaches proxy OAuth mode before the job runner can observe the job", async () => {
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrl: "http://127.0.0.1:8080",
        proxyUrls: ["http://127.0.0.1:8080"],
        proxyPoolId: "pool-atomic",
        proxySource: "pool",
        error: null,
      }),
      proxyBrowserPicker: async ({ browserLauncher }) => ({
        browser: await browserLauncher("camofox", { headless: false, proxy: "http://127.0.0.1:8080" }),
        proxyUrl: "http://127.0.0.1:8080",
        checked: 1,
        error: null,
      }),
      browserLauncher: async () => createFakeBrowser(),
    });
    let observedJob = null;
    manager.runJob = async (jobId) => {
      observedJob = manager.jobs.get(jobId);
    };

    await manager.startJob({ wrapLogin: true, proxyPoolId: "pool-atomic" });

    expect(observedJob).toMatchObject({
      wrapLogin: true,
      proxyPoolId: "pool-atomic",
      proxySource: "pool",
      proxyChecked: 1,
      humanMode: false,
    });
    expect(observedJob.accounts[0].proxyWrappedLogin).toBe(true);
  });

  it("runs bulk GSuite accounts through CodeBuddy polling and saves connections", async () => {
    const saved = [];
    const handshakes = [];
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrls: ["http://proxy-1:8080", "http://proxy-2:8080"],
        proxyPoolId: "pool-bulk",
        proxySource: "pool",
        error: null,
      }),
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async (_providerId, options) => {
        handshakes.push({ phase: "state", proxyUrl: options?.proxyUrl });
        return {
          device_code: "state-1",
          verification_uri: "https://copilot.tencent.com/login",
        };
      },
      pollToken: async (_providerId, _deviceCode, extraData) => {
        handshakes.push({ phase: "poll", proxyUrl: extraData?.proxyUrl });
        return {
          success: true,
          tokens: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresIn: 86400,
          },
        };
      },
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
      proxyPoolId: "pool-bulk",
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
    expect(handshakes).toEqual(expect.arrayContaining([
      { phase: "state", proxyUrl: "http://proxy-1:8080" },
      { phase: "poll", proxyUrl: "http://proxy-1:8080" },
      { phase: "state", proxyUrl: "http://proxy-2:8080" },
      { phase: "poll", proxyUrl: "http://proxy-2:8080" },
    ]));
    expect(JSON.stringify(finishedJob)).not.toContain("proxy-1");
    expect(JSON.stringify(finishedJob)).not.toContain("proxy-2");
  });

  it("sanitizes a bulk GSuite proxy handshake failure before persisting it", async () => {
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrls: ["http://user:secret@bulk-proxy.example:8080"],
        proxyPoolId: "pool-bulk-failure",
        proxySource: "pool",
        error: null,
      }),
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("CONNECT bulk-proxy.example failed with ECONNRESET for user:secret"),
        });
      },
    });

    const started = await manager.startJob({
      accounts: ["user@example.com|password"],
      concurrency: 1,
      proxyPoolId: "pool-bulk-failure",
    });
    const failed = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "failed" ? current : null;
    });

    expect(failed.error).toContain("could not reach the CodeBuddy OAuth endpoint over HTTPS");
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(JSON.stringify(failed)).not.toContain("bulk-proxy.example");
  });

  it("retries transient CodeBuddy token request failures before saving", async () => {
    let attempts = 0;
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrls: ["http://proxy-1:8080"],
        proxyPoolId: "pool-bulk",
        proxySource: "pool",
        error: null,
      }),
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
      proxyPoolId: "pool-bulk",
    });

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(attempts).toBe(3);
    expect(finishedJob.summary.success).toBe(1);
  });

  it("saves OAuth credentials when a free account cannot create a personal API key", async () => {
    const saved = [];
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({ proxyUrls: ["http://proxy-1:8080"], proxyPoolId: "pool-free", proxySource: "pool", error: null }),
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({ device_code: "state-free", verification_uri: "https://www.codebuddy.ai/login" }),
      pollToken: async () => ({ success: true, tokens: { accessToken: "access-free", refreshToken: "refresh-free" } }),
      googleAutomation: async ({ successPromise }) => ({ status: "success", ...(await successPromise) }),
      createApiKeyTokens: async () => {
        throw new Error("CodeBuddy API key creation failed (12602): personal API key creation requires a paid subscription");
      },
      saveConnection: async (payload) => {
        saved.push(payload);
        return { connection: { id: "conn-free" } };
      },
    });

    const started = await manager.startJob({ accounts: ["free@example.com|password"], concurrency: 1, proxyPoolId: "pool-free" });
    const finished = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "completed" ? current : null;
    });

    expect(finished.summary.success).toBe(1);
    expect(finished.activity.map((entry) => entry.step)).toContain("codebuddy_oauth_fallback");
    expect(saved[0].tokens).toMatchObject({
      accessToken: "access-free",
      refreshToken: "refresh-free",
      providerSpecificData: {
        authKind: "access_token",
        apiKeyUnavailable: true,
        apiKeyUnavailableReason: "paid_subscription_required",
      },
    });
    expect(saved[0].tokens.apiKey).toBeUndefined();
  });

  it("keeps unrelated API key creation failures terminal", async () => {
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({ proxyUrls: ["http://proxy-1:8080"], proxyPoolId: "pool-error", proxySource: "pool", error: null }),
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({ device_code: "state-error", verification_uri: "https://www.codebuddy.ai/login" }),
      pollToken: async () => ({ success: true, tokens: { accessToken: "access-error" } }),
      googleAutomation: async ({ successPromise }) => ({ status: "success", ...(await successPromise) }),
      createApiKeyTokens: async () => { throw new Error("CodeBuddy API key creation failed (500): upstream unavailable"); },
    });

    const started = await manager.startJob({ accounts: ["error@example.com|password"], concurrency: 1, proxyPoolId: "pool-error" });
    const failed = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "failed" ? current : null;
    });

    expect(failed.summary.failed).toBe(1);
    expect(failed.error).toContain("upstream unavailable");
  });

  it("launches a separate browser with a unique pool proxy for every bulk account", async () => {
    const launches = [];
    const browsers = [];
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrls: ["http://user:secret@proxy-1:8080", "socks5://proxy-2:1080"],
        proxyPoolId: "pool-unique",
        proxySource: "pool",
        error: null,
      }),
      browserLauncher: async (_browser, options) => {
        launches.push(options);
        const instance = createFakeBrowser();
        browsers.push(instance);
        return instance;
      },
      requestDeviceCodeFn: async () => ({ device_code: "state", verification_uri: "https://www.codebuddy.ai/login" }),
      pollToken: async () => ({ success: true, tokens: { accessToken: "access" } }),
      googleAutomation: async ({ successPromise }) => ({ status: "success", ...(await successPromise) }),
      createApiKeyTokens: async ({ tokens }) => ({ ...tokens, apiKey: "key" }),
      saveConnection: async ({ email }) => ({ connection: { id: `conn-${email}` } }),
    });

    const started = await manager.startJob({
      accounts: ["one@example.com|pw", "two@example.com|pw"],
      concurrency: 2,
      proxyPoolId: "pool-unique",
    });
    const finished = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "completed" ? current : null;
    });

    expect(finished.summary.success).toBe(2);
    expect(browsers).toHaveLength(2);
    expect(new Set(browsers).size).toBe(2);
    expect(launches).toEqual(expect.arrayContaining([
      { headless: true, proxy: "http://user:secret@proxy-1:8080" },
      { headless: true, proxy: "socks5://proxy-2:1080" },
    ]));
    expect(JSON.stringify(finished)).not.toContain("proxy-1");
    expect(JSON.stringify(finished)).not.toContain("secret");
  });

  it("reuses pool proxies round-robin when the pool has fewer proxies than accounts", async () => {
    const launches = [];
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrls: ["http://proxy-1:8080"],
        proxyPoolId: "pool-small",
        proxySource: "pool",
        error: null,
      }),
      browserLauncher: async (_browser, options) => {
        launches.push(options);
        return createFakeBrowser();
      },
      requestDeviceCodeFn: async () => ({ device_code: "state", verification_uri: "https://www.codebuddy.ai/login" }),
      pollToken: async () => ({ success: true, tokens: { accessToken: "access" } }),
      googleAutomation: async ({ successPromise }) => ({ status: "success", ...(await successPromise) }),
      createApiKeyTokens: async ({ tokens }) => ({ ...tokens, apiKey: "key" }),
      saveConnection: async ({ email }) => ({ connection: { id: `conn-${email}` } }),
    });

    const started = await manager.startJob({
      accounts: ["one@example.com|pw", "two@example.com|pw"],
      concurrency: 2,
      proxyPoolId: "pool-small",
    });
    const finished = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "completed" ? current : null;
    });

    expect(finished.summary.success).toBe(2);
    // Both accounts launched with the single available pool proxy.
    expect(launches.filter((opts) => opts.proxy === "http://proxy-1:8080")).toHaveLength(2);
  });

  it("launches visible workers and forwards human mode to Google automation", async () => {
    const launches = [];
    const automationCalls = [];
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrls: ["http://proxy-1:8080"],
        proxyPoolId: "pool-human",
        proxySource: "pool",
        error: null,
      }),
      browserLauncher: async (_browser, options) => {
        launches.push(options);
        return createFakeBrowser();
      },
      requestDeviceCodeFn: async () => ({ device_code: "state", verification_uri: "https://www.codebuddy.ai/login" }),
      pollToken: async () => ({ success: true, tokens: { accessToken: "access" } }),
      googleAutomation: async (options) => {
        automationCalls.push(options);
        return { status: "success", ...(await options.successPromise) };
      },
      createApiKeyTokens: async ({ tokens }) => ({ ...tokens, apiKey: "key" }),
      saveConnection: async ({ email }) => ({ connection: { id: `conn-${email}` } }),
    });

    const started = await manager.startJob({
      accounts: ["one@example.com|pw"],
      concurrency: 1,
      proxyPoolId: "pool-human",
      humanMode: true,
    });
    const finished = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "completed" ? current : null;
    });

    expect(finished.summary.success).toBe(1);
    expect(launches).toEqual([{ headless: false, proxy: "http://proxy-1:8080", humanize: true }]);
    expect(automationCalls[0].humanMode).toBe(true);
    expect(finished.humanMode).toBe(true);
  });

  it("rejects bulk jobs when the resolved proxy pool has no usable proxies", async () => {
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrls: [],
        proxyPoolId: "pool-empty",
        proxySource: "pool",
        error: null,
      }),
    });

    await expect(manager.startJob({
      accounts: ["one@example.com|pw", "two@example.com|pw"],
      concurrency: 2,
      proxyPoolId: "pool-empty",
    })).rejects.toMatchObject({ status: 400 });
  });

  it("wraps Global OAuth through a visible proxy without Google automation or API-key creation", async () => {
    const openedUrls = [];
    const launchCalls = [];
    const saved = [];
    let googleCalls = 0;
    let apiKeyCalls = 0;
    const handshakeCalls = [];
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async ({ proxyPoolId }) => ({
        proxyUrl: "socks5://user:pass@127.0.0.1:1080",
        proxyUrls: ["socks5://bad:1080", "socks5://user:pass@127.0.0.1:1080"],
        proxyPoolId,
        proxySource: "pool",
        proxyMode: "single",
        error: null,
      }),
      proxyBrowserPicker: async ({ proxyUrls, testUrl, browserLauncher }) => {
        expect(proxyUrls).toHaveLength(2);
        expect(testUrl).toBe("https://www.codebuddy.ai/login");
        return { browser: await browserLauncher("camofox", { headless: false, proxy: proxyUrls[1] }), proxyUrl: proxyUrls[1], checked: 2, error: null };
      },
      browserLauncher: async (browser, options) => {
        launchCalls.push({ browser, options });
        return createFakeBrowser({
          onGoto: (url) => openedUrls.push(url),
          cookies: [{ name: "session", value: "cookie-1", domain: ".codebuddy.ai" }],
        });
      },
      requestDeviceCodeFn: async (providerId, options) => {
        expect(providerId).toBe("codebuddy");
        handshakeCalls.push({ phase: "state", proxyUrl: options?.proxyUrl });
        return {
          device_code: "global-state-1",
          verification_uri: "https://www.codebuddy.ai/login?platform=CLI&state=global-state-1",
        };
      },
      pollToken: async (providerId, _deviceCode, extraData) => {
        expect(providerId).toBe("codebuddy");
        handshakeCalls.push({ phase: "poll", proxyUrl: extraData?.proxyUrl });
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
    expect(handshakeCalls).toEqual([
      { phase: "state", proxyUrl: "socks5://user:pass@127.0.0.1:1080" },
      { phase: "poll", proxyUrl: "socks5://user:pass@127.0.0.1:1080" },
    ]);
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
        proxyUrls: ["http://127.0.0.1:8080"],
        proxyPoolId: "pool-started",
        proxySource: "pool",
        proxyMode: "single",
        error: null,
      }),
      proxyBrowserPicker: async ({ proxyUrls, browserLauncher }) => ({
        browser: await browserLauncher("camofox", { headless: false, proxy: proxyUrls[0] }),
        proxyUrl: proxyUrls[0],
        checked: 1,
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

  it("blocks session capture until the user finishes region selection AND backend confirms it", async () => {
    // Simulates: proxy-routed OAuth returns a valid token, but the visible
    // browser is still parked on the region-selection screen. The manager
    // MUST NOT save the connection based on DOM/URL alone — it must probe
    // the CodeBuddy backend and only proceed when /console/accounts returns
    // a real userId. Capturing cookies before that yields a half-provisioned
    // session which makes the quota endpoint return 500.
    const urlRef = { value: "https://www.codebuddy.ai/login" };
    let regionVisible = true;
    let backendReady = false;
    let apiCalls = [];
    let cookieCalls = 0;

    // Simulate the user picking a region 100ms after the OAuth token arrives.
    const scheduleUserFinishesRegion = () => setTimeout(() => {
      regionVisible = false;
      urlRef.value = "https://www.codebuddy.ai/home";
      // Backend commits the region choice ~50ms later.
      setTimeout(() => { backendReady = true; }, 50);
    }, 100);

    const makePage = () => {
      const page = {
        on() {}, off() {},
        url: () => urlRef.value,
        bringToFront: async () => null,
        goto: async (url) => { urlRef.value = url; return null; },
        waitForTimeout: async () => null,
        context: () => ({}),
        frames: () => [],
        mainFrame: () => page,
        locator: (selector) => {
          const stub = {
            count: async () => 0,
            isVisible: async () => false,
            innerText: async () => "",
            textContent: async () => "",
            click: async () => { throw new Error("no dom in mock"); },
            nth: () => stub,
            first: () => stub,
          };
          if (selector === ".page-region") {
            return { ...stub, count: async () => (regionVisible ? 1 : 0), first: () => ({ ...stub, count: async () => (regionVisible ? 1 : 0) }) };
          }
          return stub;
        },
        // Any fetch-through-page evaluation → proxyCodeBuddyBackendSession
        evaluate: async (_fn, args) => {
          apiCalls.push(args?.url || "unknown");
          if (String(args?.url || "").includes("/console/accounts")) {
            if (!backendReady) return { status: 401, text: "unauthenticated", json: null };
            return { status: 200, text: "", json: { data: { accounts: [{ uid: "user-42", userEnterpriseId: "personal-edition-user-id" }] } } };
          }
          return { status: 200, text: "", json: null };
        },
      };
      return page;
    };

    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({
        proxyUrl: "http://127.0.0.1:8080",
        proxyUrls: ["http://127.0.0.1:8080"],
        proxyPoolId: "pool-region",
        proxySource: "pool",
        proxyMode: "single",
        error: null,
      }),
      proxyBrowserPicker: async ({ proxyUrls, browserLauncher }) => ({
        browser: await browserLauncher("camofox", { headless: false, proxy: proxyUrls[0] }),
        proxyUrl: proxyUrls[0],
        checked: 1,
        error: null,
      }),
      browserLauncher: async () => {
        const page = makePage();
        return {
          async newContext() {
            return {
              async newPage() { return page; },
              on() {}, off() {},
              async cookies() {
                cookieCalls += 1;
                return backendReady ? [{ name: "session", value: "final", domain: ".codebuddy.ai" }] : [];
              },
              async close() { return null; },
            };
          },
          async close() { return null; },
        };
      },
      requestDeviceCodeFn: async () => ({
        device_code: "state-region",
        verification_uri: "https://www.codebuddy.ai/login?platform=CLI&state=state-region",
      }),
      // Token arrives immediately. Nothing but the region+backend guard
      // must be able to keep the connection from being saved.
      pollToken: async () => {
        urlRef.value = "https://www.codebuddy.ai/region";
        scheduleUserFinishesRegion();
        return { success: true, tokens: { accessToken: "access-region", refreshToken: "refresh-region" } };
      },
      saveConnection: async ({ tokens }) => ({ connection: { id: "conn-region", tokens } }),
      pollIntervalMs: 10,
    });

    const started = await manager.startJob({ wrapLogin: true, proxyPoolId: "pool-region" });
    const finished = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status === "completed" ? current : null;
    }, 10_000);

    expect(finished.summary.success).toBe(1);
    const steps = finished.activity.map((entry) => entry.step);
    // Gate must have announced itself while region was visible.
    expect(steps).toContain("codebuddy_region_selection_gate");
    // Backend probe must have run at least once.
    expect(apiCalls.some((url) => String(url).includes("/console/accounts"))).toBe(true);
    // Save must happen strictly AFTER the gate.
    const gateIdx = steps.indexOf("codebuddy_region_selection_gate");
    const saveIdx = steps.indexOf("saving_connection");
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(saveIdx).toBeGreaterThan(gateIdx);
    // Cookies could only be captured after backend was ready.
    expect(cookieCalls).toBeGreaterThan(0);
    expect(backendReady).toBe(true);
  });

  it("times out and refuses to save when the user never finishes region selection", async () => {
    const urlRef = { value: "https://www.codebuddy.ai/region" };
    const makePage = () => {
      const page = {
        on() {}, off() {},
        url: () => urlRef.value,
        bringToFront: async () => null,
        goto: async () => null,
        waitForTimeout: async () => null,
        context: () => ({}),
        frames: () => [],
        mainFrame: () => page,
        locator: (selector) => {
          const stub = {
            count: async () => (selector === ".page-region" ? 1 : 0),
            isVisible: async () => false,
            innerText: async () => "",
            textContent: async () => "",
            click: async () => { throw new Error("no dom"); },
            nth: () => stub,
            first: () => stub,
          };
          return stub;
        },
        evaluate: async () => ({ status: 401, text: "unauthenticated", json: null }),
      };
      return page;
    };
    // Monkey-patch the waitUntil timeout via a small pollInterval so the test
    // finishes quickly without waiting the full production timeout.
    const manager = new CodeBuddyBulkImportManager({
      proxyResolver: async () => ({ proxyUrl: "http://p:1", proxyUrls: ["http://p:1"], proxyPoolId: "pool", proxySource: "pool", proxyMode: "single", error: null }),
      proxyBrowserPicker: async ({ proxyUrls, browserLauncher }) => ({
        browser: await browserLauncher("camofox", { headless: false, proxy: proxyUrls[0] }),
        proxyUrl: proxyUrls[0], checked: 1, error: null,
      }),
      browserLauncher: async () => {
        const page = makePage();
        return {
          async newContext() {
            return { async newPage() { return page; }, on() {}, off() {}, async cookies() { return []; }, async close() { return null; } };
          },
          async close() { return null; },
        };
      },
      requestDeviceCodeFn: async () => ({ device_code: "s", verification_uri: "https://www.codebuddy.ai/login" }),
      pollToken: async () => ({ success: true, tokens: { accessToken: "a" } }),
      saveConnection: async () => { throw new Error("saveConnection MUST NOT run when region is unresolved"); },
      pollIntervalMs: 1,
    });

    // Override the region-wait timeout for the test by clobbering the manager
    // instance method — the passive guard's timeout is not directly exposed,
    // so we shortcut by aborting the poll controller after a short delay via
    // job cancellation, which mimics "the user gave up".
    const started = await manager.startJob({ wrapLogin: true, proxyPoolId: "pool" });
    setTimeout(() => { try { manager.cancelJob(started.jobId); } catch { /* noop */ } }, 200);

    const finished = await waitFor(() => {
      const current = manager.getJob(started.jobId);
      return current?.status && current.status !== "running" && current.status !== "queued" ? current : null;
    }, 10_000);

    // Either the job was cancelled OR it failed — but it MUST NOT have saved
    // a connection while region selection was pending.
    expect(["cancelled", "completed", "failed"]).toContain(finished.status);
    expect(finished.summary?.success ?? 0).toBe(0);
  });
});
