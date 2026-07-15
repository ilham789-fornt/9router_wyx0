/**
 * CodeBuddyBulkImportManager — CodeBuddy-specific bulk import automation.
 *
 * Handles: Device code OAuth flow → Google login → token polling →
 * API key creation → cookie capture → save connection.
 * CodeBuddy uses device code flow with additional backend session setup.
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
import {
  runGoogleAccountAutomation,
  handleCodeBuddyRegionPage,
  handleProviderOnboarding,
  handleCodeBuddyStartedAuthorization,
  isProviderPage,
} from "./automation/googleOAuth.js";
import { resolveBulkImportProxy } from "./bulkImportProxyResolver.js";

const CODEBUDDY_PROVIDER_ID = "codebuddy";
const CODEBUDDY_LABEL = "CodeBuddy";
const CODEBUDDY_POLL_TIMEOUT_MS = 15 * 60_000;
const CODEBUDDY_POLL_INTERVAL_MS = 5_000;
const CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS = 6;
const CODEBUDDY_COOKIE_DOMAINS = new Set(["codebuddy.ai", "www.codebuddy.ai"]);
const CODEBUDDY_BASE_URL = "https://www.codebuddy.ai";
const CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/login/account`;
const CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/accounts`;
const CODEBUDDY_API_KEYS_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/api/client/v1/api-keys`;
const CODEBUDDY_TRIAL_ENDPOINT = `${CODEBUDDY_BASE_URL}/billing/ide/trial`;
const CODEBUDDY_DEFAULT_USER_ENTERPRISE_ID = "personal-edition-user-id";

export const CODEBUDDY_BULK_IMPORT_DEFAULT_CONCURRENCY = DEFAULT_CONCURRENCY;
export const CODEBUDDY_BULK_IMPORT_MIN_CONCURRENCY = MIN_CONCURRENCY;
export const CODEBUDDY_BULK_IMPORT_MAX_CONCURRENCY = MAX_CONCURRENCY;

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

async function defaultSaveCodeBuddyConnection({ tokens, email, wrapLogin = false, proxyPoolId, proxySource }) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const { assertProviderEnabled } = await import("@/lib/providerDisabled");
  await assertProviderEnabled(CODEBUDDY_PROVIDER_ID);
  const hasApiKey = Boolean(tokens.apiKey);
  const providerSpecificData = {
    ...(tokens.providerSpecificData || {}),
    loginEmail: email,
    automation: wrapLogin ? "codebuddy-wrap-login" : "gsuite-bulk",
    ...(wrapLogin ? {
      proxyWrappedLogin: true,
      proxyWrapping: Boolean(proxyPoolId),
      proxyPoolId: proxyPoolId || undefined,
      proxySource: proxySource || undefined,
    } : {}),
  };

  if (tokens.webCookie) {
    providerSpecificData.webCookie = tokens.webCookie;
    providerSpecificData.webCookieCapturedAt = tokens.webCookieCapturedAt || new Date().toISOString();
  }

  const connectionPayload = {
    provider: CODEBUDDY_PROVIDER_ID,
    authType: hasApiKey ? "apikey" : "oauth",
    name: wrapLogin ? "CodeBuddy OAuth via Proxy" : (email || undefined),
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
    console.warn("[CodeBuddy] captureWebCookie: context.cookies not available");
    return null;
  }

  try {
    const cookies = await context.cookies(["https://www.codebuddy.ai", "https://codebuddy.ai"]);
    console.log(`[CodeBuddy] captureWebCookie: found ${cookies.length} raw cookies from browser context`);

    const usefulCookies = cookies
      .filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
        return CODEBUDDY_COOKIE_DOMAINS.has(domain) || domain.endsWith(".codebuddy.ai");
      })
      .filter((cookie) => cookie.name && cookie.value)
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));

    if (usefulCookies.length === 0) {
      console.warn("[CodeBuddy] captureWebCookie: no useful cookies after filtering. Raw cookie names:", cookies.map(c => `${c.name}@${c.domain}`).join(", "));
      return null;
    }

    const cookieString = usefulCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    console.log(`[CodeBuddy] captureWebCookie: captured ${usefulCookies.length} cookies (${cookieString.length} chars). Names: ${usefulCookies.map(c => c.name).join(", ")}`);
    return cookieString;
  } catch (error) {
    console.error("[CodeBuddy] captureWebCookie error:", error.message);
    return null;
  }
}

async function attachCodeBuddyWebCookie(context, tokens = {}) {
  const webCookie = await captureCodeBuddyWebCookie(context);
  if (!webCookie) return tokens;
  return { ...tokens, webCookie, webCookieCapturedAt: new Date().toISOString() };
}

// ── API Key Creation ───────────────────────────────────────────────────────────

function createCodeBuddyApiKeyName() {
  const suffix = Math.floor(Math.random() * 900000) + 100000;
  return `9router-${Date.now().toString(36)}-${suffix}`;
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
  if (!apiKey) {
    throw new Error("CodeBuddy API key response did not include data.key");
  }
  return apiKey;
}

async function defaultCreateCodeBuddyApiKeyTokens({ page, tokens = {}, onStep }) {
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

// ── Token Polling ──────────────────────────────────────────────────────────────

function createCodeBuddyPollPromise({
  deviceCode,
  pollToken,
  onStep,
  signal,
  shouldCancel,
  onPending,
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
      if (signal?.aborted || shouldCancel?.()) {
        throw new Error("CodeBuddy OAuth polling cancelled");
      }

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

async function completeCodeBuddyOAuthState(page, deviceCode, onStep) {
  const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
  let parsed = null;
  try {
    parsed = currentUrl ? new URL(currentUrl) : null;
  } catch {
    parsed = null;
  }

  const isGlobalSessionPage = parsed?.hostname === "www.codebuddy.ai"
    && !/^\/(?:login|auth)(?:\/|$)/.test(parsed.pathname);
  if (!isGlobalSessionPage) return { completed: false, reason: "web_session_not_ready" };

  onStep?.("codebuddy_web_session_detected", "Authenticated CodeBuddy Global browser session detected");

  const startedUrl = new URL("https://www.codebuddy.ai/started");
  startedUrl.searchParams.set("platform", "CLI");
  startedUrl.searchParams.set("state", deviceCode);
  onStep?.("completing_codebuddy_oauth", "Completing the CodeBuddy Global OAuth browser callback");

  if (!/^\/started\/?$/.test(parsed.pathname) || parsed.searchParams.get("state") !== deviceCode) {
    await page.goto(startedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
  }
  const completed = await handleCodeBuddyStartedAuthorization(page, onStep);
  if (!completed) {
    onStep?.("codebuddy_oauth_callback_pending", "The /started callback was not accepted yet; token polling will continue");
  }
  return { completed, reason: completed ? "callback_attempted" : "callback_not_accepted" };
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

export class CodeBuddyBulkImportManager extends BaseBulkImportManager {
  constructor({
    browserLauncher,
    googleAutomation = runGoogleAccountAutomation,
    requestDeviceCodeFn = defaultRequestDeviceCode,
    pollToken = defaultPollForToken,
    saveConnection = defaultSaveCodeBuddyConnection,
    createApiKeyTokens = defaultCreateCodeBuddyApiKeyTokens,
    proxyResolver = resolveBulkImportProxy,
    pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
  } = {}) {
    super({
      storageName: "codebuddy-bulk-import",
      providerLabel: CODEBUDDY_LABEL,
      browserLauncher,
      defaultConcurrency: CODEBUDDY_BULK_IMPORT_DEFAULT_CONCURRENCY,
    });

    this.googleAutomation = googleAutomation;
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
    wrapLogin = false,
    proxyPoolId = null,
    proxyUrl = null,
  } = {}) {
    let normalizedAccounts = parsedAccounts;

    let resolvedProxy = null;
    if (wrapLogin === true) {
      resolvedProxy = await this.proxyResolver({ proxyPoolId, proxyUrl });
      if (resolvedProxy.error) {
        throw Object.assign(new Error(resolvedProxy.error), { error: resolvedProxy.error, status: 400 });
      }
      if (!resolvedProxy.proxyUrl) {
        const error = "Login wrapping requires an active proxy pool";
        throw Object.assign(new Error(error), { error, status: 400 });
      }
      normalizedAccounts = [{ line: 1, email: "CodeBuddy OAuth", password: undefined }];
    }

    if (!wrapLogin && !Array.isArray(normalizedAccounts)) {
      const { parsed, invalidLines } = parseCodeBuddyBulkAccounts(accounts);
      if (invalidLines.length > 0) {
        const error = "Invalid account format. Use one account per line: gmail@example.com|password";
        throw Object.assign(new Error(error), { error, invalidLines });
      }
      normalizedAccounts = parsed;
    }

    const sanitizedJob = super.startJob({
      parsedAccounts: normalizedAccounts,
      concurrency: wrapLogin ? 1 : concurrency,
      browser,
      browserLaunchOptions: wrapLogin ? {
        headless: false,
        proxy: resolvedProxy.proxyUrl,
      } : null,
    });
    const job = this.jobs.get(sanitizedJob.jobId);
    if (job) {
      job.wrapLogin = wrapLogin === true;
      job.proxyPoolId = resolvedProxy?.proxyPoolId || null;
      job.proxySource = resolvedProxy?.proxySource || null;
      job.accounts.forEach((account) => {
        account.proxyWrappedLogin = wrapLogin === true;
      });
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
        if (!manualPage) {
          throw new Error("CodeBuddy browser session missing for API key creation");
        }

        const tokensWithApiKey = await this.createApiKeyTokens({
          page: manualPage,
          tokens: result.tokens || {},
          email: account.email,
          onStep: (step, message) => {
            this.setAccountStep(account, step, message);
            void this.persistJobSnapshot(job, { forcePreview: false });
          },
        });

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy API key connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, tokensWithApiKey);
        const { connection } = await this.saveConnection({
          tokens: { ...tokensWithCookie, isActive: false },
          email: account.email,
        });

        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy API key connection saved successfully",
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

  async processAccount(job, account, workerId) {
    if (job.cancelRequested || !job.browser) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    const { context, page } = await createFreshContext(job.browser);
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
      let startedCallbackCompleted = false;
      let waitingForWebSessionReported = false;
      const successPromise = createCodeBuddyPollPromise({
        deviceCode: deviceData.device_code,
        pollToken: this.pollToken,
        signal: pollController.signal,
        shouldCancel: () => job.cancelRequested,
        onPending: job.wrapLogin ? async (_result, pollAttempt) => {
          if (startedCallbackCompleted || job.cancelRequested) return;
          const completion = await completeCodeBuddyOAuthState(
            page,
            deviceData.device_code,
            (step, message) => {
              this.setAccountStep(account, step, message);
              void this.persistJobSnapshot(job, { forcePreview: false });
            }
          );
          if (completion.reason === "web_session_not_ready" && !waitingForWebSessionReported) {
            waitingForWebSessionReported = true;
            this.setAccountStep(
              account,
              "waiting_for_codebuddy_web_session",
              "OAuth is pending; waiting for the browser login to create a CodeBuddy Global web session"
            );
          }
          startedCallbackCompleted = completion.completed;
          if (startedCallbackCompleted) {
            this.setAccountStep(
              account,
              "polling_after_codebuddy_callback",
              `CodeBuddy OAuth callback attempted after poll ${pollAttempt}; validating through the official token endpoint`
            );
          }
        } : undefined,
        pollIntervalMs: this.pollIntervalMs,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (job.wrapLogin) {
        this.setAccountStep(account, "opening_codebuddy_oauth", "Opening CodeBuddy OAuth login through the selected proxy");
        await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const result = await successPromise;
        if (job.cancelRequested) throw new Error("Job cancelled");

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy OAuth connection from proxy-routed login");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, result.tokens || {});
        if (job.cancelRequested) throw new Error("Job cancelled");
        const { connection } = await this.saveConnection({
          tokens: {
            ...tokensWithCookie,
            providerSpecificData: {
              ...(tokensWithCookie.providerSpecificData || {}),
              authKind: "access_token",
              proxyWrappedLogin: true,
            },
            isActive: false,
          },
          email: undefined,
          wrapLogin: true,
          proxyPoolId: job.proxyPoolId,
          proxySource: job.proxySource,
        });
        if (job.cancelRequested) throw new Error("Job cancelled");
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
        allowProviderRestrictedBypass: true,
        restrictedBypassStep: "codebuddy_restricted_bypass",
        restrictedBypassMessage: "CodeBuddy restricted page detected; continuing with backend API key request",
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (automationResult.status === "success") {
        if (automationResult.restrictedBypass) {
          pollController.abort();
        }

        this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration");
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

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy API key connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = await attachCodeBuddyWebCookie(context, tokensWithApiKey);
        const { connection } = await this.saveConnection({
          tokens: { ...tokensWithCookie, isActive: false },
          email: account.email,
        });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy API key connection saved successfully",
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

export function parseCodeBuddyBulkAccounts(accounts = []) {
  return parseBulkAccounts(accounts, CODEBUDDY_LABEL);
}

function getSingletonStore() {
  if (!globalThis.__codeBuddyBulkImportSingleton) {
    globalThis.__codeBuddyBulkImportSingleton = { manager: new CodeBuddyBulkImportManager() };
  }
  return globalThis.__codeBuddyBulkImportSingleton;
}

export function getCodeBuddyBulkImportManager() {
  return getSingletonStore().manager;
}

export { buildLookupResponse };
