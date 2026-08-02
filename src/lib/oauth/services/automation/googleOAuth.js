// Time the automated Google+provider flow is allowed to run before the worker
// gives up and surfaces "Manual assist required". Raised from 90s to 6 minutes
// so slow proxies, Google speedbumps, and fresh-account consent/onboarding
// screens have room to complete. 5 minutes was requested; we use 6 to leave
// margin after the consent/scroll settle delays.
const DEFAULT_SHORT_TIMEOUT_MS = 6 * 60_000;
const DEFAULT_MANUAL_TIMEOUT_MS = 15 * 60_000;
const GOOGLE_EMAIL_TRANSITION_GRACE_MS = 6_000;
const GOOGLE_PASSWORD_TRANSITION_GRACE_MS = 8_000;

const EMAIL_INPUT_SELECTOR = '#identifierId, input[name="identifier"], input[type="email"], input[autocomplete="username"], input[aria-label*="Email" i], input[aria-label*="phone" i]';
const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';

const NEXT_BUTTON_SELECTORS = [
  '#identifierNext button',
  '#identifierNext [role="button"]',
  '#passwordNext button',
  '#passwordNext [role="button"]',
  'button:has-text("Next")',
  'button:has-text("Berikutnya")',
  'button:has-text("Continue")',
  'div[role="button"]:has-text("Next")',
  'div[role="button"]:has-text("Berikutnya")',
];

// Keep the locator fallback deliberately small. The DOM path below is the
// primary path; this is only for a footer rendered after the first DOM probe.
// A broad selector list with a five-second click timeout can stall one worker
// for minutes when Google renders a slightly different consent document.
const GOOGLE_CONSENT_FALLBACK_SELECTORS = [
  '#submit_approve_access button',
  '#submit_approve_access',
  'button:has-text("Lanjutkan")',
  'div[role="button"]:has-text("Lanjutkan")',
  'button:has-text("Izinkan")',
  'div[role="button"]:has-text("Izinkan")',
  'button:has-text("Allow")',
  'div[role="button"]:has-text("Allow")',
  'button:has-text("Continue")',
  'div[role="button"]:has-text("Continue")',
];

const APPROVE_BUTTON_SELECTORS = [
  '#submit_approve_access',
  '#submit_approve_access button',
  'button[jsname]:has-text("Allow")',
  'button:has-text("Allow")',
  '[role="button"]:has-text("Allow")',
  'input[type="submit"][value="Allow"]',
  'input[type="button"][value="Allow"]',
  'button[jsname]:has-text("Izinkan")',
  'button:has-text("Izinkan")',
  '[role="button"]:has-text("Izinkan")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
  'button:has-text("Yes")',
  'button:has-text("Accept")',
  'button:has-text("Lanjutkan")',
  'button:has-text("Berikutnya")',
  'button:has-text("Setuju")',
  'button:has-text("Saya mengerti")',
  'button:has-text("Oke")',
  'button:has-text("OK")',
  'button:has-text("Got it")',
  'button:has-text("I understand")',
  'div[role="button"]:has-text("Continue")',
  'div[role="button"]:has-text("Next")',
  'div[role="button"]:has-text("Allow")',
  'div[role="button"]:has-text("Lanjutkan")',
  'div[role="button"]:has-text("Berikutnya")',
  'div[role="button"]:has-text("Izinkan")',
  'div[role="button"]:has-text("Setuju")',
  'div[role="button"]:has-text("Saya mengerti")',
  'div[role="button"]:has-text("Oke")',
  'div[role="button"]:has-text("OK")',
  'div[role="button"]:has-text("Got it")',
  'div[role="button"]:has-text("I understand")',
  'input[type="button"][value="Saya mengerti"]',
  'input[type="submit"][value="Saya mengerti"]',
];

const SKIP_BUTTON_SELECTORS = [
  'button:has-text("Skip")',
  'button:has-text("Lewati")',
  'button:has-text("Not now")',
  'button:has-text("Bukan sekarang")',
  'button:has-text("No thanks")',
  'button:has-text("Tidak sekarang")',
  'div[role="button"]:has-text("Skip")',
  'div[role="button"]:has-text("Not now")',
];

const GOOGLE_LOGIN_BUTTON_SELECTORS = [
  '#social-google',
  'a#social-google',
  'a:has-text("Sign up with Google")',
  'a:has-text("Log in with Google")',
  'button:has-text("Sign up with Google")',
  'button:has-text("Log in with Google")',
  'button:has-text("Google")',
  'a:has-text("Google")',
  'div[role="button"]:has-text("Google")',
  'span:has-text("Google")',
  '[aria-label*="Google"]',
  '[data-provider*="google" i]',
];

const TERMS_CHECKBOX_SELECTORS = [
  '#agree-policy-account',
  '#agree-policy',
  '#agree-policy-sso',
  'input[type="checkbox"][id*="agree" i]',
  'input[type="checkbox"][name*="agree" i]',
  'input[type="checkbox"][id*="policy" i]',
  'input[type="checkbox"][name*="policy" i]',
  'input[type="checkbox"][id*="terms" i]',
  'input[type="checkbox"][name*="terms" i]',
  '.login-checkbox input[type="checkbox"]',
  '[class*="checkbox"] input[type="checkbox"]',
  '[class*="agree"] input[type="checkbox"]',
  'input[type="checkbox"]',
];

const PRIVACY_CONFIRM_BUTTON_SELECTORS = [
  '.ui-dialog button:has-text("Confirm")',
  'dialog button:has-text("Confirm")',
  'button:has-text("Confirm")',
  'button:has-text("I agree")',
  'button:has-text("Agree")',
  'button:has-text("同意")',
  'button:has-text("确认")',
];

const PROVIDER_ONBOARDING_ACTION_SELECTORS = [
  'button:has-text("Continue")',
  '[role="button"]:has-text("Continue")',
  'button:has-text("Get started")',
  'button:has-text("GET STARTED")',
  'input[type="submit"][value="GET STARTED"]',
  'button:has-text("Start")',
  'button:has-text("Confirm")',
  'button:has-text("Done")',
  'button:has-text("Next")',
  'button:has-text("Skip")',
  'button:has-text("Not now")',
  'button:has-text("Save")',
  'button:has-text("Create")',
  'button:has-text("Enter")',
  'button:has-text("Launch")',
  'button:has-text("Use CodeBuddy")',
  'button:has-text("Go to CodeBuddy")',
];

const PROVIDER_REGION_TRIGGER_SELECTORS = [
  'select',
  '[role="combobox"]',
  '.page-region [role="combobox"]',
  '.page-region .t-select',
  '.page-region [class*="t-select"]',
  '.page-region [class*="select"]',
  '.page-region input[placeholder]',
  'button:has-text("Region")',
  '[role="button"]:has-text("Region")',
  'button:has-text("Select region")',
  '[role="button"]:has-text("Select region")',
  'button:has-text("Data region")',
  '[aria-label*="region" i]',
  '[placeholder*="region" i]',
];

