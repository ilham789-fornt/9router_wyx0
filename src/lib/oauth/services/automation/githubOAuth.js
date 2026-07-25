/**
 * githubOAuth.js — GitHub SSO automation helper for provider bulk-login flows.
 *
 * Mirrors googleOAuth.js in shape: takes a Camoufox `page` already routed to a
 * provider login URL, clicks the provider's "Sign in with GitHub" button (if
 * present), fills GitHub username/password, handles the OAuth authorize
 * consent, detects 2FA / captcha / device verification and either surfaces
 * needs_manual or races against `successPromise` (provider token polling).
 *
 * Contract with the manager (identical to runGoogleAccountAutomation):
 *   returns { status: "success" | "failed_invalid_credentials"
 *                    | "failed_timeout" | "needs_manual"
 *                    | "failed_restricted" | "failed",
 *             tokens?, error?, restrictedBypass? }
 *
 * Providers (CodeBuddy Global today) attach a `successPromise` that resolves
 * once their device-code polling endpoint returns a token. We race provider
 * polling against GitHub UI progress so a working session wins even if the
 * final GitHub redirect goes to a page we cannot introspect.
 */
import { handleCodeBuddyRegionPage, handleProviderOnboarding, handleCodeBuddyStartedAuthorization } from "./googleOAuth.js";
import { otpReaderFromEnv } from "./otpImapReader.js";

const DEFAULT_SHORT_TIMEOUT_MS = 90_000;

// GitHub's Device Verification screen. When a proxy-routed login lands on
// this page GitHub emails a code (8 digits) to the signup mailbox and blocks
// OAuth until the code is entered on /sessions/verified-device (or the
// direct-confirm URL from the email is opened). The handler below fulfils
// both paths automatically when IMAP_USER/IMAP_PASS are configured — see
// otpImapReader.js.
const GITHUB_DEVICE_VERIFY_URL_RE = /\/sessions\/verified-device|\/two-factor\/verify|\/account_verifications/i;
const GITHUB_DEVICE_VERIFY_HEADING_RE = /device verification|verify device|confirm your account|check your email/i;
const GITHUB_DEVICE_VERIFY_INPUT_SELECTORS = [
  'input[name="otp"]',
  'input[name="code"]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  '#otp',
  '#code',
  'input[type="text"][maxlength="6"]',
  'input[type="text"][maxlength="8"]',
];
const GITHUB_DEVICE_VERIFY_SUBMIT_SELECTORS = [
  'button:has-text("Verify")',
  'button[type="submit"]:has-text("Verify")',
  'input[type="submit"][value*="Verify" i]',
  'button:has-text("Continue")',
];
// GitHub emails include a direct-confirm URL that skips the code-entry step.
// Pattern matches BOTH the /account_verifications/confirm path and the
// newer /verified_device paths.
const GITHUB_DEVICE_CONFIRM_URL_RE = /https:\/\/github\.com\/(?:account_verifications\/confirm|sessions\/verified-device)\/[A-Za-z0-9/_-]+/;
// GitHub emails a 6 or 8-digit code. Newer flows use 8 digits.
const GITHUB_DEVICE_OTP_RE = /\b(\d{6,8})\b/g;

// ── Selectors for the provider-side "Sign in with GitHub" gate ─────────────
const GITHUB_LOGIN_BUTTON_SELECTORS = [
  "#social-github",
  "a#social-github",
  'a[href*="/github"]',
  'a[href*="github.com/login/oauth"]',
  'a:has-text("Sign up with GitHub")',
  'a:has-text("Sign up with Github")',
  'a:has-text("Log in with GitHub")',
  'a:has-text("Log in with Github")',
  'a:has-text("Continue with GitHub")',
  'button:has-text("Sign up with GitHub")',
  'button:has-text("Log in with GitHub")',
  'button:has-text("Continue with GitHub")',
  'button:has-text("GitHub")',
  'a:has-text("GitHub")',
  'div[role="button"]:has-text("GitHub")',
  'span:has-text("GitHub")',
  '[aria-label*="GitHub" i]',
  '[data-provider*="github" i]',
];

// Terms/agree checkboxes shown before the social login buttons (same shape as
// googleOAuth). Kept local so the two flows can diverge freely.
const TERMS_CHECKBOX_SELECTORS = [
  "#agree-policy-account",
  "#agree-policy",
  "#agree-policy-sso",
  'input[type="checkbox"][id*="agree" i]',
  'input[type="checkbox"][name*="agree" i]',
  'input[type="checkbox"][id*="policy" i]',
  'input[type="checkbox"][name*="policy" i]',
  'input[type="checkbox"][id*="terms" i]',
  'input[type="checkbox"][name*="terms" i]',
  ".login-checkbox input[type='checkbox']",
  "[class*='checkbox'] input[type='checkbox']",
  "[class*='agree'] input[type='checkbox']",
  'input[type="checkbox"]',
];

const PRIVACY_CONFIRM_BUTTON_SELECTORS = [
  ".ui-dialog button:has-text('Confirm')",
  "dialog button:has-text('Confirm')",
  "button:has-text('Confirm')",
  "button:has-text('I agree')",
  "button:has-text('Agree')",
  "button:has-text('同意')",
  "button:has-text('确认')",
];

