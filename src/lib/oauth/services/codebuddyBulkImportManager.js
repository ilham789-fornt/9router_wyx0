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
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const CODEBUDDY_PROVIDER_ID = "codebuddy";
const CODEBUDDY_LABEL = "CodeBuddy";
const CODEBUDDY_POLL_TIMEOUT_MS = 15 * 60_000;
const CODEBUDDY_POLL_INTERVAL_MS = 5_000;
const CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS = 6;
const CODEBUDDY_COOKIE_DOMAINS = new Set(["codebuddy.ai", "www.codebuddy.ai"]);
const CODEBUDDY_BASE_URL = "https://www.codebuddy.ai";
const CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/login/account`;
const CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/accounts`;
const CODEBUDDY_PLUGIN_ACCOUNTS_ENDPOINT = `${CODEBUDDY_BASE_URL}/v2/plugin/accounts`;
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

async function defaultSaveCodeBuddyConnection({ tokens, email }) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const { assertProviderEnabled } = await import("@/lib/providerDisabled");
  await assertProviderEnabled(CODEBUDDY_PROVIDER_ID);
  const hasApiKey = Boolean(tokens.apiKey);
  const providerSpecificData = {
    ...(tokens.providerSpecificData || {}),
    loginEmail: email,
    automation: "gsuite-bulk",
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

async function readCodeBuddyResponseBody(response) {
  const text = await response.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { text, json };
}

function summarizeCodeBuddyResponse(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "unknown response";
}

function getCodeBuddyDomain(providerSpecificData = {}) {
  return String(providerSpecificData.domain || providerSpecificData.rawAuth?.domain || "www.codebuddy.ai").trim() || "www.codebuddy.ai";
}

function getCodeBuddyAccessToken(tokens = {}) {
  const providerSpecificData = tokens.providerSpecificData || {};
  return String(
    tokens.accessToken
    || tokens.access_token
    || providerSpecificData.accessToken
    || providerSpecificData.access_token
    || providerSpecificData.rawAuth?.accessToken
    || providerSpecificData.rawAuth?.access_token
    || ""
  ).trim();
}

function buildCodeBuddyBearerHeaders({ accessToken, providerSpecificData = {}, uid = null, enterpriseId = null, extraHeaders = {} }) {
  const domain = getCodeBuddyDomain(providerSpecificData);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": "Mozilla/5.0",
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": domain,
    Authorization: `Bearer ${accessToken}`,
    Origin: `https://${domain}`,
    Referer: `https://${domain}/console/api-key`,
    ...extraHeaders,
  };

  if (uid) headers["X-User-Id"] = uid;
  if (enterpriseId) {
    headers["X-Enterprise-Id"] = enterpriseId;
    headers["X-Tenant-Id"] = enterpriseId;
  }

  return headers;
}

async function fetchCodeBuddyBackendIdentity({ accessToken, providerSpecificData = {}, fetchImpl = proxyAwareFetch, proxyOptions = null } = {}) {
  const domain = getCodeBuddyDomain(providerSpecificData);
  const fromMeta = {
    uid: String(providerSpecificData.uid || providerSpecificData.userId || providerSpecificData.codeBuddyUserId || "").trim(),
    enterpriseId: String(providerSpecificData.enterpriseId || providerSpecificData.userEnterpriseId || "").trim(),
    userEnterpriseId: String(providerSpecificData.userEnterpriseId || providerSpecificData.enterpriseId || "").trim(),
  };

  try {
    const response = await fetchImpl(
      domain === "www.codebuddy.ai" ? CODEBUDDY_PLUGIN_ACCOUNTS_ENDPOINT : `https://${domain}/v2/plugin/accounts`,
      {
        method: "GET",
        headers: buildCodeBuddyBearerHeaders({ accessToken, providerSpecificData }),
      },
      proxyOptions
    );
    const { json } = await readCodeBuddyResponseBody(response);
    const accounts = json?.data?.accounts || [];
    if (response.ok && Array.isArray(accounts) && accounts.length) {
      const account = accounts.find((entry) => entry?.lastLogin) || accounts[0] || {};
      return {
        uid: String(account.uid || fromMeta.uid || "").trim(),
        enterpriseId: String(account.enterpriseId || fromMeta.enterpriseId || "").trim(),
        userEnterpriseId: String(account.userEnterpriseId || account.user_enterprise_id || account.enterpriseId || fromMeta.userEnterpriseId || "").trim(),
      };
    }
  } catch {
    // Best effort; metadata/defaults below are enough for personal accounts.
  }

  return fromMeta;
}

