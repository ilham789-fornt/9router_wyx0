/**
 * CodeBuddyGithubBulkImportManager — CodeBuddy Global bulk import via GitHub SSO.
 *
 * Same skeleton as `codebuddyBulkImportManager.js` (device-code OAuth flow,
 * region/started callback, API-key creation via authenticated web page,
 * web-cookie capture, deduplicated persistence) but drives the *GitHub* social
 * login gate instead of Google GSuite.
 *
 * Contract with routes / UI:
 *   - Same job JSON shape as CodeBuddy GSuite bulk import so the shared
 *     BulkAccountAutomationModal reuses without changes.
 *   - Provider identifier for the modal & endpoints: "codebuddy-github".
 *   - Saved connections still use provider="codebuddy" (they are CodeBuddy
 *     accounts); providerSpecificData.automation is set to
 *     "codebuddy-github-bulk" so the source of the connection stays queryable.
 *
 * Design notes worth keeping:
 *   - Proxy pool is optional (unlike GSuite bulk which is proxy-required).
 *     When omitted, all workers share the host outbound IP; GitHub is IP-
 *     sensitive so operators should still wire a pool for scale.
 *   - We share the CodeBuddy-side helpers (region page, /started callback,
 *     onboarding) with the Google flow — those pages behave identically no
 *     matter which social provider fed the session.
 */
import {
  BaseBulkImportManager,
  createFreshContext,
  parseBulkAccounts,
  buildLookupResponse,
  nowIso,
  DEFAULT_CONCURRENCY,
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
} from "./automation/baseBulkImportManager.js";
import { runGithubAccountAutomation } from "./automation/githubOAuth.js";
import {
  handleCodeBuddyRegionPage,
  handleProviderOnboarding,
  handleCodeBuddyStartedAuthorization,
  isProviderPage,
} from "./automation/googleOAuth.js";
import { resolveBulkImportProxy } from "./bulkImportProxyResolver.js";