// ── GitHub sign-in page selectors ──────────────────────────────────────────
const GITHUB_LOGIN_FIELD_SELECTOR = '#login_field, input[name="login"], input[autocomplete="username"]';
const GITHUB_PASSWORD_FIELD_SELECTOR = '#password, input[name="password"], input[type="password"]';

const GITHUB_SIGNIN_SUBMIT_SELECTORS = [
  'input[type="submit"][name="commit"]',
  'input[type="submit"][value="Sign in"]',
  'button[type="submit"]:has-text("Sign in")',
  'button:has-text("Sign in")',
  '#login button[type="submit"]',
];

// GitHub OAuth authorize / re-consent page.
const GITHUB_AUTHORIZE_SELECTORS = [
  'button[name="authorize"][value="1"]',
  'button:has-text("Authorize")',
  'button:has-text("Continue")',
  'input[type="submit"][value*="Authorize"]',
  'form[action*="/login/oauth/authorize"] button[type="submit"]',
];

// GitHub 2FA / device-verification / suspicious-signin surfaces. All of these
// mean we cannot proceed unattended — flip to needs_manual so the operator
// can complete verification in the visible browser window.
const GITHUB_MANUAL_MARKERS = [
  "two-factor authentication",
  "two-factor code",
  "verification code",
  "authentication code",
  "sign in to github",
  "device verification",
  "verify your device",
  "verify your identity",
  "confirm access",
  "confirm your account",
  "recovery code",
  "sudo mode",
  "unable to sign in",
  "one-time password",
  "authenticator app",
  "check your email",
  "we sent a verification code",
];

const GITHUB_INVALID_CRED_MARKERS = [
  "incorrect username or password",
  "incorrect email or password",
  "the username you entered does not exist",
  "invalid username or password",
];

const GITHUB_RESTRICTED_MARKERS = [
  "account suspended",
  "account has been suspended",
  "account is suspended",
  "account has been flagged",
  "your account is temporarily locked",
  "account has been disabled",
  "access denied",
  "this account has been",
];

// CodeBuddy Global's "Account Access Restricted" screen shown on the
// /login page after a rejected GitHub SSO exchange. When this text
// appears the account is server-side rejected — GitHub credentials are
// fine, but Tencent's policy blocks the CodeBuddy binding. This is
// terminal: retrying will not help, the account cannot proceed to the
// region page or token issuance. We match on any of these strings and
// fail fast so bulk jobs don't spend the whole timeout waiting.
const CODEBUDDY_PROVIDER_RESTRICTED_MARKERS = [
  "account access restricted",
  "temporarily unavailable due to security policy",
  "temporarily unavailable due to security",
  "security policy restrictions",
  "contact tencent cloud support",
  "temporarily restricted",
];

function getInteractionScopes(page) {
  const frames = typeof page.frames === "function" ? page.frames() : [];
  return [page, ...frames.filter((frame) => frame !== page.mainFrame?.())];
}

async function getFirstVisibleLocator(page, selector) {
  for (const scope of getInteractionScopes(page)) {
    const locator = scope.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    return locator;
  }
  return null;
}

async function clickFirstActionable(page, selectors) {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;

      await locator.scrollIntoViewIfNeeded().catch(() => null);
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const enabled = await locator.isEnabled().catch(() => true);
      if (!enabled) continue;

      const clicked = await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
  }
  return false;
}

async function checkFirstVisible(page, selectors) {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;

      const checked = await locator.isChecked().catch(() => false);
      if (checked) return true;

      const visible = await locator.isVisible().catch(() => false);
      const didCheck = visible
        ? await locator.check({ force: true, timeout: 5_000 }).then(() => true).catch(() => false)
        : false;
      if (didCheck) return true;

      const clicked = visible
        ? await locator.click({ force: true, timeout: 5_000 }).then(() => true).catch(() => false)
        : false;
      if (clicked) return true;
    }
  }
  return false;
}

async function fillFieldRobust(locator, value) {
  await locator.scrollIntoViewIfNeeded?.().catch(() => null);
  await locator.click({ timeout: 5_000 }).catch(() => null);

  await locator.fill(value, { timeout: 15_000 }).catch(() => null);
  const first = await locator.inputValue?.().catch(() => "");
  if (first === value) return true;

  await locator.press?.("Control+A").catch(() => null);
  await locator.press?.("Meta+A").catch(() => null);
  await locator.press?.("Backspace").catch(() => null);

  const typed = await locator.pressSequentially?.(value, { delay: 30 }).then(() => true).catch(() => false);
  const second = await locator.inputValue?.().catch(() => "");
  if (typed && second === value) return true;

  await locator.type?.(value, { delay: 30 }).catch(() => null);
  return (await locator.inputValue?.().catch(() => "")) === value;
}

async function readPageText(page) {
  const chunks = [];
  for (const scope of getInteractionScopes(page)) {
    try {
      chunks.push(await scope.evaluate(() => document.body?.innerText || ""));
    } catch {
      // Cross-origin frames are unreadable; ignore them and continue.
    }
  }
  return chunks.join("\n");
}

