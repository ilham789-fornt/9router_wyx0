/**
 * githubSignupAutomation.js — Drive github.com/signup end-to-end.
 *
 * Ported from the tested Python reference at
 * `D:\porto vibe\bot farm2\github-farm-edu\farm.py` (reverse-engineered
 * against the signup-b6d6c1f9ec8b74e0.js bundle, Dec 2024). The Python
 * version has been battle-tested against real GitHub signup pages; this
 * port preserves the same selectors, ordering, and success/failure state
 * detection.
 *
 * Key facts (see FLOW.md in the reference project):
 *   - The signup form is SINGLE-PAGE: country + email + password +
 *     password_confirmation + username all shown together. There is no
 *     multi-step "Continue" wizard.
 *   - Field selectors are stable: `input[name="user[email]"]`,
 *     `input.js-password-with-confirmation`, `input.js-password-confirm`,
 *     `input[name="user[login]"]`.
 *   - The primary submit button is `.js-octocaptcha-load-captcha` ("Verify"),
 *     which pops the octocaptcha iframe.
 *   - After "Verify", either (a) GitHub silently bypasses captcha for a
 *     good fingerprint and progresses to email verification, or (b) the
 *     octocaptcha iframe demands solving — we cannot bypass without a
 *     paid solver, so we surface `needs_manual` with the browser open.
 *   - GitHub emails an 8-digit code + a direct-confirm URL of the form
 *     `https://github.com/account_verifications/confirm/<uuid>/<code>`.
 *     Navigating to that URL is more reliable than typing the code.
 *   - Success is detected via URL (`/welcome`, `/onboarding`, `/dashboard`,
 *     …) or the "account was created" copy on the resulting /login page.
 *
 * Return shape (mirrors `runGithubAccountAutomation` for symmetry):
 *   { status: "success", email, username, password, landingUrl }
 *   { status: "needs_manual", reason, error }
 *   { status: "failed_username_taken", error }
 *   { status: "failed_rate_limited", error }
 *   { status: "failed_phone_verify", error }
 *   { status: "failed", error }
 *
 * The caller (bulk-register manager) decides retry vs abort. This helper
 * never mutates account state or persists anything.
 */

const SIGNUP_URL = "https://github.com/signup";
const DEFAULT_SHORT_TIMEOUT_MS = 30_000;
const DEFAULT_OTP_TIMEOUT_MS = 180_000;
const DEFAULT_COUNTRY = "Indonesia"; // Lower verification friction than US/UK.

// ── Screenshot-on-error helper ─────────────────────────────────────────────
//
// When the automation hits a needs_manual / failed branch we take a best-
// effort screenshot into `data/github-signup-screenshots/<label>_<ts>.jpg`.
// Directory creation and screenshot capture both swallow errors so a
// disk-space or permission problem never masks the real automation error
// the caller cares about.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../../dataDir.js";

const SCREENSHOT_DIR = join(DATA_DIR, "github-signup-screenshots");

async function saveScreenshot(page, label) {
  if (!page?.screenshot) return null;
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  } catch { /* ignore */ }
  const safeLabel = String(label || "signup").replace(/[^a-z0-9_\-]/gi, "_").slice(0, 60);
  const filename = `${safeLabel}_${Date.now()}.jpg`;
  const filePath = join(SCREENSHOT_DIR, filename);
  try {
    await page.screenshot({
      path: filePath,
      type: "jpeg",
      quality: 60,
      fullPage: false,
      animations: "disabled",
      caret: "hide",
    });
    return filePath;
  } catch { return null; }
}

// Reference-verified selectors. Order matters: primary first, fallbacks after.
const EMAIL_INPUT_SELECTORS = [
  'input[name="user[email]"]',
  'input.js-auto-check-input[type="email"]',
  'input[autocomplete="email"]',
];

const PASSWORD_INPUT_SELECTORS = [
  'input.js-password-with-confirmation',
  'input[name="user[password]"]',
  'input[autocomplete="new-password"]',
];