// ── Region-page humanize helper ────────────────────────────────────────────
//
// CodeBuddy Global's "Select Registration Region" page has multiple UI
// variants. The classic one uses a `.page-region` container with a t-select
// dropdown — that flow is handled by `handleCodeBuddyRegionPage` above. The
// newer dark-theme variant (screenshot 2026-07: prefilled "Indonesia" text
// input + green rounded "Submit" button) does not carry the `.page-region`
// class, so the shared handler returns false and the operator sees the flow
// nyangkut at "waiting for next screen".
//
// This helper humanizes the interaction on the newer variant:
//   1. Small viewport scroll (page feels touched).
//   2. Focus the region input and clear it, then type "Singapore" with
//      per-key delay so the framework's onChange listener fires normally
//      (fill() bypasses that and leaves the button stuck in the disabled
//      pre-submit state on this variant).
//   3. Pick the "Singapore" option from any dropdown that appears.
//   4. Move the mouse in a small arc across the viewport, ending on the
//      Submit button. This satisfies GitHub-style "did a human touch this?"
//      heuristics that some regions of the CodeBuddy console reuse.
//   5. Playwright real click on Submit (trusted event). Falls back to a
//      JS click + form submit if the button is still not clickable.
export async function humanizeRegionSelection(page, reportStep, preferredRegion = "Singapore") {
  // Guard: only run on the /register/user/complete URL where the region
  // page is served. isProviderPage() is not tight enough on its own.
  const url = page.url?.() || "";
  if (!/register\/user\/complete/i.test(url)) return false;

  // (1) Nudge scroll — a tiny wheel gesture makes the page feel used.
  try {
    await page.mouse?.wheel?.(0, 120).catch(() => null);
    await page.waitForTimeout(180).catch(() => null);
    await page.mouse?.wheel?.(0, -60).catch(() => null);
    await page.waitForTimeout(120).catch(() => null);
  } catch { /* not fatal */ }

  // (2) Type the preferred region into the visible input. We select-all
  //     first because the field often ships with "Indonesia" already filled
  //     and Playwright's fill() sometimes concatenates.
  const inputSelectors = [
    'input[placeholder*="region" i]',
    'input[placeholder*="location" i]',
    'input[placeholder*="country" i]',
    '.t-input input',
    'input[type="text"]',
  ];

  let inputHit = null;
  for (const selector of inputSelectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    inputHit = locator;
    break;
  }

  if (inputHit) {
    try {
      await inputHit.scrollIntoViewIfNeeded().catch(() => null);
      await inputHit.click({ timeout: 4_000 }).catch(() => null);
      await page.waitForTimeout(150).catch(() => null);
      await inputHit.press("Control+A").catch(() => null);
      await inputHit.press("Meta+A").catch(() => null);
      await inputHit.press("Backspace").catch(() => null);
      // pressSequentially fires per-key input events, unlike fill() which
      // sets .value directly and can leave the framework thinking the field
      // is still empty.
      await inputHit.pressSequentially(preferredRegion, { delay: 60 }).catch(() => null);
      reportStep?.("typed_region_name", `Typed region name "${preferredRegion}" into the CodeBuddy region input`);
      await page.waitForTimeout(600).catch(() => null);
    } catch (err) {
      reportStep?.("region_input_typing_failed", `Region input typing failed: ${err?.message || err}`);
    }
  }

  // (3) Pick the region from the autocomplete dropdown that appears while
  //     typing. Any of these selectors could be the dropdown item; we click
  //     the first one whose text matches the preferred region.
  const optionRegex = new RegExp(`^\\s*${preferredRegion.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "i");
  const dropdownOption = await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, "i");
    const candidates = Array.from(document.querySelectorAll(
      "ul.dropdown-section li, .dropdown-section li, [role='option'], .t-select-option, [class*='option'], .t-select__list li, [class*='select__list'] li, [class*='autocomplete'] li"
    )).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && rect.width > 0
        && rect.height > 0
        && pattern.test((el.innerText || el.textContent || "").trim());
    });
    if (!candidates.length) return null;
    const target = candidates[0];
    target.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: type.endsWith("down") ? 1 : 0 }));
    }
    return (target.innerText || target.textContent || "").trim();
  }, optionRegex.source).catch(() => null);

  if (dropdownOption) {
    reportStep?.("picked_region_option", `Picked region option: ${dropdownOption}`);
    await page.waitForTimeout(500).catch(() => null);
  }

  // (4 + 5) Humanize the pointer to the Submit button, then real-click it.
  //
  // The dark-theme region page renders Submit as a `<div class="cursor-pointer
  // ...bg-#4B4F6D">Submit</div>` — no <button>, no role="button". Selectors
  // that assume a <button> element miss it entirely, which is why the earlier
  // handler returned false and the flow stalled on this page.
  //
  // Strategy: find the Submit target via evaluate() so we can filter by
  // effective text and computed style, then locate its coordinates and
  // dispatch a real Playwright mouse click on those coordinates. This gives
  // us trusted-event semantics without needing a Playwright selector that
  // can uniquely identify the element.
  const submitTarget = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const wordRe = /^\s*(submit|get started|continue|confirm)\s*$/i;
    // Look for the target element in three passes so the tightest match wins:
    //   (a) real <button> / <input type=submit> tags with matching text
    //   (b) role=button or [class*=cursor-pointer] elements with matching text
    //   (c) any visible element whose ownText equals the label
    const collectByFilter = (nodes) => Array.from(nodes)
      .filter(isVisible)
      .filter((el) => wordRe.test((el.innerText || el.value || "").trim()));
    const passes = [
      collectByFilter(document.querySelectorAll('button, input[type="submit"], input[type="button"]')),
      collectByFilter(document.querySelectorAll('[role="button"], [class*="cursor-pointer"], .t-button, [class*="button"]')),
      collectByFilter(document.querySelectorAll('div, span, a')),
    ];
    const pick = passes.find((list) => list.length > 0);
    const target = pick?.[0];
    if (!target) return null;
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = target.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: rect.width,
      height: rect.height,
      tag: target.tagName.toLowerCase(),
      classList: typeof target.className === "string" ? target.className.slice(0, 120) : "",
      text: (target.innerText || target.value || "").trim().slice(0, 40),
    };
  }).catch(() => null);

  if (submitTarget && submitTarget.width > 0 && submitTarget.height > 0) {
    // Humanize: small pointer arc into the Submit target. GitHub-style
    // anti-clickjacking on the button unlocks after this activity, and even
    // on plain-div "buttons" it makes the framework's onMouseEnter listeners
    // fire.
    try {
      const cx = submitTarget.x;
      const cy = submitTarget.y;
      await page.mouse?.move?.(cx - 80, cy - 40, { steps: 6 }).catch(() => null);
      await page.waitForTimeout(120).catch(() => null);
      await page.mouse?.move?.(cx + 30, cy + 10, { steps: 4 }).catch(() => null);
      await page.waitForTimeout(90).catch(() => null);
      await page.mouse?.move?.(cx, cy, { steps: 3 }).catch(() => null);
      await page.waitForTimeout(80).catch(() => null);
    } catch { /* pointer arc is best-effort */ }

    // Real click at the button center. Trusted event = framework's onClick
    // handler fires as if a real user clicked.
    try {
      await page.mouse.down();
      await page.waitForTimeout(45).catch(() => null);
      await page.mouse.up();
      reportStep?.(
        "submitting_codebuddy_region",
        `Submitted CodeBuddy region selection (humanized click on <${submitTarget.tag}> "${submitTarget.text}")`
      );
      await page.waitForTimeout(1_500).catch(() => null);
      return true;
    } catch (err) {
      reportStep?.("region_submit_click_failed", `Region submit click failed: ${err?.message || err}`);
    }
  }

  // Fallback A: JS synthetic click on any element that matches "Submit".
  const jsSubmitted = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && rect.width > 0
        && rect.height > 0;
    };
    const label = /^\s*(submit|get started|continue|confirm)\s*$/i;
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button'], .t-button, [class*='cursor-pointer'], div, span, a"));
    const target = candidates.find((el) => {
      if (!isVisible(el)) return false;
      const text = (el.innerText || el.value || "").trim();
      return label.test(text);
    });
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: type.endsWith("down") ? 1 : 0 }));
    }
    return true;
  }).catch(() => false);

  if (jsSubmitted) {
    reportStep?.("submitting_codebuddy_region_force", "Submitted CodeBuddy region via JS click fallback");
    await page.waitForTimeout(1_500).catch(() => null);
    return true;
  }

  return false;
}