function includesAny(text, markers) {
  const lower = String(text || "").toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

function isGitHubPage(page) {
  try {
    const url = new URL(page.url());
    const host = url.hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".github.com");
  } catch {
    return false;
  }
}

function isProviderPage(page) {
  try {
    const url = new URL(page.url());
    return /codebuddy\.(ai|cn)$/.test(url.hostname)
      || url.hostname.endsWith(".codebuddy.ai")
      || url.hostname.endsWith(".codebuddy.cn");
  } catch {
    return false;
  }
}

function isTargetClosedError(error) {
  return /target page, context or browser has been closed|browser has been closed|context.*closed|page.*closed/i
    .test(error?.message || "");
}

// ── Provider gate handlers (click GitHub button, accept terms) ─────────────

async function handleProviderLoginGate(page, reportStep) {
  if (isGitHubPage(page)) return false;

  const confirmedExistingDialog = await clickFirstActionable(page, PRIVACY_CONFIRM_BUTTON_SELECTORS);
  if (confirmedExistingDialog) {
    reportStep("accepting_provider_privacy_dialog", "Confirmed provider privacy agreement dialog");
    await page.waitForTimeout(1000);
    return true;
  }

  const checkedTerms = await checkFirstVisible(page, TERMS_CHECKBOX_SELECTORS);
  if (checkedTerms) {
    reportStep("accepting_provider_terms", "Accepted provider terms for GitHub login");
    await page.waitForTimeout(400);
  }

  const clickedGithub = await clickFirstActionable(page, GITHUB_LOGIN_BUTTON_SELECTORS);
  if (clickedGithub) {
    reportStep("selecting_github_login", "Selecting GitHub login");
    await page.waitForTimeout(1200);

    const confirmedDialog = await clickFirstActionable(page, PRIVACY_CONFIRM_BUTTON_SELECTORS);
    if (confirmedDialog) {
      reportStep("accepting_provider_privacy_dialog", "Confirmed provider privacy agreement dialog after GitHub click");
      await page.waitForTimeout(1000);
    }
    return true;
  }

  return false;
}

// ── GitHub credential + authorize handlers ─────────────────────────────────

async function handleGithubCredentialInputs(page, username, password, reportStep, state) {
  if (!isGitHubPage(page)) return false;

  const loginField = await getFirstVisibleLocator(page, GITHUB_LOGIN_FIELD_SELECTOR);
  const passwordField = await getFirstVisibleLocator(page, GITHUB_PASSWORD_FIELD_SELECTOR);

  // GitHub renders both fields on the same page (unlike Google's two-step
  // flow), so we can fill them together and submit once.
  if (loginField && passwordField && !state.submittedCredentials) {
    reportStep("github_credentials_visible", "GitHub sign-in form detected");

    const filledLogin = await fillFieldRobust(loginField, username);
    reportStep(
      filledLogin ? "github_username_filled" : "github_username_fill_failed",
      filledLogin ? "GitHub username field accepted input" : "Could not fill GitHub username field"
    );
    if (!filledLogin) {
      await page.waitForTimeout(500);
      return true;
    }

    const filledPassword = await fillFieldRobust(passwordField, password);
    reportStep(
      filledPassword ? "github_password_filled" : "github_password_fill_failed",
      filledPassword ? "GitHub password field accepted input" : "Could not fill GitHub password field"
    );
    if (!filledPassword) {
      await page.waitForTimeout(500);
      return true;
    }

    const clickedSubmit = await clickFirstActionable(page, GITHUB_SIGNIN_SUBMIT_SELECTORS);
    if (!clickedSubmit) {
      await passwordField.press?.("Enter").catch(() => null);
    }
    reportStep("github_credentials_submitted", "Submitted GitHub credentials");
    state.submittedCredentials = true;
    state.submittedAt = Date.now();
    await page.waitForTimeout(1500);
    return true;
  }

  // The password field can still be present alone on the "re-authenticate for
  // sudo" screen. Fill it and submit.
  if (passwordField && !loginField && !state.submittedCredentials) {
    const filled = await fillFieldRobust(passwordField, password);
    if (filled) {
      const clicked = await clickFirstActionable(page, GITHUB_SIGNIN_SUBMIT_SELECTORS);
      if (!clicked) await passwordField.press?.("Enter").catch(() => null);
      reportStep("github_password_only_submitted", "Submitted GitHub password on re-authentication screen");
      state.submittedCredentials = true;
      state.submittedAt = Date.now();
      await page.waitForTimeout(1500);
      return true;
    }
  }

  return false;
}

