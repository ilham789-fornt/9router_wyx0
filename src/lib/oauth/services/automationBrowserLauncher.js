import { existsSync } from "node:fs";
import {
  AUTOMATION_BROWSER_CAMOFOX,
  AUTOMATION_BROWSER_CHROMIUM,
  normalizeAutomationBrowser,
} from "../../../shared/constants/automationBrowsers.js";

const COMPACT_VISIBLE_WINDOW = [1100, 700];

function getHostFingerprintOs() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/**
 * Parse a proxy URL string into a Playwright proxy object.
 * "socks5://user:pass@host:1080" -> { server, username, password }.
 * Returns null when the URL is empty or unparseable.
 */
export function parseProxyStringToObject(proxyUrl) {
  const clean = String(proxyUrl || "").trim();
  if (!clean) return null;
  try {
    const parsed = new URL(clean);
    if (!parsed.hostname) return null;
    if (!["http:", "https:", "socks4:", "socks5:"].includes(parsed.protocol)) return null;
    const defaultPort = parsed.protocol === "http:" ? "80"
      : parsed.protocol === "https:" ? "443"
        : "1080";
    const host = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
    const proxy = { server: `${parsed.protocol}//${host}:${parsed.port || defaultPort}` };
    if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
    if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
    return proxy;
  } catch {
    return null;
  }
}

async function launchCamoufox({ headless = true, proxy, humanize = false } = {}) {
  const { Camoufox } = await import("camoufox-js");
  const config = {
    headless,
    os: getHostFingerprintOs(),
    block_webrtc: true,
    // Camoufox humanize=true enables cursor/keyboard humanization at the
    // browser process level (real mouse movement paths, per-key jitter,
    // typing-speed variance). Reference: github-farm-edu farm.py sets
    // this to True for signup workloads. Default false keeps every other
    // automation flow bit-identical to how it ran before this option
    // existed; only the register manager (which needs to survive GitHub's
    // post-signup behavior scoring) opts in.
    humanize: humanize === true,
  };
  if (!headless) config.window = COMPACT_VISIBLE_WINDOW;
  if (proxy) {
    // Camoufox accepts a string OR a Playwright proxy object. Pass the string
    // directly so socks5/http schemes resolve natively. geoip: true makes
    // Camoufox probe the proxy exit IP and auto-match the fingerprint locale,
    // timezone, and geo — critical for defeating geo anti-fraud on the target.
    config.proxy = typeof proxy === "string" ? proxy : parseProxyStringToObject(proxy);
    config.geoip = true;
  }
  try {
    return await Camoufox(config);
  } catch (error) {
    if (/Unknown property .* in config/i.test(String(error?.message || ""))) {
      throw new Error("Camoufox package and browser assets are incompatible. Run npm install, then npm exec -- camoufox-js fetch.");
    }
    if (/Failed to get a public proxy IP address/i.test(String(error?.message || ""))) {
      throw new Error("The selected proxy cannot establish the HTTPS connection required by browser OAuth. Verify that it supports HTTP CONNECT to port 443, its credentials are valid, and its allowlist permits www.codebuddy.ai.");
    }
    throw error;
  }
}

function findInstalledChromiumExecutable() {
  const candidates = process.platform === "win32"
    ? [
      `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

async function launchChromium({ headless = true, proxy } = {}) {
  const { chromium } = await import("playwright-core");
  const executablePath = findInstalledChromiumExecutable();
  if (!executablePath) {
    throw new Error("Chromium/Chrome/Edge is not installed on this host");
  }
  const launchOptions = { headless, executablePath };
  if (proxy) {
    // Chromium launch only accepts the object proxy form.
    launchOptions.proxy = typeof proxy === "string" ? parseProxyStringToObject(proxy) : proxy;
    if (!launchOptions.proxy) {
      throw new Error("Chromium proxy URL is invalid; expected http(s)/socks5 URL with a host");
    }
  }
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    throw new Error(
      `Chromium launch failed (${error?.message || error}). ` +
      `Install the browser with: npx playwright install chromium`
    );
  }
}

/**
 * Camoufox is the default automation runtime. Chromium is supported as an
 * alternate runtime when the caller selects it (browser === "chromium"). Both
 * accept an optional proxy URL for login wrapping through a proxy pool.
 */
export function createAutomationBrowserLauncher(browser, options = {}) {
  const browserId = normalizeAutomationBrowser(browser);
  const launchOptions = {
    headless: options.headless !== false,
    proxy: options.proxy || null,
    // Passthrough for Camoufox's built-in humanization. Chromium ignores.
    humanize: options.humanize === true,
  };
  return async function launchAutomationBrowser() {
    if (browserId === AUTOMATION_BROWSER_CHROMIUM) {
      return await launchChromium(launchOptions);
    }
    return await launchCamoufox(launchOptions);
  };
}

export function getAutomationBrowserUnavailableMessage(browser) {
  if (normalizeAutomationBrowser(browser) === AUTOMATION_BROWSER_CHROMIUM && !findInstalledChromiumExecutable()) {
    return "Chrome, Edge, or Chromium is not installed on this host";
  }
  return null;
}

export { AUTOMATION_BROWSER_CAMOFOX, AUTOMATION_BROWSER_CHROMIUM };
