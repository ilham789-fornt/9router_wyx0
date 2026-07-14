// CodeBuddy CN restriction detection.
// A restriction page is an upstream server-side policy signal. This module only
// detects and reports it; it does not claim that navigation or proxying removes
// the restriction.

const CN_RESTRICTION_PATTERNS = [
  "账号访问受限",
  "安全策略限制",
  "暂无法访问",
  "暂时受限",
  "访问受限",
  "Account Access Restricted",
  "temporarily restricted",
  "security policy",
];

const CN_RESTRICTED_PATHS = new Set([
  "/no-permission",
  "/no-client-authorization",
  "/no-client-authorize",
  "/restricted",
]);

export async function detectCodeBuddyCnRestriction(page) {
  if (!page) return false;
  try {
    const rawUrl = typeof page.url === "function" ? page.url() : String(page.url || "");
    if (rawUrl) {
      const parsed = new URL(rawUrl);
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      if (CN_RESTRICTED_PATHS.has(path)) return true;
    }
  } catch { /* ignore malformed/transient URL */ }

  if (typeof page.evaluate !== "function") return false;
  return Boolean(await page.evaluate((patterns) => {
    const text = String(document.body?.innerText || document.body?.textContent || "").toLowerCase();
    return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
  }, CN_RESTRICTION_PATTERNS).catch(() => false));
}

export const __test__ = {
  CN_RESTRICTION_PATTERNS,
  CN_RESTRICTED_PATHS,
};