// GitHub keeps its OAuth Authorize button disabled for ~5 seconds as an
// anti-clickjacking measure. Under the hood the js-oauth-authorize-btn class
// listens for actual user activity (mouse moves, focus, scroll) before it
// clears the `disabled` attribute — a plain `form.submit()` from a headless
// worker bypasses that gate but sometimes lands the operator on a "verify
// you're human" interstitial. To keep the flow humane and reliable we now:
//
//   1. Wait for the authorize form to be present in the DOM (up to 4s).
//   2. Humanize the pointer: scroll the button into view, move the mouse
//      across the page in a couple of small hops, hover the button. This
//      is enough to let GitHub's inline JS re-enable the button.
//   3. Trigger the button via Playwright's real click (trusted event).
//   4. If the button still refused to become enabled inside the humanize
//      budget, fall back to the JS `requestSubmit` path that already works
//      end-to-end (proven in the previous test round).
//
// Each step reports a distinct step so operators can see exactly which
// path took the account past the consent screen in the activity log.

async function waitForAuthorizeForm(page, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await page.evaluate(() => (
      Boolean(document.querySelector('form[action*="/login/oauth/authorize"] button[name="authorize"][value="1"]'))
    )).catch(() => false);
    if (present) return true;
    await page.waitForTimeout(200).catch(() => null);
  }
  return false;
}

async function humanizeAuthorizeInteraction(page) {
  // Small, believable pointer movement across the viewport so GitHub's
  // "did a human touch this?" heuristic sees interaction before we try to
  // click. Deliberately kept short — automation should not idle for long.
  try {
    const box = await page.evaluate(() => {
      const button = document.querySelector('button[name="authorize"][value="1"]');
      if (!button) return null;
      button.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    });

    if (!box || box.width <= 0 || box.height <= 0) return false;

    const mouse = page.mouse;
    if (!mouse) return false;

    // A tiny arc into the button, split into a few steps. Playwright's
    // `steps` option interpolates the moves; that alone is often enough to
    // trip GitHub's activity listener.
    await mouse.move(box.x - 40, box.y - 30, { steps: 4 }).catch(() => null);
    await page.waitForTimeout(120).catch(() => null);
    await mouse.move(box.x + 20, box.y + 10, { steps: 4 }).catch(() => null);
    await page.waitForTimeout(80).catch(() => null);
    await mouse.move(box.x, box.y, { steps: 3 }).catch(() => null);

    // Fire focus + hover through the DOM as a belt-and-braces. Some
    // js-oauth-authorize-btn variants unlock the button in response to
    // pointerenter rather than mousemove.
    await page.evaluate(() => {
      const button = document.querySelector('button[name="authorize"][value="1"]');
      if (!button) return;
      button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      try { button.focus?.(); } catch { /* ignore */ }
    }).catch(() => null);

    return true;
  } catch {
    return false;
  }
}

async function waitForAuthorizeEnabled(page, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const enabled = await page.evaluate(() => {
      const button = document.querySelector('button[name="authorize"][value="1"]');
      if (!button) return false;
      return !button.disabled && button.getAttribute("disabled") === null;
    }).catch(() => false);
    if (enabled) return true;
    // Keep nudging the pointer while we wait; GitHub sometimes needs a
    // second wiggle if the first hover happened right as the countdown
    // started.
    await page.mouse?.move?.((80 + (Date.now() % 40)), (80 + ((Date.now() / 3) % 40)), { steps: 2 }).catch(() => null);
    await page.waitForTimeout(300).catch(() => null);
  }
  return false;
}

async function forceAuthorizeSubmitViaJs(page) {
  return await page.evaluate(() => {
    const form = document.querySelector('form[action*="/login/oauth/authorize"]');
    if (!form) return { ok: false, reason: "no-form" };
    const approve = form.querySelector('button[name="authorize"][value="1"], input[name="authorize"][value="1"]');
    if (approve) {
      approve.disabled = false;
      approve.removeAttribute("disabled");
    }
    if (!form.querySelector('input[type="hidden"][name="authorize"][value="1"]')) {
      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = "authorize";
      hidden.value = "1";
      form.appendChild(hidden);
    }
    if (typeof form.requestSubmit === "function") {
      try { form.requestSubmit(approve || undefined); return { ok: true, via: "requestSubmit" }; }
      catch (e) { /* fall through */ }
    }
    try { form.submit(); return { ok: true, via: "form.submit" }; }
    catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }).catch((e) => ({ ok: false, reason: String(e && e.message || e) }));
}

