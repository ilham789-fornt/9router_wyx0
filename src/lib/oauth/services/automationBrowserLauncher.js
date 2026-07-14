import { existsSync } from "node:fs";
import {
  AUTOMATION_BROWSER_CAMOFOX,
  AUTOMATION_BROWSER_CHROMIUM,
  normalizeAutomationBrowser,
} from "../../../shared/constants/automationBrowsers.js";

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

async function launchCamoufox({ headless = true, proxy } = {}) {
  const { Camoufox } = await import("camoufox-js");
  const config = {
    headless,
    os: getHostFingerprintOs(),
    block_webrtc: true,
    humanize: false,
  };
  if (proxy) {
    // Camoufox accepts a string OR a Playwright proxy object. Pass the string
    // directly so socks5/http schemes resolve natively. geoip: true makes
    // Camoufox probe the proxy exit IP and auto-match the fingerprint locale,
    // timezone, and geo — critical for defeating geo anti-fraud on the target.
    config.proxy = typeof proxy === "string" ? proxy : parseProxyStringToObject(proxy);
    config.geoip = true;
  }
  return await Camoufox(config);
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