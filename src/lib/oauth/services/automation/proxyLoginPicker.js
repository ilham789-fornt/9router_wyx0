import { testProxyUrl } from "../../../network/proxyTest.js";

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Probe each candidate proxy with a real HTTP request (HEAD via undici
 * ProxyAgent) and return the first one that can reach the provider login
 * endpoint. This guarantees the proxy handed to Camoufox is alive BEFORE we
 * spend a browser launch on it.
 */
export async function pickWorkingLoginProxy({
  proxyUrls = [],
  testUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  testProxy = testProxyUrl,
} = {}) {
  const urls = [...new Set(proxyUrls.filter(Boolean))];
  if (!urls.length) {
    return { proxyUrl: null, checked: 0, error: "Proxy pool has no launchable proxy URLs" };
  }

  for (let index = 0; index < urls.length; index += 1) {
    const result = await testProxy({ proxyUrl: urls[index], testUrl, timeoutMs });
    if (result?.ok) {
      return { proxyUrl: urls[index], checked: index + 1, error: null };
    }
  }

  return {
    proxyUrl: null,
    checked: urls.length,
    error: `No proxy in the selected pool could reach the provider login endpoint (${urls.length} checked)`,
  };
}

export async function launchWithWorkingLoginProxy({
  proxyUrls = [],
  testUrl,
  browser,
  browserLauncher,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  testProxy = testProxyUrl,
} = {}) {
  const urls = [...new Set(proxyUrls.filter(Boolean))];
  for (let index = 0; index < urls.length; index += 1) {
    const preflight = await testProxy({ proxyUrl: urls[index], testUrl, timeoutMs });
    if (!preflight?.ok) continue;
    try {
      const launchedBrowser = await browserLauncher(browser, { headless: false, proxy: urls[index] });
      return { browser: launchedBrowser, proxyUrl: urls[index], checked: index + 1, error: null };
    } catch {
      // Try the next candidate without exposing transport details or credentials.
    }
  }
  return {
    browser: null,
    proxyUrl: null,
    checked: urls.length,
    error: `No proxy in the selected pools could open the provider login browser (${urls.length} checked)`,
  };
}