// ── GitHub Device Verification handler ────────────────────────────────────
//
// Returns:
//   { ok: true, via: "direct-url" | "otp-form" }  — verification cleared
//   { ok: false, reason: "no-imap-config" }        — no IMAP creds, needs_manual
//   { ok: false, reason: "no-otp" }                — IMAP configured but no code arrived in time
//   { ok: false, reason: "no-input" }              — code arrived but the input/submit UI is gone
//
// The caller (main automation loop) uses `no-imap-config` and `no-otp` to
// bail into needs_manual so the operator can finish by hand; all other
// return values are internal implementation detail.
async function handleGithubDeviceVerification(page, reportStep, {
  targetEmail,
  otpTimeoutMs = 180_000,
  tempMailClient = null,
} = {}) {
  const url = page.url?.() || "";
  const looksLikeVerifyPage = GITHUB_DEVICE_VERIFY_URL_RE.test(url);
  if (!looksLikeVerifyPage) {
    // Also match by page heading in case GitHub changes the URL path.
    const headingHit = await page.evaluate((patternSource) => {
      const re = new RegExp(patternSource, "i");
      const text = String(document.body?.innerText || "").slice(0, 800);
      return re.test(text);
    }, GITHUB_DEVICE_VERIFY_HEADING_RE.source).catch(() => false);
    if (!headingHit) return { ok: false, reason: "not-verify-page" };
  }

  if (!targetEmail) {
    reportStep(
      "github_device_verification_no_target",
      "GitHub device verification reached but the account email is not available — cannot read OTP for a missing address."
    );
    return { ok: false, reason: "no-target-email" };
  }

  // Two OTP reader paths:
  //   1. tempMailClient (register flow) — reads OTP from the mail Camoufox
  //      context's temp-mail.org inbox. The client already knows the
  //      email/token binding; we call waitForOtp() with the same OTP shape
  //      (8-digit primary, 6-digit fallback) and confirm-URL pattern that
  //      IMAP mode uses.
  //   2. IMAP (bulk-login flow) — legacy path via otpImapReader.js, kept
  //      unchanged so the existing bulk-login manager works.
  // The two paths return the same shape ({ code, confirmUrl, ...}) so the
  // downstream code below is the same regardless of source.
  let otpHit = null;
  if (tempMailClient?.waitForOtp) {
    reportStep(
      "github_device_verification_detected",
      "GitHub asked for a device verification code — reading temp-mail inbox"
    );
    otpHit = await tempMailClient.waitForOtp(targetEmail, {
      senderMatch: "github",
      otpPattern: GITHUB_DEVICE_OTP_RE,
      confirmUrlPattern: GITHUB_DEVICE_CONFIRM_URL_RE,
      // The device-verify email arrives seconds after the OAuth login;
      // subject filter helps skip the launch-code email if it is still
      // in the inbox from the signup phase moments earlier.
      subjectMatch: "verify your device",
      timeoutMs: otpTimeoutMs,
      onStep: (step, message) => reportStep(step, message),
    }).catch((err) => {
      reportStep("github_device_verification_tempmail_error", `temp-mail read failed: ${err?.message || err}`);
      return null;
    });
  } else {
    reportStep(
      "github_device_verification_detected",
      "GitHub asked for a device verification code — reading IMAP inbox"
    );
    const reader = otpReaderFromEnv({
      senderMatch: "github",
      otpPattern: GITHUB_DEVICE_OTP_RE,
      confirmUrlPattern: GITHUB_DEVICE_CONFIRM_URL_RE,
    });
    if (!reader) {
      reportStep(
        "github_device_verification_needs_imap",
        "GitHub device verification page reached but no OTP reader is configured. Set IMAP_USER/IMAP_PASS or provide tempMailClient; falling back to needs_manual."
      );
      return { ok: false, reason: "no-imap-config" };
    }
    otpHit = await reader.waitForOtpWithUrl(targetEmail, {
      timeoutMs: otpTimeoutMs,
      onStep: (step, message) => reportStep(step, message),
    }).catch((err) => {
      reportStep("github_device_verification_imap_error", `IMAP read failed: ${err?.message || err}`);
      return null;
    });
  }

  if (!otpHit) return { ok: false, reason: "no-otp" };

  // Preferred path: navigate directly to GitHub's confirm URL. Skips the
  // form entirely, and the URL is single-use so the code cannot be reused.
  if (otpHit.confirmUrl) {
    reportStep("github_device_verification_direct_url", "Opening GitHub's direct-confirm URL from the OTP email");
    try {
      await page.goto(otpHit.confirmUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(1_500).catch(() => null);
      return { ok: true, via: "direct-url" };
    } catch (err) {
      reportStep("github_device_verification_direct_url_failed", `Direct URL navigation failed, falling back to code entry: ${err?.message || err}`);
      // Fall through to code-entry.
    }
  }

  // Fallback: type the OTP into the visible verify form.
  const inputLocator = await (async () => {
    for (const selector of GITHUB_DEVICE_VERIFY_INPUT_SELECTORS) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      return locator;
    }
    return null;
  })();

  if (!inputLocator) {
    reportStep("github_device_verification_input_missing", "OTP retrieved from IMAP but the verify input field is not visible");
    return { ok: false, reason: "no-input" };
  }

  reportStep("github_device_verification_typing", `Typing OTP ${otpHit.code} into GitHub verify form`);
  try {
    await inputLocator.scrollIntoViewIfNeeded().catch(() => null);
    await inputLocator.click({ timeout: 3_000 }).catch(() => null);
    await inputLocator.fill("").catch(() => null);
    await inputLocator.pressSequentially(otpHit.code, { delay: 60 }).catch(() => null);
    await page.waitForTimeout(300).catch(() => null);

    // Try Verify button first; fall back to Enter on the input.
    let submitted = false;
    for (const selector of GITHUB_DEVICE_VERIFY_SUBMIT_SELECTORS) {
      const btn = page.locator(selector).first();
      if (!(await btn.count().catch(() => 0))) continue;
      if (!(await btn.isVisible().catch(() => false))) continue;
      const ok = await btn.click({ timeout: 4_000, delay: 40 }).then(() => true).catch(() => false);
      if (ok) { submitted = true; break; }
    }
    if (!submitted) {
      await inputLocator.press("Enter").catch(() => null);
    }

    await page.waitForNavigation?.({ timeout: 10_000, waitUntil: "domcontentloaded" })
      .catch(() => page.waitForTimeout(2_000).catch(() => null));
    reportStep("github_device_verification_submitted", "Submitted GitHub device verification code");
    return { ok: true, via: "otp-form" };
  } catch (err) {
    reportStep("github_device_verification_submit_failed", `Failed to submit OTP: ${err?.message || err}`);
    return { ok: false, reason: "submit-failed" };
  }
}