async function createCodeBuddyApiKeyViaBackend({ accessToken, providerSpecificData = {}, userEnterpriseId = null, fetchImpl = proxyAwareFetch, proxyOptions = null } = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { apiKey: null, error: "CodeBuddy OAuth token is not available for backend API key creation" };
  }

  const domain = getCodeBuddyDomain(providerSpecificData);
  const identity = await fetchCodeBuddyBackendIdentity({ accessToken: token, providerSpecificData, fetchImpl, proxyOptions });
  const enterpriseId = String(
    userEnterpriseId
    || identity.userEnterpriseId
    || identity.enterpriseId
    || CODEBUDDY_DEFAULT_USER_ENTERPRISE_ID
  ).trim();

  try {
    const response = await fetchImpl(
      `https://${domain}/console/api/client/v1/api-keys`,
      {
        method: "POST",
        headers: buildCodeBuddyBearerHeaders({
          accessToken: token,
          providerSpecificData,
          uid: identity.uid,
          enterpriseId,
          extraHeaders: { "Content-Type": "application/json" },
        }),
        body: JSON.stringify({
          name: createCodeBuddyApiKeyName(),
          expire_in_days: -1,
          user_enterprise_id: enterpriseId,
        }),
      },
      proxyOptions
    );
    const { text, json } = await readCodeBuddyResponseBody(response);
    if (!response.ok || json?.code !== 0) {
      const code = json?.code ?? response.status;
      const message = json?.msg || json?.message || text;
      return {
        apiKey: null,
        identity: { ...identity, userEnterpriseId: enterpriseId },
        error: `CodeBuddy bearer API key creation failed (${code}): ${summarizeCodeBuddyResponse(message)}`,
      };
    }

    const apiKey = String(json?.data?.key || json?.data?.api_key || json?.data?.token || "").trim();
    if (!apiKey) {
      return {
        apiKey: null,
        identity: { ...identity, userEnterpriseId: enterpriseId },
        error: "CodeBuddy bearer API key response did not include data.key",
      };
    }

    return { apiKey, identity: { ...identity, userEnterpriseId: enterpriseId } };
  } catch (error) {
    return {
      apiKey: null,
      identity: { ...identity, userEnterpriseId: enterpriseId },
      error: error.message || "CodeBuddy bearer API key creation failed",
    };
  }
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
    throw new Error(`CodeBuddy API key creation failed (${code}): ${summarizeCodeBuddyResponse(message)}`);
  }

  const apiKey = String(result.payload?.data?.key || "").trim();
  if (!apiKey) {
    throw new Error("CodeBuddy API key response did not include data.key");
  }
  return apiKey;
}

async function defaultCreateCodeBuddyApiKeyTokens({ page, tokens = {}, onStep, fetchImpl = proxyAwareFetch, proxyOptions = null }) {
  onStep?.("preparing_codebuddy_backend_session", "Preparing CodeBuddy backend session");
  const identity = await prepareCodeBuddyBackendSession(page);

  onStep?.("creating_codebuddy_api_key", "Creating CodeBuddy API key");
  let apiKey = null;
  let apiKeySource = "browser_backend";
  let resolvedIdentity = identity;

  try {
    apiKey = await createCodeBuddyApiKeyViaPage(page, identity.userEnterpriseId);
  } catch (browserError) {
    const accessToken = getCodeBuddyAccessToken(tokens);
    if (!accessToken) throw browserError;

    onStep?.(
      "creating_codebuddy_api_key_with_token",
      "Browser console session was unauthorized; retrying CodeBuddy API key creation with OAuth token"
    );
    const backendResult = await createCodeBuddyApiKeyViaBackend({
      accessToken,
      providerSpecificData: tokens.providerSpecificData || {},
      userEnterpriseId: identity.userEnterpriseId === CODEBUDDY_DEFAULT_USER_ENTERPRISE_ID ? null : identity.userEnterpriseId,
      fetchImpl,
      proxyOptions,
    });

    if (!backendResult?.apiKey) {
      throw new Error(backendResult?.error || browserError.message || "CodeBuddy API key creation failed");
    }

    apiKey = backendResult.apiKey;
    apiKeySource = "bearer_backend";
    resolvedIdentity = {
      userEnterpriseId: backendResult.identity?.userEnterpriseId || identity.userEnterpriseId,
      userId: backendResult.identity?.uid || identity.userId,
    };
  }

  return {
    ...tokens,
    apiKey,
    providerSpecificData: {
      ...(tokens.providerSpecificData || {}),
      authKind: "api_key",
      apiKeySource,
      apiKeyCreatedAt: new Date().toISOString(),
      userEnterpriseId: resolvedIdentity.userEnterpriseId,
      ...(resolvedIdentity.userId ? { codeBuddyUserId: resolvedIdentity.userId } : {}),
    },
  };
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

export class CodeBuddyBulkImportManager extends BaseBulkImportManager {
  constructor({
    browserLauncher,
    googleAutomation = runGoogleAccountAutomation,
    requestDeviceCodeFn = defaultRequestDeviceCode,
    pollToken = defaultPollForToken,
    saveConnection = defaultSaveCodeBuddyConnection,
    createApiKeyTokens = defaultCreateCodeBuddyApiKeyTokens,
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
    this.pollIntervalMs = pollIntervalMs;
  }

  startJob({ accounts, parsedAccounts, concurrency, browser } = {}) {
    let normalizedAccounts = parsedAccounts;

    if (!Array.isArray(normalizedAccounts)) {
      const { parsed, invalidLines } = parseCodeBuddyBulkAccounts(accounts);
      if (invalidLines.length > 0) {
        const error = "Invalid account format. Use one account per line: gmail@example.com|password";
        throw Object.assign(new Error(error), { error, invalidLines });
      }
      normalizedAccounts = parsed;
    }

    return super.startJob({
      parsedAccounts: normalizedAccounts,
      concurrency,
      browser,
    });
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

export const __test__ = {
  createCodeBuddyApiKeyViaBackend,
  defaultCreateCodeBuddyApiKeyTokens,
};
