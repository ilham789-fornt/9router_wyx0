/**
 * CodeBuddyOAuthBulkImportManager — CodeBuddy bulk import WITHOUT API key creation.
 *
 * Same flow as CodeBuddyBulkImportManager (device code OAuth → Google login →
 * token polling → registration completion → cookie capture → save connection),
 * but skips the console API key step entirely. Connections are saved as
 * oauth-type credentials carrying the accessToken + refreshToken pair returned
 * by the device flow. Token renewal is handled at chat time by
 * refreshCodeBuddy() in open-sse/executors/default.js via
 * POST /v2/plugin/auth/token/refresh (X-Refresh-Token header).
 *
 * This exists because the CodeBuddy console API
 * (/console/api/client/v1/api-keys) is gated behind APISIX and returns a bare
 * "401 Authorization Required" page for both browser sessions and bearer
 * tokens, making the API-key-based bulk flow fail on every account.
 */
import {
  BaseBulkImportManager,
  createFreshContext,
  parseBulkAccounts,
  buildLookupResponse,
  DEFAULT_CONCURRENCY,
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
} from "./automation/baseBulkImportManager.js";
import {
  runGoogleAccountAutomation,
  handleCodeBuddyRegionPage,
  handleProviderOnboarding,
  handleCodeBuddyStartedAuthorization,
  isProviderPage,
} from "./automation/googleOAuth.js";
import { resolveBulkImportProxy } from "./bulkImportProxyResolver.js";
import { pickWorkingLoginProxy } from "./automation/proxyLoginPicker.js";

const CODEBUDDY_PROVIDER_ID = "codebuddy";
const CODEBUDDY_LABEL = "CodeBuddy";
const CODEBUDDY_POLL_TIMEOUT_MS = 15 * 60_000;
const CODEBUDDY_POLL_INTERVAL_MS = 5_000;
const CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS = 6;
const CODEBUDDY_COOKIE_DOMAINS = new Set(["codebuddy.ai", "www.codebuddy.ai"]);

export const CODEBUDDY_OAUTH_BULK_IMPORT_DEFAULT_CONCURRENCY = DEFAULT_CONCURRENCY;
export const CODEBUDDY_OAUTH_BULK_IMPORT_MIN_CONCURRENCY = MIN_CONCURRENCY;
export const CODEBUDDY_OAUTH_BULK_IMPORT_MAX_CONCURRENCY = MAX_CONCURRENCY;

// ── Utilities ──────────────────────────────────────────────────────────────────

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

function normalizeCodeBuddyAuthUrl(rawUrl, state) {
  if (!rawUrl && !state) return rawUrl;
  const url = rawUrl ? new URL(rawUrl) : new URL("https://www.codebuddy.ai/login");
  const platform = url.searchParams.get("platform") || "CLI";
  const effectiveState = state || url.searchParams.get("state");
  const normalized = new URL("https://www.codebuddy.ai/login");
  normalized.searchParams.set("platform", platform);
  if (effectiveState) normalized.searchParams.set("state", effectiveState);
  return normalized.toString();
}

// ── Connection & Token Helpers ─────────────────────────────────────────────────

async function defaultSaveCodeBuddyOAuthConnection({ tokens, email }) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const { assertProviderEnabled } = await import("@/lib/providerDisabled");
  await assertProviderEnabled(CODEBUDDY_PROVIDER_ID);

  const refreshToken = String(
    tokens.refreshToken
    || tokens.refresh_token
    || tokens.providerSpecificData?.refreshToken
    || tokens.providerSpecificData?.refresh_token
    || tokens.providerSpecificData?.rawAuth?.refreshToken
    || tokens.providerSpecificData?.rawAuth?.refresh_token
    || ""
  ).trim();

  if (!refreshToken) {
    throw new Error("CodeBuddy OAuth tokens did not include a refresh token; refusing to save an unusable connection");
  }

  const providerSpecificData = {
    ...(tokens.providerSpecificData || {}),
    loginEmail: email,
    automation: "gsuite-bulk-oauth",
    authKind: "access_token",
  };

  if (tokens.webCookie) {
    providerSpecificData.webCookie = tokens.webCookie;
    providerSpecificData.webCookieCapturedAt = tokens.webCookieCapturedAt || new Date().toISOString();
  }

  const connection = await createProviderConnection({
    provider: CODEBUDDY_PROVIDER_ID,
    authType: "oauth",
    name: email || undefined,
    email,
    ...tokens,
    refreshToken,
    providerSpecificData,
    isActive: false,
    testStatus: "active",
    expiresAt: tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : null,
  });
  return { connection };
}