const PROVIDER_REGION_OPTION_SELECTORS = [
  'text=/^Indonesia$/i',
  'text=/^ID$/i',
  'text=/^Singapore$/i',
  'text=/^SG$/i',
  'text=/^Japan$/i',
  'text=/^JP$/i',
  'text=/^Thailand$/i',
  'text=/^TH$/i',
  'text=/^Global$/i',
  'text=/^International$/i',
  'text=/^United States$/i',
  'text=/^US$/i',
  'text=/^Asia Pacific$/i',
  'text=/^Hong Kong$/i',
  'text=/^Default$/i',
];

const PROVIDER_ONBOARDING_INPUT_DEFAULTS = [
  { selector: 'input[name*="workspace" i]', value: "Default" },
  { selector: 'input[placeholder*="workspace" i]', value: "Default" },
  { selector: 'input[name*="team" i]', value: "Default" },
  { selector: 'input[placeholder*="team" i]', value: "Default" },
  { selector: 'input[name*="name" i]', value: "Default" },
  { selector: 'input[placeholder*="name" i]', value: "Default" },
];

const INVALID_CREDENTIAL_MARKERS = [
  "wrong password",
  "incorrect password",
  "couldn't find your google account",
  "couldn’t find your google account",
  "enter a valid email",
  "couldn’t sign you in",
  "couldn't sign you in",
  "invalid email or password",
  "password is incorrect",
];

const MANUAL_ASSIST_MARKERS = [
  "2-step verification",
  "2-step verification required",
  "verify it’s you",
  "verify it's you",
  "check your phone",
  "confirm it’s you",
  "confirm it's you",
  "recovery email",
  "recovery phone",
  "suspicious sign-in prevented",
  "unusual activity detected",
  "captcha",
  "try again later",
  "browser or app may not be secure",
  "this browser or app may not be secure",
  "browser may not be secure",
  "app may not be secure",
  "couldn’t sign you in from this browser",
  "couldn't sign you in from this browser",
];

const RESTRICTED_ACCOUNT_MARKERS = [
  "restricted",
  "account has been restricted",
  "account is restricted",
  "account has been suspended",
  "account is suspended",
  "account has been disabled",
  "account is disabled",
  "account has been banned",
  "account is banned",
  "access denied",
  "account blocked",
  "your account has been",
  "violation of terms",
  "terms of service violation",
  "temporarily locked",
  "permanently locked",
  "account locked",
  "akun dibatasi",
  "akun diblokir",
  "akun ditangguhkan",
];

const GOOGLE_ONBOARDING_MARKERS = [
  "welcome to your new google account",
  "selamat datang di akun google baru anda",
  "welcome to your new account",
  "selamat datang di akun baru",
  "privacy and terms",
  "privasi dan persyaratan",
  "personalize your google services",
  "personalisasikan layanan google anda",
  "add recovery phone",
  "tambahkan nomor telepon pemulihan",
  "choose your settings",
  "pilih setelan anda",
];

// Google's generic "Something went wrong" error page. It is shown during load
// races (often transient) but also as a soft anti-bot block on freshly created
// or suspicious accounts. It has no input field and no consent control, so it
// falls through every handler in the main loop and used to spin for the full
// shortTimeoutMs before being mislabelled needs_manual. We retry the "Try
// again" button a bounded number of times, then fail the account honestly.
const GOOGLE_GENERIC_ERROR_MARKERS = [
  "something went wrong",
  "terjadi kesalahan",
  "maaf, terjadi kesalahan",
  "try again",
  "coba lagi",
];

const GOOGLE_GENERIC_ERROR_RETRY_LIMIT = 3;
const GOOGLE_GENERIC_ERROR_RETRY_SELECTORS = [
  'button:has-text("Try again")',
  'button:has-text("Retry")',
  'button:has-text("Coba lagi")',
  'div[role="button"]:has-text("Try again")',
  'div[role="button"]:has-text("Coba lagi")',
  '#identifierNext button',
  '#passwordNext button',
  'button:has-text("Next")',
  'button:has-text("Berikutnya")',
];

const GOOGLE_CONSENT_TEXT_PATTERN = /wants to access|ingin mengakses|akses ke akun google|choose what .* can access|grant .* access|akan mengizinkan .* mengakses|mengakses info tentang anda|login ke .*google akan mengizinkan/i;

const KIRO_CALLBACK_PREFIX = "kiro://kiro.kiroAgent/authenticate-success";

function parseCallbackUrl(rawUrl) {
  if (!rawUrl || !rawUrl.startsWith(KIRO_CALLBACK_PREFIX)) return null;

  const queryIndex = rawUrl.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : "");
  const code = params.get("code");
  const state = params.get("state");

  if (!code) return null;

  return {
    callbackUrl: rawUrl,
    code,
    state,
  };
}

function getInteractionScopes(page) {
  const frames = typeof page.frames === "function" ? page.frames() : [];
  return [page, ...frames.filter((frame) => frame !== page.mainFrame?.())];
}

async function clickFirstVisible(page, selectors) {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;

      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;

      const clicked = await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
  }

  return false;
}

async function clickFirstActionable(page, selectors) {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;

      await locator.scrollIntoViewIfNeeded().catch(() => null);
      // Settle after the scroll so the target is fully in view and any
      // scroll-triggered layout has finished before we read visibility and
      // click. Clicking immediately after scrollIntoViewIfNeeded on a fresh
      // account can drop the event and surface as "Something went wrong".
      await page.waitForTimeout(300);

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

      const domChecked = await scope.evaluate((candidateSelector) => {
        const input = document.querySelector(candidateSelector);
        if (!(input instanceof HTMLInputElement)) return false;
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return input.checked;
      }, selector).catch(() => false);
      if (domChecked) return true;
    }
  }

  return false;
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

async function hasGoogleCredentialInput(page) {
  return Boolean(
    await getFirstVisibleLocator(page, EMAIL_INPUT_SELECTOR)
      || await getFirstVisibleLocator(page, PASSWORD_INPUT_SELECTOR)
  );
}

async function fillGoogleInput(locator, value) {
  await locator.scrollIntoViewIfNeeded?.().catch(() => null);
  await locator.click({ timeout: 5_000 }).catch(() => null);

  await locator.fill(value, { timeout: 15_000 }).catch(() => null);
  const currentValue = await locator.inputValue?.().catch(() => "");
  if (currentValue === value) return true;

  await locator.click({ timeout: 5_000 }).catch(() => null);
  await locator.press?.("Control+A").catch(() => null);
  await locator.press?.("Meta+A").catch(() => null);
  await locator.press?.("Backspace").catch(() => null);

  const typed = await locator.pressSequentially?.(value, { delay: 35 }).then(() => true).catch(() => false);
  const typedValue = await locator.inputValue?.().catch(() => "");
  if (typed && typedValue === value) return true;

  await locator.press?.("Control+A").catch(() => null);
  await locator.press?.("Meta+A").catch(() => null);
  await locator.press?.("Backspace").catch(() => null);

  await locator.type?.(value, { delay: 35 }).catch(() => null);
  return (await locator.inputValue?.().catch(() => "")) === value;
}

