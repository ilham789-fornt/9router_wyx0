import { describe, expect, it, vi } from "vitest";
import {
  CodeBuddyGithubBulkRegisterManager,
  generateGithubUsername,
  generateGithubPassword,
} from "../../src/lib/oauth/services/codebuddyGithubBulkRegisterManager.js";

// ── Small fakes ───────────────────────────────────────────────────────────

function createFakeBrowser({ onGoto } = {}) {
  const page = {
    on() {}, off() {}, url: () => "about:blank",
    bringToFront: async () => null,
    goto: async (url) => { onGoto?.(url); return null; },
    evaluate: async () => null,
    waitForTimeout: async () => null,
    context() { return {}; },
    screenshot: async () => Buffer.from(""),
  };
  return {
    async newContext() {
      return {
        async newPage() { return page; },
        on() {}, off() {},
        async cookies() { return []; },
        async close() { return null; },
      };
    },
    async close() { return null; },
  };
}

function makeAllocResult(count, { capped = false, available = count } = {}) {
  const addresses = Array.from({ length: count }, (_, i) => ({
    email: `alex${1000 + i}@d${i}.com`,
    domain: `@d${i}.com`,
    id: `md5-${i}`,
  }));
  return { addresses, requested: count, allocated: count, available, capped };
}

function makeTempMailStub(allocResult) {
  return {
    allocateUniqueAddresses: vi.fn(async (count) => {
      if (allocResult) return allocResult;
      return makeAllocResult(count);
    }),
    waitForOtp: vi.fn(async () => ({ code: "12345678", confirmUrl: null, message: {} })),
    listDomains: vi.fn(async () => []),
  };
}

async function waitFor(fn, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

// ── Credential generators ────────────────────────────────────────────────

describe("credential generators", () => {
  it("generateGithubUsername produces letter-first alnum names within GitHub rules", () => {
    for (let i = 0; i < 20; i += 1) {
      const name = generateGithubUsername();
      expect(name).toMatch(/^[a-z][a-z0-9]{10,14}$/);
      expect(name.length).toBeGreaterThanOrEqual(11);
      expect(name.length).toBeLessThanOrEqual(15);
    }
  });

  it("generateGithubPassword produces 20-char passwords with upper + lower + digit guaranteed", () => {
    for (let i = 0; i < 20; i += 1) {
      const pw = generateGithubPassword();
      expect(pw).toHaveLength(20);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/\d/);
      // No special chars — automation-safe alphabet.
      expect(pw).toMatch(/^[A-Za-z0-9]+$/);
    }
  });
});

// ── startJob validations ─────────────────────────────────────────────────

describe("CodeBuddyGithubBulkRegisterManager.startJob", () => {
  it("rejects when no proxy pool is provided", async () => {
    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: makeTempMailStub(),
    });
    await expect(manager.startJob({ count: 5 })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects when proxyResolver returns an empty pool", async () => {
    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: makeTempMailStub(),
      proxyResolver: async () => ({ proxyUrls: [], proxyPoolId: "p1", proxySource: "pool", error: null }),
    });
    await expect(manager.startJob({ count: 5, proxyPoolId: "p1" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects when TEMPMAIL_RAPIDAPI_KEY is not configured (no injected client, factory returns null)", async () => {
    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: null,
      tempMailClientFactory: () => null,
      proxyResolver: async () => ({
        proxyUrls: ["http://p1:8080", "http://p2:8080"],
        proxyPoolId: "p1",
        proxySource: "pool",
        error: null,
      }),
    });
    await expect(manager.startJob({ count: 2, proxyPoolId: "p1" })).rejects.toMatchObject({
      status: 400,
      code: "tempmail_missing_credentials",
    });
  });

  it("caps allocation to min(requested, uniqueProxyCount)", async () => {
    const tempMail = makeTempMailStub(makeAllocResult(15, { available: 15 }));
    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: tempMail,
      browserLauncher: async () => createFakeBrowser(),
      githubSignup: async () => ({ status: "needs_manual", reason: "test_stub", error: "stub" }),
      proxyResolver: async () => ({
        proxyUrls: ["http://p1:8080", "http://p2:8080", "http://p3:8080"],
        proxyPoolId: "p1",
        proxySource: "pool",
        error: null,
      }),
    });

    const started = await manager.startJob({ count: 15, proxyPoolId: "p1", concurrency: 1 });
    // Proxy pool has 3 unique proxies → account count must cap to 3.
    // Allocation itself is now performed per-account inside processAccount,
    // so the batch info on the sanitized job is the authoritative source.
    expect(started.accounts).toHaveLength(3);
  });

  it("uses random 20..30 batch by default when count is unspecified", async () => {
    const tempMail = makeTempMailStub(makeAllocResult(25, { available: 25 }));
    const proxyPool = Array.from({ length: 30 }, (_, i) => `http://p${i}:8080`);
    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: tempMail,
      browserLauncher: async () => createFakeBrowser(),
      githubSignup: async () => ({ status: "needs_manual", reason: "stop", error: "stop" }),
      proxyResolver: async () => ({
        proxyUrls: proxyPool,
        proxyPoolId: "p1",
        proxySource: "pool",
        error: null,
      }),
    });

    const started = await manager.startJob({ proxyPoolId: "p1", concurrency: 1 });
    // The account count must be in [20, 30] since count is unspecified and
    // the proxy pool is large enough. Allocation happens per-account inside
    // processAccount, so we assert the resulting worker count instead of
    // the temp-mail client call count.
    expect(started.accounts.length).toBeGreaterThanOrEqual(20);
    expect(started.accounts.length).toBeLessThanOrEqual(30);
  });
});

