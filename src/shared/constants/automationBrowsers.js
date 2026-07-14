// Automation browser runtimes.
//
// Camoufox is the default stealth runtime (hardened Firefox + fingerprint
// spoofing + WebRTC blocking + geoip-aware proxy matching).
// Chromium is the alternate runtime: faster and more compatible, useful as a
// fallback when Camoufox misbehaves on a specific target. Requires the
// Playwright chromium browser binary (run `npx playwright install chromium`).
export const AUTOMATION_BROWSER_CAMOFOX = "camofox";
export const AUTOMATION_BROWSER_CHROMIUM = "chromium";

export const DEFAULT_AUTOMATION_BROWSER = AUTOMATION_BROWSER_CAMOFOX;

const AUTOMATION_BROWSER_IDS = new Set([
  AUTOMATION_BROWSER_CAMOFOX,
  AUTOMATION_BROWSER_CHROMIUM,
]);

export const AUTOMATION_BROWSER_OPTIONS = [
  {
    id: AUTOMATION_BROWSER_CAMOFOX,
    label: "Camoufox",
    badge: "Default",
    description: "Stealth Firefox runtime with fingerprint spoofing, WebRTC blocking, and geoip-aware proxy matching.",
  },
  {
    id: AUTOMATION_BROWSER_CHROMIUM,
    label: "Chromium",
    badge: "Alt",
    description: "Standard Playwright Chromium. Faster and more compatible; less stealthy. Install with: npx playwright install chromium",
  },
];

export function normalizeAutomationBrowser(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return AUTOMATION_BROWSER_IDS.has(normalized) ? normalized : AUTOMATION_BROWSER_CAMOFOX;
}

export function getAutomationBrowserOption(id) {
  const normalized = id ? normalizeAutomationBrowser(id) : DEFAULT_AUTOMATION_BROWSER;
  return AUTOMATION_BROWSER_OPTIONS.find((option) => option.id === normalized) || AUTOMATION_BROWSER_OPTIONS[0];
}

export function isChromiumBrowser(value) {
  return normalizeAutomationBrowser(value) === AUTOMATION_BROWSER_CHROMIUM;
}