const PASSWORD_CONFIRM_INPUT_SELECTORS = [
  'input.js-password-confirm',
  'input[name="user[password_confirmation]"]',
];

const USERNAME_INPUT_SELECTORS = [
  'input[name="user[login]"]',
  'input[autocomplete="username"]',
];

const COUNTRY_BUTTON_SELECTORS = [
  'select-panel button.country-select-button',
  'button.country-select-button',
];

const COUNTRY_SEARCH_INPUT_SELECTORS = [
  'input[type="search"]',
  'input[placeholder*="Search" i]',
  'input[aria-label*="country" i]',
];

const VERIFY_BUTTON_SELECTORS = [
  '.js-octocaptcha-load-captcha',
  'button:has-text("Verify")',
  'button:has-text("Create account")',
  'button:has-text("Create an account")',
];

const OTP_SINGLE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
  'input[name="otp"]',
  'input[name="launch_code"]',
  'input[data-target*="code"]',
];

const OTP_DIGIT_BOX_SELECTORS = [
  'input[inputmode="numeric"][maxlength="1"]',
  'input[data-index]',
];

const OTP_SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("Verify")',
  'button:has-text("Continue")',
  'button:has-text("Confirm")',
];

const SUGGESTED_USERNAME_SELECTORS = [
  '.js-suggested-username',
  '[data-target*="suggested-username"]',
];

// Direct-confirm URL that GitHub embeds inside the verification email.
const GITHUB_CONFIRM_URL_RE = /https:\/\/github\.com\/account_verifications\/confirm\/[a-f0-9\-]+\/\d{6,8}/;
// OTP body regex — 8 digits primary, 6 as fallback.
const GITHUB_SIGNUP_OTP_RE = /\b(\d{6,8})\b/g;

// URL patterns that indicate SUCCESS.
const ONBOARDING_URL_MARKERS = [
  "/welcome", "/get-started", "/select-features",
  "/onboarding", "/interests", "/personal-plan",
];
const LOGGED_IN_URL_MARKERS = [
  "github.com/dashboard", "github.com/home",
  "github.com/notifications", "github.com/settings",
];

// Copy fragments (lowercase) that indicate specific states.
const SUCCESS_COPY_FRAGMENTS = [
  "account was created successfully",
  "account was created",
  "successfully created your account",
  "your account has been created",
];
const PHONE_VERIFY_COPY_FRAGMENTS = [
  "verify your phone",
  "sms verification",
];
const RATE_LIMITED_COPY_FRAGMENTS = [
  "unusual activity",
  "please try again later",
  "too many attempts",
];
const CAPTCHA_COPY_FRAGMENTS = [
  "octocaptcha",
];
const USERNAME_TAKEN_COPY_FRAGMENTS = [
  "already taken",
  "unavailable",
];

// URL patterns that indicate the OTP entry page.
const DEVICE_VERIFY_URL_FRAGMENTS = [
  "/account_verifications",
  "/two-factor",
  "/session/verified-device",
];

// ── Small locator + timing helpers ─────────────────────────────────────────

function pickRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitStable(page, ms = 800) {
  try {
    await page.waitForLoadState?.("networkidle", { timeout: 5_000 });
  } catch { /* ignore */ }
  await page.waitForTimeout?.(ms).catch(() => null);
}

/**
 * Simulate a human "reading the page" pause. GitHub's post-signup behavioral
 * scoring tracks time-on-page per form section — a signup completed in
 * < 30 seconds is flagged even if the fingerprint looks fine. We insert a
 * randomized reading pause between logical sections (country → email,
 * email → password, password → username, username → submit) so the total
 * form fill lands in the human 60-120s range instead of the automation
 * 15-25s range.
 *
 * The pause optionally includes a small mouse jitter so keyboard-only
 * automation is not identifiable by "zero cursor events during typing".
 */
