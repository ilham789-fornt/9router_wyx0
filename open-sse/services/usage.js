/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { getGitHubUsage } from "./usage/github.js";
import { getGeminiUsage, getAntigravityUsage } from "./usage/google.js";
import { getClaudeUsage } from "./usage/claude.js";
import { getCodexUsage, consumeCodexRateLimitResetCredit } from "./usage/codex.js";
import { getCodeBuddyCnUsage } from "./usage/codebuddy-cn.js";
// CodeBuddy CN auth/metadata helpers live in ./codebuddyCn.js and are consumed
// directly by ./usage/codebuddy-cn.js. The legacy inline CN usage handler that
// used them from this file was replaced during the v0.5.8 sync.

export { consumeCodexRateLimitResetCredit };
import { getKiroUsage } from "./usage/kiro.js";
import { getMirasimUsage } from "./usage/mirasim.js";
import { getMiniMaxUsage } from "./usage/minimax.js";
import {
  getQwenUsage,
  getIflowUsage,
  getOllamaUsage,
  getGlmUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
} from "./usage/misc.js";

const CODEBUDDY_CONFIG = {
  usageUrl: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
  productCode: "p_tcaca",
  packageCodes: {
    free: "TCACA_code_001_PqouKr6QWV",
    proMon: "TCACA_code_002_AkiJS3ZHF5",
    gift: "TCACA_code_006_DbXS0lrypC",
    activity: "TCACA_code_007_nzdH5h4Nl0",
    proYear: "TCACA_code_003_FAnt7lcmRT",
    freeMon: "TCACA_code_008_cfWoLwvjU4",
    extra: "TCACA_code_009_0XmEQc2xOf",
  },
};

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
const USAGE_HANDLERS = {
  github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
  antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions),
  codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
  kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  qoder: (c) => getQoderUsage(c.accessToken, c.proxyOptions),
  qwen: (c) => getQwenUsage(c.accessToken, c.providerSpecificData),
  iflow: (c) => getIflowUsage(c.accessToken),
  ollama: (c) => getOllamaUsage(c.accessToken),
  glm: (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  "glm-cn": (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
  "codebuddy-cn": (c) => getCodeBuddyCnUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  mirasim: (c) => getMirasimUsage(
    { accessToken: c.accessToken, refreshToken: c.refreshToken, providerSpecificData: c.providerSpecificData },
    c.proxyOptions,
  ),
};

export async function getUsageForProvider(connection, proxyOptions = null) {
  const { provider, accessToken, apiKey, refreshToken, providerSpecificData, projectId } = connection;
  const providerDataWithProjectId = {
    ...(providerSpecificData || {}),
    ...(projectId ? { projectId } : {}),
  };

  const handler = provider === "codebuddy"
    ? (c) => getCodeBuddyUsage(c.accessToken || c.apiKey, c.providerSpecificData, c.proxyOptions)
    : USAGE_HANDLERS[provider];
  if (!handler) return { message: `Usage API not implemented for ${provider}` };
  return await handler({
    provider,
    accessToken,
    apiKey,
    refreshToken,
    providerSpecificData,
    providerDataWithProjectId,
    proxyOptions,
  });
}

// CodeBuddy CN usage is handled by ./usage/codebuddy-cn.js (Tencent billing
// endpoint with refill/bonus credit separation). The legacy inline handler
// was replaced during the v0.5.8 sync; the helpers below remain in use by
// the CodeBuddy (non-CN) path and the providerMetadata enrichment.

async function fetchCodeBuddyUid(accessToken, providerSpecificData = {}, proxyOptions = null) {
  const cachedUid = providerSpecificData?.uid || providerSpecificData?.rawAuth?.uid;
  if (cachedUid) return { uid: cachedUid, enterpriseId: providerSpecificData?.enterpriseId || null };

  const domain = providerSpecificData?.domain || providerSpecificData?.rawAuth?.domain || "www.codebuddy.ai";
  try {
    const response = await proxyAwareFetch(`https://${domain}/v2/plugin/accounts`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "X-Domain": domain,
      },
    }, proxyOptions);

    if (!response.ok) return { uid: null, enterpriseId: null };

    const body = await response.json();
    const accounts = body?.data?.accounts || [];
    const account = accounts.find((a) => a.lastLogin) || accounts[0] || {};
    return {
      uid: account.uid || null,
      enterpriseId: account.enterpriseId || null,
    };
  } catch {
    return { uid: null, enterpriseId: null };
  }
}

