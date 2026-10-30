/**
 * CodeBuddyGithubBulkRegisterManager — CodeBuddy Global bulk provisioning via
 * temp-mail GitHub signup + chained GitHub-SSO OAuth in one job.
 *
 * Contract summary:
 *   - Input: operator supplies just a count (or lets the manager pick a
 *     random 20..30 batch). Emails, usernames, and passwords are generated.
 *   - Per-account flow inside ONE Camoufox context:
 *       1. Allocate a Privatix temp-mail address on a UNIQUE domain from
 *          the shuffled Privatix domain pool. CodeBuddy Global's account-
 *          restriction heuristics flag repeated same-domain signups, so
 *          domain uniqueness is enforced by the temp-mail client.
 *       2. Run runGithubSignupAutomation → creates the GitHub account and
 *          leaves the Camoufox context authenticated at github.com.
 *       3. Reuse that same context to open the CodeBuddy OAuth URL. Since
 *          GitHub is already logged in, the Authorize button lands us on
 *          CodeBuddy's /started callback without a second GitHub login.
 *       4. Run the standard CodeBuddy region → onboarding → API-key
 *          creation → save-connection sequence (identical to the existing
 *          codebuddyGithubBulkImportManager).
 *   - Fallbacks: any surface the automation cannot auto-solve (Arkose
 *     octocaptcha, phone verification, OTP timeout) raises needs_manual
 *     with the browser preserved so the operator can finish by hand.
 *   - Proxy pool: REQUIRED, one unique proxy per account (opposite of the
 *     bulk-login manager which allows round-robin). GitHub blocks repeat
 *     signups from the same exit IP within a short window.
 *
 * Saved connection metadata:
 *   provider = "codebuddy"
 *   providerSpecificData.automation = "codebuddy-github-register-bulk"
 *   providerSpecificData.githubUsername = <generated username>
 *
 * Runtime GitHub credentials (username / password) are stored on the
 * in-memory account object during the job so the browser can retry after
 * a needs_manual escape, but they are scrubbed from every persisted
 * snapshot in `finalizeAccount`. They are not written to disk beyond the
 * accountsSummary at the end of the job (opt-in via the CLI flag, off by
 * default in production).
 */
import { randomUUID } from "node:crypto";

import {
  BaseBulkImportManager,
  createFreshContext,
  buildLookupResponse,
  nowIso,
} from "./automation/baseBulkImportManager.js";
import { runGithubSignupAutomation } from "./automation/githubSignupAutomation.js";
import { runGithubAccountAutomation } from "./automation/githubOAuth.js";
import {
  handleCodeBuddyRegionPage,
  handleProviderOnboarding,
  handleCodeBuddyStartedAuthorization,
  isProviderPage,
} from "./automation/googleOAuth.js";
import { resolveBulkImportProxy } from "./bulkImportProxyResolver.js";
import { tempMailClientFromEnv } from "./automation/tempMailClient.js";
import { tempMailOrgClientFromEnv } from "./automation/tempMailOrgClient.js";
import {
  CODEBUDDY_PROVIDER_ID,
  CODEBUDDY_LABEL,
  CODEBUDDY_POLL_INTERVAL_MS,
  attachCodeBuddyWebCookie,
  completeCodeBuddyRegistration,
  createCodeBuddyPollPromise,
  defaultCreateCodeBuddyApiKeyTokens,
  defaultPollForToken,
  defaultRequestDeviceCode,
  defaultSaveCodeBuddyGithubConnection,
  humanizeRegionSelection,
  normalizeCodeBuddyAuthUrl,
} from "./codebuddyGithubBulkImportManager.js";

const REGISTER_LABEL = "CodeBuddy (GitHub Register)";
const REGISTER_DEFAULT_CONCURRENCY = 2; // Lower than login-only; each worker signs up a fresh account.
const REGISTER_DEFAULT_MIN_BATCH = 20;
const REGISTER_DEFAULT_MAX_BATCH = 30;

