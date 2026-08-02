import {
  AUTOMATION_BROWSER_CAMOFOX,
  normalizeAutomationBrowser,
} from "../../../shared/constants/automationBrowsers.js";

const COMPACT_VISIBLE_WINDOW = [1100, 700];

function getHostFingerprintOs() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/**
 * Parse a proxy URL string into a Playwright/Camoufox proxy object.
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

function maskProxyForLog(proxy) {
  if (!proxy) return "direct";
  const raw = typeof proxy === "string" ? proxy : proxy.server;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return `${url.protocol}//${url.hostname}:${url.port || "(default)"}`;
  } catch {
    return "proxy(custom)";
  }
}

async function launchCamoufox({ headless = true, proxy, humanize = false } = {}) {
  const { NewBrowser, launchOptions } = await import("camoufox-js");
  const { firefox } = await import("playwright-core");

  const proxyString = proxy ? (typeof proxy === "string" ? proxy : proxy?.server) : null;

  const inputConfig = {
    headless,
    os: getHostFingerprintOs(),
    block_webrtc: true,
    // humanize=true enables cursor/keyboard humanization at the browser process
    // level (real mouse movement paths, per-key jitter, typing-speed variance).
    // Slows login down to a human pace so Google/CodeBuddy behavior scoring
    // does not flag the worker as a bot.
    humanize: humanize === true,
  };
  if (!headless) inputConfig.window = COMPACT_VISIBLE_WINDOW;

  if (proxyString) {
    // We pass the proxy STRING here so Camoufox's launchOptions uses it for the
    // geoip public-IP probe (which routes the probe THROUGH the proxy) and for
    // the fingerprint geo/locale spoof. The final Playwright proxy object is
    // corrected below — see the proxy override note.
    inputConfig.proxy = proxyString;
    // geoip: true makes Camoufox probe the proxy EXIT IP and auto-spoof the
    // fingerprint locale, timezone, geolocation AND language to match the
    // proxy's country. This is what produces the proxy-IP wrap evidence and
    // flips the browser language to the proxy region. STRICT: no silent
    // fallback — if the proxy cannot reach the IP-echo service the launch
    // fails loudly so the caller can try the next proxy.
    inputConfig.geoip = true;
  }

  try {
    // Build the Playwright launch options via Camoufox (fingerprint, env vars,
    // firefox prefs, executable path, geoip spoof). This returns an object with
    // a `proxy` key — BUT for socks4/socks5 the Camoufox 0.11.1 build sets
    // `proxy.server = String(proxyUrl.origin)`, and Node's URL.origin is "null"
    // for non-special schemes. That yields server:"null", which Playwright
    // silently ignores → the proxy is NOT applied at all.
    const built = await launchOptions({ debug: false, ...inputConfig, headless });

    // FIX: always rebuild the Playwright proxy object ourselves from the
    // original proxy URL so socks5/http(s) all resolve to a real server. We
    // only override when we actually have a proxy; otherwise leave as-is.
    if (proxyString) {
      const corrected = parseProxyStringToObject(proxyString);
      if (corrected) built.proxy = corrected;
    }

    // NewBrowser with fromOptions already built skips the internal launchOptions
    // call and goes straight to playwright.firefox.launch(fromOptions). This is
    // the supported Camoufox path for pre-built options.
    const browser = await NewBrowser(firefox, headless, built, false, false, inputConfig);

    if (proxyString) {
      // Attach the proxy credentials to the browser instance so the context
      // factory (createFreshContext) can inject them as `httpCredentials`.
      // Proxy auth in Playwright is a CONTEXT option, NOT a launch option —
      // without this, an HTTP proxy that requires auth answers every request
      // with "407 Proxy Authentication Required" and the page never loads.
      const corrected = built.proxy;
      if (corrected?.username || corrected?.password) {
        browser.__proxyHttpCredentials = {
          username: corrected.username || "",
          password: corrected.password || "",
        };
      }
      console.log(`[AutomationBrowser] Spawned Camoufox via proxy ${maskProxyForLog(proxyString)} server=${built.proxy?.server} auth=${browser.__proxyHttpCredentials ? "yes" : "no"} (headless=${headless}, humanize=${humanize === true})`);
      // Evidence: resolve and log the actual proxy exit IP so the wrap is
      // verifiable in the worker logs. Best-effort; never fails the launch.
      try {
        const { publicIP } = await import("camoufox-js/dist/ip.js");
        const exitIp = await publicIP(proxyString);
        console.log(`[AutomationBrowser] Proxy exit IP confirmed: ${exitIp} (proxy ${maskProxyForLog(proxyString)})`);
      } catch {
        // geoip already spoofed the fingerprint; the IP log is just evidence.
      }
    }
    return browser;
  } catch (error) {
    const message = String(error?.message || "");
    if (/Unknown property .* in config/i.test(message)) {
      throw new Error("Camoufox package and browser assets are incompatible. Run npm install, then npm exec -- camoufox-js fetch.");
    }
    if (/Failed to get a public proxy IP address/i.test(message)) {
      throw new Error("The selected proxy cannot establish the HTTPS connection required by browser OAuth. Verify that it supports HTTP CONNECT to port 443 and its credentials are valid.");
    }
    throw error;
  }
}

/**
 * Camoufox is the sole automation runtime. The browser argument is accepted so
 * legacy jobs and stored settings remain compatible while migrating to Camoufox.
 * `options.proxy` (URL string or proxy object) routes the browser through a proxy.
 * `options.humanize` enables human-paced cursor/keyboard for login realism.
 */
export function createAutomationBrowserLauncher(browser, options = {}) {
  normalizeAutomationBrowser(browser);
  const launchOptions = {
    headless: options.headless !== false,
    proxy: options.proxy || null,
    humanize: options.humanize === true,
  };
  return async function launchAutomationBrowser() {
    return await launchCamoufox(launchOptions);
  };
}

export function getAutomationBrowserUnavailableMessage() {
  return null;
}

export { AUTOMATION_BROWSER_CAMOFOX };