async function submitGoogleInput(page, locator) {
  const clickedNext = await clickFirstVisible(page, NEXT_BUTTON_SELECTORS);
  if (clickedNext) return "next";

  const pressedInputEnter = await locator.press?.("Enter").then(() => true).catch(() => false);
  if (pressedInputEnter) return "enter";

  await page.keyboard?.press?.("Enter").catch(() => null);
  return "keyboard_enter";
}

async function fillGoogleInputByDom(page, selectors, value) {
  for (const scope of getInteractionScopes(page)) {
    const filled = await scope.evaluate(({ selectors: candidateSelectors, value: inputValue }) => {
      const input = candidateSelectors
        .map((selector) => document.querySelector(selector))
        .find((element) => element instanceof HTMLInputElement && element.offsetParent !== null);
      if (!input) return false;

      input.focus();
      input.value = inputValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value === inputValue;
    }, { selectors, value }).catch(() => false);
    if (filled) return true;
  }

  return false;
}

async function handleGoogleCredentialInputs(page, email, password, reportStep, credentialState = null) {
  const now = Date.now();
  const emailInput = await getFirstVisibleLocator(page, EMAIL_INPUT_SELECTOR);
  const emailRecentlySubmitted = credentialState?.emailSubmittedAt
    && (now - credentialState.emailSubmittedAt) < GOOGLE_EMAIL_TRANSITION_GRACE_MS;
  if (emailInput && !emailRecentlySubmitted) {
    reportStep("google_email_input_found", "Google email input detected");
    reportStep("entering_email", "Entering Google email");
    const filledEmail = await fillGoogleInput(emailInput, email);
    reportStep(
      filledEmail ? "google_email_filled" : "google_email_fill_fallback",
      filledEmail ? "Google email field accepted input" : "Trying DOM fallback for Google email input"
    );
    if (!filledEmail) {
      const filledByDom = await fillGoogleInputByDom(page, ["#identifierId", 'input[name="identifier"]', 'input[type="email"]'], email);
      reportStep(
        filledByDom ? "google_email_dom_filled" : "google_email_dom_fill_failed",
        filledByDom ? "Google email field accepted DOM input" : "Google email DOM fallback did not fill the field"
      );
      if (!filledByDom) {
        await page.waitForTimeout(500);
        return true;
      }
    }
    reportStep("submitting_email", "Submitting email");
    const submitMethod = await submitGoogleInput(page, emailInput);
    if (credentialState) credentialState.emailSubmittedAt = Date.now();
    reportStep("google_email_submitted", submitMethod === "next" ? "Clicked Google email Next button" : "Submitted Google email with Enter");
    await page.waitForTimeout(900);
    return true;
  }

  const passwordInput = await getFirstVisibleLocator(page, PASSWORD_INPUT_SELECTOR);
  const passwordRecentlySubmitted = credentialState?.passwordSubmittedAt
    && (now - credentialState.passwordSubmittedAt) < GOOGLE_PASSWORD_TRANSITION_GRACE_MS;
  if (passwordInput && !passwordRecentlySubmitted) {
    reportStep("google_password_input_found", "Google password input detected");
    reportStep("entering_password", "Entering Google password");
    const filledPassword = await fillGoogleInput(passwordInput, password);
    reportStep(
      filledPassword ? "google_password_filled" : "google_password_fill_attempted",
      filledPassword ? "Google password field accepted input" : "Attempted to enter Google password"
    );
    if (!filledPassword) {
      await page.waitForTimeout(500);
      return true;
    }
    reportStep("submitting_password", "Submitting password");
    const submitMethod = await submitGoogleInput(page, passwordInput);
    if (credentialState) credentialState.passwordSubmittedAt = Date.now();
    reportStep("google_password_submitted", submitMethod === "next" ? "Clicked Google password Next button" : "Submitted Google password with Enter");
    await page.waitForTimeout(900);
    return true;
  }

  return false;
}

async function readPageText(page) {
  const chunks = [];
  for (const scope of getInteractionScopes(page)) {
    try {
      chunks.push(await scope.evaluate(() => document.body?.innerText || ""));
    } catch {
      // Cross-origin frames can be unreadable; ignore them.
    }
  }
  return chunks.join("\n");
}

function includesAny(text, markers) {
  const normalized = String(text || "").toLowerCase();
  return markers.some((marker) => normalized.includes(marker));
}

function isTargetClosedError(error) {
  return /target page, context or browser has been closed|browser has been closed|context.*closed|page.*closed/i.test(error?.message || "");
}