/**
 * Choose the temp-mail provider based on TEMPMAIL_PROVIDER env.
 *
 *   TEMPMAIL_PROVIDER=tempmailorg  (default) → web2.temp-mail.org web API
 *   TEMPMAIL_PROVIDER=privatix              → Privatix (RapidAPI)
 *
 * We default to temp-mail.org because its domain pool (@kierko.com,
 * @fakomail.com, @mymailix.com, …) has empirically survived GitHub's
 * post-signup domain-reputation lookup while Privatix's fixed 10-domain
 * pool has been blocklisted for years (bulk-farm abuse history).
 *
 * Returns null when the selected provider needs credentials the operator
 * has not supplied (Privatix requires TEMPMAIL_RAPIDAPI_KEY).
 */
function defaultTempMailClientFactory() {
  const provider = String(process.env.TEMPMAIL_PROVIDER || "tempmailorg").toLowerCase().trim();
  if (provider === "privatix") return tempMailClientFromEnv();
  // Anything else (including empty / unrecognized) defaults to the safer
  // temp-mail.org web adapter. That client needs no credentials so it can
  // never return null due to missing config.
  return tempMailOrgClientFromEnv();
}

// ── Credential generators ──────────────────────────────────────────────────
//
// The temp-mail client already generates a random prefix; here we generate
// GitHub-side identifiers that satisfy GitHub's format rules and pair them
// with the Privatix address deterministically enough for logging but
// randomly enough to avoid detection patterns.

// GitHub username rules: 1-39 chars, alphanumeric + single hyphens between
// letters, must start with a letter or digit. Keep it letter-first + alnum
// suffix for safety.
const USERNAME_FIRST_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const USERNAME_TAIL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// GitHub password rules (2024): 15+ chars, or 8+ chars with a digit and a
// letter. We use 20 chars with guaranteed upper + lower + digit; special
// chars are avoided (keyboard-layout quirks during automated typing).
const PASSWORD_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateGithubUsername(rng = Math.random) {
  const first = USERNAME_FIRST_ALPHABET[Math.floor(rng() * USERNAME_FIRST_ALPHABET.length)];
  const tailLength = 10 + Math.floor(rng() * 5); // 10..14
  let tail = "";
  for (let i = 0; i < tailLength; i += 1) {
    tail += USERNAME_TAIL_ALPHABET[Math.floor(rng() * USERNAME_TAIL_ALPHABET.length)];
  }
  return `${first}${tail}`;
}