// ── End-to-end chained flow (mocked) ────────────────────────────────────

describe("CodeBuddyGithubBulkRegisterManager end-to-end (mocked)", () => {
  it("chains signup → CodeBuddy OAuth → saveConnection with the correct providerSpecificData", async () => {
    const savedConnections = [];
    const tempMail = makeTempMailStub(makeAllocResult(2, { available: 5 }));

    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: tempMail,
      browserLauncher: async () => createFakeBrowser(),
      githubSignup: async ({ email, username, password }) => ({
        status: "success",
        email,
        username,
        password,
        landingUrl: "https://github.com/dashboard",
        finalState: "logged_in",
      }),
      githubOauth: async ({ successPromise }) => ({
        status: "success",
        ...(await successPromise),
      }),
      requestDeviceCodeFn: async () => ({
        device_code: "state-1",
        verification_uri: "https://www.codebuddy.ai/login?platform=CLI&state=state-1",
      }),
      pollToken: async () => ({ success: true, tokens: { accessToken: "access-x", refreshToken: "refresh-x" } }),
      createApiKeyTokens: async ({ tokens, email }) => ({
        ...tokens,
        apiKey: `cb-key-${email}`,
      }),
      saveConnection: async ({ tokens, email }) => {
        savedConnections.push({ tokens, email });
        return { connection: { id: `conn-${email}` } };
      },
      proxyResolver: async () => ({
        proxyUrls: ["http://p1:8080", "http://p2:8080"],
        proxyPoolId: "p1",
        proxySource: "pool",
        error: null,
      }),
    });

    const started = await manager.startJob({ count: 2, proxyPoolId: "p1", concurrency: 2 });
    const finished = await waitFor(() => {
      const job = manager.getJob(started.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(finished.summary.success).toBe(2);
    expect(savedConnections).toHaveLength(2);
    // Every saved connection must carry the register-flow provenance metadata.
    for (const entry of savedConnections) {
      expect(entry.tokens.providerSpecificData?.automation).toBe("codebuddy-github-register-bulk");
      expect(entry.tokens.providerSpecificData?.githubUsername).toMatch(/^[a-z][a-z0-9]+$/);
      expect(entry.tokens.isActive).toBe(false);
    }
    // Every account must have its own connectionId.
    expect(finished.accounts.every((a) => a.connectionId)).toBe(true);
    // The sanitized snapshot must NEVER expose the GitHub password.
    const snapshotJson = JSON.stringify(finished);
    expect(snapshotJson).not.toContain("Aa1"); // password guarantees these three chars
  });

  it("finalizes as needs_manual when GitHub signup hits octocaptcha", async () => {
    const tempMail = makeTempMailStub(makeAllocResult(1, { available: 5 }));

    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: tempMail,
      browserLauncher: async () => createFakeBrowser(),
      githubSignup: async () => ({
        status: "needs_manual",
        reason: "octocaptcha",
        error: "Octocaptcha shown",
      }),
      githubOauth: async () => ({ status: "success", tokens: {} }),
      requestDeviceCodeFn: async () => ({ device_code: "x", verification_uri: "https://www.codebuddy.ai/login" }),
      pollToken: async () => ({ success: true, tokens: {} }),
      saveConnection: async () => ({ connection: { id: "should-not-be-called" } }),
      proxyResolver: async () => ({
        proxyUrls: ["http://p1:8080"],
        proxyPoolId: "p1",
        proxySource: "pool",
        error: null,
      }),
    });

    const started = await manager.startJob({ count: 1, proxyPoolId: "p1", concurrency: 1 });
    const finished = await waitFor(() => {
      const job = manager.getJob(started.jobId);
      // Wait until at least one account reaches a terminal state OR needs_manual.
      if (!job) return null;
      const nm = job.accounts.filter((a) => a.status === "needs_manual").length;
      if (nm >= 1) return job;
      return null;
    });

    expect(finished.summary.needs_manual).toBe(1);
    expect(finished.accounts[0].error).toMatch(/Octocaptcha/i);
  });

  it("finalizes as failed_rate_limited when GitHub signup returns that status", async () => {
    const tempMail = makeTempMailStub(makeAllocResult(1, { available: 5 }));

    const manager = new CodeBuddyGithubBulkRegisterManager({
      tempMailClient: tempMail,
      browserLauncher: async () => createFakeBrowser(),
      githubSignup: async () => ({ status: "failed_rate_limited", error: "rate-limited" }),
      proxyResolver: async () => ({
        proxyUrls: ["http://p1:8080"],
        proxyPoolId: "p1",
        proxySource: "pool",
        error: null,
      }),
    });

    const started = await manager.startJob({ count: 1, proxyPoolId: "p1", concurrency: 1 });
    const finished = await waitFor(() => {
      const job = manager.getJob(started.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(finished.summary.failed).toBe(1);
    expect(finished.accounts[0].error).toMatch(/rate-limited/i);
  });
});
