import { describe, expect, it } from "vitest";
import { CodeBuddyOAuthBulkImportManager } from "../../src/lib/oauth/services/codebuddyOAuthBulkImportManager.js";

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

describe("CodeBuddyOAuthBulkImportManager", () => {
  it("saves OAuth connections with refresh token and never touches API key creation", async () => {
    const saved = [];
    const manager = new CodeBuddyOAuthBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "state-1",
        verification_uri: "https://www.codebuddy.ai/login?platform=CLI&state=state-1",
      }),
      pollToken: async () => ({
        success: true,
        tokens: {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresIn: 86400,
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
    // No API key anywhere — connections carry the OAuth token pair only.
    expect(saved.every((entry) => entry.tokens.apiKey === undefined)).toBe(true);
    expect(saved.every((entry) => entry.tokens.refreshToken === "refresh-1")).toBe(true);
    expect(saved.every((entry) => entry.tokens.accessToken === "access-1")).toBe(true);
    expect(saved.every((entry) => entry.tokens.isActive === false)).toBe(true);
    expect(finishedJob.accounts.every((account) => account.connectionId)).toBe(true);
    expect(finishedJob.accounts.every((account) => account.status === "success")).toBe(true);
  });

  it("retries transient token polling failures before saving", async () => {
    let attempts = 0;
    const manager = new CodeBuddyOAuthBulkImportManager({
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

  it("default save refuses tokens without a refresh token", async () => {
    const { __test__ } = await import("../../src/lib/oauth/services/codebuddyOAuthBulkImportManager.js");
    await expect(
      __test__.defaultSaveCodeBuddyOAuthConnection({
        tokens: { accessToken: "access-only" },
        email: "user1@example.com",
      })
    ).rejects.toThrow(/refresh token/i);
  });
});