async function handleGithubAuthorize(page, reportStep) {
  if (!isGitHubPage(page)) return false;
  const url = page.url?.() || "";
  if (!/\/login\/oauth\/authorize/i.test(url)) return false;

  // 1. Wait for the consent form to actually render. This avoids racing an
  //    empty DOM on the first tick after redirect.
  const formPresent = await waitForAuthorizeForm(page, 4_000);
  if (!formPresent) {
    reportStep("waiting_for_github_authorize_form", "Waiting for GitHub OAuth consent form to render");
    return false; // let the outer loop tick and retry after another paint
  }

  // 2. Humanize: scroll button into view, hover, small pointer arc.
  const humanized = await humanizeAuthorizeInteraction(page);
  if (humanized) {
    reportStep("humanizing_github_authorize", "Humanizing pointer over the GitHub Authorize button");
  }

  // 3. Wait (briefly) for GitHub's countdown to lift the disabled flag,
  //    then fire a real Playwright click. Trusted events > synthetic clicks
  //    for GitHub's OAuth flow.
  const enabled = await waitForAuthorizeEnabled(page, 8_000);
  if (enabled) {
    const clicked = await page.locator('button[name="authorize"][value="1"]').first()
      .click({ timeout: 5_000, delay: 40 })
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      reportStep("authorizing_github_oauth", "Approved GitHub OAuth via humanized click");
      await page.waitForNavigation?.({ timeout: 8_000, waitUntil: "domcontentloaded" })
        .catch(() => page.waitForTimeout(2_000).catch(() => null));
      return true;
    }
  }

  // 4. Belt-and-braces: force-submit via requestSubmit(). Proven to work in
  //    the earlier test run — we keep it as the guaranteed exit path.
  const submitted = await forceAuthorizeSubmitViaJs(page);
  if (submitted.ok) {
    reportStep("authorizing_github_oauth_force", `Approved GitHub OAuth via ${submitted.via} fallback`);
    await page.waitForNavigation?.({ timeout: 8_000, waitUntil: "domcontentloaded" })
      .catch(() => page.waitForTimeout(2_000).catch(() => null));
    return true;
  }

  // 5. Last-resort broad visible-click loop over every declared selector.
  const clicked = await clickFirstActionable(page, GITHUB_AUTHORIZE_SELECTORS);
  if (clicked) {
    reportStep("authorizing_github_oauth_click", "Approved GitHub OAuth via generic selector click");
    await page.waitForNavigation?.({ timeout: 8_000, waitUntil: "domcontentloaded" })
      .catch(() => page.waitForTimeout(2_000).catch(() => null));
    return true;
  }

  return false;
}

// ── Success race helper (identical shape to googleOAuth.js) ────────────────

async function waitForSuccessAfterBrowserClosed({
  successPromise, timeoutMs, reportStep, serviceLabel, successStep, successMessage,
}) {
  reportStep(
    "waiting_for_token_after_browser_closed",
    `Browser closed while ${serviceLabel} authorization was pending; waiting for token polling`
  );

  const result = await Promise.race([
    successPromise.then((value) => ({ kind: "success", value })).catch((error) => ({ kind: "error", error })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), Math.max(timeoutMs, 0))),
  ]);

  if (result.kind === "success") {
    reportStep(successStep, successMessage);
    return { status: "success", ...result.value };
  }
  if (result.kind === "error") {
    reportStep("oauth_timeout", `Timed out waiting for ${serviceLabel} authorization`);
    return {
      status: "failed_timeout",
      error: result.error?.message || `Timed out waiting for ${serviceLabel} authorization`,
    };
  }
  reportStep("manual_assist_required", `${serviceLabel} browser closed before authorization completed`);
  return {
    status: "needs_manual",
    error: `${serviceLabel} browser closed before authorization completed. Token polling did not finish automatically.`,
  };
}

// ── Public entry point ────────────────────────────────────────────────────