async function getCodeBuddyUsage(accessToken, providerSpecificData = {}, proxyOptions = null) {
  const webCookie = providerSpecificData?.webCookie;
  if (!webCookie && !accessToken) {
    return {
      plan: "CodeBuddy",
      message: "CodeBuddy quota credentials are not available. Attach a Quota Cookie from the provider page.",
      quotas: {},
    };
  }

  try {
    const useWebCookie = !accessToken && Boolean(webCookie);
    const { uid, enterpriseId } = useWebCookie
      ? { uid: null, enterpriseId: null }
      : await fetchCodeBuddyUid(accessToken, providerSpecificData, proxyOptions);

    const response = await proxyAwareFetch(CODEBUDDY_CONFIG.usageUrl, {
      method: "POST",
      headers: buildCodeBuddyUsageHeaders(
        accessToken,
        providerSpecificData,
        uid,
        enterpriseId,
        useWebCookie ? webCookie : null,
      ),
      body: JSON.stringify(buildCodeBuddyUsageBody()),
    }, proxyOptions);

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (response.status === 401 || response.status === 403) {
      return {
        plan: "CodeBuddy",
        message: useWebCookie
          ? `CodeBuddy quota cookie is expired or unauthorized (${response.status}). Attach a fresh Quota Cookie.`
          : `CodeBuddy quota API key is unauthorized (${response.status}).`,
        quotas: {},
      };
    }

    if (!response.ok) {
      return {
        plan: "CodeBuddy",
        message: `CodeBuddy quota endpoint returned ${response.status}.`,
        quotas: {},
      };
    }

    return parseCodeBuddyUsage(payload);
  } catch (error) {
    return { plan: "CodeBuddy", message: `CodeBuddy connected. Unable to fetch quota: ${error.message}`, quotas: {} };
  }
}

/**
 * Parse reset date/time to ISO string
 * Handles multiple formats: Unix timestamp (ms), ISO date string, etc.
 */
function parseResetTime(resetValue) {
  if (!resetValue) return null;

  try {
    // If it's already a Date object
    if (resetValue instanceof Date) {
      return resetValue.toISOString();
    }

    // Unix timestamps from provider APIs may be seconds or milliseconds.
    if (typeof resetValue === 'number') {
      return new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue).toISOString();
    }

    // If it's a numeric string, treat it like a Unix timestamp too.
    if (typeof resetValue === 'string') {
      if (/^\d+$/.test(resetValue)) {
        const timestamp = Number(resetValue);
        return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
      }
      return new Date(resetValue).toISOString();
    }

    return null;
  } catch (error) {
    console.warn(`Failed to parse reset time: ${resetValue}`, error);
    return null;
  }
}

function formatCodeBuddyDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildCodeBuddyUsageBody() {
  const now = new Date();
  const rangeEnd = new Date(now);
  rangeEnd.setFullYear(rangeEnd.getFullYear() + 101);

  return {
    PageNumber: 1,
    PageSize: 200,
    ProductCode: CODEBUDDY_CONFIG.productCode,
    Status: [0, 3],
    PackageCodes: Object.values(CODEBUDDY_CONFIG.packageCodes),
    PackageEndTimeRangeBegin: formatCodeBuddyDate(now),
    PackageEndTimeRangeEnd: formatCodeBuddyDate(rangeEnd),
  };
}

function buildCodeBuddyUsageHeaders(
  accessToken,
  providerSpecificData = {},
  uid = null,
  enterpriseId = null,
  webCookie = null,
) {
  const domain = providerSpecificData?.domain || providerSpecificData?.rawAuth?.domain || "www.codebuddy.ai";

  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": domain,
  };

  if (webCookie) {
    headers.Cookie = webCookie;
    headers.Origin = `https://${domain}`;
    headers.Referer = `https://${domain}/profile/usage`;
  } else if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (uid) {
    headers["X-User-Id"] = uid;
  }
  if (enterpriseId) {
    headers["X-Enterprise-Id"] = enterpriseId;
    headers["X-Tenant-Id"] = enterpriseId;
  }

  return headers;
}