async function waitForSuccessAfterBrowserClosed({
  successPromise,
  timeoutMs,
  reportStep,
  serviceLabel,
  successStep,
  successMessage,
}) {
  reportStep("waiting_for_token_after_browser_closed", `Browser closed while ${serviceLabel} authorization was pending; waiting for token polling`);

  const result = await Promise.race([
    successPromise.then((value) => ({ kind: "success", value })).catch((error) => ({ kind: "error", error })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), Math.max(timeoutMs, 0))),
  ]);

  if (result.kind === "success") {
    reportStep(successStep, successMessage);
    return {
      status: "success",
      ...result.value,
    };
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

function isGoogleAuthPage(page) {
  try {
    const url = new URL(page.url());
    const hostname = url.hostname.toLowerCase();
    return hostname === "accounts.google.com"
      || hostname.startsWith("accounts.google.")
      || hostname.endsWith(".accounts.google.com");
  } catch {
    return false;
  }
}

function isProviderPage(page) {
  try {
    const url = new URL(page.url());
    return /codebuddy\.(ai|cn)$/.test(url.hostname)
      || url.hostname.endsWith(".codebuddy.ai")
      || url.hostname.endsWith(".codebuddy.cn")
      || url.hostname === "qoder.com"
      || url.hostname.endsWith(".qoder.com");
  } catch {
    return false;
  }
}

function isQoderPage(page) {
  try {
    const url = new URL(page.url());
    return url.hostname === "qoder.com" || url.hostname.endsWith(".qoder.com");
  } catch {
    return false;
  }
}

function isQoderDeviceFlowPage(page) {
  try {
    const url = new URL(page.url());
    if (!(url.hostname === "qoder.com" || url.hostname.endsWith(".qoder.com"))) return false;
    return /^\/device(?:\/|$)/i.test(url.pathname) || /^\/oauth(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isQoderDeviceAuthUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!(url.hostname === "qoder.com" || url.hostname.endsWith(".qoder.com"))) return false;
    return /^\/device(?:\/|$)/i.test(url.pathname) || /^\/oauth(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function getSafePagePath(page) {
  try {
    const url = new URL(page.url());
    return url.pathname || "/";
  } catch {
    return "unknown";
  }
}

async function handleGoogleConsent(page, reportStep) {
  if (!isGoogleAuthPage(page)) return false;
  // Settle briefly before probing the approval control. A fresh Google account
  // renders the consent footer and the OAuth speedbump asynchronously; probing
  // too early makes Google return a generic "Something went wrong" page. Give
  // the document a short moment to finish wiring the consent action.
  await page.waitForTimeout(900);
  // Keep this DOM-first. Google localizes consent copy and its fixed footer can
  // make Playwright-style locator clicks wait for seconds. Enow's flow succeeds
  // by probing the actual approval control on every Google page instead of
  // first requiring a particular consent sentence.
  const clickedApprove = await clickGoogleConsentByDom(page)
    || await clickGoogleConsentLocatorFallback(page);
  if (clickedApprove) {
    reportStep("approving_google_consent", "Approving Google OAuth consent");
    // Post-click settle: let the consent POST round-trip before the next poll
    // loop re-reads the page, so we do not immediately hit a half-navigated
    // document that surfaces as "Something went wrong".
    await page.waitForTimeout(1500);
    return true;
  }

  return false;
}

async function clickGoogleConsentByDom(page) {
  const consentActionPattern = /continue|allow|lanjut|izinkan|setuju|accept|yes|ok|oke|got it|i understand/i;

  for (const scope of getInteractionScopes(page)) {
    const clicked = await scope.evaluate(async (patternSource) => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      };
      const directApprove = document.querySelector("#submit_approve_access button, #submit_approve_access");
      if (directApprove instanceof HTMLElement && isVisible(directApprove) && !directApprove.hasAttribute("disabled")) {
        directApprove.scrollIntoView({ block: "center", inline: "center" });
        // Let the scroll settle before interacting so a fresh-account consent
        // footer does not receive the click mid-scroll (which drops the event
        // and can surface as "Something went wrong").
        await new Promise((resolve) => setTimeout(resolve, 400));
        directApprove.focus?.();
        directApprove.click();
        directApprove.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        directApprove.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        directApprove.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      }

      const pattern = new RegExp(patternSource, "i");
      const candidates = [...document.querySelectorAll('button, div[role="button"], [role="button"], input[type="submit"], input[type="button"]')];
      const action = candidates.find((element) => {
        if (!isVisible(element) || element.hasAttribute("disabled")) return false;
        const label = String(
          element.getAttribute("aria-label")
          || element.getAttribute("value")
          || element.textContent
          || ""
        ).trim();
        return pattern.test(label);
      });
      if (!action) return false;
      action.scrollIntoView({ block: "center", inline: "center" });
      // Same scroll-settle guard as the direct-approve path above.
      await new Promise((resolve) => setTimeout(resolve, 400));
      action.focus?.();
      action.click();
      action.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      action.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      action.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }, consentActionPattern.source).catch(() => false);
    if (clicked) return true;
  }

  return false;
}

async function clickGoogleConsentLocatorFallback(page) {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of GOOGLE_CONSENT_FALLBACK_SELECTORS) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => null);
      if (!(await locator.isVisible().catch(() => false))) continue;
      if (!(await locator.isEnabled().catch(() => true))) continue;
      const clicked = await locator.click({ force: true, timeout: 750 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
  }
  return false;
}

async function handleGoogleOnboarding(page, pageText) {
  if (await hasGoogleCredentialInput(page)) return false;

  const text = String(pageText || "");
  if (!includesAny(text, GOOGLE_ONBOARDING_MARKERS)) {
    return false;
  }

  await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    if (root) root.scrollTop = root.scrollHeight;
    window.scrollTo(0, document.body?.scrollHeight || document.documentElement?.scrollHeight || 0);
  }).catch(() => null);
  // Settle after the bottom-scroll so freshly-rendered onboarding buttons are
  // fully laid out before we probe them — avoids clicking a half-painted
  // control on a fresh account (which can surface as "Something went wrong").
  await page.waitForTimeout(900);

  const clickedSkip = await clickFirstActionable(page, SKIP_BUTTON_SELECTORS);
  if (clickedSkip) {
    await page.waitForTimeout(700);
    return true;
  }

  const clickedContinue = await clickFirstActionable(page, APPROVE_BUTTON_SELECTORS);
  if (clickedContinue) {
    await page.waitForTimeout(700);
    return true;
  }

  return false;
}

// Detects Google's generic "Something went wrong" page and clicks "Try again".
// Scoped to accounts.google.* because the "try again" marker is broad and must
// not fire on a provider page (e.g. Qoder) that happens to reuse the copy.
// Returns one of:
//   { action: "retry" }    — clicked a retry control; the loop should continue
//   { action: "exhausted" } — retried GOOGLE_GENERIC_ERROR_RETRY_LIMIT times and
//                            the page still shows the error; caller should fail
//   { action: null }       — not a generic error page; caller should continue
// The retry counter is carried on `state` so it survives across loop ticks.
async function handleGoogleGenericError(page, pageText, state) {
  if (!state) return { action: null };
  if (!isGoogleAuthPage(page)) {
    state.genericErrorRetries = 0;
    return { action: null };
  }

  // A genuine credential input means we moved past the error page (or never
  // were on one); reset the counter so a later transient error can retry.
  if (await hasGoogleCredentialInput(page)) {
    state.genericErrorRetries = 0;
    return { action: null };
  }

  const text = String(pageText || "");
  if (!includesAny(text, GOOGLE_GENERIC_ERROR_MARKERS)) {
    return { action: null };
  }

  const attempt = Number(state.genericErrorRetries || 0) + 1;
  state.genericErrorRetries = attempt;

  if (attempt > GOOGLE_GENERIC_ERROR_RETRY_LIMIT) {
    return { action: "exhausted" };
  }

  const clicked = await clickFirstActionable(page, GOOGLE_GENERIC_ERROR_RETRY_SELECTORS);
  if (clicked) {
    await page.waitForTimeout(900);
    return { action: "retry", attempt };
  }

  // No retry control to click — the page is stuck. Fail rather than spin.
  return { action: "exhausted" };
}

async function selectNativeRegionOption(page) {
  const preferred = /global|international|singapore|united states|^us$|asia|hong kong|default/i;

  for (const scope of getInteractionScopes(page)) {
    const selects = scope.locator("select");
    const count = await selects.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const select = selects.nth(index);
      const visible = await select.isVisible().catch(() => false);
      const enabled = await select.isEnabled().catch(() => true);
      if (!visible || !enabled) continue;

      const value = await select.evaluate((element, patternSource) => {
        const matcher = new RegExp(patternSource, "i");
        const options = [...element.options].filter((option) => !option.disabled && option.value !== "");
        const preferredOption = options.find((option) => matcher.test(`${option.label} ${option.textContent} ${option.value}`));
        return (preferredOption || options[0])?.value || "";
      }, preferred.source).catch(() => "");

      if (!value) continue;
      const selected = await select.selectOption(value).then(() => true).catch(() => false);
      if (selected) return true;
    }
  }

  return false;
}