function generateGithubPassword(rng = Math.random) {
  // Ensure the "Aa1" guarantee first, then fill and shuffle.
  const body = [];
  for (let i = 0; i < 17; i += 1) {
    body.push(PASSWORD_ALPHABET[Math.floor(rng() * PASSWORD_ALPHABET.length)]);
  }
  const chars = ["A", "a", "1", ...body];
  // Fisher-Yates shuffle so the guarantee prefix does not land at positions 0-2.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// Map signup-side failure vocabulary onto the summary buckets that
// buildSummary in baseBulkImportManager knows about. Anything not in the
// four "failed_*" summary buckets is coerced to plain "failed" so the
// operator does not see an account stuck in an in-between state.
function mapSignupStatusToTerminal(status) {
  switch (status) {
    case "failed_invalid_credentials":
    case "failed_exchange":
    case "failed_timeout":
    case "failed":
    case "cancelled":
      return status;
    // failed_rate_limited / failed_phone_verify / failed_username_taken all
    // collapse to `failed` for summary purposes; the specific reason lives
    // in account.error and the log stream.
    default:
      return "failed";
  }
}

// ── Manager ────────────────────────────────────────────────────────────────

export class CodeBuddyGithubBulkRegisterManager extends BaseBulkImportManager {
  constructor({
    browserLauncher,
    tempMailClient = null,
    // Factory chooses the provider from TEMPMAIL_PROVIDER env at first use.
    // Injected clients (tests) bypass this factory.
    tempMailClientFactory = defaultTempMailClientFactory,
    githubSignup = runGithubSignupAutomation,
    githubOauth = runGithubAccountAutomation,
    requestDeviceCodeFn = defaultRequestDeviceCode,
    pollToken = defaultPollForToken,
    saveConnection = defaultSaveCodeBuddyGithubConnection,
    createApiKeyTokens = defaultCreateCodeBuddyApiKeyTokens,
    proxyResolver = resolveBulkImportProxy,
    pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
    usernameRng = Math.random,
    passwordRng = Math.random,
  } = {}) {
    super({
      storageName: "codebuddy-github-register-bulk",
      providerLabel: REGISTER_LABEL,
      browserLauncher,
      browserPerAccount: true,
      defaultConcurrency: REGISTER_DEFAULT_CONCURRENCY,
    });

    // tempMailClient is either injected (tests) or built from env at first
    // startJob call. We keep the factory around so a missing env var is
    // surfaced as a 400 at startJob, not at module load.
    this.tempMailClient = tempMailClient;
    this.tempMailClientFactory = tempMailClientFactory;
    this.githubSignup = githubSignup;
    this.githubOauth = githubOauth;
    this.requestDeviceCode = requestDeviceCodeFn;
    this.pollToken = pollToken;
    this.saveConnection = saveConnection;
    this.createApiKeyTokens = createApiKeyTokens;
    this.proxyResolver = proxyResolver;
    this.pollIntervalMs = pollIntervalMs;
    this.usernameRng = usernameRng;
    this.passwordRng = passwordRng;
  }

  _requireTempMailClient() {
    if (this.tempMailClient) return this.tempMailClient;
    const client = this.tempMailClientFactory?.();
    if (!client) {
      const provider = String(process.env.TEMPMAIL_PROVIDER || "tempmailorg").toLowerCase().trim();
      const error = new Error(
        provider === "privatix"
          ? "TEMPMAIL_RAPIDAPI_KEY is not configured; cannot allocate Privatix addresses. "
            + "Either set TEMPMAIL_RAPIDAPI_KEY or switch TEMPMAIL_PROVIDER=tempmailorg (default)."
          : `Temp-mail provider "${provider}" is not configured. `
            + "Set TEMPMAIL_PROVIDER=tempmailorg (default, no credentials required) or provide the credentials for your chosen provider."
      );
      error.status = 400;
      error.code = "tempmail_missing_credentials";
      throw error;
    }
    this.tempMailClient = client;
    return this.tempMailClient;
  }

  /**
   * Per-account temp-mail allocation, executed AFTER Camoufox is launched.
   *
   * Provider paths:
   *
   *   • tempmailorg (default): we drive the temp-mail.org WEBSITE via the
   *     Camoufox page. First we navigate the page to temp-mail.org (so
   *     Cloudflare's Bot Fight issues a clearance cookie and the site
   *     renders the current disposable email in its input field), then we
   *     bind that page to the DOM client via `setPage(page)`. All
   *     subsequent allocateAddress / listMessages / waitForOtp calls run
   *     against that page's DOM — no HTTP layer.
   *
   *   • privatix: served through RapidAPI, no Cloudflare, no browser
   *     needed. We just call allocateUniqueAddresses(1) directly.
   *
   * Duck-typing selects the path: temp-mail.org clients expose
   * `.setPage()` (DOM mode) or `.setBrowserTransport()` (HTTP mode);
   * Privatix exposes neither.
   */
  async _allocateTempMailForAccount({ tempMailClient, page, onStep }) {
    const supportsDom = typeof tempMailClient.setPage === "function";
    const supportsBrowserTransport = typeof tempMailClient.setBrowserTransport === "function"
      && tempMailClient.transport?.kind !== "browser"
      && !supportsDom; // prefer DOM path when both exist

    if (supportsDom) {
      onStep?.("tempmail_bootstrap", "Binding temp-mail.org DOM client to Camoufox page");
      try {
        await tempMailClient.setPage(page, { ensureHomepage: true });
        onStep?.("tempmail_transport_dom", "Temp-mail client bound to DOM (Cloudflare-safe)");
      } catch (err) {
        onStep?.("tempmail_bootstrap_warning", `DOM bind failed: ${err?.message || err}`);
        throw err;
      }
    } else if (supportsBrowserTransport) {
      onStep?.("tempmail_bootstrap", "Visiting temp-mail.org so Cloudflare can issue clearance");
      try {
        await page.goto("https://temp-mail.org/", { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState?.("networkidle", { timeout: 15_000 }).catch(() => null);
        await page.waitForTimeout?.(1500);
      } catch (err) {
        onStep?.("tempmail_bootstrap_warning", `temp-mail.org bootstrap navigation failed: ${err?.message || err}`);
      }
      tempMailClient.setBrowserTransport(page);
      onStep?.("tempmail_transport_browser", "Switched temp-mail client to browser-backed transport");
    }

    onStep?.("tempmail_allocating", "Allocating a fresh disposable email address");
    const allocation = await tempMailClient.allocateUniqueAddresses(1);
    if (!allocation?.addresses?.length) {
      throw new Error("Temp-mail provider returned an empty allocation");
    }
    const address = allocation.addresses[0];
    onStep?.("tempmail_allocated", `Address ready: ${address.email}`);
    return address;
  }

  async startJob({
    count,
    minBatch = REGISTER_DEFAULT_MIN_BATCH,
    maxBatch = REGISTER_DEFAULT_MAX_BATCH,
    concurrency,
    browser,
    proxyPoolId,
    headless = true,
  } = {}) {
    // ── Step 1: proxy pool is REQUIRED and must contain enough unique
    // proxies to give every account its own exit IP.
    if (!proxyPoolId) {
      const error = "CodeBuddy GitHub bulk-register requires an active proxy pool";
      throw Object.assign(new Error(error), { error, status: 400 });
    }
    const resolvedProxy = await this.proxyResolver({ proxyPoolId });
    if (resolvedProxy.error) {
      throw Object.assign(new Error(resolvedProxy.error), { error: resolvedProxy.error, status: 400 });
    }
    const uniqueProxies = new Set(resolvedProxy.proxyUrls || []);
    if (uniqueProxies.size === 0) {
      const error = "Proxy pool has no usable proxies";
      throw Object.assign(new Error(error), { error, status: 400 });
    }

    // ── Step 2: decide the target batch size. We DO NOT allocate temp-mail
    // addresses here — that happens inside processAccount, once Camoufox
    // is launched and (for the tempmailorg provider) has cleared the
    // Cloudflare Bot Fight challenge on temp-mail.org.
    //
    // Only Privatix is safe to hit from Node directly, but even for
    // Privatix we allocate per-account so the manager works uniformly
    // regardless of provider. The temp-mail client requirement is checked
    // eagerly so the operator gets a 400 up-front if credentials are
    // missing.
    this._requireTempMailClient();

    const requestedCount = Number.isFinite(Number(count)) && Number(count) > 0
      ? Number(count)
      : minBatch + Math.floor(Math.random() * (maxBatch - minBatch + 1));
    const targetCount = Math.min(requestedCount, uniqueProxies.size);

    if (targetCount === 0) {
      const error = "No accounts can be provisioned (proxy pool empty after resolution)";
      throw Object.assign(new Error(error), { error, status: 400 });
    }

    // ── Step 3: build parsed accounts as PLACEHOLDERS. The real email +
    // temp-mail token are filled inside processAccount when the Camoufox
    // context is ready. We keep the account count deterministic here so
    // BaseBulkImportManager's worker pool can size correctly.
    const parsedAccounts = Array.from({ length: targetCount }, (_, index) => ({
      line: index + 1,
      email: `(pending allocation #${index + 1})`,
      password: undefined,
      githubCredentials: {
        username: generateGithubUsername(this.usernameRng),
        password: generateGithubPassword(this.passwordRng),
      },
    }));

    // ── Step 4: map each account to a unique proxy from the pool.
    const proxyList = [...uniqueProxies];
    const proxyByLine = new Map(parsedAccounts.map((account, index) => [
      account.line,
      proxyList[index],
    ]));

    // ── Step 5: delegate to the base class which spins up the worker pool
    // and calls this.processAccount for each queued entry.
    const sanitizedJob = super.startJob({
      parsedAccounts: parsedAccounts.map(({ githubCredentials, ...rest }) => rest),
      concurrency,
      browser,
      browserLaunchOptions: ({ account }) => ({
        headless: headless !== false,
        proxy: proxyByLine.get(account.line),
        // Register flow ONLY: enable Camoufox's browser-process-level
        // humanization (real cursor paths, keystroke jitter). Reference
        // implementation (farm.py) uses this for signup workloads; without
        // it, GitHub's post-signup behavioral scoring flags freshly-created
        // accounts within seconds, blocking OAuth SSO downstream.
        humanize: true,
      }),
      configureJob: (job) => {
        job.proxyPoolId = resolvedProxy.proxyPoolId || null;
        job.proxySource = resolvedProxy.proxySource || null;
        job.socialProvider = "github-register";
        job.headlessRequested = headless !== false;
        job.batchInfo = {
          requested: requestedCount,
          allocated: targetCount,
          available: uniqueProxies.size,
          capped: requestedCount > uniqueProxies.size,
        };
        // Runtime credentials are attached before workers start, but remain
        // excluded from sanitized snapshots and persisted job JSON.
        job.accounts.forEach((account, index) => {
          account.githubCredentials = parsedAccounts[index].githubCredentials;
          account.oauthProxyUrl = proxyByLine.get(account.line);
        });
      },
    });
    return this.getJob(sanitizedJob.jobId);
  }

  async processAccount(job, account, workerId, accountBrowser) {
    if (job.cancelRequested || !accountBrowser) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    // ── TWO isolated contexts inside one Camoufox browser ─────────────
    // context-A ("mail"): standby at https://temp-mail.org/, owns the
    //   temp-mail DOM client. Never navigates away — the register flow
    //   needs its inbox live throughout the entire signup + OAuth run.
    // context-B ("work"): drives github.com/signup, then chains into
    //   CodeBuddy OAuth. Fully isolated cookie jar from context-A so
    //   temp-mail.org session leakage cannot influence GitHub scoring.
    //
    // If either context creation fails we abort the account cleanly.
    const { context: mailContext, page: mailPage } = await createFreshContext(accountBrowser);
    const { context, page } = await createFreshContext(accountBrowser);
    account.runtimeSession = { context, page, mailContext, mailPage };
    let pollController = null;
    const tempMailClient = this._requireTempMailClient();

    try {
      this.setAccountStep(account, "preparing_worker", `Worker ${workerId} is preparing 2 Camoufox contexts (mail + work)`);
      await this.persistJobSnapshot(job, { forcePreview: true });

      // ── Phase 0: temp-mail allocation on the MAIL context.
      // The temp-mail client binds to mailPage — every subsequent
      // allocate/list/read/refresh operates on that page. The work
      // context (page) is untouched here and stays "cold" until we need
      // it for github.com/signup below.
      let tempMailAddress;
      try {
        tempMailAddress = await this._allocateTempMailForAccount({
          tempMailClient,
          page: mailPage,
          onStep: (step, message) => {
            this.setAccountStep(account, step, message);
            void this.persistJobSnapshot(job, { forcePreview: false });
          },
        });
      } catch (err) {
        // No point continuing — every downstream step needs an inbox.
        this.finalizeAccount(account, "failed", {
          error: `Temp-mail allocation failed: ${err?.message || err}`,
          step: "tempmail_allocation_failed",
          message: `Temp-mail allocation failed: ${err?.message || err}`,
        });
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await mailContext.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }
      account.email = tempMailAddress.email;
      account.tempMail = tempMailAddress;
      await this.persistJobSnapshot(job, { forcePreview: false });

      // ── Phase A: GitHub signup ────────────────────────────────────────
      this.setAccountStep(account, "starting_github_signup", `Starting GitHub signup for ${account.email}`);
      const signupResult = await this.githubSignup({
        page,
        email: account.email,
        username: account.githubCredentials.username,
        password: account.githubCredentials.password,
        tempMailClient,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (!signupResult || signupResult.status !== "success") {
        // Signup failed. Map GitHub-side errors onto the manager's finalize
        // vocabulary. All non-success states leave the browser open for the
        // operator via needs_manual so an octocaptcha or phone-verify page
        // can be finished by hand.
        if (signupResult?.status === "needs_manual") {
          // Keep BOTH contexts alive during manual assist — the operator may
          // need to switch between the GitHub tab (context) and the
          // temp-mail.org tab (mailContext) to read the OTP manually. We
          // stash both on manualSession so runManualFollowup can dispose
          // them after the operator finishes.
          account.manualSession = { context, page, mailContext, mailPage, opened: false, openedAt: null };
          this.setAccountStep(account, "awaiting_manual", `GitHub signup stopped at ${signupResult.reason} — hand over to operator`);
          this.finalizeAccount(account, "needs_manual", {
            error: signupResult.error || "GitHub signup needs manual assist",
            step: "awaiting_manual",
            message: signupResult.error,
          });
          await this.persistJobSnapshot(job, { forcePreview: true });
          return;
        }
        // Normalize the fine-grained failure vocabulary from
        // runGithubSignupAutomation (failed_rate_limited, failed_phone_verify,
        // failed_username_taken, …) into the base-class summary buckets
        // (`failed`, `failed_invalid_credentials`, `failed_exchange`,
        // `failed_timeout`). The specific reason is preserved in the log
        // stream and the account.error string so operators still see it.
        const finalizedStatus = mapSignupStatusToTerminal(signupResult?.status);
        this.finalizeAccount(account, finalizedStatus, {
          error: signupResult?.error || `GitHub signup failed (${signupResult?.status})`,
          step: signupResult?.status || "failed",
          message: signupResult?.error || `GitHub signup failed (${signupResult?.status})`,
        });
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await mailContext.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      // At this point the Camoufox context is authenticated on github.com
      // and can drive the CodeBuddy OAuth flow without a second login.
      account.githubUsername = signupResult.username;
      this.setAccountStep(account, "github_signup_completed", `GitHub account ${signupResult.username} ready; opening CodeBuddy OAuth`);

      // ── Phase B: CodeBuddy device-code OAuth via GitHub SSO ──────────
      const deviceData = await this.requestDeviceCode(CODEBUDDY_PROVIDER_ID, { proxyUrl: account.oauthProxyUrl });
      const authUrl = normalizeCodeBuddyAuthUrl(deviceData.verification_uri, deviceData.device_code);
      if (!authUrl || !deviceData.device_code) {
        throw new Error("CodeBuddy did not return an OAuth login URL");
      }

      pollController = new AbortController();
      let startedCallbackAttempted = false;
      let regionAttempts = 0;
      const MAX_REGION_ATTEMPTS = 20;
      const successPromise = createCodeBuddyPollPromise({
        deviceCode: deviceData.device_code,
        pollToken: this.pollToken,
        proxyUrl: account.oauthProxyUrl,
        signal: pollController.signal,
        shouldCancel: () => job.cancelRequested,
        pollIntervalMs: this.pollIntervalMs,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
        onPending: async (_result, _pollAttempt) => {
          try {
            if (job.cancelRequested) return;
            const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
            let parsed = null;
            try { parsed = currentUrl ? new URL(currentUrl) : null; } catch { parsed = null; }
            if (!parsed) return;

            if (/register\/user\/complete/i.test(parsed.pathname)) {
              if (regionAttempts >= MAX_REGION_ATTEMPTS) return;
              regionAttempts += 1;
              const reportPollStep = (step, message) => {
                this.setAccountStep(account, step, message);
                void this.persistJobSnapshot(job, { forcePreview: false });
              };
              const humanized = await humanizeRegionSelection(page, reportPollStep, "Singapore").catch(() => false);
              if (!humanized) {
                await handleCodeBuddyRegionPage(page, reportPollStep).catch(() => false);
              }
              await page.waitForTimeout(1_500).catch(() => null);
              return;
            }

            const onCodeBuddy = parsed.hostname === "www.codebuddy.ai" || parsed.hostname.endsWith(".codebuddy.ai");
            if (!onCodeBuddy) return;

            if (/\/started\/?$/.test(parsed.pathname)) {
              const handled = await handleCodeBuddyStartedAuthorization(page, (step, message) => {
                this.setAccountStep(account, step, message);
                void this.persistJobSnapshot(job, { forcePreview: false });
              }).catch(() => false);
              if (handled) startedCallbackAttempted = true;
              return;
            }

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
            this.setAccountStep(account, "poll_driver_error", `Poll-side driver error: ${err?.message || err}`);
          }
        },
      });

      // Drive the OAuth Authorize page (GitHub already logged in in this
      // same context — no password entry needed). We pass the tempMailClient
      // through so the SECOND OTP that GitHub emails on the CodeBuddy OAuth
      // flow (device authorization, subject "[GitHub] Please verify your
      // device") can be auto-read from the SAME temp-mail.org inbox the
      // signup OTP was read from — the register flow explicitly does NOT
      // use IMAP.
      const automationResult = await this.githubOauth({
        page,
        authUrl,
        username: signupResult.username,
        email: account.email,
        password: account.githubCredentials.password,
        successPromise,
        shortTimeoutMs: 180_000,
        customRegionHandler: async (p, reportStep) => (
          await humanizeRegionSelection(p, reportStep, "Singapore").catch(() => false)
        ),
        otpTargetEmail: account.email,
        otpTimeoutMs: 180_000,
        tempMailClient,
        serviceLabel: CODEBUDDY_LABEL,
        openingStep: "opening_codebuddy_oauth",
        openingMessage: "Opening CodeBuddy OAuth page for GitHub sign-in (chained)",
        successStep: "codebuddy_token_received",
        successMessage: "CodeBuddy OAuth token received (chained via freshly-created GitHub)",
        allowProviderRestrictedBypass: false,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (automationResult.status === "success") {
        if (automationResult.restrictedBypass) pollController.abort();

        this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration (chained)");
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

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy connection (GitHub Register)");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, tokensWithApiKey);
        // Enrich providerSpecificData so operators can trace the origin flow.
        const enrichedTokens = {
          ...tokensWithCookie,
          providerSpecificData: {
            ...(tokensWithCookie.providerSpecificData || {}),
            automation: "codebuddy-github-register-bulk",
            githubUsername: signupResult.username,
          },
          isActive: false,
        };
        const { connection } = await this.saveConnection({
          tokens: enrichedTokens,
          email: account.email,
          proxyPoolId: job.proxyPoolId,
          proxySource: job.proxySource,
        });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy (GitHub Register) connection saved successfully",
        });
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await mailContext.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      if (automationResult.status === "needs_manual") {
        account.manualSession = { context, page, opened: false, openedAt: null };
        this.setAccountStep(account, "awaiting_manual", "CodeBuddy OAuth needs manual assist");
        this.finalizeAccount(account, "needs_manual", {
          error: automationResult.error,
          step: "awaiting_manual",
          message: automationResult.error,
        });
        // We keep the WORK context alive so the operator can finish in the
        // visible window. The MAIL context can be closed — the manual
        // handover on CodeBuddy OAuth does not need the temp-mail inbox
        // anymore (device-verification OTP is not re-issued when the same
        // session finishes manually).
        await mailContext.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      pollController.abort();
      this.finalizeAccount(account, automationResult.status || "failed", {
        error: automationResult.error || "CodeBuddy GitHub (Register) automation failed.",
        step: automationResult.status || "failed",
        message: automationResult.error || "CodeBuddy GitHub (Register) automation failed.",
      });
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await mailContext.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      pollController?.abort();
      if (job.cancelRequested) {
        this.finalizeAccount(account, "cancelled", {
          error: "Job cancelled",
          step: "cancelled",
          message: "Job cancelled while CodeBuddy GitHub Register automation was running",
        });
      } else {
        this.finalizeAccount(account, "failed", {
          error: error.message || "Unexpected CodeBuddy GitHub Register failure.",
          step: "failed",
          message: error.message || "Unexpected CodeBuddy GitHub Register failure.",
        });
      }
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await mailContext.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      // Scrub in-memory credentials regardless of outcome. sanitizeAccount
      // in the base class already strips these before persistence, but we
      // also delete them here so no other component can accidentally read
      // them once the account is finalized.
      account.githubCredentials = undefined;
      account.tempMail = undefined;
    }
  }
}

function getSingletonStore() {
  if (!globalThis.__codeBuddyGithubBulkRegisterSingleton) {
    globalThis.__codeBuddyGithubBulkRegisterSingleton = { manager: new CodeBuddyGithubBulkRegisterManager() };
  }
  return globalThis.__codeBuddyGithubBulkRegisterSingleton;
}

export function getCodeBuddyGithubBulkRegisterManager() {
  return getSingletonStore().manager;
}

export {
  buildLookupResponse,
  generateGithubUsername,
  generateGithubPassword,
  REGISTER_DEFAULT_MIN_BATCH,
  REGISTER_DEFAULT_MAX_BATCH,
};
