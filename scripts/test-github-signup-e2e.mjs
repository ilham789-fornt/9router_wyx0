// End-to-end smoke test for the CodeBuddy Global GitHub-register automation.
//
// Runs ONE credential: allocates a Privatix temp-mail address, opens Camoufox
// (visible), navigates to github.com/signup, drives the signup form, waits
// for the verification email, then chains into CodeBuddy OAuth via GitHub
// SSO in the same context and (if all goes well) saves the resulting
// CodeBuddy connection.
//
// Usage:
//   node scripts/test-github-signup-e2e.mjs \
//     [--proxy=http://user:pass@host:port] \
//     [--headless] \
//     [--skip-codebuddy] \
//     [--username-suffix=xyz]
//
// Required env (read from .env in project root):
//   TEMPMAIL_PROVIDER       Optional. "tempmailorg" (default) or "privatix".
//                           tempmailorg uses web2.temp-mail.org — no key.
//                           privatix uses RapidAPI — requires the key below.
//   TEMPMAIL_RAPIDAPI_KEY   Only when TEMPMAIL_PROVIDER=privatix.
//
// Optional flags:
//   --proxy=<url>        One outbound proxy URL. If omitted, direct connection
//                        (very likely to hit octocaptcha / rate-limit).
//   --headless           Run Camoufox headless. Default: visible window so
//                        the operator can solve octocaptcha manually.
//   --skip-codebuddy     Stop after successful GitHub signup; do not chain
//                        into CodeBuddy OAuth. Useful for isolating the
//                        signup helper before the full pipeline is trusted.
//   --username-suffix=X  Append X to the generated username (helps distinguish
//                        multiple test runs in GitHub's account list).
//
// This script never persists anything to the app's database. Successful
// credentials are printed to stdout so the operator can capture them.

import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { runGithubSignupAutomation } from "../src/lib/oauth/services/automation/githubSignupAutomation.js";
import { runGithubAccountAutomation } from "../src/lib/oauth/services/automation/githubOAuth.js";
import { tempMailClientFromEnv } from "../src/lib/oauth/services/automation/tempMailClient.js";
import { tempMailOrgClientFromEnv } from "../src/lib/oauth/services/automation/tempMailOrgClient.js";
import {
  generateGithubUsername,
  generateGithubPassword,
} from "../src/lib/oauth/services/codebuddyGithubBulkRegisterManager.js";
import {
  attachCodeBuddyWebCookie,
  completeCodeBuddyRegistration,
  createCodeBuddyPollPromise,
  defaultCreateCodeBuddyApiKeyTokens,
  defaultPollForToken,
  defaultRequestDeviceCode,
  humanizeRegionSelection,
  normalizeCodeBuddyAuthUrl,
  CODEBUDDY_PROVIDER_ID,
  CODEBUDDY_LABEL,
  CODEBUDDY_POLL_INTERVAL_MS,
} from "../src/lib/oauth/services/codebuddyGithubBulkImportManager.js";
import {
  handleCodeBuddyRegionPage,
  handleCodeBuddyStartedAuthorization,
} from "../src/lib/oauth/services/automation/googleOAuth.js";
import { createAutomationBrowserLauncher } from "../src/lib/oauth/services/automationBrowserLauncher.js";
import { DEFAULT_AUTOMATION_BROWSER } from "../src/shared/constants/automationBrowsers.js";

// ── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = { proxy: null, headless: false, skipCodebuddy: false, usernameSuffix: "" };
for (const arg of args) {
  if (arg === "--headless") options.headless = true;
  else if (arg === "--skip-codebuddy") options.skipCodebuddy = true;
  else if (arg.startsWith("--proxy=")) options.proxy = arg.slice("--proxy=".length);
  else if (arg.startsWith("--username-suffix=")) options.usernameSuffix = arg.slice("--username-suffix=".length);
}