export const CODEBUDDY_PROVIDER_ID = "codebuddy";
export const CODEBUDDY_LABEL = "CodeBuddy (GitHub)";
const CODEBUDDY_POLL_TIMEOUT_MS = 15 * 60_000;
export const CODEBUDDY_POLL_INTERVAL_MS = 5_000;
const CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS = 6;
const CODEBUDDY_COOKIE_DOMAINS = new Set(["codebuddy.ai", "www.codebuddy.ai"]);
const CODEBUDDY_BASE_URL = "https://www.codebuddy.ai";
const CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/login/account`;
const CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/accounts`;
const CODEBUDDY_API_KEYS_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/api/client/v1/api-keys`;
const CODEBUDDY_TRIAL_ENDPOINT = `${CODEBUDDY_BASE_URL}/billing/ide/trial`;
const CODEBUDDY_DEFAULT_USER_ENTERPRISE_ID = "personal-edition-user-id";

export const CODEBUDDY_GITHUB_BULK_IMPORT_DEFAULT_CONCURRENCY = DEFAULT_CONCURRENCY;
export const CODEBUDDY_GITHUB_BULK_IMPORT_MIN_CONCURRENCY = MIN_CONCURRENCY;
export const CODEBUDDY_GITHUB_BULK_IMPORT_MAX_CONCURRENCY = MAX_CONCURRENCY;

// ── Utilities ───────────────────────────────────────────────────────────────

function wait(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => signal?.removeEventListener?.("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      resolve();
    };
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

export function normalizeCodeBuddyAuthUrl(rawUrl, state) {
  if (!rawUrl && !state) return rawUrl;
  const url = rawUrl ? new URL(rawUrl) : new URL("https://www.codebuddy.ai/login");
  const platform = url.searchParams.get("platform") || "CLI";
  const effectiveState = state || url.searchParams.get("state");
  const normalized = new URL("https://www.codebuddy.ai/login");
  normalized.searchParams.set("platform", platform);
  if (effectiveState) normalized.searchParams.set("state", effectiveState);
  return normalized.toString();
}

// ── Connection & Token Helpers ─────────────────────────────────────────────

export async function defaultSaveCodeBuddyGithubConnection({
  tokens, email, proxyPoolId, proxySource,
}) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const { assertProviderEnabled } = await import("@/lib/providerDisabled");
  await assertProviderEnabled(CODEBUDDY_PROVIDER_ID);
  const hasApiKey = Boolean(tokens.apiKey);
  const providerSpecificData = {
    ...(tokens.providerSpecificData || {}),
    loginEmail: email,
    automation: "codebuddy-github-bulk",
    socialProvider: "github",
    ...(proxyPoolId ? { proxyPoolId, proxySource: proxySource || undefined } : {}),
  };

  if (tokens.webCookie) {
    providerSpecificData.webCookie = tokens.webCookie;
    providerSpecificData.webCookieCapturedAt = tokens.webCookieCapturedAt || new Date().toISOString();
  }

  const connectionPayload = {
    provider: CODEBUDDY_PROVIDER_ID,
    authType: hasApiKey ? "apikey" : "oauth",
    name: email || undefined,
    email,
    providerSpecificData,
    isActive: false,
    testStatus: "active",
  };

  if (hasApiKey) {
    connectionPayload.apiKey = tokens.apiKey;
  } else {
    Object.assign(connectionPayload, {
      ...tokens,
      providerSpecificData,
      expiresAt: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
        : null,
    });
  }

  const connection = await createProviderConnection(connectionPayload);
  return { connection };
}

export async function defaultRequestDeviceCode(providerId) {
  const { requestDeviceCode } = await import("../providers.js");
  return requestDeviceCode(providerId);
}

export async function defaultPollForToken(providerId, deviceCode) {
  const { pollForToken } = await import("../providers.js");
  return pollForToken(providerId, deviceCode);
}

// ── Cookie Capture ─────────────────────────────────────────────────────────

async function captureCodeBuddyWebCookie(context) {
  if (!context?.cookies) return null;
  try {
    const cookies = await context.cookies(["https://www.codebuddy.ai", "https://codebuddy.ai"]);
    const useful = cookies
      .filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
        return CODEBUDDY_COOKIE_DOMAINS.has(domain) || domain.endsWith(".codebuddy.ai");
      })
      .filter((cookie) => cookie.name && cookie.value)
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));

    if (!useful.length) return null;
    return useful.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch (error) {
    console.error("[CodeBuddy GitHub] captureWebCookie error:", error.message);
    return null;
  }
}

export async function attachCodeBuddyWebCookie(context, tokens = {}) {
  const webCookie = await captureCodeBuddyWebCookie(context);
  if (!webCookie) return tokens;
  return { ...tokens, webCookie, webCookieCapturedAt: new Date().toISOString() };
}

// ── API Key Creation via Browser Page (identical to Google flow) ───────────

function createCodeBuddyApiKeyName() {
  const suffix = Math.floor(Math.random() * 900000) + 100000;
  return `9router-gh-${Date.now().toString(36)}-${suffix}`;
}

async function codeBuddyRequestViaPage(page, method, url, body = null) {
  if (typeof page?.evaluate !== "function") {
    throw new Error("CodeBuddy browser session is missing page.evaluate()");
  }
  const result = await page.evaluate(
    async ({ url, method, body }) => {
      try {
        const headers = {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
        };
        const init = { method, credentials: "include", headers };
        if (body !== null) {
          headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(body);
        }
        const response = await fetch(url, init);
        const text = await response.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status: response.status, text, json };
      } catch (error) {
        return { status: 0, text: String(error?.message || error), json: null };
      }
    },
    { url, method: String(method || "GET").toUpperCase(), body }
  );
  return {
    status: Number(result?.status || 0),
    payload: result?.json && typeof result.json === "object" ? result.json : null,
    bodyText: String(result?.text || ""),
  };
}

function getCodeBuddyAccountIdentity(accountsPayload) {
  const accounts = accountsPayload?.data?.accounts;
  const firstAccount = Array.isArray(accounts) ? accounts[0] : null;
  return {
    userEnterpriseId: String(firstAccount?.userEnterpriseId || CODEBUDDY_DEFAULT_USER_ENTERPRISE_ID),
    userId: String(firstAccount?.uid || ""),
  };
}

async function prepareCodeBuddyBackendSession(page) {
  await codeBuddyRequestViaPage(page, "POST", CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT, {
    attributes: {
      countryCode: ["65"],
      countryFullName: ["Singapore"],
      countryName: ["SG"],
    },
  }).catch(() => null);

  const accountsResult = await codeBuddyRequestViaPage(page, "GET", CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT)
    .catch(() => ({ status: 0, payload: null }));
  const identity = getCodeBuddyAccountIdentity(accountsResult.payload);

  if (identity.userId) {
    const registerUrl = `${CODEBUDDY_BASE_URL}/auth/realms/copilot/overseas/user/register?userId=${encodeURIComponent(identity.userId)}`;
    await codeBuddyRequestViaPage(page, "GET", registerUrl).catch(() => null);
  }

  await codeBuddyRequestViaPage(page, "POST", CODEBUDDY_TRIAL_ENDPOINT).catch(() => null);
  return identity;
}

async function createCodeBuddyApiKeyViaPage(page, userEnterpriseId = CODEBUDDY_DEFAULT_USER_ENTERPRISE_ID) {
  const result = await codeBuddyRequestViaPage(page, "POST", CODEBUDDY_API_KEYS_ENDPOINT, {
    name: createCodeBuddyApiKeyName(),
    expire_in_days: -1,
    user_enterprise_id: userEnterpriseId || CODEBUDDY_DEFAULT_USER_ENTERPRISE_ID,
  });

  if (result.status !== 200 || result.payload?.code !== 0) {
    const code = result.payload?.code ?? result.status;
    const message = result.payload?.msg || result.payload?.message || result.bodyText || "unknown response";
    throw new Error(`CodeBuddy API key creation failed (${code}): ${String(message).slice(0, 160)}`);
  }

  const apiKey = String(result.payload?.data?.key || "").trim();
  if (!apiKey) throw new Error("CodeBuddy API key response did not include data.key");
  return apiKey;
}

export async function defaultCreateCodeBuddyApiKeyTokens({ page, tokens = {}, onStep }) {
  onStep?.("preparing_codebuddy_backend_session", "Preparing CodeBuddy backend session");
  const identity = await prepareCodeBuddyBackendSession(page);

  onStep?.("creating_codebuddy_api_key", "Creating CodeBuddy API key");
  const apiKey = await createCodeBuddyApiKeyViaPage(page, identity.userEnterpriseId);

  return {
    ...tokens,
    apiKey,
    providerSpecificData: {
      ...(tokens.providerSpecificData || {}),
      authKind: "api_key",
      apiKeySource: "browser_backend",
      apiKeyCreatedAt: new Date().toISOString(),
      userEnterpriseId: identity.userEnterpriseId,
      ...(identity.userId ? { codeBuddyUserId: identity.userId } : {}),
    },
  };
}

// ── Token Polling (unchanged from Google flow) ─────────────────────────────

export function createCodeBuddyPollPromise({
  deviceCode, pollToken, onStep, signal, shouldCancel, onPending,
  timeoutMs = CODEBUDDY_POLL_TIMEOUT_MS,
  pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
  maxTransientErrors = CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS,
}) {
  return (async () => {
    const startedAt = Date.now();
    let lastStepAt = 0;
    let pollAttempt = 0;
    let transientErrors = 0;

    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted || shouldCancel?.()) throw new Error("CodeBuddy OAuth polling cancelled");

      if (Date.now() - lastStepAt > pollIntervalMs - 100) {
        onStep?.("polling_codebuddy_token", "Waiting for CodeBuddy OAuth token");
        lastStepAt = Date.now();
      }

      pollAttempt += 1;
      const result = await pollToken(CODEBUDDY_PROVIDER_ID, deviceCode);
      if (result.success) {
        onStep?.("codebuddy_token_received", `CodeBuddy OAuth token received after ${pollAttempt} poll attempt${pollAttempt === 1 ? "" : "s"}`);
        return { tokens: result.tokens };
      }

      if (!result.pending && result.error !== "authorization_pending" && result.error !== "slow_down") {
        if (result.error === "request_failed" && transientErrors < maxTransientErrors) {
          transientErrors += 1;
          onStep?.("codebuddy_poll_retry", `CodeBuddy token poll failed temporarily (${transientErrors}/${maxTransientErrors}); retrying`);
          await wait(pollIntervalMs, signal);
          continue;
        }
        throw new Error(result.errorDescription || result.error || "CodeBuddy OAuth polling failed");
      }

      onStep?.("codebuddy_token_pending", `CodeBuddy OAuth authorization is still pending (poll ${pollAttempt})`);
      await onPending?.(result, pollAttempt);
      await wait(pollIntervalMs, signal);
    }
    throw new Error("Timed out waiting for CodeBuddy OAuth token");
  })();
}

// ── Registration completion (identical to Google flow) ─────────────────────

const CODEBUDDY_DASHBOARD_URL = "https://www.codebuddy.ai/home";
const CODEBUDDY_COMPLETE_REGISTER_TIMEOUT_MS = 30_000;
const CODEBUDDY_COMPLETE_REGISTER_POLL_MS = 1_500;

export async function completeCodeBuddyRegistration(page, onStep) {
  const reportStep = (step, message) => onStep?.(step, message);
  try {
    reportStep("navigating_to_dashboard", "Navigating to CodeBuddy to complete registration");
    await page.goto(CODEBUDDY_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    const startedAt = Date.now();
    let handledAnything = false;

    while (Date.now() - startedAt < CODEBUDDY_COMPLETE_REGISTER_TIMEOUT_MS) {
      if (!isProviderPage(page)) break;

      const handledStarted = await handleCodeBuddyStartedAuthorization(page, reportStep);
      if (handledStarted) { handledAnything = true; await page.waitForTimeout(CODEBUDDY_COMPLETE_REGISTER_POLL_MS); continue; }

      const handledRegion = await handleCodeBuddyRegionPage(page, reportStep);
      if (handledRegion) { handledAnything = true; await page.waitForTimeout(CODEBUDDY_COMPLETE_REGISTER_POLL_MS); continue; }

      const handledOnboarding = await handleProviderOnboarding(page, reportStep, CODEBUDDY_LABEL);
      if (handledOnboarding) { handledAnything = true; await page.waitForTimeout(CODEBUDDY_COMPLETE_REGISTER_POLL_MS); continue; }

      break;
    }

    if (handledAnything) {
      reportStep("complete_register_done", "CodeBuddy registration completed, establishing session");
    }
  } catch (error) {
    reportStep("complete_register_skipped", `Could not complete registration: ${error.message}`);
  }
}

// ── Manager Class ──────────────────────────────────────────────────────────

export class CodeBuddyGithubBulkImportManager extends BaseBulkImportManager {
  constructor({
    browserLauncher,
    githubAutomation = runGithubAccountAutomation,
    requestDeviceCodeFn = defaultRequestDeviceCode,
    pollToken = defaultPollForToken,
    saveConnection = defaultSaveCodeBuddyGithubConnection,
    createApiKeyTokens = defaultCreateCodeBuddyApiKeyTokens,
    proxyResolver = resolveBulkImportProxy,
    pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
  } = {}) {
    super({
      storageName: "codebuddy-github-bulk-import",
      providerLabel: CODEBUDDY_LABEL,
      browserLauncher,
      browserPerAccount: true,
      defaultConcurrency: CODEBUDDY_GITHUB_BULK_IMPORT_DEFAULT_CONCURRENCY,
    });

    this.githubAutomation = githubAutomation;
    this.requestDeviceCode = requestDeviceCodeFn;
    this.pollToken = pollToken;
    this.saveConnection = saveConnection;
    this.createApiKeyTokens = createApiKeyTokens;
    this.proxyResolver = proxyResolver;
    this.pollIntervalMs = pollIntervalMs;
  }

  async startJob({
    accounts,
    parsedAccounts,
    concurrency,
    browser,
    proxyPoolId = null,
    // When true, workers open a visible Camoufox window so the operator can
    // watch the flow (and manually take over any surface the automation
    // stalls on — GitHub 2FA, weird region-page variants, etc.). Defaults
    // to true so bulk jobs stay unattended.
    headless = true,
  } = {}) {
    let normalizedAccounts = parsedAccounts;
    if (!Array.isArray(normalizedAccounts)) {
      const { parsed, invalidLines } = parseCodeBuddyGithubBulkAccounts(accounts);
      if (invalidLines.length > 0) {
        const error = "Invalid account format. Use one account per line: github_username_or_email|password";
        throw Object.assign(new Error(error), { error, invalidLines });
      }
      normalizedAccounts = parsed;
    }

    // Proxy is optional here. When a pool is provided, distribute proxies
    // round-robin across workers; a pool smaller than the account count is
    // allowed and will simply reuse proxies across accounts.
    let resolvedProxy = null;
    if (proxyPoolId) {
      resolvedProxy = await this.proxyResolver({ proxyPoolId });
      if (resolvedProxy.error) {
        throw Object.assign(new Error(resolvedProxy.error), { error: resolvedProxy.error, status: 400 });
      }
      if (!(resolvedProxy.proxyUrls || []).length) {
        const error = "Proxy pool has no usable proxies";
        throw Object.assign(new Error(error), { error, status: 400 });
      }
    }

    const availableProxyUrls = resolvedProxy?.proxyUrls || [];
    const proxyByLine = new Map((normalizedAccounts || []).map((account, index) => [
      account.line,
      availableProxyUrls.length
        ? availableProxyUrls[index % availableProxyUrls.length]
        : null,
    ]));

    const sanitizedJob = super.startJob({
      parsedAccounts: normalizedAccounts,
      concurrency,
      browser,
      browserLaunchOptions: ({ account }) => ({
        headless: headless !== false,
        proxy: proxyByLine.get(account.line),
      }),
    });
    const job = this.jobs.get(sanitizedJob.jobId);
    if (job) {
      job.proxyPoolId = resolvedProxy?.proxyPoolId || null;
      job.proxySource = resolvedProxy?.proxySource || null;
      job.proxyChecked = resolvedProxy?.proxyChecked || null;
      job.socialProvider = "github";
      job.headlessRequested = headless !== false;
    }
    return this.getJob(sanitizedJob.jobId);
  }

  async runManualFollowup(job, account, workerId, context, successPromise, accountBrowser) {
    const followupPromise = (async () => {
      try {
        const result = await successPromise;
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual completion",
          });
          await this.persistJobSnapshot(job, { forcePreview: true });
          return;
        }

        const manualPage = account.manualSession?.page;
        if (!manualPage) throw new Error("CodeBuddy browser session missing for API key creation");

        this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration");
        await this.persistJobSnapshot(job, { forcePreview: true });
        await completeCodeBuddyRegistration(manualPage, (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        });

        const tokensWithApiKey = await this.createApiKeyTokens({
          page: manualPage,
          tokens: result.tokens || {},
          email: account.email,
          onStep: (step, message) => {
            this.setAccountStep(account, step, message);
            void this.persistJobSnapshot(job, { forcePreview: false });
          },
        });

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy API key connection (GitHub)");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, tokensWithApiKey);
        const { connection } = await this.saveConnection({
          tokens: { ...tokensWithCookie, isActive: false },
          email: account.email,
          proxyPoolId: job.proxyPoolId,
          proxySource: job.proxySource,
        });

        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy (GitHub) API key connection saved successfully",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
      } catch (error) {
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual completion",
          });
        } else {
          this.finalizeAccount(account, "failed_exchange", {
            error: error.message || "Manual assist flow failed during token polling.",
            step: "exchange_failed",
            message: error.message || "Manual assist flow failed during token polling.",
          });
        }
        await this.persistJobSnapshot(job, { forcePreview: true });
      } finally {
        account.manualSession = null;
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await accountBrowser?.close?.().catch(() => null);
        job.activeBrowsers?.delete(accountBrowser);
        job.manualFollowups.delete(followupPromise);
        await this.persistJobSnapshot(job, { forcePreview: true });
      }
    })();

    job.manualFollowups.add(followupPromise);
  }

  async processAccount(job, account, workerId, accountBrowser) {
    if (job.cancelRequested || !accountBrowser) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    const { context, page } = await createFreshContext(accountBrowser);
    account.runtimeSession = { context, page };
    let pollController = null;

    try {
      this.setAccountStep(account, "preparing_worker", `Worker ${workerId} is preparing a browser context (GitHub SSO)`);
      await this.persistJobSnapshot(job, { forcePreview: true });

      this.setAccountStep(account, "requesting_codebuddy_state", "Requesting CodeBuddy OAuth state");
      const deviceData = await this.requestDeviceCode(CODEBUDDY_PROVIDER_ID);
      const authUrl = normalizeCodeBuddyAuthUrl(deviceData.verification_uri, deviceData.device_code);
      if (!authUrl || !deviceData.device_code) {
        throw new Error("CodeBuddy did not return an OAuth login URL");
      }

      pollController = new AbortController();
      // Track whether we already pushed the browser to /started so we don't
      // spam the same navigation every poll cycle. Region attempts are gated
      // by "still on region page?" instead of a one-shot flag so a partial
      // click (opened dropdown but did not submit) does not permanently
      // lock the poll driver out.
      let startedCallbackAttempted = false;
      let regionAttempts = 0;
      // 20 attempts × ~5s poll interval = ~100s budget on the region page,
      // enough for the humanize handler to iterate through input type,
      // dropdown pick, humanized submit click, then fall through to the
      // JS-synthetic click fallback if the framework rejects the first hit.
      const MAX_REGION_ATTEMPTS = 20;
      const successPromise = createCodeBuddyPollPromise({
        deviceCode: deviceData.device_code,
        pollToken: this.pollToken,
        signal: pollController.signal,
        shouldCancel: () => job.cancelRequested,
        pollIntervalMs: this.pollIntervalMs,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
        // Runs between poll attempts. Once GitHub authorize succeeds the
        // browser lands on a codebuddy.ai session page — we still need the
        // `/started?state=<device_code>` callback to fire so the CodeBuddy
        // backend can associate this session with the pending device code
        // and issue an OAuth token to the poller. Mirrors what
        // `completeCodeBuddyOAuthState` does in the Google GSuite manager.
        onPending: async (_result, _pollAttempt) => {
          try {
            if (job.cancelRequested) return;
            const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
            let parsed = null;
            try { parsed = currentUrl ? new URL(currentUrl) : null; } catch { parsed = null; }
            if (!parsed) return;

            // Early terminal check: CodeBuddy "Account Access Restricted"
            // page. Fires the main automation loop back with a failed_restricted
            // result via pollController.abort() so we do not spin the full
            // 3-minute budget waiting for a token that will never come.
            if (
              (parsed.hostname === "www.codebuddy.ai" || parsed.hostname.endsWith(".codebuddy.ai"))
              && !parsed.hostname.endsWith("github.com")
            ) {
              const pageText = await page.evaluate(
                () => String(document.body?.innerText || "").toLowerCase()
              ).catch(() => "");
              const isRestricted = pageText.includes("account access restricted")
                || pageText.includes("temporarily unavailable due to security")
                || pageText.includes("security policy restrictions")
                || pageText.includes("contact tencent cloud support");
              if (isRestricted) {
                this.setAccountStep(
                  account,
                  "codebuddy_account_restricted",
                  "CodeBuddy rejected this account (Account Access Restricted). Aborting poll."
                );
                // Abort the poll so the main automation loop's next race
                // resolves with failed_timeout → but we also throw a marker
                // error via pollController so the main loop reads the
                // restricted status from the text scan. Simplest: just
                // return here; the runGithubAccountAutomation main loop
                // has its own restricted detection block that will fire
                // on the next tick (once the racing 800ms timer expires).
                return;
              }
            }

            // Region selection surface. Retry every tick until we leave the
            // page — sometimes the first click opens the dropdown but the
            // second is needed to submit, and the "Registration location"
            // variant renders its Submit differently from the classic
            // dropdown flow. Cap retries so we do not spin forever on a
            // genuinely stuck page.
            if (/register\/user\/complete/i.test(parsed.pathname)) {
              if (regionAttempts >= MAX_REGION_ATTEMPTS) return;
              regionAttempts += 1;
              const reportPollStep = (step, message) => {
                this.setAccountStep(account, step, message);
                void this.persistJobSnapshot(job, { forcePreview: false });
              };
              this.setAccountStep(
                account,
                "handling_region_page",
                `Attempt ${regionAttempts}/${MAX_REGION_ATTEMPTS}: driving CodeBuddy region selection (humanize + Singapore)`
              );
              // Try the humanize variant first (new dark-theme UI with a
              // prefilled input + green Submit button). If it does not
              // find a matching Submit, fall back to the shared handler
              // for the classic .page-region dropdown flow.
              const humanized = await humanizeRegionSelection(page, reportPollStep, "Singapore").catch(() => false);
              if (!humanized) {
                await handleCodeBuddyRegionPage(page, reportPollStep).catch(() => false);
              }
              await page.waitForTimeout(1_500).catch(() => null);
              return;
            }

            const onCodeBuddy = parsed.hostname === "www.codebuddy.ai" || parsed.hostname.endsWith(".codebuddy.ai");
            if (!onCodeBuddy) return;

            // Already on /started with the right state — let the shared
            // handler fire the CLI-login authorize call.
            if (/\/started\/?$/.test(parsed.pathname)) {
              const handled = await handleCodeBuddyStartedAuthorization(page, (step, message) => {
                this.setAccountStep(account, step, message);
                void this.persistJobSnapshot(job, { forcePreview: false });
              }).catch(() => false);
              if (handled) startedCallbackAttempted = true;
              return;
            }

            // Authenticated on codebuddy.ai but not on /started (e.g. /home
            // after region submit). Push the browser to /started so the
            // backend can bind the device code to this session.
            if (!startedCallbackAttempted && !/^\/(?:login|auth|register)(?:\/|$)/.test(parsed.pathname)) {
              const startedUrl = new URL("https://www.codebuddy.ai/started");
              startedUrl.searchParams.set("platform", "CLI");
              startedUrl.searchParams.set("state", deviceData.device_code);
              this.setAccountStep(
                account,
                "navigating_to_started_callback",
                "Navigating browser to /started so CodeBuddy can bind the device code"
              );
              await page.goto(startedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
              await page.waitForTimeout(1_000).catch(() => null);
              const handled = await handleCodeBuddyStartedAuthorization(page, (step, message) => {
                this.setAccountStep(account, step, message);
                void this.persistJobSnapshot(job, { forcePreview: false });
              }).catch(() => false);
              startedCallbackAttempted = true;
              if (!handled) {
                this.setAccountStep(
                  account,
                  "started_callback_not_accepted",
                  "The /started callback was not accepted yet; token polling will continue"
                );
              }
            }
          } catch (err) {
            // Poll-driver failures are non-fatal; the next poll tick will retry.
            this.setAccountStep(account, "poll_driver_error", `Poll-side driver error: ${err?.message || err}`);
          }
        },
      });

      const automationResult = await this.githubAutomation({
        page,
        authUrl,
        username: account.email,   // one value; githubOAuth accepts either
        email: account.email,
        password: account.password,
        successPromise,
        // GitHub SSO has an extra hop compared to Google (device verify +
        // Authorize consent + redirect back to /login/select). Raise the
        // per-account budget so a single slow render does not tip an
        // otherwise-successful account into needs_manual.
        shortTimeoutMs: 180_000,
        // Custom region-page handler for the dark-theme variant that ships
        // a <div class="cursor-pointer">Submit</div> instead of a real
        // <button>. Runs before the shared handleCodeBuddyRegionPage which
        // only knows about the classic .page-region markup.
        customRegionHandler: async (p, reportStep) => (
          await humanizeRegionSelection(p, reportStep, "Singapore").catch(() => false)
        ),
        // GitHub's Device Verification surface: `otpTargetEmail` is the
        // catch-all mailbox that receives the code; runGithubAccountAutomation
        // reads it via IMAP (IMAP_USER/IMAP_PASS in env). Falls back to
        // needs_manual when IMAP is not configured or the code never
        // arrives within the OTP timeout window.
        otpTargetEmail: account.email,
        otpTimeoutMs: 180_000,
        serviceLabel: CODEBUDDY_LABEL,
        openingStep: "opening_codebuddy_oauth",
        openingMessage: "Opening CodeBuddy OAuth page for GitHub sign-in",
        successStep: "codebuddy_token_received",
        successMessage: "CodeBuddy OAuth token received (via GitHub SSO)",
        // For GitHub SSO, "Account Access Restricted" is a hard terminal
        // rejection — the account cannot be recovered by continuing. Set
        // bypass to false so runGithubAccountAutomation fails fast with
        // failed_restricted instead of pretending the flow succeeded.
        allowProviderRestrictedBypass: false,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (automationResult.status === "success") {
        if (automationResult.restrictedBypass) pollController.abort();

        this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration (GitHub)");
        await this.persistJobSnapshot(job, { forcePreview: true });
        await completeCodeBuddyRegistration(page, (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        });

        const tokensWithApiKey = await this.createApiKeyTokens({
          page,
          tokens: automationResult.tokens || {},
          email: account.email,
          onStep: (step, message) => {
            this.setAccountStep(account, step, message);
            void this.persistJobSnapshot(job, { forcePreview: false });
          },
        });

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy API key connection (GitHub)");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, tokensWithApiKey);
        const { connection } = await this.saveConnection({
          tokens: { ...tokensWithCookie, isActive: false },
          email: account.email,
          proxyPoolId: job.proxyPoolId,
          proxySource: job.proxySource,
        });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy (GitHub) API key connection saved successfully",
        });
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      if (automationResult.status === "needs_manual") {
        account.manualSession = { context, page, opened: false, openedAt: null };
        this.setAccountStep(account, "awaiting_manual", "Waiting for manual completion in the GitHub browser session");
        this.finalizeAccount(account, "needs_manual", {
          error: automationResult.error,
          step: "awaiting_manual",
          message: automationResult.error,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        await this.runManualFollowup(job, account, workerId, context, successPromise, accountBrowser);
        return;
      }

      pollController.abort();
      this.finalizeAccount(account, automationResult.status || "failed", {
        error: automationResult.error || "CodeBuddy GitHub automation failed.",
        step: automationResult.status || "failed",
        message: automationResult.error || "CodeBuddy GitHub automation failed.",
      });
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      pollController?.abort();
      if (job.cancelRequested) {
        this.finalizeAccount(account, "cancelled", {
          error: "Job cancelled",
          step: "cancelled",
          message: "Job cancelled while CodeBuddy GitHub automation was running",
        });
      } else {
        this.finalizeAccount(account, "failed", {
          error: error.message || "Unexpected CodeBuddy GitHub bulk import failure.",
          step: "failed",
          message: error.message || "Unexpected CodeBuddy GitHub bulk import failure.",
        });
      }
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      account.password = undefined;
    }
  }
}

export function parseCodeBuddyGithubBulkAccounts(accounts = []) {
  return parseBulkAccounts(accounts, CODEBUDDY_LABEL);
}

function getSingletonStore() {
  if (!globalThis.__codeBuddyGithubBulkImportSingleton) {
    globalThis.__codeBuddyGithubBulkImportSingleton = { manager: new CodeBuddyGithubBulkImportManager() };
  }
  return globalThis.__codeBuddyGithubBulkImportSingleton;
}

export function getCodeBuddyGithubBulkImportManager() {
  return getSingletonStore().manager;
}

export { buildLookupResponse };
