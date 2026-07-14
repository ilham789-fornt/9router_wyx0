import { describe, expect, it, vi } from "vitest";
import { __test__ } from "../../src/lib/oauth/services/codebuddyCnAutomationManager.js";
import { parseProxyStringToObject } from "../../src/lib/oauth/services/automationBrowserLauncher.js";

describe("CodeBuddy CN automation security", () => {
  it("redacts provider secrets from live and persisted job responses", () => {
    const job = {
      jobId: "job-1", status: "running", createdAt: "now", startedAt: "now", finishedAt: null,
      concurrency: 1, browserChoice: "camofox", error: null, lastPreview: null,
      options: {
        fiveSimApiKey: "five-secret", proxyUrl: "socks5://user:pass@host:1080",
        proxyPoolId: "pool-1", proxySource: "pool", proxyMode: "single", wrapLogin: true,
      },
      accounts: [],
    };
    const safe = __test__.sanitizeJob(job);
    expect(JSON.stringify(safe)).not.toContain("five-secret");
    expect(JSON.stringify(safe)).not.toContain("user:pass");
    expect(safe.options).toMatchObject({ hasFiveSimApiKey: true, hasProxy: true, proxyPoolId: "pool-1" });

    const legacy = __test__.normalizePersistedSnapshot({ ...safe, options: { ...job.options } });
    expect(JSON.stringify(legacy)).not.toContain("five-secret");
    expect(JSON.stringify(legacy)).not.toContain("user:pass");
  });

  it("uses protocol-correct proxy defaults and preserves credentials separately", () => {
    expect(parseProxyStringToObject("http://u:p@host")).toEqual({ server: "http://host:80", username: "u", password: "p" });
    expect(parseProxyStringToObject("https://host")).toEqual({ server: "https://host:443" });
    expect(parseProxyStringToObject("socks5://host")).toEqual({ server: "socks5://host:1080" });
    expect(parseProxyStringToObject("ftp://host")).toBeNull();
  });

  it("checks the TDesign terms state after exactly one click path", async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ found: true, checked: false })
      .mockResolvedValueOnce({ found: true, checked: false })
      .mockResolvedValueOnce({ found: true, checked: true });
    await expect(__test__.acceptCodeBuddyCnLoginTerms({ evaluate })).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(evaluate.mock.calls.filter(([, arg]) => arg?.shouldClick)).toHaveLength(1);
  });
});