async function readingPause(page, { minMs, maxMs, label = "reading" } = {}) {
  const duration = pickRandomInt(minMs, maxMs);
  // Emit a small mouse wiggle roughly in the middle so the pause is not a
  // pure `sleep` — real humans move the cursor while reading.
  const wiggleAt = Math.floor(duration * pickRandomInt(30, 70) / 100);
  const wiggleTask = (async () => {
    await page.waitForTimeout?.(wiggleAt).catch(() => null);
    try {
      const w = pickRandomInt(200, 900);
      const h = pickRandomInt(200, 600);
      await page.mouse?.move?.(w, h, { steps: pickRandomInt(6, 12) }).catch(() => null);
    } catch { /* ignore */ }
  })();
  await Promise.all([
    page.waitForTimeout?.(duration).catch(() => null),
    wiggleTask,
  ]);
  return { label, duration };
}

async function findFirstVisible(page, selectors, { timeoutMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        const count = await locator.count().catch(() => 0);
        if (!count) continue;
        const visible = await locator.isVisible().catch(() => false);
        if (visible) return locator;
      } catch { /* try next */ }
    }
    await page.waitForTimeout?.(150).catch(() => null);
  }
  return null;
}

async function typeHumanlike(locator, text, page) {
  for (const ch of String(text)) {
    await locator.type?.(ch, { delay: pickRandomInt(60, 180) }).catch(() => null);
  }
  await page.waitForTimeout?.(80).catch(() => null);
}

/**
 * Move the mouse in a short arc to the center of the locator's bounding box,
 * then click. GitHub's post-signup behavioral scoring inspects `mousemove`
 * event trails; a synthetic `click()` without prior movement is a strong
 * "automated" signal, even when Camoufox's own humanize=true is enabled
 * (which humanizes system-level cursor paths but only when there ARE cursor
 * paths to humanize — a direct `element.click()` bypasses that).
 *
 * The arc is 3 waypoints with random jitter so consecutive clicks do not
 * trace the same line. Uses page.mouse.move which fires real `mousemove`
 * events; falls back to a plain click if the locator's bounding box is
 * unavailable (some SVG/pseudo elements).
 */
async function humanClick(page, locator, { timeoutMs = 4_000 } = {}) {
  try {
    const box = await locator.boundingBox?.().catch(() => null);
    if (box && page.mouse?.move) {
      const targetX = box.x + box.width / 2 + pickRandomInt(-3, 3);
      const targetY = box.y + box.height / 2 + pickRandomInt(-3, 3);
      // Start from a plausible "current" position (upper-left area) so the
      // first movement of the run is not a teleport from (0,0) to target.
      const startX = pickRandomInt(80, 320);
      const startY = pickRandomInt(120, 260);
      const midX = (startX + targetX) / 2 + pickRandomInt(-40, 40);
      const midY = (startY + targetY) / 2 + pickRandomInt(-30, 30);
      // steps > 1 makes Playwright emit intermediate mousemove events.
      await page.mouse.move(startX, startY, { steps: pickRandomInt(4, 8) }).catch(() => null);
      await page.mouse.move(midX, midY, { steps: pickRandomInt(6, 12) }).catch(() => null);
      await page.mouse.move(targetX, targetY, { steps: pickRandomInt(8, 14) }).catch(() => null);
      // Brief settle before the click so the fingerprint scorer sees a
      // "human" pause between hover and click, not an instant tap.
      await page.waitForTimeout?.(pickRandomInt(80, 180)).catch(() => null);
    }
  } catch { /* fall through to plain click */ }
  await locator.click({ timeout: timeoutMs }).catch(() => null);
}

async function clearAndType(locator, text, page) {
  // fill("") clears without firing per-key input events — that is fine for
  // the *initial* clear, but the subsequent typing must fire input events so
  // React/Turbo-controlled validators pick up the value.
  await locator.fill?.("").catch(() => null);
  await typeHumanlike(locator, text, page);
}

async function safePageHtml(page) {
  try {
    const html = await page.content?.();
    return String(html || "").slice(0, 80_000);
  } catch { return ""; }
}

async function hasSessionCookie(page) {
  try {
    const cookies = await page.context?.().cookies?.("https://github.com").catch(() => []);
    return (cookies || []).some((c) => (
      c?.name?.startsWith?.("user_session") || c?.name?.startsWith?.("logged_in")
    ));
  } catch { return false; }
}