async function defaultRequestDeviceCode(providerId) {
  const { requestDeviceCode } = await import("../providers.js");
  return requestDeviceCode(providerId);
}

async function defaultPollForToken(providerId, deviceCode) {
  const { pollForToken } = await import("../providers.js");
  return pollForToken(providerId, deviceCode);
}

// ── Cookie Capture ─────────────────────────────────────────────────────────────

async function captureCodeBuddyWebCookie(context) {
  if (!context?.cookies) {
    console.warn("[CodeBuddy-OAuth] captureWebCookie: context.cookies not available");
    return null;
  }

  try {
    const cookies = await context.cookies(["https://www.codebuddy.ai", "https://codebuddy.ai"]);
    const usefulCookies = cookies
      .filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
        return CODEBUDDY_COOKIE_DOMAINS.has(domain) || domain.endsWith(".codebuddy.ai");
      })
      .filter((cookie) => cookie.name && cookie.value)
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));

    if (usefulCookies.length === 0) {
      console.warn("[CodeBuddy-OAuth] captureWebCookie: no useful cookies after filtering");
      return null;
    }

    return usefulCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  } catch (error) {
    console.error("[CodeBuddy-OAuth] captureWebCookie error:", error.message);
    return null;
  }
}

async function attachCodeBuddyWebCookie(context, tokens = {}) {
  const webCookie = await captureCodeBuddyWebCookie(context);
  if (!webCookie) return tokens;
  return { ...tokens, webCookie, webCookieCapturedAt: new Date().toISOString() };
}

// ── Token Polling ──────────────────────────────────────────────────────────────

function createCodeBuddyPollPromise({
  deviceCode,
  pollToken,
  onStep,
  signal,
  timeoutMs = CODEBUDDY_POLL_TIMEOUT_MS,
  pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
  maxTransientErrors = CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS,
}) {
  return (async () => {
    const startedAt = Date.now();
    let lastStepAt = 0;
    let transientErrors = 0;

    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) {
        throw new Error("CodeBuddy OAuth polling cancelled");
      }

      if (Date.now() - lastStepAt > pollIntervalMs - 100) {
        onStep?.("polling_codebuddy_token", "Waiting for CodeBuddy OAuth token");
        lastStepAt = Date.now();
      }

      const result = await pollToken(CODEBUDDY_PROVIDER_ID, deviceCode);
      if (result.success) return { tokens: result.tokens };

      if (!result.pending && result.error !== "authorization_pending" && result.error !== "slow_down") {
        if (result.error === "request_failed" && transientErrors < maxTransientErrors) {
          transientErrors += 1;
          onStep?.("codebuddy_poll_retry", `CodeBuddy token poll failed temporarily (${transientErrors}/${maxTransientErrors}); retrying`);
          await wait(pollIntervalMs, signal);
          continue;
        }
        throw new Error(result.errorDescription || result.error || "CodeBuddy OAuth polling failed");
      }

      await wait(pollIntervalMs, signal);
    }

    throw new Error("Timed out waiting for CodeBuddy OAuth token");
  })();
}

// ── Registration Completion ────────────────────────────────────────────────────

const CODEBUDDY_DASHBOARD_URL = "https://www.codebuddy.ai/home";
const CODEBUDDY_COMPLETE_REGISTER_TIMEOUT_MS = 30_000;
const CODEBUDDY_COMPLETE_REGISTER_POLL_MS = 1_500;