function banner(title) {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

function step(tag, message) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts} ${tag}] ${message}`);
}

// ── Pre-flight ─────────────────────────────────────────────────────────────

const tempMailProvider = String(process.env.TEMPMAIL_PROVIDER || "tempmailorg").toLowerCase().trim();

banner("GitHub Register → CodeBuddy OAuth (end-to-end smoke)");
console.log(`  Provider:   ${tempMailProvider}`);
console.log(`  Proxy:      ${options.proxy || "(none — direct connection)"}`);
console.log(`  Headless:   ${options.headless}`);
console.log(`  CodeBuddy:  ${options.skipCodebuddy ? "SKIP" : "chain after signup"}`);
console.log(`  Suffix:     ${options.usernameSuffix || "(none)"}`);

if (tempMailProvider === "privatix" && !process.env.TEMPMAIL_RAPIDAPI_KEY) {
  console.error("\n❌ TEMPMAIL_RAPIDAPI_KEY is not set. Either add it to .env or switch to TEMPMAIL_PROVIDER=tempmailorg (default).");
  process.exit(1);
}

// ── Build temp-mail client (transport upgrade happens after Camoufox) ─────

const tempMail = tempMailProvider === "privatix"
  ? tempMailClientFromEnv()
  : tempMailOrgClientFromEnv();
if (!tempMail) {
  console.error(`❌ Temp-mail client build failed for provider "${tempMailProvider}".`);
  process.exit(1);
}

// ── Generate GitHub credentials ────────────────────────────────────────────

const githubUsername = generateGithubUsername() + (options.usernameSuffix || "").slice(0, 5).toLowerCase();
const githubPassword = generateGithubPassword();
banner("Step 1  Generate GitHub credentials");
console.log(`  Username:   ${githubUsername}`);
console.log(`  Password:   ${githubPassword}`);
console.log(`  (Not persisted — copy to a password manager NOW if you want to keep them.)`);

// ── Launch Camoufox ────────────────────────────────────────────────────────

banner("Step 2  Launch Camoufox");

const launch = createAutomationBrowserLauncher(DEFAULT_AUTOMATION_BROWSER, {
  headless: options.headless,
  proxy: options.proxy || null,
  // Match the register manager: enable Camoufox humanization so the
  // browser process itself moves the cursor and jitters keystrokes.
  // Critical for surviving GitHub's post-signup behavioral scoring.
  humanize: true,
});
const browser = await launch();

// ── TWO isolated contexts inside one Camoufox browser ─────────────────────
// Same architecture the register manager uses:
//   mailContext + mailPage  → standby at temp-mail.org for the whole run
//   context     + page      → github.com/signup, then codebuddy OAuth
// Isolating them into separate contexts keeps cookies of the two sites
// from bleeding into each other.
const mailContext = await browser.newContext();
const mailPage = await mailContext.newPage();
const context = await browser.newContext();
const page = await context.newPage();

// ── Bind temp-mail client to the MAIL Camoufox page ───────────────────────

if (tempMailProvider !== "privatix" && typeof tempMail.setPage === "function") {
  banner("Step 3  Bind temp-mail.org DOM client to the MAIL Camoufox context");
  try {
    step("cf_bootstrap", "Navigating mail context to https://temp-mail.org/ + waiting for the address to render");
    await tempMail.setPage(mailPage, { ensureHomepage: true });
    step("cf_bootstrap_done", `Bound (${tempMail.transport?.kind || "dom"} mode) — mail context standby`);
  } catch (err) {
    console.error(`❌ DOM bind failed: ${err?.message || err}`);
    await browser.close().catch(() => null);
    process.exit(1);
  }
} else if (tempMailProvider !== "privatix" && typeof tempMail.setBrowserTransport === "function") {
  // Legacy HTTP client (TEMPMAIL_HTTP=1) — kept for completeness. Not
  // recommended: web2.temp-mail.org is Cloudflare-protected and the API
  // contract has drifted; DOM mode is more reliable.
  banner("Step 3  Bootstrap temp-mail.org HTTP via Camoufox (Cloudflare clearance)");
  try {
    step("cf_bootstrap", "Navigating to https://temp-mail.org/ to earn cf_clearance cookie");
    await page.goto("https://temp-mail.org/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(1500);
    tempMail.setBrowserTransport(page);
    step("cf_bootstrap_done", "Switched temp-mail client to Camoufox-backed transport");
  } catch (err) {
    console.error(`❌ Cloudflare bootstrap failed: ${err?.message || err}`);
    await browser.close().catch(() => null);
    process.exit(1);
  }
}

// ── Allocate temp-mail address ─────────────────────────────────────────────

banner(`Step 4  Allocate ${tempMailProvider === "privatix" ? "Privatix" : "temp-mail.org"} address`);

let address;
try {
  const allocation = await tempMail.allocateUniqueAddresses(1);
  address = allocation.addresses[0];
  console.log(`  ✅ Address:  ${address.email}`);
  console.log(`     Domain:  ${address.domain}`);
  console.log(`     ID:      ${String(address.id).slice(0, 24)}...`);
  if (allocation.capped) {
    console.log(`  ⚠️  Pool exposes ${allocation.available} domains; requested ${allocation.requested}`);
  }
} catch (err) {
  console.error(`❌ Temp-mail allocation failed: ${err?.message || err}`);
  await browser.close().catch(() => null);
  process.exit(1);
}

// ── Run signup ─────────────────────────────────────────────────────────────

banner("Step 5  Run GitHub signup");

let signupResult;
try {
  signupResult = await runGithubSignupAutomation({
    page,
    email: address.email,
    username: githubUsername,
    password: githubPassword,
    tempMailClient: tempMail,
    onStep: (tag, message) => step(tag, message),
  });
} catch (err) {
  console.error(`❌ Signup automation threw: ${err?.stack || err?.message || err}`);
  await browser.close().catch(() => null);
  process.exit(1);
}

console.log("\n  Signup result:", signupResult);

if (signupResult.status !== "success") {
  console.log(`\n⚠️  Signup did NOT complete automatically (${signupResult.status}: ${signupResult.reason || "-"}).`);
  console.log("    The Camoufox window stays open so you can finish manually.");
  console.log("    When done, press Ctrl+C to exit.");
  if (!options.headless) {
    // Keep the process alive so the operator can drive the visible window.
    await sleep(24 * 60 * 60 * 1000);
  }
  await browser.close().catch(() => null);
  process.exit(2);
}

console.log(`\n✅ GitHub signup succeeded — landing URL: ${signupResult.landingUrl}`);

if (options.skipCodebuddy) {
  console.log("\n--skip-codebuddy passed; stopping here.");
  console.log("\nGitHub account credentials (SAVE THESE NOW):");
  console.log(`  email:    ${address.email}`);
  console.log(`  username: ${signupResult.username}`);
  console.log(`  password: ${signupResult.password}`);
  await browser.close().catch(() => null);
  process.exit(0);
}

// ── Chain into CodeBuddy OAuth ─────────────────────────────────────────────

banner("Step 5  Chain into CodeBuddy OAuth (same Camoufox context)");

let deviceData;
try {
  deviceData = await defaultRequestDeviceCode(CODEBUDDY_PROVIDER_ID);
  console.log("  ✅ CodeBuddy device code obtained.");
} catch (err) {
  console.error(`❌ CodeBuddy device-code request failed: ${err?.message || err}`);
  await browser.close().catch(() => null);
  process.exit(3);
}

const authUrl = normalizeCodeBuddyAuthUrl(deviceData.verification_uri, deviceData.device_code);
if (!authUrl || !deviceData.device_code) {
  console.error("❌ CodeBuddy did not return an OAuth login URL");
  await browser.close().catch(() => null);
  process.exit(3);
}

const pollController = new AbortController();
let startedCallbackAttempted = false;
let regionAttempts = 0;
const MAX_REGION_ATTEMPTS = 20;

const successPromise = createCodeBuddyPollPromise({
  deviceCode: deviceData.device_code,
  pollToken: defaultPollForToken,
  signal: pollController.signal,
  shouldCancel: () => false,
  pollIntervalMs: CODEBUDDY_POLL_INTERVAL_MS,
  onStep: (tag, message) => step(tag, message),
  onPending: async () => {
    try {
      const currentUrl = String(page.url() || "");
      const parsed = currentUrl ? new URL(currentUrl) : null;
      if (!parsed) return;

      if (/register\/user\/complete/i.test(parsed.pathname)) {
        if (regionAttempts >= MAX_REGION_ATTEMPTS) return;
        regionAttempts += 1;
        const humanized = await humanizeRegionSelection(page, step, "Singapore").catch(() => false);
        if (!humanized) await handleCodeBuddyRegionPage(page, step).catch(() => false);
        await page.waitForTimeout(1500).catch(() => null);
        return;
      }

      const onCodeBuddy = parsed.hostname === "www.codebuddy.ai" || parsed.hostname.endsWith(".codebuddy.ai");
      if (!onCodeBuddy) return;

      if (/\/started\/?$/.test(parsed.pathname)) {
        const handled = await handleCodeBuddyStartedAuthorization(page, step).catch(() => false);
        if (handled) startedCallbackAttempted = true;
        return;
      }

      if (!startedCallbackAttempted && !/^\/(?:login|auth|register)(?:\/|$)/.test(parsed.pathname)) {
        const startedUrl = new URL("https://www.codebuddy.ai/started");
        startedUrl.searchParams.set("platform", "CLI");
        startedUrl.searchParams.set("state", deviceData.device_code);
        await page.goto(startedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
        await page.waitForTimeout(1000).catch(() => null);
        await handleCodeBuddyStartedAuthorization(page, step).catch(() => false);
        startedCallbackAttempted = true;
      }
    } catch (err) {
      step("poll_driver_error", err?.message || String(err));
    }
  },
});

const oauthResult = await runGithubAccountAutomation({
  page,
  authUrl,
  username: signupResult.username,
  email: address.email,
  password: signupResult.password,
  successPromise,
  shortTimeoutMs: 180_000,
  customRegionHandler: async (p, reportStep) => (
    await humanizeRegionSelection(p, reportStep, "Singapore").catch(() => false)
  ),
  otpTargetEmail: address.email,
  otpTimeoutMs: 180_000,
  // Pass the SAME tempmail client that provisioned the signup address.
  // The mail context is already bound and standing by; when GitHub emails
  // the device-verification OTP (subject "[GitHub] Please verify your
  // device") on the CodeBuddy OAuth surface, handleGithubDeviceVerification
  // pulls it from the same DOM inbox — no IMAP required.
  tempMailClient: tempMail,
  serviceLabel: CODEBUDDY_LABEL,
  openingStep: "opening_codebuddy_oauth",
  openingMessage: "Opening CodeBuddy OAuth page (chained via freshly-created GitHub)",
  successStep: "codebuddy_token_received",
  successMessage: "CodeBuddy OAuth token received",
  allowProviderRestrictedBypass: false,
  onStep: (tag, message) => step(tag, message),
});

console.log("\n  OAuth result:", { status: oauthResult.status, error: oauthResult.error });

if (oauthResult.status !== "success") {
  console.log(`\n⚠️  CodeBuddy OAuth did NOT complete (${oauthResult.status}: ${oauthResult.error}).`);
  console.log("    The Camoufox window stays open so you can inspect / retry manually.");
  if (!options.headless) await sleep(24 * 60 * 60 * 1000);
  await browser.close().catch(() => null);
  process.exit(4);
}

banner("Step 6  Complete CodeBuddy registration + API-key creation");

try {
  await completeCodeBuddyRegistration(page, step);
  const tokensWithApiKey = await defaultCreateCodeBuddyApiKeyTokens({
    page,
    tokens: oauthResult.tokens || {},
    email: address.email,
    onStep: step,
  });
  const tokensWithCookie = await attachCodeBuddyWebCookie(context, tokensWithApiKey);

  console.log("\n✅ End-to-end flow completed successfully!\n");
  console.log("  ───── Result ─────");
  console.log(`  GitHub email:    ${address.email}`);
  console.log(`  GitHub username: ${signupResult.username}`);
  console.log(`  GitHub password: ${signupResult.password}`);
  console.log(`  CodeBuddy access token (prefix): ${String(tokensWithCookie.accessToken || "").slice(0, 12)}...`);
  console.log(`  CodeBuddy API key: ${tokensWithCookie.apiKey ? tokensWithCookie.apiKey.slice(0, 12) + "..." : "(missing)"}`);
  console.log("\n  Note: this script does NOT persist to the app database.");
  console.log("        Copy the values above if you want to keep them.\n");
} catch (err) {
  console.error(`❌ Post-OAuth step failed: ${err?.stack || err?.message || err}`);
  process.exit(5);
} finally {
  await browser.close().catch(() => null);
}