// ── State detection ────────────────────────────────────────────────────────
//
// Mirrors farm.py's `detect_state()`. Returns one of:
//   "ok" | "captcha_present" | "rate_limited" | "device_verify"
//   "phone_verify" | "onboarding" | "logged_in" | "account_created"
//   "unknown"

async function detectState(page) {
  const url = String(page.url?.() || "").toLowerCase();

  if (ONBOARDING_URL_MARKERS.some((marker) => url.includes(marker))) return "onboarding";
  if (LOGGED_IN_URL_MARKERS.some((marker) => url.includes(marker))) return "logged_in";

  // Bare github.com/ landing — cross-check with session cookie.
  const bare = url.replace(/\/+$/, "");
  if (bare === "https://github.com" || bare === "http://github.com") {
    if (await hasSessionCookie(page)) return "logged_in";
  }

  if (DEVICE_VERIFY_URL_FRAGMENTS.some((frag) => url.includes(frag))) return "device_verify";

  const html = (await safePageHtml(page)).toLowerCase();
  if (!html) return "unknown";

  if (SUCCESS_COPY_FRAGMENTS.some((phrase) => html.includes(phrase))) return "account_created";
  if (PHONE_VERIFY_COPY_FRAGMENTS.some((phrase) => html.includes(phrase))
      || (html.includes("phone number") && html.includes("verify"))) return "phone_verify";
  if (RATE_LIMITED_COPY_FRAGMENTS.some((phrase) => html.includes(phrase))) return "rate_limited";
  if (CAPTCHA_COPY_FRAGMENTS.some((phrase) => html.includes(phrase)) && html.includes("iframe")) return "captcha_present";
  if (html.includes("launch code") || (html.includes("verification code") && html.includes("verify"))) return "device_verify";

  return "ok";
}

// ── Country select (optional / AB-tested) ──────────────────────────────────

async function fillCountry(page, countryName, report) {
  try {
    const button = await findFirstVisible(page, COUNTRY_BUTTON_SELECTORS, { timeoutMs: 3_000 });
    if (!button) return true; // not shown, skip

    await humanClick(page, button, { timeoutMs: 4_000 });
    await page.waitForTimeout?.(pickRandomInt(500, 900)).catch(() => null);

    const search = await findFirstVisible(page, COUNTRY_SEARCH_INPUT_SELECTORS, { timeoutMs: 2_500 });
    if (search) {
      await typeHumanlike(search, countryName, page);
      await page.waitForTimeout?.(pickRandomInt(600, 1_000)).catch(() => null);
    }

    const option = page.locator(
      `[role="option"]:has-text("${countryName}"), li:has-text("${countryName}")`
    ).first();
    await humanClick(page, option, { timeoutMs: 4_000 });
    await page.waitForTimeout?.(pickRandomInt(400, 800)).catch(() => null);
    report?.("country_selected", `Selected country "${countryName}"`);
    return true;
  } catch (err) {
    report?.("country_select_skipped", `Country select skipped: ${err?.message || err}`);
    return false;
  }
}

// ── Auto-check field (email / username) ────────────────────────────────────
//
// Fills a field that has server-side auto-check XHR validation. Returns true
// on validation pass, false when GitHub rejects the value.

async function fillAndWaitAutocheck(page, locator, value, label) {
  await clearAndType(locator, value, page);
  await page.keyboard?.press?.("Tab").catch(() => null);
  await waitStable(page, pickRandomInt(1_500, 2_500));

  try {
    const html = (await safePageHtml(page)).toLowerCase();
    if (label === "username" && html.includes("unavailable")) return false;
    if (USERNAME_TAKEN_COPY_FRAGMENTS.some((frag) => html.includes(frag))) return false;
    if (html.includes("email is invalid")) return false;
    const invalidAttr = await locator.getAttribute?.("aria-invalid").catch(() => null);
    if (invalidAttr === "true") return false;
  } catch { /* ignore */ }
  return true;
}