async function fillProviderOnboardingDefaults(page) {
  let filled = false;

  for (const scope of getInteractionScopes(page)) {
    for (const { selector, value } of PROVIDER_ONBOARDING_INPUT_DEFAULTS) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;

      const visible = await locator.isVisible().catch(() => false);
      const enabled = await locator.isEnabled().catch(() => true);
      if (!visible || !enabled) continue;

      const currentValue = await locator.inputValue().catch(() => "");
      if (currentValue) continue;

      const didFill = await locator.fill(value, { timeout: 5_000 }).then(() => true).catch(() => false);
      if (didFill) filled = true;
    }
  }

  return filled;
}

async function clickLocatorCenter(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => null);
  const visible = await locator.isVisible().catch(() => false);
  const enabled = await locator.isEnabled().catch(() => true);
  if (!visible || !enabled) return false;

  const box = await locator.boundingBox().catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) return false;

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

async function clickVisibleLocatorByText(page, selector, patterns) {
  for (const scope of getInteractionScopes(page)) {
    const locators = scope.locator(selector);
    const count = Math.min(await locators.count().catch(() => 0), 80);
    const candidates = [];

    for (let index = 0; index < count; index += 1) {
      const locator = locators.nth(index);
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;

      const text = (await locator.innerText({ timeout: 1_000 }).catch(() => "")
        || await locator.textContent({ timeout: 1_000 }).catch(() => "")
        || "").trim();
      if (!text) continue;
      candidates.push({ locator, text });
    }

    for (const pattern of patterns) {
      const candidate = candidates.find((item) => pattern.test(item.text));
      if (!candidate) continue;
      const clicked = await clickLocatorCenter(page, candidate.locator).catch(() => false);
      if (clicked) return candidate.text;
    }

    if (candidates[0]) {
      const clicked = await clickLocatorCenter(page, candidates[0].locator).catch(() => false);
      if (clicked) return candidates[0].text;
    }
  }

  return "";
}

async function clickFirstVisibleLocatorCenter(page, selectors) {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locators = scope.locator(selector);
      const count = Math.min(await locators.count().catch(() => 0), 20);
      for (let index = 0; index < count; index += 1) {
        const locator = locators.nth(index);
        const clicked = await clickLocatorCenter(page, locator).catch(() => false);
        if (clicked) return true;
      }
    }
  }

  return false;
}

async function handleCodeBuddyRegionPageWithMouse(page, reportStep) {
  if (!isProviderPage(page) || isGoogleAuthPage(page)) return false;

  const isRegionPage = await page.locator(".page-region").first().count().then(Boolean).catch(() => false);
  if (!isRegionPage) return false;

  const optionPatterns = [
    /indonesia|^id$|\u5370\u5ea6\u5c3c\u897f\u4e9a/i,
    /singapore|^sg$|\u65b0\u52a0\u5761/i,
    /japan|^jp$|\u65e5\u672c/i,
    /thailand|^th$|\u6cf0\u56fd/i,
    /global|international|default/i,
  ];

  const submitClicked = await clickFirstVisibleLocatorCenter(page, [
    ".page-region [class*='28B894']",
    ".page-region button:has-text('Get started')",
    ".page-region button:has-text('Start')",
    ".page-region button:has-text('Submit')",
    ".page-region button:has-text('Continue')",
    ".page-region [role='button']:has-text('Get started')",
    ".page-region [role='button']:has-text('Start')",
    ".page-region [role='button']:has-text('Submit')",
    ".page-region [role='button']:has-text('Continue')",
  ]);
  if (submitClicked) {
    reportStep("submitting_codebuddy_region", "Submitted CodeBuddy region selection");
    await page.waitForTimeout(1200);
    return true;
  }

  const visibleOption = await clickVisibleLocatorByText(
    page,
    "ul.dropdown-section li, .dropdown-section li, [role='option'], .t-select-option, [class*='option']",
    optionPatterns
  );
  if (visibleOption) {
    reportStep("selecting_codebuddy_region", `Selected CodeBuddy region: ${visibleOption}`);
    await page.waitForTimeout(900);
    return true;
  }

  const opened = await clickFirstVisibleLocatorCenter(page, [
    ".page-region .t-select",
    ".page-region [class*='t-select']",
    ".page-region [role='combobox']",
    ".page-region input[placeholder]",
    ".page-region [class*='select']",
    ".page-region [class*='cursor-pointer']",
  ]);
  if (!opened) return false;

  reportStep("opening_codebuddy_region_selector", "Opening CodeBuddy region selector");
  await page.waitForTimeout(600);

  const openedOption = await clickVisibleLocatorByText(
    page,
    "ul.dropdown-section li, .dropdown-section li, [role='option'], .t-select-option, [class*='option']",
    optionPatterns
  );
  if (openedOption) {
    reportStep("selecting_codebuddy_region", `Selected CodeBuddy region: ${openedOption}`);
    await page.waitForTimeout(900);
  }

  return true;
}

async function handleCodeBuddyRegionPage(page, reportStep) {
  if (!isProviderPage(page) || isGoogleAuthPage(page)) return false;

  const handledWithMouse = await handleCodeBuddyRegionPageWithMouse(page, reportStep);
  if (handledWithMouse) return true;

  for (const scope of getInteractionScopes(page)) {
    const result = await scope.evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const root = document.querySelector(".page-region");
      const bodyText = document.body?.innerText || "";
      const looksLikeRegionPage = root
        || /select\s+region|region|country|area|get started|complete/i.test(bodyText);
      if (!looksLikeRegionPage) return null;

      const clickElement = (element) => {
        element.scrollIntoView({ block: "center", inline: "center" });
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          element.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            buttons: type.endsWith("down") ? 1 : 0,
          }));
        }
      };

      const optionPatterns = [
        /indonesia|^id$|\u5370\u5ea6\u5c3c\u897f\u4e9a/i,
        /singapore|^sg$|\u65b0\u52a0\u5761/i,
        /japan|^jp$|\u65e5\u672c/i,
        /thailand|^th$|\u6cf0\u56fd/i,
        /global|international|default/i,
      ];

      const searchRoot = root || document.body;
      const submitSelectors = [
        "button",
        "[role='button']",
        "input[type='submit']",
        ".t-button",
        "[class*='button']",
        "[class*='28B894']",
      ];
      const submitButtons = [...searchRoot.querySelectorAll(submitSelectors.join(","))]
        .filter(visible)
        .filter((element) => {
          const text = `${element.innerText || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("value") || ""}`;
          const className = element.getAttribute("class") || "";
          return /submit|start|continue|confirm|done|get started|complete|\u5b8c\u6210|\u5f00\u59cb|\u786e\u5b9a|\u4e0b\u4e00\u6b65/i.test(text)
            || className.includes("28B894");
        });

      if (submitButtons.length) {
        clickElement(submitButtons[0]);
        return { action: "submitted" };
      }

      const optionSelectors = [
        "ul.dropdown-section li",
        ".dropdown-section li",
        "[role='option']",
        ".t-select-option",
        "[class*='option']",
        "[class*='dropdown'] li",
      ];
      const options = [...document.querySelectorAll(optionSelectors.join(","))]
        .filter(visible)
        .filter((element) => (element.innerText || element.textContent || "").trim());

      if (options.length) {
        const option = optionPatterns
          .map((pattern) => options.find((element) => pattern.test((element.innerText || element.textContent || "").trim())))
          .find(Boolean) || options[0];
        const label = (option.innerText || option.textContent || "").trim();
        clickElement(option);
        return { action: "selected", label };
      }

      const controlSelectors = [
        "[role='combobox']",
        ".t-select",
        "[class*='t-select']",
        "[class*='select']",
        "input[placeholder]",
        ".text-sm",
        "[class*='cursor-pointer']",
      ];
      const controls = [...searchRoot.querySelectorAll(controlSelectors.join(","))]
        .filter(visible)
        .filter((element) => {
          const text = `${element.innerText || ""} ${element.getAttribute("placeholder") || ""} ${element.getAttribute("aria-label") || ""}`;
          return /region|country|area|select|placeholder|\u5730\u533a|\u56fd\u5bb6|\u9009\u62e9/i.test(text)
            || element.matches?.(".t-select,[class*='t-select'],input[placeholder],[class*='select']");
        });

      if (controls.length) {
        clickElement(controls[0]);
        return { action: "opened" };
      }

      return null;
    }).catch(() => null);

    if (!result?.action) continue;

    if (result.action === "selected") {
      reportStep("selecting_codebuddy_region", `Selected CodeBuddy region${result.label ? `: ${result.label}` : ""}`);
      await page.waitForTimeout(700);
      return true;
    }

    if (result.action === "submitted") {
      reportStep("submitting_codebuddy_region", "Submitted CodeBuddy region selection");
      await page.waitForTimeout(1200);
      return true;
    }

    reportStep("opening_codebuddy_region_selector", "Opening CodeBuddy region selector");
    await page.waitForTimeout(700);
    return true;
  }

  return false;
}