function parseCodeBuddyUsage(payload) {
  const data = payload?.data?.Response?.Data || payload?.Response?.Data || payload?.data || payload || {};
  const accounts = Array.isArray(data?.Accounts)
    ? data.Accounts
    : Array.isArray(data?.accounts)
      ? data.accounts
      : [];

  if (accounts.length === 0) {
    return {
      plan: "CodeBuddy",
      message: "CodeBuddy connected. No quota records were returned.",
      quotas: {},
    };
  }

  const quotas = {};
  let hasProPackage = false;

  for (const account of accounts) {
    if (!account || typeof account !== "object") continue;
    const label = getCodeBuddyQuotaLabel(account.PackageCode);
    if (!label) continue;

    if (account.PackageCode === CODEBUDDY_CONFIG.packageCodes.proMon || account.PackageCode === CODEBUDDY_CONFIG.packageCodes.proYear) {
      hasProPackage = true;
    }

    const quota = getCodeBuddyQuotaValues(account);
    if (!quota) continue;

    if (!quotas[label]) {
      quotas[label] = {
        used: 0,
        total: 0,
        remaining: 0,
        resetAt: null,
        unit: "credits",
        unlimited: false,
      };
    }

    quotas[label].used += quota.used;
    quotas[label].total += quota.total;
    quotas[label].remaining += quota.remaining;
    quotas[label].resetAt = getEarlierReset(quotas[label].resetAt, quota.resetAt);
  }

  if (Object.keys(quotas).length === 0) {
    return {
      plan: hasProPackage ? "Pro" : "Free",
      message: "CodeBuddy connected. Unable to extract quota values.",
      quotas: {},
    };
  }

  for (const quota of Object.values(quotas)) {
    quota.remainingPercentage = quota.total > 0
      ? Math.max(0, Math.min(100, (quota.remaining / quota.total) * 100))
      : 0;
  }

  return {
    plan: hasProPackage ? "Pro" : "Free",
    quotas,
  };
}

function getCodeBuddyQuotaLabel(packageCode) {
  const codes = CODEBUDDY_CONFIG.packageCodes;
  switch (packageCode) {
    case codes.free:
    case codes.freeMon:
    case codes.proMon:
    case codes.proYear:
      return "Monthly Credits";
    case codes.gift:
      return "Gift Credits";
    case codes.extra:
      return "Extra Credits";
    case codes.activity:
      return "Activity Credits";
    default:
      return packageCode ? "Other Credits" : null;
  }
}

function getCodeBuddyQuotaValues(account) {
  const total = firstFiniteNumber(
    account.CycleCapacitySizePrecise,
    account.CycleCapacitySize,
    account.CapacitySizePrecise,
    account.CapacitySize,
  );
  const remaining = firstFiniteNumber(
    account.CycleCapacityRemainPrecise,
    account.CapacityRemainPrecise,
    account.CapacityRemain,
  );
  const used = firstFiniteNumber(
    account.CapacityUsedPrecise,
    account.CapacityUsed,
    total !== null && remaining !== null ? Math.max(0, total - remaining) : null,
  );

  if (total === null && remaining === null && used === null) return null;

  const safeTotal = Math.max(0, total ?? ((used ?? 0) + (remaining ?? 0)));
  const safeRemaining = Math.max(0, remaining ?? Math.max(0, safeTotal - (used ?? 0)));
  const safeUsed = Math.max(0, used ?? Math.max(0, safeTotal - safeRemaining));

  return {
    total: safeTotal,
    remaining: safeRemaining,
    used: safeUsed,
    resetAt: parseResetTime(account.CycleEndTime || account.DeductionEndTime || account.ExpiredTime),
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function getEarlierReset(current, next) {
  if (!current) return next || null;
  if (!next) return current;
  return new Date(next).getTime() < new Date(current).getTime() ? next : current;
}
