import { describe, expect, it, vi } from "vitest";
import { launchWithWorkingLoginProxy, pickWorkingLoginProxy } from "../../src/lib/oauth/services/automation/proxyLoginPicker.js";

describe("OAuth login proxy picker", () => {
  it("checks proxies in order and returns the first provider-reachable proxy", async () => {
    const testProxy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await pickWorkingLoginProxy({
      proxyUrls: ["http://user:secret@bad:8080", "socks5://good:1080"],
      testUrl: "https://www.codebuddy.ai/login",
      testProxy,
    });

    expect(result).toEqual({ proxyUrl: "socks5://good:1080", checked: 2, error: null });
    expect(testProxy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      proxyUrl: "http://user:secret@bad:8080",
      testUrl: "https://www.codebuddy.ai/login",
    }));
  });

  it("returns a credential-free error when no proxy works", async () => {
    const result = await pickWorkingLoginProxy({
      proxyUrls: ["http://user:secret@bad:8080"],
      testUrl: "https://www.codebuddy.cn/login",
      testProxy: async () => ({ ok: false, error: "credential-bearing transport error" }),
    });

    expect(result.proxyUrl).toBeNull();
    expect(result.error).toBe("No proxy in the selected pool could reach the provider login endpoint (1 checked)");
    expect(result.error).not.toContain("secret");
  });

  it("continues to the next preflight-valid proxy when browser launch fails", async () => {
    const browserLauncher = vi.fn()
      .mockRejectedValueOnce(new Error("spawn timeout"))
      .mockResolvedValueOnce({ id: "browser-2" });
    const result = await launchWithWorkingLoginProxy({
      proxyUrls: ["http://first:8080", "http://second:8080"],
      testUrl: "https://www.codebuddy.ai/login",
      testProxy: async () => ({ ok: true }),
      browser: "camofox",
      browserLauncher,
    });

    expect(result).toMatchObject({ browser: { id: "browser-2" }, proxyUrl: "http://second:8080", checked: 2 });
    expect(browserLauncher).toHaveBeenCalledTimes(2);
  });
});