async function handleCodeBuddyStartedAuthorization(page, reportStep) {
  if (!isProviderPage(page) || isGoogleAuthPage(page)) return false;

  const result = await page.evaluate(async () => {
    const url = new URL(window.location.href);
    if (!/\/started\/?$/.test(url.pathname)) return null;

    const platform = url.searchParams.get("platform") || "CLI";
    const state = url.searchParams.get("state");
    if (!state) return null;

    const domains = [window.location.hostname || "www.codebuddy.ai"].filter(Boolean);
    for (const domain of [...new Set(domains)]) {
      const authUrl = new URL("/console/auth/login", window.location.origin);
      authUrl.searchParams.set("platform", platform);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("domain", domain);

      try {
        const response = await fetch(authUrl.toString(), {
          method: "GET",
          credentials: "include",
          redirect: "manual",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "X-Domain": domain,
          },
        });
        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          return { action: "attempted", domain, message: "redirected" };
        }
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        if (response.ok && (!data || data.code === 0 || data.code === 200 || typeof data.code === "undefined")) {
          return { action: "authorized", domain };
        }
        if (response.ok) {
          return { action: "attempted", domain, code: data?.code, message: data?.msg || data?.message || "" };
        }
      } catch (error) {
        // Try the next domain variant.
      }
    }

    return { action: "failed" };
  }).catch(() => null);

  if (!result?.action || result.action === "failed") return false;

  if (result.action === "authorized") {
    reportStep("authorizing_codebuddy_cli_state", "Authorized CodeBuddy CLI login state");
    await page.waitForTimeout(1200);
    return true;
  }

  reportStep(
    "authorizing_codebuddy_cli_state",
    result.message
      ? `Attempted CodeBuddy CLI login state authorization: ${result.message}`
      : "Attempted CodeBuddy CLI login state authorization"
  );
  await page.waitForTimeout(1200);
  return true;
}