async function completeCodeBuddyRegistration(page, onStep) {
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

// ── Manager Class ──────────────────────────────────────────────────────────────

export class CodeBuddyOAuthBulkImportManager extends BaseBulkImportManager {
  constructor({
    browserLauncher,
    googleAutomation = runGoogleAccountAutomation,
    requestDeviceCodeFn = defaultRequestDeviceCode,
    pollToken = defaultPollForToken,
    saveConnection = defaultSaveCodeBuddyOAuthConnection,
    proxyResolver = resolveBulkImportProxy,
    pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
  } = {}) {
    super({
      storageName: "codebuddy-oauth-bulk-import",
      providerLabel: CODEBUDDY_LABEL,
      browserLauncher,
      browserPerAccount: true,
      defaultConcurrency: CODEBUDDY_OAUTH_BULK_IMPORT_DEFAULT_CONCURRENCY,
    });

    this.googleAutomation = googleAutomation;
    this.requestDeviceCode = requestDeviceCodeFn;
    this.pollToken = pollToken;
    this.saveConnection = saveConnection;
    this.proxyResolver = proxyResolver;
    this.pollIntervalMs = pollIntervalMs;
  }

  async startJob({ accounts, parsedAccounts, concurrency, browser, proxyPoolId = null, proxyUrl = null } = {}) {
    let normalizedAccounts = parsedAccounts;

    if (!Array.isArray(normalizedAccounts)) {
      const { parsed, invalidLines } = parseCodeBuddyOAuthBulkAccounts(accounts);
      if (invalidLines.length > 0) {
        const error = "Invalid account format. Use one account per line: gmail@example.com|password";
        throw Object.assign(new Error(error), { error, invalidLines });
      }
      normalizedAccounts = parsed;
    }

    let resolvedProxy = null;
    if (proxyPoolId || proxyUrl) {
      resolvedProxy = await this.proxyResolver({ proxyPoolId, proxyUrl });
      if (resolvedProxy.error) {
        throw Object.assign(new Error(resolvedProxy.error), { error: resolvedProxy.error, status: 400 });
      }
      if (!(resolvedProxy.proxyUrls || []).length) {
        const error = "Proxy pool has no usable proxies";
        throw Object.assign(new Error(error), { error, status: 400 });
      }

      const reachable = [];
      for (const candidate of resolvedProxy.proxyUrls) {
        const picked = await pickWorkingLoginProxy({
          proxyUrls: [candidate],
          testUrl: "https://www.codebuddy.ai/login",
        });
        if (picked.proxyUrl) reachable.push(candidate);
      }
      if (!reachable.length) {
        const error = `No proxy in the selected pool could reach the CodeBuddy login endpoint (${resolvedProxy.proxyUrls.length} checked)`;
        throw Object.assign(new Error(error), { error, status: 400 });
      }
      resolvedProxy = { ...resolvedProxy, proxyUrls: reachable, proxyUrl: reachable[0] };
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
        headless: true,
        proxy: proxyByLine.get(account.line) || null,
        humanize: true,
      }),
    });
    const job = this.jobs.get(sanitizedJob.jobId);
    if (job) {
      job.proxyPoolId = resolvedProxy?.proxyPoolId || null;
      job.proxySource = resolvedProxy?.proxySource || null;
    }
    return this.getJob(sanitizedJob.jobId);
  }

  async runManualFollowup(job, account, workerId, context, successPromise) {
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
        if (manualPage) {
          this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration");
          await this.persistJobSnapshot(job, { forcePreview: true });
          await completeCodeBuddyRegistration(manualPage, (step, message) => {
            this.setAccountStep(account, step, message);
            void this.persistJobSnapshot(job, { forcePreview: false });
          });
        }

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy OAuth connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, result.tokens || {});
        const { connection } = await this.saveConnection({
          tokens: { ...tokensWithCookie, isActive: false },
          email: account.email,
        });

        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy OAuth connection saved successfully",
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
        job.manualFollowups.delete(followupPromise);
        await this.persistJobSnapshot(job, { forcePreview: true });
      }
    })();

    job.manualFollowups.add(followupPromise);
  }

  async processAccount(job, account, workerId, accountBrowser = null) {
    const browser = accountBrowser || job.browser;
    if (job.cancelRequested || !browser) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    const { context, page } = await createFreshContext(browser);
    account.runtimeSession = { context, page };
    let pollController = null;

    try {
      this.setAccountStep(account, "preparing_worker", `Worker ${workerId} is preparing a browser context`);
      await this.persistJobSnapshot(job, { forcePreview: true });

      this.setAccountStep(account, "requesting_codebuddy_state", "Requesting CodeBuddy OAuth state");
      const deviceData = await this.requestDeviceCode(CODEBUDDY_PROVIDER_ID);
      const authUrl = normalizeCodeBuddyAuthUrl(deviceData.verification_uri, deviceData.device_code);
      if (!authUrl || !deviceData.device_code) {
        throw new Error("CodeBuddy did not return an OAuth login URL");
      }

      pollController = new AbortController();
      const successPromise = createCodeBuddyPollPromise({
        deviceCode: deviceData.device_code,
        pollToken: this.pollToken,
        signal: pollController.signal,
        pollIntervalMs: this.pollIntervalMs,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      const automationResult = await this.googleAutomation({
        page,
        authUrl,
        email: account.email,
        password: account.password,
        successPromise,
        serviceLabel: CODEBUDDY_LABEL,
        openingStep: "opening_codebuddy_oauth",
        openingMessage: "Opening CodeBuddy OAuth page",
        successStep: "codebuddy_token_received",
        successMessage: "CodeBuddy OAuth token received",
        allowProviderRestrictedBypass: false,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (automationResult.status === "success") {
        this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration");
        await this.persistJobSnapshot(job, { forcePreview: true });
        await completeCodeBuddyRegistration(page, (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        });

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy OAuth connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, automationResult.tokens || {});
        const { connection } = await this.saveConnection({
          tokens: { ...tokensWithCookie, isActive: false },
          email: account.email,
        });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy OAuth connection saved successfully",
        });
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      if (automationResult.status === "needs_manual") {
        account.manualSession = { context, page, opened: false, openedAt: null };
        this.setAccountStep(account, "awaiting_manual", "Waiting for manual completion in the browser session");
        this.finalizeAccount(account, "needs_manual", {
          error: automationResult.error,
          step: "awaiting_manual",
          message: automationResult.error,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        await this.runManualFollowup(job, account, workerId, context, successPromise);
        return;
      }

      pollController.abort();
      this.finalizeAccount(account, automationResult.status || "failed", {
        error: automationResult.error || "CodeBuddy Google automation failed.",
        step: automationResult.status || "failed",
        message: automationResult.error || "CodeBuddy Google automation failed.",
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
          message: "Job cancelled while CodeBuddy automation was running",
        });
      } else {
        this.finalizeAccount(account, "failed", {
          error: error.message || "Unexpected CodeBuddy bulk import failure.",
          step: "failed",
          message: error.message || "Unexpected CodeBuddy bulk import failure.",
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

export function parseCodeBuddyOAuthBulkAccounts(accounts = []) {
  return parseBulkAccounts(accounts, CODEBUDDY_LABEL);
}

function getSingletonStore() {
  if (!globalThis.__codeBuddyOAuthBulkImportSingleton) {
    globalThis.__codeBuddyOAuthBulkImportSingleton = { manager: new CodeBuddyOAuthBulkImportManager() };
  }
  return globalThis.__codeBuddyOAuthBulkImportSingleton;
}

export function getCodeBuddyOAuthBulkImportManager() {
  return getSingletonStore().manager;
}

export { buildLookupResponse };

export const __test__ = {
  defaultSaveCodeBuddyOAuthConnection,
};