export async function runGithubAccountAutomation({
  page,
  authUrl,
  email,          // We accept "email" for symmetry with googleOAuth; it is the GitHub username or email.
  username,       // Preferred alias; falls back to email.
  password,
  successPromise,
  shortTimeoutMs = DEFAULT_SHORT_TIMEOUT_MS,
  serviceLabel = "provider",
  openingStep = "opening_github_oauth",
  openingMessage = "Opening GitHub OAuth login page",
  successStep = "oauth_success_received",
  successMessage = "OAuth success received",
  allowProviderRestrictedBypass = false,
  restrictedBypassStep = "provider_restricted_bypass",
  restrictedBypassMessage = "Provider restricted page detected; continuing with existing browser session",
  onStep,
  // Optional: provider-specific region-page handler (async fn (page, reportStep) => bool).
  // Runs before the shared handleCodeBuddyRegionPage so managers can drive
  // UI variants the shared handler does not know about (e.g. the dark-theme
  // <div>-based Submit surface on CodeBuddy Global's /register/user/complete).
  customRegionHandler = null,
  // Email address to receive GitHub's device-verification OTP. Defaults to
  // `email`. When set together with IMAP_USER/IMAP_PASS in the environment,
  // the automation reads the mailbox for the code and clears the verify
  // page without operator intervention.
  otpTargetEmail = null,
  otpTimeoutMs = 180_000,
  // Optional: pluggable temp-mail client (e.g. TempMailOrgDomClient bound to
  // a Camoufox mail context). When provided, GitHub's device-verification
  // OTP is read from this client's inbox instead of the classic IMAP reader
  // in otpImapReader.js. The two paths are mutually exclusive — bulk-login
  // flows without tempMailClient keep using IMAP unchanged, while the
  // register flow injects its DOM-bound tempmail client here so the second
  // OTP (device verification during CodeBuddy OAuth) is auto-solved from
  // the same temp-mail.org inbox the signup OTP was read from.
  tempMailClient = null,
}) {
  const login = username || email || "";
  const startTime = Date.now();
  const state = {
    submittedCredentials: false,
    submittedAt: 0,
    githubButtonClicked: false,
  };
  const reportStep = (step, message) => onStep?.(step, message);

  reportStep(openingStep, openingMessage);
  await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);

  // The provider login page opens first. Accept terms and click "Sign in with
  // GitHub" so we land on github.com.
  const clickedGithub = await handleProviderLoginGate(page, reportStep);
  if (clickedGithub) state.githubButtonClicked = true;

  try {
    while (Date.now() - startTime < shortTimeoutMs) {
      // 1. If the provider's polling already resolved, we're done.
      const raced = await Promise.race([
        successPromise.then((result) => ({ kind: "success", result })).catch((error) => ({ kind: "success_error", error })),
        new Promise((resolve) => setTimeout(() => resolve(null), 800)),
      ]);

      if (raced?.kind === "success") {
        reportStep(successStep, successMessage);
        return { status: "success", ...raced.result };
      }
      if (raced?.kind === "success_error") {
        reportStep("oauth_timeout", `Timed out waiting for ${serviceLabel} authorization`);
        return {
          status: "failed_timeout",
          error: raced.error?.message || `Timed out waiting for ${serviceLabel} authorization`,
        };
      }

      // 2. If we're on github.com, drive credentials + authorize + device
      //    verification. Device verification runs *after* credentials so a
      //    fresh sign-in that skips the check does not incur an IMAP poll.
      if (isGitHubPage(page)) {
        const filledCreds = await handleGithubCredentialInputs(page, login, password, reportStep, state);
        if (filledCreds) continue;

        // Device verification surface — GitHub emails an OTP to the signup
        // mailbox and blocks OAuth until the code is entered. We attempt
        // to solve it automatically via IMAP; on any of {no-imap-config,
        // no-otp, submit-failed} we fall through to the MANUAL_MARKERS
        // block below which flips the account to needs_manual so the
        // operator can finish it in the visible browser.
        if (state.submittedCredentials) {
          const deviceResult = await handleGithubDeviceVerification(page, reportStep, {
            targetEmail: otpTargetEmail || login,
            otpTimeoutMs,
            tempMailClient,
          }).catch((err) => ({ ok: false, reason: `exception:${err?.message || err}` }));
          if (deviceResult?.ok) {
            reportStep("github_device_verification_cleared", `Cleared GitHub device verification via ${deviceResult.via}`);
            continue;
          }
          if (deviceResult?.reason === "no-imap-config" || deviceResult?.reason === "no-otp" || deviceResult?.reason === "submit-failed") {
            reportStep("manual_assist_required", `Device verification could not be auto-solved (${deviceResult.reason}). Falling back to manual assist.`);
            return {
              status: "needs_manual",
              error: `GitHub device verification requires manual entry (auto-solver returned: ${deviceResult.reason}).`,
            };
          }
          // reason === "not-verify-page": nothing to do, fall through.
        }

        const authorized = await handleGithubAuthorize(page, reportStep);
        if (authorized) continue;
      }

      // 2b. If we bounced back to the provider (CodeBuddy) side, drive the
      //     post-authorize surfaces here too. Otherwise the main loop just
      //     idles on "waiting_for_next_screen" while it waits for the
      //     token-poll driver to do the same work — doubling up the drivers
      //     also lets the whichever-fires-first take the account past the
      //     region page.
      if (isProviderPage(page) && !isGitHubPage(page)) {
        const handledStarted = await handleCodeBuddyStartedAuthorization(page, reportStep).catch(() => false);
        if (handledStarted) continue;

        // Provider-specific region handler runs first (e.g. dark-theme
        // <div>-based Submit variant). Falls through to the classic
        // .page-region dropdown handler if the custom one bails.
        if (typeof customRegionHandler === "function") {
          const handledCustom = await customRegionHandler(page, reportStep).catch(() => false);
          if (handledCustom) {
            await page.waitForTimeout(1_200).catch(() => null);
            continue;
          }
        }

        const handledRegion = await handleCodeBuddyRegionPage(page, reportStep).catch(() => false);
        if (handledRegion) {
          await page.waitForTimeout(1_200).catch(() => null);
          continue;
        }

        const handledOnboarding = await handleProviderOnboarding(page, reportStep, serviceLabel).catch(() => false);
        if (handledOnboarding) {
          await page.waitForTimeout(1_000).catch(() => null);
          continue;
        }
      }

      // 3. Detect failure/manual/restricted markers on whichever page we're on.
      const text = await readPageText(page);
      if (isGitHubPage(page) && includesAny(text, GITHUB_INVALID_CRED_MARKERS)) {
        reportStep("invalid_credentials", "GitHub rejected the supplied username or password");
        return {
          status: "failed_invalid_credentials",
          error: "GitHub rejected the supplied username or password.",
        };
      }
      if (isGitHubPage(page) && includesAny(text, GITHUB_MANUAL_MARKERS)) {
        // Only flip to needs_manual once credentials were actually submitted;
        // otherwise the "Sign in to GitHub" heading itself would match.
        if (state.submittedCredentials) {
          reportStep("manual_assist_required", "GitHub requested 2FA / verification / device confirmation");
          return {
            status: "needs_manual",
            error: "Manual assist required in the GitHub session (2FA, device verification, email code, or CAPTCHA).",
          };
        }
      }
      // CodeBuddy-side "Account Access Restricted" — terminal server-side
      // rejection. Detected independently of the GitHub markers block so a
      // restricted CodeBuddy page never falls through and stalls the flow.
      // We check this BEFORE the GitHub-restricted branch because the two
      // pages use overlapping vocabulary ("access", "restricted") and
      // getting the provider identity wrong changes the failure type.
      if (
        isProviderPage(page)
        && !isGitHubPage(page)
        && includesAny(text, CODEBUDDY_PROVIDER_RESTRICTED_MARKERS)
      ) {
        reportStep(
          "codebuddy_account_restricted",
          "CodeBuddy rejected this account (Account Access Restricted / security policy). Skipping — cannot retry."
        );
        return {
          status: "failed_restricted",
          error: "CodeBuddy rejected the account with an Account Access Restricted page (Tencent security policy). Skipping.",
        };
      }

      if (includesAny(text, GITHUB_RESTRICTED_MARKERS)) {
        const isProviderRestrictedPage = isProviderPage(page)
          && !isGitHubPage(page)
          && includesAny(text, CODEBUDDY_PROVIDER_RESTRICTED_MARKERS);
        // Legacy escape hatch: some callers (older CodeBuddy Global GSuite
        // flow) allowed the flow to continue past the restricted page and
        // still land credentials. GitHub SSO flow never uses this branch —
        // manager passes allowProviderRestrictedBypass=true only for the
        // rare case where the restricted page renders spuriously after a
        // valid token was already issued (in which case successPromise
        // would have resolved first anyway).
        if (allowProviderRestrictedBypass && isProviderRestrictedPage) {
          reportStep(restrictedBypassStep, restrictedBypassMessage);
          return { status: "success", tokens: {}, restrictedBypass: true };
        }
        reportStep("account_restricted", "GitHub account is restricted, suspended, or disabled");
        return {
          status: "failed_restricted",
          error: "GitHub account is restricted, suspended, or disabled. Skipping.",
        };
      }

      // 4. If we bounced back to the provider page (post-authorize redirect),
      //    the successPromise race at the top of the next loop tick should
      //    win once the provider issues its token. Give the token endpoint a
      //    moment and continue.
      if (!isGitHubPage(page) && !state.githubButtonClicked) {
        // We never left the provider login page — maybe the GitHub button
        // was gated behind a terms modal that appeared late. Retry the gate.
        const retried = await handleProviderLoginGate(page, reportStep);
        if (retried) state.githubButtonClicked = true;
      }

      reportStep("waiting_for_next_screen", `Waiting for the next GitHub or ${serviceLabel} screen`);
      await page.waitForTimeout(700);
    }
  } catch (error) {
    if (isTargetClosedError(error)) {
      return await waitForSuccessAfterBrowserClosed({
        successPromise,
        timeoutMs: shortTimeoutMs - (Date.now() - startTime),
        reportStep,
        serviceLabel,
        successStep,
        successMessage,
      });
    }
    throw error;
  }

  reportStep("manual_assist_required", `Flow did not complete ${serviceLabel} authorization automatically`);
  return {
    status: "needs_manual",
    error: `Manual assist required in the browser session because the GitHub login flow did not complete ${serviceLabel} authorization automatically.`,
  };
}

export {
  isGitHubPage,
  isProviderPage as isProviderPageForGithubFlow,
  GITHUB_LOGIN_BUTTON_SELECTORS,
};