async function handleQoderSelectAccounts(page, reportStep) {
  if (!isQoderPage(page) || isGoogleAuthPage(page)) return false;
  const isDeviceFlowPage = isQoderDeviceFlowPage(page);
  const pagePath = getSafePagePath(page);

  reportStep("qoder_page_seen", `Qoder page path: ${pagePath}`);
  if (!isDeviceFlowPage) {
    reportStep("qoder_non_device_page", `Qoder non-device page path: ${pagePath}`);
  }

  const result = await page.evaluate(({ allowAccountSelection }) => {
    const bodyText = document.body?.innerText?.slice(0, 500) || "";
    const lowered = bodyText.toLowerCase();
    const successIndicators = [
      "sign in success",
      "you're all set",
      "all set!",
      "begin your ai coding",
      "return to qoder",
      "successfully signed in",
      "login successful",
      "authorized successfully",
      "authorization complete",
      "authentication complete",
      "device login complete",
      "you can close this page",
      "close this page",
    ];

    if (successIndicators.some((indicator) => lowered.includes(indicator))) {
      return { success: true, clicked: false, method: "success-page" };
    }

    if (!allowAccountSelection) return null;

    const clickables = document.querySelectorAll(
      'button, a, [role="button"], [role="link"], input[type="submit"]'
    );
    const actionTexts = [
      "select",
      "continue",
      "authorize",
      "confirm",
      "allow",
      "grant",
      "approve",
      "accept",
      "sign in",
      "log in",
      "get started",
      "proceed",
      "next",
      "ok",
      "pilih",
      "lanjutkan",
      "setujui",
      "izinkan",
      "konfirmasi",
    ];

    for (const button of clickables) {
      if (button.offsetParent === null) continue;
      const text = (button.textContent || button.value || "").toLowerCase().trim();
      if (actionTexts.some((keyword) => text.includes(keyword))) {
        button.click();
        return { clicked: true, method: `action-text: ${text.slice(0, 50)}` };
      }
    }

    const accountElements = document.querySelectorAll(
      '[class*="account"], [class*="user"], [class*="profile"], [class*="card"], [class*="item"], [class*="option"]'
    );
    for (const element of accountElements) {
      if (element.offsetParent === null) continue;
      const text = (element.textContent || "").trim();
      if (text.length > 2 && text.length < 200) {
        element.click();
        return { clicked: true, method: `account-card: ${text.slice(0, 50)}` };
      }
    }

    return null;
  }, { allowAccountSelection: isDeviceFlowPage }).catch(() => null);

  if (!result) return false;
  if (result.success) {
    reportStep("qoder_authorized", "Qoder authorization page reports success");
    await page.waitForTimeout(1000);
    return true;
  }
  if (result.clicked) {
    if (/^first-visible-btn:/i.test(result.method || "")) {
      return false;
    }
    reportStep("qoder_select_accounts", `Qoder selectAccounts: ${result.method}`);
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

async function handleProviderOnboarding(page, reportStep, serviceLabel) {
  if (!isProviderPage(page) || isGoogleAuthPage(page)) return false;

  const confirmedPrivacy = await clickFirstActionable(page, PRIVACY_CONFIRM_BUTTON_SELECTORS);
  if (confirmedPrivacy) {
    reportStep("accepting_provider_privacy_dialog", `Confirmed ${serviceLabel} privacy or terms dialog`);
    await page.waitForTimeout(800);
    return true;
  }

  const handledCodeBuddyStarted = await handleCodeBuddyStartedAuthorization(page, reportStep);
  if (handledCodeBuddyStarted) {
    return true;
  }

  const handledQoderSelectAccounts = await handleQoderSelectAccounts(page, reportStep);
  if (handledQoderSelectAccounts) {
    return true;
  }

  if (isQoderPage(page)) {
    return false;
  }

  const handledCodeBuddyRegion = await handleCodeBuddyRegionPage(page, reportStep);
  if (handledCodeBuddyRegion) {
    return true;
  }

  const selectedNativeRegion = await selectNativeRegionOption(page);
  if (selectedNativeRegion) {
    reportStep("selecting_provider_region", `Selected ${serviceLabel} region`);
    await page.waitForTimeout(700);
    return true;
  }

  const openedRegionMenu = await clickFirstActionable(page, PROVIDER_REGION_TRIGGER_SELECTORS);
  if (openedRegionMenu) {
    reportStep("opening_provider_region_selector", `Opening ${serviceLabel} region selector`);
    await page.waitForTimeout(500);
    const selectedRegion = await clickFirstActionable(page, PROVIDER_REGION_OPTION_SELECTORS);
    if (selectedRegion) {
      reportStep("selecting_provider_region", `Selected ${serviceLabel} region`);
      await page.waitForTimeout(700);
    }
    return true;
  }

  const selectedRegion = await clickFirstActionable(page, PROVIDER_REGION_OPTION_SELECTORS);
  if (selectedRegion) {
    reportStep("selecting_provider_region", `Selected ${serviceLabel} region`);
    await page.waitForTimeout(700);
    return true;
  }

  const filledDefaults = await fillProviderOnboardingDefaults(page);
  if (filledDefaults) {
    reportStep("filling_provider_onboarding", `Filled ${serviceLabel} onboarding defaults`);
    await page.waitForTimeout(500);
    return true;
  }

  const clickedAction = await clickFirstActionable(page, PROVIDER_ONBOARDING_ACTION_SELECTORS);
  if (clickedAction) {
    reportStep("continuing_provider_onboarding", `Continuing ${serviceLabel} onboarding`);
    await page.waitForTimeout(1000);
    return true;
  }

  return false;
}

async function handleProviderLoginGate(page, reportStep) {
  if (isGoogleAuthPage(page)) return false;

  const confirmedExistingDialog = await clickFirstActionable(page, PRIVACY_CONFIRM_BUTTON_SELECTORS);
  if (confirmedExistingDialog) {
    reportStep("accepting_provider_privacy_dialog", "Confirmed provider privacy agreement dialog");
    await page.waitForTimeout(1000);
    return true;
  }

  const checkedTerms = await checkFirstVisible(page, TERMS_CHECKBOX_SELECTORS);
  if (checkedTerms) {
    reportStep("accepting_provider_terms", "Accepted provider terms for Google login");
    await page.waitForTimeout(400);
  }

  const clickedGoogle = await clickFirstActionable(page, GOOGLE_LOGIN_BUTTON_SELECTORS);
  if (clickedGoogle) {
    reportStep("selecting_google_login", "Selecting Google login");
    await page.waitForTimeout(1000);

    const confirmedDialog = await clickFirstActionable(page, PRIVACY_CONFIRM_BUTTON_SELECTORS);
    if (confirmedDialog) {
      reportStep("accepting_provider_privacy_dialog", "Confirmed provider privacy agreement dialog");
      await page.waitForTimeout(1000);
    }

    return true;
  }

  return false;
}

export function createKiroCallbackMonitor(context, page, timeoutMs = DEFAULT_MANUAL_TIMEOUT_MS) {
  let resolveCallback;
  let rejectCallback;
  let settled = false;
  const trackedPages = new Set();
  const cleanupFns = [];
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const settle = (result, error = null) => {
    if (settled) return;
    settled = true;
    for (const fn of cleanupFns) fn();
    if (error) rejectCallback(error);
    else resolveCallback(result);
  };

  const registerPage = (trackedPage) => {
    if (!trackedPage || trackedPages.has(trackedPage)) return;
    trackedPages.add(trackedPage);

    const onFrame = (frame) => {
      const parsed = parseCallbackUrl(frame?.url?.() || "");
      if (parsed) settle(parsed);
    };

    const onRequest = (request) => {
      const parsed = parseCallbackUrl(request?.url?.() || "");
      if (parsed) settle(parsed);
    };

    const onRequestFailed = (request) => {
      const parsed = parseCallbackUrl(request?.url?.() || "");
      if (parsed) settle(parsed);
    };

    const onResponse = async (response) => {
      try {
        const headers = typeof response?.allHeaders === "function"
          ? await response.allHeaders()
          : await response?.headers?.();
        const parsed = parseCallbackUrl(headers?.location || headers?.Location || "");
        if (parsed) settle(parsed);
      } catch {
        // Passive request and navigation listeners remain available as fallback.
      }
    };

    const onLoadState = () => {
      const parsed = parseCallbackUrl(trackedPage.url?.() || "");
      if (parsed) settle(parsed);
    };

    const onClose = () => {
      settle(null, new Error("Kiro callback browser closed"));
    };

    trackedPage.on("framenavigated", onFrame);
    trackedPage.on("request", onRequest);
    trackedPage.on("requestfailed", onRequestFailed);
    trackedPage.on("response", onResponse);
    trackedPage.on("domcontentloaded", onLoadState);
    trackedPage.on("load", onLoadState);
    trackedPage.on("close", onClose);

    cleanupFns.push(() => {
      trackedPage.off("framenavigated", onFrame);
      trackedPage.off("request", onRequest);
      trackedPage.off("requestfailed", onRequestFailed);
      trackedPage.off("response", onResponse);
      trackedPage.off("domcontentloaded", onLoadState);
      trackedPage.off("load", onLoadState);
      trackedPage.off("close", onClose);
    });

    const current = parseCallbackUrl(trackedPage.url?.() || "");
    if (current) settle(current);
  };

  const onPage = (newPage) => registerPage(newPage);
  context.on("page", onPage);
  cleanupFns.push(() => context.off("page", onPage));

  const onContextClose = () => settle(null, new Error("Kiro callback browser closed"));
  context.on("close", onContextClose);
  cleanupFns.push(() => context.off("close", onContextClose));

  registerPage(page);

  const timeout = setTimeout(() => {
    settle(null, new Error("Timed out waiting for Kiro callback"));
  }, timeoutMs);
  cleanupFns.push(() => clearTimeout(timeout));

  return callbackPromise;
}

export async function runGoogleAccountAutomation({
  page,
  authUrl,
  email,
  password,
  successPromise,
  shortTimeoutMs = DEFAULT_SHORT_TIMEOUT_MS,
  serviceLabel = "provider",
  openingStep = "opening_google_oauth",
  openingMessage = "Opening Google OAuth page",
  successStep = "oauth_success_received",
  successMessage = "OAuth success received",
  allowProviderRestrictedBypass = false,
  restrictedBypassStep = "provider_restricted_bypass",
  restrictedBypassMessage = "Provider restricted page detected; continuing with existing browser session",
  waitForKiroCallbackPage = false,
  onStep,
}) {
  const startTime = Date.now();
  const credentialState = {
    emailSubmittedAt: 0,
    passwordSubmittedAt: 0,
    genericErrorRetries: 0,
  };
  let qoderDeviceAuthReopened = false;
  let kiroCallbackWaitReported = false;
  const reportStep = (step, message) => {
    onStep?.(step, message);
  };

  reportStep(openingStep, openingMessage);
  await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);

  await handleProviderLoginGate(page, reportStep);

  await handleGoogleCredentialInputs(page, email, password, reportStep, credentialState);

  try {
  while (Date.now() - startTime < shortTimeoutMs) {
    const successResult = await Promise.race([
      successPromise.then((result) => ({ kind: "success", result })).catch((error) => ({ kind: "success_error", error })),
      new Promise((resolve) => setTimeout(() => resolve(null), 800)),
    ]);

    if (successResult?.kind === "success") {
      reportStep(successStep, successMessage);
      return {
        status: "success",
        ...successResult.result,
      };
    }

    if (successResult?.kind === "success_error") {
      reportStep("oauth_timeout", `Timed out waiting for ${serviceLabel} authorization`);
      return {
        status: "failed_timeout",
        error: successResult.error?.message || `Timed out waiting for ${serviceLabel} authorization`,
      };
    }

    const currentUrl = page.url?.() || "";
    if (waitForKiroCallbackPage && (/\/accounts\/SetSID/i.test(currentUrl) || /\/accounts\/set/i.test(currentUrl))) {
      if (!kiroCallbackWaitReported) {
        kiroCallbackWaitReported = true;
        reportStep("waiting_for_kiro_callback", "Google login completed; waiting for the Kiro callback");
      }
      await page.waitForTimeout(500);
      continue;
    }

    const handledGoogleConsent = await handleGoogleConsent(page, reportStep);
    if (handledGoogleConsent) {
      continue;
    }

    const handledCredentialInput = await handleGoogleCredentialInputs(page, email, password, reportStep, credentialState);
    if (handledCredentialInput) {
      continue;
    }

    const providerPage = isProviderPage(page) && !isGoogleAuthPage(page);
    if (providerPage) {
      const handledProviderOnboarding = await handleProviderOnboarding(page, reportStep, serviceLabel);
      if (handledProviderOnboarding) {
        continue;
      }

      if (!qoderDeviceAuthReopened && isQoderDeviceAuthUrl(authUrl) && isQoderPage(page) && !isQoderDeviceFlowPage(page)) {
        qoderDeviceAuthReopened = true;
        reportStep("reopening_qoder_device_auth", "Reopening Qoder device authorization after provider redirected to a non-device page");
        await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(1500);
        continue;
      }
    }

    const text = await readPageText(page);
    if (includesAny(text, MANUAL_ASSIST_MARKERS)) {
      reportStep("manual_assist_required", "Google requested CAPTCHA, 2FA, recovery verification, or secure-browser verification");
      return {
        status: "needs_manual",
        error: "Manual assist required in the browser session (CAPTCHA, 2FA, recovery, suspicious-login, or secure-browser challenge).",
      };
    }

    if (!providerPage && includesAny(text, INVALID_CREDENTIAL_MARKERS)) {
      reportStep("invalid_credentials", "Google rejected the supplied email or password");
      return {
        status: "failed_invalid_credentials",
        error: "Google rejected the supplied email or password.",
      };
    }

    if (includesAny(text, RESTRICTED_ACCOUNT_MARKERS)) {
      const isCodeBuddyRestrictedPage = isProviderPage(page)
        && !isGoogleAuthPage(page)
        && /account access restricted|temporarily restricted/i.test(text);
      if (allowProviderRestrictedBypass && isCodeBuddyRestrictedPage) {
        reportStep(restrictedBypassStep, restrictedBypassMessage);
        return {
          status: "success",
          tokens: {},
          restrictedBypass: true,
        };
      }

      reportStep("account_restricted", "Account is restricted, suspended, or banned by the provider");
      return {
        status: "failed_restricted",
        error: "Account is restricted, suspended, or banned. Skipping.",
      };
    }

    const genericErrorResult = await handleGoogleGenericError(page, text, credentialState);
    if (genericErrorResult.action === "retry") {
      reportStep(
        "retrying_google_generic_error",
        `Google showed a "Something went wrong" page; clicked Try again (${genericErrorResult.attempt}/${GOOGLE_GENERIC_ERROR_RETRY_LIMIT})`
      );
      continue;
    }
    if (genericErrorResult.action === "exhausted") {
      reportStep(
        "google_generic_error_blocked",
        `Google kept showing a "Something went wrong" page after ${GOOGLE_GENERIC_ERROR_RETRY_LIMIT} attempts; treating as a server-side block`
      );
      return {
        status: "failed",
        error: "Google blocked sign-in with a \"Something went wrong\" page. This is a server-side block on the account (rate limit or anti-bot); manual assist cannot fix it.",
      };
    }

    const handledOnboarding = await handleGoogleOnboarding(page, text);
    if (handledOnboarding) {
      reportStep("google_onboarding", "Accepted Google onboarding or privacy prompt");
      continue;
    }

    if (!providerPage) {
      const handledProviderOnboarding = await handleProviderOnboarding(page, reportStep, serviceLabel);
      if (handledProviderOnboarding) {
        continue;
      }
    }

    const handledProviderGate = await handleProviderLoginGate(page, reportStep);
    if (handledProviderGate) {
      continue;
    }

    if (!isGoogleAuthPage(page) && !(await hasGoogleCredentialInput(page))) {
      const clickedApprove = await clickFirstVisible(page, APPROVE_BUTTON_SELECTORS);
      if (clickedApprove) {
        reportStep("approving_consent", `Approving ${serviceLabel} consent`);
        await page.waitForTimeout(700);
        continue;
      }
    }

    reportStep("waiting_for_next_screen", `Waiting for the next Google or ${serviceLabel} screen`);
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
    error: `Manual assist required in the browser session because the login flow did not complete ${serviceLabel} authorization automatically.`,
  };
}

export async function runKiroGoogleAutomation({
  page,
  authUrl,
  email,
  password,
  callbackPromise,
  shortTimeoutMs = DEFAULT_SHORT_TIMEOUT_MS,
  onStep,
}) {
  return runGoogleAccountAutomation({
    page,
    authUrl,
    email,
    password,
    successPromise: callbackPromise,
    shortTimeoutMs,
    serviceLabel: "Kiro",
    openingStep: "opening_google_oauth",
    openingMessage: "Opening Google OAuth page",
    successStep: "kiro_callback_received",
    successMessage: "Kiro callback received",
    waitForKiroCallbackPage: true,
    onStep,
  });
}

export {
  handleCodeBuddyRegionPage,
  handleProviderOnboarding,
  handleCodeBuddyStartedAuthorization,
  handleQoderSelectAccounts,
  isProviderPage,
};
