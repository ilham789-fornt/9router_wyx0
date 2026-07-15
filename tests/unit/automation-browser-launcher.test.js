import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_BROWSER_CAMOFOX,
  AUTOMATION_BROWSER_CHROMIUM,
  AUTOMATION_BROWSER_OPTIONS,
  DEFAULT_AUTOMATION_BROWSER,
  normalizeAutomationBrowser,
} from "../../src/shared/constants/automationBrowsers.js";

const Camoufox = vi.fn(async (options) => ({ options }));

vi.mock("camoufox-js", () => ({ Camoufox }));

describe("automation browser runtime", () => {
  it("exposes Camoufox and Chromium automation browsers", () => {
    expect(AUTOMATION_BROWSER_OPTIONS).toEqual([
      expect.objectContaining({
        id: AUTOMATION_BROWSER_CAMOFOX,
        label: "Camoufox",
      }),
      expect.objectContaining({
        id: AUTOMATION_BROWSER_CHROMIUM,
        label: "Chromium",
      }),
    ]);
    expect(normalizeAutomationBrowser("chromium")).toBe(AUTOMATION_BROWSER_CHROMIUM);
    expect(normalizeAutomationBrowser("google-chrome")).toBe(AUTOMATION_BROWSER_CAMOFOX);
    expect(normalizeAutomationBrowser("playwright-chromium")).toBe(AUTOMATION_BROWSER_CAMOFOX);
    expect(DEFAULT_AUTOMATION_BROWSER).toBe(AUTOMATION_BROWSER_CAMOFOX);
  });

  it("launches headless Camoufox for legacy browser selections", async () => {
    const { createAutomationBrowserLauncher } = await import("../../src/lib/oauth/services/automationBrowserLauncher.js");
    const launcher = createAutomationBrowserLauncher("google-chrome", { headless: true });

    await launcher();

    const expectedOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    expect(Camoufox).toHaveBeenCalledWith({
      headless: true,
      os: expectedOs,
      block_webrtc: true,
      humanize: false,
    });
  });

  it("uses a compact laptop-sized window for visible Camoufox sessions", async () => {
    const { createAutomationBrowserLauncher } = await import("../../src/lib/oauth/services/automationBrowserLauncher.js");

    await createAutomationBrowserLauncher("camofox", { headless: false })();

    expect(Camoufox).toHaveBeenLastCalledWith(expect.objectContaining({
      headless: false,
      window: [1100, 700],
    }));
  });

  it("explains package and browser asset incompatibility", async () => {
    Camoufox.mockRejectedValueOnce(new Error("Unknown property audio:seed in config"));
    const { createAutomationBrowserLauncher } = await import("../../src/lib/oauth/services/automationBrowserLauncher.js");

    await expect(createAutomationBrowserLauncher("camofox")()).rejects.toThrow(
      "Camoufox package and browser assets are incompatible"
    );
  });

  it("explains proxy IP probe failures as HTTPS proxy incompatibility", async () => {
    Camoufox.mockRejectedValueOnce(new Error("Failed to get a public proxy IP address from any API endpoint."));
    const { createAutomationBrowserLauncher } = await import("../../src/lib/oauth/services/automationBrowserLauncher.js");

    await expect(createAutomationBrowserLauncher("camofox", {
      proxy: "http://proxy.example:8080",
    })()).rejects.toThrow("supports HTTP CONNECT to port 443");
  });
});