async function trySuggestedUsername(page) {
  try {
    for (const selector of SUGGESTED_USERNAME_SELECTORS) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const text = await locator.innerText?.().catch(() => "");
      const cleaned = String(text || "").trim();
      if (cleaned) return cleaned;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run the GitHub signup automation.
 *
 * @param {object} params
 * @param {import("playwright").Page} params.page   Camoufox page to drive.
 * @param {string} params.email                     Address from Privatix.
 * @param {string} params.username                  Desired GitHub username.
 * @param {string} params.password                  Password to set.
 * @param {object} params.tempMailClient            Must expose waitForOtp(email, opts)
 *                                                  returning `{ code, confirmUrl } | null`.
 * @param {string}  [params.country]                Country to select. Default "Indonesia".
 * @param {number}  [params.shortTimeoutMs]         Per-form-step wait budget.
 * @param {number}  [params.otpTimeoutMs]           Full OTP polling budget.
 * @param {number}  [params.captchaWaitMs]          How long to wait for GitHub to
 *                                                  auto-bypass captcha before we
 *                                                  give up (default 30s).
 * @param {(step, message) => void} [params.onStep]
 */
export async function runGithubSignupAutomation({
  page,
  email,
  username,
  password,
  tempMailClient,
  country = DEFAULT_COUNTRY,
  shortTimeoutMs = DEFAULT_SHORT_TIMEOUT_MS,
  otpTimeoutMs = DEFAULT_OTP_TIMEOUT_MS,
  captchaWaitMs = 30_000,
  onStep = null,
} = {}) {
  const report = (step, message) => { try { onStep?.(step, message); } catch { /* swallow */ } };

  if (!page) return { status: "failed", error: "GitHub signup requires a page" };
  if (!email || !username || !password) {
    return { status: "failed", error: "GitHub signup requires email, username and password" };
  }
  if (!tempMailClient?.waitForOtp) {
    return { status: "failed", error: "GitHub signup requires a temp-mail client" };
  }

  let currentUsername = username;

  try {
    // ── Step 1: Load /signup ──────────────────────────────────────────
    report("navigating_to_signup", "Opening github.com/signup");
    await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: shortTimeoutMs }).catch(() => null);
    await waitStable(page, pickRandomInt(2_000, 3_500));

    let state = await detectState(page);
    if (state === "rate_limited") {
      const screenshot = await saveScreenshot(page, "rate_limited_initial");
      return { status: "failed_rate_limited", error: "GitHub /signup returned rate-limit page on landing", screenshot };
    }

    // ── Step 2: Country (optional; AB-tested) ─────────────────────────
    await fillCountry(page, country, report);

    // ── Step 3: Email + auto-check ────────────────────────────────────
    // Use half the short-step budget for locating the initial email field —
    // scaled so tests with tight shortTimeoutMs values do not stall.
    const emailProbeTimeout = Math.min(15_000, Math.max(500, Math.floor(shortTimeoutMs / 2)));
    const emailInput = await findFirstVisible(page, EMAIL_INPUT_SELECTORS, { timeoutMs: emailProbeTimeout });
    if (!emailInput) return { status: "failed", error: "GitHub signup email input not found" };
    report("filling_email", `Typing signup email ${email}`);
    const emailOk = await fillAndWaitAutocheck(page, emailInput, email, "email");
    if (!emailOk) {
      const screenshot = await saveScreenshot(page, "email_rejected");
      return { status: "failed", error: "Email rejected by GitHub auto-check (invalid or blocked)", screenshot };
    }

    // ── Step 4: Password + confirmation ───────────────────────────────
    const passInput = await findFirstVisible(page, PASSWORD_INPUT_SELECTORS, { timeoutMs: 10_000 });
    if (!passInput) return { status: "failed", error: "GitHub signup password input not found" };
    report("filling_password", "Typing password");
    await clearAndType(passInput, password, page);
    await page.waitForTimeout?.(pickRandomInt(500, 900)).catch(() => null);

    const passConfirm = await findFirstVisible(page, PASSWORD_CONFIRM_INPUT_SELECTORS, { timeoutMs: 3_000 });
    if (passConfirm) {
      report("filling_password_confirmation", "Typing password confirmation");
      await clearAndType(passConfirm, password, page);
      await page.keyboard?.press?.("Tab").catch(() => null);
      await page.waitForTimeout?.(pickRandomInt(500, 900)).catch(() => null);
    }

    // ── Step 5: Username (retry on collision) ─────────────────────────
    const userInput = await findFirstVisible(page, USERNAME_INPUT_SELECTORS, { timeoutMs: 10_000 });
    if (!userInput) return { status: "failed", error: "GitHub signup username input not found" };

    let usernameAccepted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      report("filling_username", `Trying username "${currentUsername}" (attempt ${attempt + 1}/3)`);
      const ok = await fillAndWaitAutocheck(page, userInput, currentUsername, "username");
      if (ok) { usernameAccepted = true; break; }
      const suggested = await trySuggestedUsername(page);
      if (suggested) currentUsername = suggested;
      else break; // cannot generate a new one from here — caller must retry
    }
    if (!usernameAccepted) {
      const screenshot = await saveScreenshot(page, "username_taken");
      return { status: "failed_username_taken", error: `Username "${currentUsername}" (and suggestions) rejected`, screenshot };
    }

    // ── Step 6: Verify button → octocaptcha ───────────────────────────
    await page.waitForTimeout?.(pickRandomInt(800, 1_500)).catch(() => null);
    state = await detectState(page);
    if (state === "rate_limited") {
      const screenshot = await saveScreenshot(page, "rate_limited_pre_submit");
      return { status: "failed_rate_limited", error: "Rate-limited before submit", screenshot };
    }

    const verifyBtn = await findFirstVisible(page, VERIFY_BUTTON_SELECTORS, { timeoutMs: 5_000 });
    if (!verifyBtn) return { status: "failed", error: "Verify / Create-account button not found" };
    report("clicking_verify", "Clicking Verify / Create account to trigger captcha");
    await humanClick(page, verifyBtn, { timeoutMs: 5_000 });
    await waitStable(page, pickRandomInt(3_000, 5_000));

    // Poll for captcha suppression or captcha-required.
    const captchaDeadline = Date.now() + captchaWaitMs;
    let captchaCleared = false;
    while (Date.now() < captchaDeadline) {
      state = await detectState(page);
      if (state === "device_verify" || state === "onboarding" || state === "logged_in" || state === "account_created") {
        captchaCleared = true;
        break;
      }
      if (state === "phone_verify") {
        return { status: "failed_phone_verify", error: "GitHub asked for phone verification" };
      }
      if (state === "rate_limited") {
        return { status: "failed_rate_limited", error: "Rate-limited while waiting for captcha resolution" };
      }
      await page.waitForTimeout?.(2_000).catch(() => null);
    }

    if (!captchaCleared) {
      state = await detectState(page);
      if (state === "captcha_present") {
        return { status: "needs_manual", reason: "octocaptcha", error: "Octocaptcha shown; operator must solve" };
      }
      return { status: "needs_manual", reason: "captcha_timeout", error: "Timed out waiting for captcha resolution" };
    }

    // ── Step 7: Email OTP ─────────────────────────────────────────────
    report("waiting_for_email_otp", `Polling temp-mail inbox for ${email} (up to ${Math.round(otpTimeoutMs / 1000)}s)`);
    const otpHit = await tempMailClient.waitForOtp(email, {
      senderMatch: "github",
      otpPattern: GITHUB_SIGNUP_OTP_RE,
      confirmUrlPattern: GITHUB_CONFIRM_URL_RE,
      timeoutMs: otpTimeoutMs,
      onStep: (step, message) => report(step, message),
    }).catch((err) => {
      report("tempmail_error", `Privatix poll failed: ${err?.message || err}`);
      return null;
    });

    if (!otpHit?.code && !otpHit?.confirmUrl) {
      return { status: "needs_manual", reason: "otp_timeout", error: "GitHub verification email did not arrive in time" };
    }

    // ── Strategy A: direct-confirm URL (preferred, most reliable) ────
    if (otpHit.confirmUrl) {
      report("otp_direct_confirm", "Opening GitHub's direct-confirm URL from the OTP email");
      await page.goto(otpHit.confirmUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
      await waitStable(page, pickRandomInt(3_000, 5_000));
    }

    state = await detectState(page);

    // ── Strategy B/C: fill OTP form if still on verify page ──────────
    if (state === "device_verify") {
      const code = String(otpHit.code || "");
      report("typing_email_otp", `Typing OTP ${code}`);

      // Strategy B: single input field.
      let entered = false;
      const singleInput = await findFirstVisible(page, OTP_SINGLE_INPUT_SELECTORS, { timeoutMs: 5_000 });
      if (singleInput) {
        await clearAndType(singleInput, code, page);
        entered = true;
      }

      // Strategy C: per-digit boxes.
      if (!entered) {
        for (const selector of OTP_DIGIT_BOX_SELECTORS) {
          const boxes = page.locator(selector);
          const count = await boxes.count().catch(() => 0);
          if (count >= code.length) {
            for (let i = 0; i < code.length; i += 1) {
              await boxes.nth(i).fill?.(code[i]).catch(() => null);
              await page.waitForTimeout?.(pickRandomInt(80, 180)).catch(() => null);
            }
            entered = true;
            break;
          }
        }
      }

      if (!entered) {
        return { status: "needs_manual", reason: "otp_input_missing", error: "OTP received but the verify input is not visible" };
      }

      // Explicit submit — some pages auto-submit on last digit.
      await page.waitForTimeout?.(pickRandomInt(1_500, 2_500)).catch(() => null);
      const submitBtn = await findFirstVisible(page, OTP_SUBMIT_BUTTON_SELECTORS, { timeoutMs: 2_500 });
      if (submitBtn) {
        await humanClick(page, submitBtn, { timeoutMs: 3_000 });
      }
      await waitStable(page, pickRandomInt(3_000, 5_000));
    }

    // ── Step 8: Verify success landing ────────────────────────────────
    for (let i = 0; i < 6; i += 1) {
      state = await detectState(page);
      if (state === "onboarding" || state === "logged_in" || state === "account_created") break;
      await page.waitForTimeout?.(1_500).catch(() => null);
    }

    if (state === "onboarding" || state === "logged_in" || state === "account_created") {
      const landingUrl = String(page.url?.() || "");
      report("signup_completed", `GitHub signup completed (${state}) → ${landingUrl}`);
      return {
        status: "success",
        email,
        username: currentUsername,
        password,
        landingUrl,
        finalState: state,
      };
    }

    if (state === "phone_verify") {
      return { status: "failed_phone_verify", error: "GitHub asked for phone verification after OTP" };
    }
    if (state === "device_verify") {
      return { status: "needs_manual", reason: "otp_rejected", error: "OTP submitted but page did not advance" };
    }

    // Last-ditch content sweep — the page may show "account was created"
    // even when detect_state was too conservative.
    const html = (await safePageHtml(page)).toLowerCase();
    if (SUCCESS_COPY_FRAGMENTS.some((phrase) => html.includes(phrase))
        || html.includes("sign in to continue")) {
      const landingUrl = String(page.url?.() || "");
      report("signup_completed_late_detect", `Detected 'account created' copy on ${landingUrl}`);
      return {
        status: "success",
        email,
        username: currentUsername,
        password,
        landingUrl,
        finalState: "account_created_late",
      };
    }

    return { status: "needs_manual", reason: "signup_landing_unknown", error: `Signup did not land on a known state (state=${state})` };
  } catch (error) {
    return { status: "failed", error: error?.message || String(error) };
  }
}

// Named exports of helpers so the unit test can drive individual steps.
export {
  detectState,
  fillCountry,
  fillAndWaitAutocheck,
  trySuggestedUsername,
  GITHUB_CONFIRM_URL_RE,
  GITHUB_SIGNUP_OTP_RE,
  DEFAULT_COUNTRY,
};
