/**
 * OAuth Provider Configurations and Handlers
 * Centralized DRY approach for all OAuth providers
 */

// Ensure outbound fetch respects HTTP(S)_PROXY/ALL_PROXY in Node runtime
import "open-sse/index.js";
import crypto from "crypto";

import { generatePKCE, generateState } from "./utils/pkce";
import {
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CONFIG,
  QWEN_CONFIG,
  QODER_CONFIG,
  IFLOW_CONFIG,
  ANTIGRAVITY_CONFIG,
  GITHUB_CONFIG,
  KIRO_CONFIG,
  assertValidAwsRegion,
  CURSOR_CONFIG,
  KIMI_CODING_CONFIG,
  KILOCODE_CONFIG,
  CLINE_CONFIG,
  CLINEPASS_CONFIG,
  GROK_CLI_CONFIG,
  GITLAB_CONFIG,
  CODEBUDDY_CONFIG,
  CODEBUDDY_CN_CONFIG,
  TRAE_CONFIG,
  WINDSURF_CONFIG,
  ZED_HOSTED_CONFIG,
  getOAuthClientMetadata,
} from "./constants/oauth";
import { XAI_CONFIG, XAI_PKCE_VERIFIER_BYTES } from "./constants/xai";
import {
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  extractEmailFromAccessToken,
  extractCodexAccountInfo,
  fetchKiroProfileArn,
} from "./providerHelpers";
import {
  createZedNativeAuthData,
  decryptZedAccessToken,
  fetchZedAuthenticatedUser,
  parseZedCallbackPayload,
  resolveZedOrganizationId,
} from "open-sse/shared/zedAuth.js";

export { extractCodexAccountInfo, fetchKiroProfileArn };

// Inlined from services/xai.js to keep web route bundle free of `open` (CLI-only) package
let cachedXaiDiscovery = null;

async function discoverXaiEndpoints() {
  if (cachedXaiDiscovery) return cachedXaiDiscovery;
  try {
    const res = await fetch(XAI_CONFIG.discoveryUrl, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      cachedXaiDiscovery = {
        authorizeUrl: validateXaiOAuthEndpoint(data.authorization_endpoint, "authorization_endpoint"),
        tokenUrl: validateXaiOAuthEndpoint(data.token_endpoint, "token_endpoint"),
      };
      return cachedXaiDiscovery;
    }
  } catch { /* fall through to static fallback */ }
  cachedXaiDiscovery = { authorizeUrl: XAI_CONFIG.authorizeUrl, tokenUrl: XAI_CONFIG.tokenUrl };
  return cachedXaiDiscovery;
}

function extractJsonPath(data, paths) {
  for (const path of paths) {
    let value = data;
    for (const key of path) value = value?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function buildTraeDeviceContext() {
  return {
    plugin_version: TRAE_CONFIG.defaultPluginVersion,
    machine_id: crypto.randomUUID(),
    device_id: TRAE_CONFIG.defaultDeviceId,
    x_device_brand: "unknown",
    x_device_type: "unknown",
    x_os_version: "unknown",
    x_env: "",
    x_app_version: TRAE_CONFIG.defaultAppVersion,
    x_app_type: TRAE_CONFIG.defaultAppType,
  };
}

async function fetchTraeLoginGuidance(loginTraceId) {
  const body = JSON.stringify({ loginTraceID: loginTraceId, login_trace_id: loginTraceId });
  let lastError = "no successful response";
  for (const url of TRAE_CONFIG.loginGuidanceUrls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": TRAE_CONFIG.userAgent,
        },
        body,
      });
      if (!response.ok) {
        lastError = `${url} HTTP ${response.status}`;
        continue;
      }
      const data = await response.json();
      const loginHost = extractJsonPath(data, [
        ["Result", "LoginHost"], ["Result", "loginHost"], ["Result", "LoginURL"],
        ["result", "loginHost"], ["data", "Result", "LoginHost"], ["data", "loginHost"],
        ["LoginHost"], ["loginHost"],
      ]);
      if (loginHost) return loginHost;
      lastError = `${url} missing LoginHost`;
    } catch (error) {
      lastError = `${url} ${error.message}`;
    }
  }
  throw new Error(`Trae GetLoginGuidance failed: ${lastError}`);
}

function buildTraeVerificationUrl(loginHost, loginTraceId, callbackUrl, context) {
  const url = new URL(loginHost.startsWith("http") ? loginHost : `https://${loginHost.replace(/^\/+/, "")}`);
  url.pathname = TRAE_CONFIG.authorizationPath;
  url.search = new URLSearchParams({
    login_version: "1",
    auth_from: "trae",
    login_channel: "native_ide",
    plugin_version: context.plugin_version,
    auth_type: "local",
    client_id: TRAE_CONFIG.clientId,
    redirect: "0",
    login_trace_id: loginTraceId,
    auth_callback_url: callbackUrl,
    machine_id: context.machine_id,
    device_id: context.device_id,
    x_device_id: context.device_id,
    x_machine_id: context.machine_id,
    x_device_brand: context.x_device_brand,
    x_device_type: context.x_device_type,
    x_os_version: context.x_os_version,
    x_env: context.x_env,
    x_app_version: context.x_app_version,
    x_app_type: context.x_app_type,
  }).toString();
  return url.toString();
}

function parseTraeCallback(raw) {
  const text = String(raw || "").trim();
  let query = text;
  if (text.includes("?")) query = text.slice(text.indexOf("?") + 1);
  if (text.startsWith("#")) query = text.slice(1);
  const params = Object.fromEntries(new URLSearchParams(query));
  const pick = (keys) => {
    for (const key of keys) {
      const value = params[key];
      if (value && String(value).trim()) return String(value).trim();
    }
    return null;
  };
  const error = pick(["error", "error_code", "errorCode"]);
  if (error) {
    const description = pick(["error_description", "error_desc", "message"]);
    throw new Error(description ? `Trae auth failed: ${error} (${description})` : `Trae auth failed: ${error}`);
  }
  const refreshToken = pick(["refreshToken", "refresh_token", "RefreshToken"]);
  if (!refreshToken) throw new Error("Trae callback missing refreshToken");
  const cloudideToken = pick(["x-cloudide-token", "xCloudideToken", "accessToken", "access_token", "token"]);
  return { refreshToken, cloudideToken };
}

async function fetchTraeExchangeToken(refreshToken, cloudideToken) {
  const body = JSON.stringify({
    ClientID: TRAE_CONFIG.clientId,
    RefreshToken: refreshToken,
    ClientSecret: TRAE_CONFIG.clientSecret,
    UserID: "",
  });
  let lastError = "no successful response";
  for (const origin of TRAE_CONFIG.apiOrigins) {
    const url = `${origin.replace(/\/$/, "")}${TRAE_CONFIG.exchangeTokenPath}`;
    try {
      const headers = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": TRAE_CONFIG.userAgent,
      };
      if (cloudideToken) headers["x-cloudide-token"] = cloudideToken;
      const response = await fetch(url, { method: "POST", headers, body });
      const text = await response.text();
      if (!response.ok) {
        lastError = `${url} HTTP ${response.status}`;
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastError = `${url} invalid JSON`;
        continue;
      }
      const accessToken = extractJsonPath(data, [
        ["Result", "AccessToken"], ["Result", "accessToken"], ["result", "access_token"], ["accessToken"],
      ]);
      if (!accessToken) {
        lastError = `${url} missing AccessToken`;
        continue;
      }
      return {
        accessToken,
        refreshToken: extractJsonPath(data, [["Result", "RefreshToken"], ["result", "refresh_token"], ["refreshToken"]]) || refreshToken,
        expiresAt: extractJsonPath(data, [["Result", "ExpiresAt"], ["Result", "expiresAt"], ["result", "expires_at"], ["expiresAt"]]),
      };
    } catch (error) {
      lastError = `${url} ${error.message}`;
    }
  }
  throw new Error(`Trae ExchangeToken failed: ${lastError}`);
}

async function fetchTraeUserInfo(accessToken) {
  for (const origin of TRAE_CONFIG.apiOrigins) {
    try {
      const response = await fetch(`${origin.replace(/\/$/, "")}${TRAE_CONFIG.getUserInfoPath}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": TRAE_CONFIG.userAgent,
          "x-cloudide-token": accessToken,
        },
        body: "{}",
      });
      if (!response.ok) continue;
      const data = await response.json();
      return {
        email: extractJsonPath(data, [["Result", "NonPlainTextEmail"], ["Result", "Email"], ["Result", "email"], ["email"]]),
        name: extractJsonPath(data, [["Result", "ScreenName"], ["Result", "Nickname"], ["Result", "Name"], ["name"]]),
        aiRegion: extractJsonPath(data, [["Result", "AIRegion"], ["Result", "aiRegion"], ["aiRegion"]]),
        region: extractJsonPath(data, [["Result", "Region"], ["Result", "region"], ["region"]]),
        tenant: extractJsonPath(data, [["Result", "TenantID"], ["Result", "tenantId"], ["tenantId"]]),
        userId: extractJsonPath(data, [["Result", "UserID"], ["Result", "userId"], ["userId"]]),
      };
    } catch {
      // Try the next fixed origin.
    }
  }
  return { email: null, name: null };
}

function traeScopeForRegion(aiRegion) {
  const region = String(aiRegion || "").toLowerCase();
  if (region === "sg" || region.includes("singapore")) return "marscode-sg";
  if (region === "cn" || region.includes("china")) return "marscode-cn";
  return "marscode-us";
}

const traeProvider = {
  config: TRAE_CONFIG,
  flowType: "authorization_code",
  callbackPath: TRAE_CONFIG.callbackPath,
  prepareOnExchange: false,
  prepareConfig: async (config) => {
    const loginTraceID = crypto.randomUUID();
    const loginHost = await fetchTraeLoginGuidance(loginTraceID);
    return { ...config, loginTraceID, loginHost };
  },
  buildAuthUrl: (config, redirectUri, state) =>
    buildTraeVerificationUrl(config.loginHost, config.loginTraceID || state, redirectUri, buildTraeDeviceContext()),
  exchangeToken: async (config, code) => {
    const token = String(code || "").trim();
    const looksLikeCallback = /[?=&]/.test(token) && (token.includes("refreshToken") || token.includes("refresh_token"));
    if (!looksLikeCallback) {
      const accessToken = token.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, "");
      return { accessToken, refreshToken: null, expiresIn: TRAE_CONFIG.tokenLifetimeDays * 86400, _authMethod: "imported" };
    }
    const { refreshToken, cloudideToken } = parseTraeCallback(token);
    return { ...(await fetchTraeExchangeToken(refreshToken, cloudideToken)), _authMethod: "oauth" };
  },
  postExchange: async (tokens) => ({ userInfo: await fetchTraeUserInfo(tokens.accessToken) }),
  mapTokens: (tokens, extra) => {
    let expiresIn = tokens.expiresIn;
    if (!expiresIn && tokens.expiresAt) {
      const absoluteSeconds = typeof tokens.expiresAt === "number"
        ? tokens.expiresAt
        : Date.parse(tokens.expiresAt) / 1000;
      if (Number.isFinite(absoluteSeconds)) {
        expiresIn = Math.max(60, absoluteSeconds - Math.floor(Date.now() / 1000));
      }
    }
    if (!expiresIn) expiresIn = TRAE_CONFIG.tokenLifetimeDays * 86400;
    const user = extra?.userInfo || {};
    const aiRegion = user.aiRegion || "US-East";
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn,
      email: user.email || undefined,
      displayName: user.name || undefined,
      providerSpecificData: {
        authMethod: tokens._authMethod || "oauth",
        aiRegion,
        region: user.region || aiRegion,
        tenant: user.tenant || "marscode",
        userId: user.userId || "",
        scope: traeScopeForRegion(aiRegion),
        webId: "",
        bizUserId: "",
        userUniqueId: "",
        appLanguage: "en",
        appVersion: TRAE_CONFIG.defaultAppVersion,
        userRegion: aiRegion === "SG" ? "SG" : "US",
        userIdentity: "Free",
      },
    };
  },
};

async function windsurfSeatRequest(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": WINDSURF_CONFIG.userAgent,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Windsurf ${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Windsurf ${path} invalid JSON`);
  }
}

function parseWindsurfCallback(raw, expectedState) {
  const text = String(raw || "").trim();
  let query = text;
  if (text.includes("?")) query = text.slice(text.indexOf("?") + 1);
  if (text.startsWith("#")) query = text.slice(1);
  const params = Object.fromEntries(new URLSearchParams(query));
  const accessToken = params.access_token || params.token;
  if (!accessToken) throw new Error("Windsurf callback missing access_token");
  if (expectedState && params.state !== expectedState) throw new Error("Windsurf callback state mismatch");
  return { firebaseIdToken: String(accessToken).trim() };
}

async function fetchWindsurfRegisterUser(firebaseIdToken) {
  const data = await windsurfSeatRequest(WINDSURF_CONFIG.registerApiBaseUrl, WINDSURF_CONFIG.registerPath, {
    firebase_id_token: firebaseIdToken,
  });
  const apiKey = extractJsonPath(data, [["apiKey"], ["api_key"]]);
  if (!apiKey) throw new Error("Windsurf RegisterUser missing apiKey");
  const candidateApiServerUrl = extractJsonPath(data, [["apiServerUrl"], ["api_server_url"]])
    || WINDSURF_CONFIG.defaultApiServerUrl;
  let apiServerUrl;
  try {
    const parsed = new URL(candidateApiServerUrl);
    if (parsed.protocol !== "https:" || !WINDSURF_CONFIG.apiOrigins.includes(parsed.origin)) {
      throw new Error("origin is not allowlisted");
    }
    apiServerUrl = parsed.origin;
  } catch {
    throw new Error("Windsurf RegisterUser returned an untrusted apiServerUrl");
  }
  return {
    apiKey,
    apiServerUrl,
  };
}

async function fetchWindsurfUserInfo(apiServerUrl, firebaseIdToken) {
  try {
    const auth = await windsurfSeatRequest(apiServerUrl, WINDSURF_CONFIG.oneTimeAuthPath, { firebaseIdToken });
    const authToken = extractJsonPath(auth, [["authToken"], ["auth_token"]]);
    if (!authToken) return { email: null, name: null };
    const data = await windsurfSeatRequest(apiServerUrl, WINDSURF_CONFIG.currentUserPath, {
      authToken,
      includeSubscription: true,
    });
    const user = data.user || data;
    return { email: user.email || null, name: user.name || null };
  } catch {
    return { email: null, name: null };
  }
}

const windsurfProvider = {
  config: WINDSURF_CONFIG,
  flowType: "authorization_code",
  callbackPath: WINDSURF_CONFIG.callbackPath,
  buildAuthUrl: (config, redirectUri, state) => {
    const params = new URLSearchParams({
      response_type: "token",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state,
      prompt: "login",
      redirect_parameters_type: "query",
      workflow: "onboarding",
    });
    return `${config.authBaseUrl}${config.signInPath}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier, state) => {
    const token = String(code || "").trim();
    const looksLikeCallback = token.includes("?") || token.includes("access_token=");
    if (!looksLikeCallback) {
      const clean = token.replace(/^Bearer\s+/i, "");
      if (clean.startsWith("sk-ws-")) {
        return { accessToken: clean, refreshToken: null, expiresIn: null, apiServerUrl: config.defaultApiServerUrl, firebaseIdToken: null, _authMethod: "imported" };
      }
      const registration = await fetchWindsurfRegisterUser(clean);
      return { accessToken: registration.apiKey, refreshToken: null, expiresIn: null, apiServerUrl: registration.apiServerUrl, firebaseIdToken: clean, _authMethod: "imported" };
    }
    const { firebaseIdToken } = parseWindsurfCallback(token, state);
    const registration = await fetchWindsurfRegisterUser(firebaseIdToken);
    return { accessToken: registration.apiKey, refreshToken: null, expiresIn: null, apiServerUrl: registration.apiServerUrl, firebaseIdToken, _authMethod: "oauth" };
  },
  postExchange: async (tokens) => ({
    userInfo: tokens.firebaseIdToken
      ? await fetchWindsurfUserInfo(tokens.apiServerUrl, tokens.firebaseIdToken)
      : { email: null, name: null },
  }),
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.accessToken,
    refreshToken: null,
    expiresIn: null,
    email: extra?.userInfo?.email || undefined,
    displayName: extra?.userInfo?.name || undefined,
    providerSpecificData: {
      authMethod: tokens._authMethod || "oauth",
      apiServerUrl: tokens.apiServerUrl,
      firebaseIdToken: tokens.firebaseIdToken,
    },
  }),
};

const zedProvider = {
  config: ZED_HOSTED_CONFIG,
  flowType: "authorization_code",
  callbackPath: "/",
  prepareOnExchange: false,
  prepareConfig: async (config, meta) => {
    const nativeAppPort = Number(meta?.nativeAppPort) || config.defaultNativeAppPort;
    return { ...config, ...createZedNativeAuthData(config, { nativeAppPort }) };
  },
  buildAuthUrl: (config) => config.authUrl,
  exchangeToken: async (config, code, redirectUri, codeVerifier, state) => {
    const { userId, encryptedAccessToken } = parseZedCallbackPayload(code);
    const accessToken = decryptZedAccessToken(encryptedAccessToken, codeVerifier);
    return { accessToken, userId, systemId: state };
  },
  postExchange: async (tokens) => {
    const credentials = {
      accessToken: tokens.accessToken,
      providerSpecificData: { userId: tokens.userId, systemId: tokens.systemId },
    };
    let userInfo = null;
    try {
      userInfo = await fetchZedAuthenticatedUser(credentials, { config: ZED_HOSTED_CONFIG });
    } catch {
      // Identity enrichment is best-effort; the decrypted credential remains usable.
    }
    return {
      organizationId: resolveZedOrganizationId(credentials, userInfo),
      email: userInfo?.email || null,
      name: userInfo?.name || userInfo?.display_name || null,
    };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.accessToken,
    refreshToken: null,
    expiresIn: null,
    email: extra?.email || undefined,
    displayName: extra?.name || undefined,
    providerSpecificData: {
      authMethod: "oauth",
      userId: tokens.userId,
      systemId: tokens.systemId,
      organizationId: extra?.organizationId || "",
    },
  }),
};


function createCodeBuddyDeviceProvider(config) {
  return {
    config,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await fetch(`${config.stateUrl}?platform=${config.platform}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": config.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": config.domain,
          "X-No-Authorization": "true",
          "X-No-User-Id": "true",
          "X-No-Enterprise-Id": "true",
          "X-No-Department-Info": "true",
          "X-Product": "SaaS",
        },
        body: "{}",
      });
      if (!response.ok) throw new Error(`CodeBuddy state request failed: ${await response.text()}`);
      const data = await response.json();
      if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
        throw new Error(`CodeBuddy state error: ${data.msg || "missing state/authUrl"}`);
      }
      return {
        device_code: data.data.state,
        verification_uri: data.data.authUrl,
        user_code: "",
        interval: config.pollInterval / 1000,
        _isCodeBuddy: true,
      };
    },
    pollToken: async (config, deviceCode) => {
      const tokenUrl = new URL(config.tokenUrl);
      tokenUrl.searchParams.set("state", deviceCode);
      const response = await fetch(tokenUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": config.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": config.domain,
          "X-No-Authorization": "true",
          "X-No-User-Id": "true",
          "X-No-Enterprise-Id": "true",
          "X-No-Department-Info": "true",
          "X-Product": "SaaS",
        },
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          ok: false,
          data: {
            error: "request_failed",
            error_description: errorText || `${response.status} ${response.statusText}`,
          },
        };
      }
      const data = await response.json();
      if (data.code === 0 && data.data?.accessToken) {
        return {
          ok: true,
          data: {
            access_token: data.data.accessToken,
            refresh_token: data.data.refreshToken || "",
            token_type: data.data.tokenType || "Bearer",
            expires_in: data.data.expiresIn,
            expires_at: data.data.expiresAt,
            refresh_expires_in: data.data.refreshExpiresIn,
            refresh_expires_at: data.data.refreshExpiresAt,
            domain: data.data.domain || config.domain,
            raw: data.data,
          },
        };
      }
      if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
      return { ok: false, data: { error: data.msg || "unknown_error" } };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || (
        tokens.expires_at
          ? Math.max(1, Math.floor((new Date(tokens.expires_at).getTime() - Date.now()) / 1000))
          : 86400
      ),
      providerSpecificData: {
        domain: tokens.domain || config.domain,
        refreshExpiresIn: tokens.refresh_expires_in,
        refreshExpiresAt: tokens.refresh_expires_at,
        tokenType: tokens.token_type || "Bearer",
        rawAuth: tokens.raw,
      },
    }),
  };
}
// Provider configurations
const PROVIDERS = {
  claude: {
    config: CLAUDE_CONFIG,
    flowType: "authorization_code_pkce",
    buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
      const params = new URLSearchParams({
        code: "true",
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
        state: state,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier, state) => {
      // Parse code - may contain state after #
      let authCode = code;
      let codeState = "";
      if (authCode.includes("#")) {
        const parts = authCode.split("#");
        authCode = parts[0];
        codeState = parts[1] || "";
      }

      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          code: authCode,
          state: codeState || state,
          grant_type: "authorization_code",
          client_id: config.clientId,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    }),
  },

  codex: {
    config: CODEX_CONFIG,
    flowType: "authorization_code_pkce",
    fixedPort: CODEX_CONFIG.fixedPort,
    callbackPath: CODEX_CONFIG.callbackPath,
    buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
      const params = {
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scope,
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
        ...config.extraParams,
        state: state,
      };
      const queryString = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");
      return `${config.authorizeUrl}?${queryString}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          code: code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    mapTokens: (tokens) => {
      const info = extractCodexAccountInfo(tokens.id_token);
      const mapped = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
        lastRefreshAt: new Date().toISOString(),
      };
      const email = info.email || extractEmailFromAccessToken(tokens.access_token);
      if (email) mapped.email = email;
      if (info.chatgptAccountId || info.chatgptPlanType) {
        mapped.providerSpecificData = {
          chatgptAccountId: info.chatgptAccountId,
          chatgptPlanType: info.chatgptPlanType,
        };
      }
      return mapped;
    },
  },

  xai: {
    config: XAI_CONFIG,
    flowType: "authorization_code_pkce",
    fixedPort: XAI_CONFIG.loopbackPort,
    callbackPath: XAI_CONFIG.callbackPath,
    pkceVerifierBytes: XAI_PKCE_VERIFIER_BYTES,
    prepareConfig: async (config) => {
      const endpoints = await discoverXaiEndpoints();
      return {
        ...config,
        authorizeUrl: endpoints.authorizeUrl,
        tokenUrl: endpoints.tokenUrl,
      };
    },
    buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
      // Mirror CLIProxyAPI BuildAuthorizeURL: includes nonce, plan, referrer
      const nonce = crypto.randomBytes(16).toString("hex");
      const params = {
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scope,
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
        state,
        nonce,
        plan: "generic",
        referrer: "cli-proxy-api",
      };
      const qs = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
      return `${config.authorizeUrl}?${qs}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`xAI token exchange failed: ${error}`);
      }
      return await response.json();
    },
    mapTokens: (tokens) => {
      const mapped = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
      };
      const email = decodeXaiIdTokenEmail(tokens.id_token);
      if (email) mapped.email = email;
      if (tokens.id_token) {
        mapped.providerSpecificData = { idToken: tokens.id_token };
      }
      return mapped;
    },
  },

  "gemini-cli": {
    config: GEMINI_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri, state) => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        state: state,
        access_type: "offline",
        prompt: "consent",
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: code,
          redirect_uri: redirectUri,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    postExchange: async (tokens) => {
      // Fetch user info
      const userInfoRes = await fetch(`${GEMINI_CONFIG.userInfoUrl}?alt=json`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

      // Fetch project ID
      let projectId = "";
      try {
        const projectRes = await fetch(
          "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              metadata: getOAuthClientMetadata(),
              mode: 1,
            }),
          }
        );
        if (projectRes.ok) {
          const data = await projectRes.json();
          projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
        }
      } catch (e) {
        console.log("Failed to fetch project ID:", e);
      }

      return { userInfo, projectId };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      email: extra?.userInfo?.email,
      projectId: extra?.projectId,
    }),
  },

  antigravity: {
    config: ANTIGRAVITY_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri, state) => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        state: state,
        access_type: "offline",
        prompt: "consent",
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: code,
          redirect_uri: redirectUri,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    postExchange: async (tokens) => {
      // Numeric enums matching Antigravity binary ClientMetadata
      const loadHeaders = {
        "Authorization": `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_CONFIG.loadCodeAssistUserAgent,
        "X-Goog-Api-Client": ANTIGRAVITY_CONFIG.loadCodeAssistApiClient,
        "Client-Metadata": ANTIGRAVITY_CONFIG.loadCodeAssistClientMetadata,
        "x-request-source": "local",
      };
      const metadata = getOAuthClientMetadata();

      // Fetch user info
      const userInfoRes = await fetch(`${ANTIGRAVITY_CONFIG.userInfoUrl}?alt=json`, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "x-request-source": "local",
        },
      });
      const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

      // Load Code Assist to get project ID and tier
      let projectId = "";
      let tierId = "legacy-tier";
      try {
        const loadRes = await fetch(ANTIGRAVITY_CONFIG.loadCodeAssistEndpoint, {
          method: "POST",
          headers: loadHeaders,
          body: JSON.stringify({ metadata }),
        });
        if (loadRes.ok) {
          const data = await loadRes.json();
          projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
          if (Array.isArray(data.allowedTiers)) {
            for (const tier of data.allowedTiers) {
              if (tier.isDefault && tier.id) {
                tierId = tier.id.trim();
                break;
              }
            }
          }
        }
      } catch (e) {
        console.log("Failed to load code assist:", e);
      }

      // Fire-and-forget onboarding — does not block DB save
      if (projectId) {
        const doOnboard = async () => {
          for (let i = 0; i < 10; i++) {
            try {
              const onboardRes = await fetch(ANTIGRAVITY_CONFIG.onboardUserEndpoint, {
                method: "POST",
                headers: loadHeaders,
                body: JSON.stringify({ tierId, metadata }),
              });
              if (onboardRes.ok) {
                const result = await onboardRes.json();
                if (result.done === true) break;
              }
            } catch (e) {
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        };
        doOnboard().catch(() => {});
      }

      return { userInfo, projectId };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      email: extra?.userInfo?.email,
      projectId: extra?.projectId,
    }),
  },

  iflow: {
    config: IFLOW_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri, state) => {
      const params = new URLSearchParams({
        loginMethod: config.extraParams.loginMethod,
        type: config.extraParams.type,
        redirect: redirectUri,
        state: state,
        client_id: config.clientId,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      // Create Basic Auth header
      const basicAuth = Buffer.from(
        `${config.clientId}:${config.clientSecret}`
      ).toString("base64");

      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    postExchange: async (tokens) => {
      // Fetch user info (MUST succeed to get API key)
      const userInfoRes = await fetch(
        `${IFLOW_CONFIG.userInfoUrl}?accessToken=${encodeURIComponent(tokens.access_token)}`,
        {
          headers: {
            Accept: "application/json",
          },
        }
      );
      
      if (!userInfoRes.ok) {
        const errorText = await userInfoRes.text();
        throw new Error(`Failed to fetch user info: ${errorText}`);
      }
      
      const result = await userInfoRes.json();
      if (!result.success) {
        throw new Error(`User info request failed: ${result.message || 'Unknown error'}`);
      }
      
      const userInfo = result.data || {};
      
      // Validate API key (critical for iFlow)
      if (!userInfo.apiKey || userInfo.apiKey.trim() === "") {
        throw new Error("Empty API key returned from iFlow");
      }
      
      // Validate email/phone
      const email = userInfo.email?.trim() || userInfo.phone?.trim();
      if (!email) {
        throw new Error("Missing account email/phone in user info");
      }
      
      return { userInfo };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      apiKey: extra?.userInfo?.apiKey,
      email: extra?.userInfo?.email || extra?.userInfo?.phone,
      displayName: extra?.userInfo?.nickname || extra?.userInfo?.name,
    }),
  },

  qoder: {
    config: QODER_CONFIG,
    flowType: "device_code",
    // Qoder uses a custom device flow: PKCE + nonce + machine_id are generated
    // locally, the user lands on qoder.com/device/selectAccounts in the
    // browser, and we poll openapi.qoder.sh until a `dt-...` token appears.
    requestDeviceCode: async (config) => {
      const { QoderService } = await import("@/lib/oauth/services/qoder");
      const flow = new QoderService().initiateDeviceFlow();
      // Match the device_code shape the rest of the OAuthModal expects
      // (device_code, user_code, verification_uri[_complete], interval).
      // The poll endpoint identifies us by nonce+verifier, not by a
      // server-issued device_code, so we plumb our own values through:
      //   device_code   = nonce  (modal forwards as deviceCode on poll)
      //   codeVerifier  = our PKCE verifier (route forwards as codeVerifier)
      return {
        device_code: flow.nonce,
        user_code: flow.nonce.slice(0, 8).toUpperCase(),
        verification_uri: config.loginUrl,
        verification_uri_complete: flow.verificationUriComplete,
        expires_in: 300,
        interval: 2,
        codeVerifier: flow.codeVerifier,
        _qoderNonce: flow.nonce,
        _qoderMachineId: flow.machineId,
      };
    },
    pollToken: async (config, deviceCode, codeVerifier, extraData) => {
      const { QoderService } = await import("@/lib/oauth/services/qoder");
      const svc = new QoderService();
      const nonce = deviceCode || extraData?._qoderNonce;
      const verifier = codeVerifier || extraData?._qoderVerifier;
      if (!nonce || !verifier) {
        return {
          ok: false,
          data: { error: "invalid_request", error_description: "Missing nonce/verifier" },
        };
      }
      let result;
      try {
        result = await svc.pollDeviceToken({ nonce, codeVerifier: verifier });
      } catch (err) {
        return {
          ok: false,
          data: { error: "poll_failed", error_description: err.message },
        };
      }
      if (result.status === "pending") {
        return { ok: false, data: { error: "authorization_pending" } };
      }
      // Best-effort profile lookup so we have a name/email to display.
      const userInfo = await svc.fetchUserInfo(result.accessToken);
      // expireTime is a Unix-ms timestamp from QoderService.parseExpiry,
      // which already falls back to "now + 30 days" when the upstream
      // omits expiry. Floor to a sane minimum (1 day) so a stale or
      // skewed upstream timestamp doesn't truncate the stored token below
      // something useful.
      const minSeconds = 24 * 60 * 60;
      const remainingSeconds = Math.floor((result.expireTime - Date.now()) / 1000);
      const expiresIn = Math.max(minSeconds, remainingSeconds);
      return {
        ok: true,
        data: {
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          expires_in: expiresIn,
          _qoderUserId: result.userId,
          _qoderMachineId: extraData?._qoderMachineId || "",
          _qoderName: userInfo.name,
          _qoderEmail: userInfo.email,
          _qoderOrganizationId: userInfo.organizationId,
        },
      };
    },
    mapTokens: (tokens) => {
      const rawEmail = (tokens._qoderEmail || "").trim();
      const displayName = (tokens._qoderName || "").trim() || null;
      const userId = tokens._qoderUserId || "";
      // Dedup in createProviderConnection requires a non-empty email. When
      // fetchUserInfo silently fails (returns ""), fall back to a stable
      // synthetic identifier derived from userId so re-logins update the
      // existing row instead of accumulating "Account N" duplicates.
      const email = rawEmail || (userId ? `qoder-user-${userId}` : null);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresIn: tokens.expires_in,
        email,
        displayName,
        providerSpecificData: {
          authMethod: "device",
          userId,
          machineId: tokens._qoderMachineId || "",
          organizationId: tokens._qoderOrganizationId || "",
        },
      };
    },
  },

  qwen: {
    config: QWEN_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config, codeChallenge) => {
      const response = await fetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          scope: config.scope,
          code_challenge: codeChallenge,
          code_challenge_method: config.codeChallengeMethod,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Device code request failed: ${error}`);
      }

      return await response.json();
    },
    pollToken: async (config, deviceCode, codeVerifier) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: deviceCode,
          code_verifier: codeVerifier,
        }),
      });

      return {
        ok: response.ok,
        data: await response.json(),
      };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      providerSpecificData: { resourceUrl: tokens.resource_url },
    }),
  },

  github: {
    config: GITHUB_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await fetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          scope: config.scopes,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Device code request failed: ${error}`);
      }

      return await response.json();
    },
    pollToken: async (config, deviceCode) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      // Handle response properly - if not ok, try to get error as text first
      let data;
      try {
        data = await response.json();
      } catch (e) {
        // If response is not JSON, get as text
        const text = await response.text();
        data = { error: "invalid_response", error_description: text };
      }

      return {
        ok: response.ok,
        data: data,
      };
    },
    postExchange: async (tokens) => {
      // Get Copilot token using GitHub access token
      const copilotRes = await fetch(GITHUB_CONFIG.copilotTokenUrl, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
          "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
          "User-Agent": GITHUB_CONFIG.userAgent,
        },
      });
      const copilotToken = copilotRes.ok ? await copilotRes.json() : {};

      // Get user info from GitHub
      const userRes = await fetch(GITHUB_CONFIG.userInfoUrl, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
          "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
          "User-Agent": GITHUB_CONFIG.userAgent,
        },
      });
      const userInfo = userRes.ok ? await userRes.json() : {};

      return { copilotToken, userInfo };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      providerSpecificData: {
        copilotToken: extra?.copilotToken?.token,
        copilotTokenExpiresAt: extra?.copilotToken?.expires_at,
        githubUserId: extra?.userInfo?.id,
        githubLogin: extra?.userInfo?.login,
        githubName: extra?.userInfo?.name,
        githubEmail: extra?.userInfo?.email,
      },
    }),
  },

  kiro: {
    config: KIRO_CONFIG,
    flowType: "device_code",
    // Kiro uses AWS SSO OIDC - requires client registration first
    requestDeviceCode: async (config, codeChallenge, options = {}) => {
      const trimmedRegion = typeof options.region === "string" ? options.region.trim() : "";
      const region = trimmedRegion || "us-east-1";
      assertValidAwsRegion(region);
      const trimmedStartUrl = typeof options.startUrl === "string" ? options.startUrl.trim() : "";
      const startUrl = trimmedStartUrl || config.startUrl;
      const authMethod = options.authMethod === "idc" ? "idc" : "builder-id";
      const registerClientUrl = `https://oidc.${region}.amazonaws.com/client/register`;
      const deviceAuthUrl = `https://oidc.${region}.amazonaws.com/device_authorization`;

      // Step 1: Register client with AWS SSO OIDC
      const registerRes = await fetch(registerClientUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          clientName: config.clientName,
          clientType: config.clientType,
          scopes: config.scopes,
          grantTypes: config.grantTypes,
          issuerUrl: config.issuerUrl,
        }),
      });

      if (!registerRes.ok) {
        const error = await registerRes.text();
        throw new Error(`Client registration failed: ${error}`);
      }

      const clientInfo = await registerRes.json();

      // Step 2: Request device authorization
      const deviceRes = await fetch(deviceAuthUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          clientId: clientInfo.clientId,
          clientSecret: clientInfo.clientSecret,
          startUrl,
        }),
      });

      if (!deviceRes.ok) {
        const error = await deviceRes.text();
        throw new Error(`Device authorization failed: ${error}`);
      }

      const deviceData = await deviceRes.json();

      // Return combined data for polling
      return {
        device_code: deviceData.deviceCode,
        user_code: deviceData.userCode,
        verification_uri: deviceData.verificationUri,
        verification_uri_complete: deviceData.verificationUriComplete,
        expires_in: deviceData.expiresIn,
        interval: deviceData.interval || 5,
        // Store client credentials for token exchange
        _clientId: clientInfo.clientId,
        _clientSecret: clientInfo.clientSecret,
        _region: region,
        _authMethod: authMethod,
        _startUrl: startUrl,
      };
    },
    pollToken: async (config, deviceCode, codeVerifier, extraData) => {
      const region = extraData?._region || "us-east-1";
      assertValidAwsRegion(region);
      const tokenUrl = `https://oidc.${region}.amazonaws.com/token`;
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          clientId: extraData?._clientId,
          clientSecret: extraData?._clientSecret,
          deviceCode: deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      let data;
      try {
        data = await response.json();
      } catch (e) {
        const text = await response.text();
        data = { error: "invalid_response", error_description: text };
      }

      // AWS SSO OIDC returns camelCase
      if (data.accessToken) {
        return {
          ok: true,
          data: {
            access_token: data.accessToken,
            refresh_token: data.refreshToken,
            expires_in: data.expiresIn,
            profile_arn: data?.profileArn || null,
            // Store client credentials for refresh
            _clientId: extraData?._clientId,
            _clientSecret: extraData?._clientSecret,
            _region: extraData?._region,
            _authMethod: extraData?._authMethod,
            _startUrl: extraData?._startUrl,
          },
        };
      }

      return {
        ok: false,
        data: {
          error: data.error || "authorization_pending",
          error_description: data.error_description || data.message,
        },
      };
    },
    mapTokens: (tokens) => {
      const email = extractEmailFromAccessToken(tokens.access_token);
      const mapped = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        email,
        providerSpecificData: {
          profileArn: tokens?.profile_arn || null,
          clientId: tokens._clientId,
          clientSecret: tokens._clientSecret,
          region: tokens._region || "us-east-1",
          authMethod: tokens._authMethod || "builder-id",
          startUrl: tokens._startUrl || KIRO_CONFIG.startUrl,
        },
      };
      return mapped;
    },
  },

  cursor: {
    config: CURSOR_CONFIG,
    flowType: "import_token",
    // Cursor uses import token flow - tokens are extracted from local SQLite database
    // No OAuth flow needed, handled by /api/oauth/cursor/import route
    mapTokens: (tokens) => ({
      accessToken: tokens.accessToken,
      refreshToken: null, // Cursor doesn't have public refresh endpoint
      expiresIn: tokens.expiresIn || 86400,
      providerSpecificData: {
        machineId: tokens.machineId,
        authMethod: "imported",
      },
    }),
  },

  "kimi-coding": {
    config: KIMI_CODING_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await fetch(config.deviceCodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: config.clientId }),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Device code request failed: ${error}`);
      }
      const data = await response.json();
      return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri || "https://www.kimi.com/code/authorize_device",
        verification_uri_complete:
          data.verification_uri_complete ||
          `https://www.kimi.com/code/authorize_device?user_code=${data.user_code}`,
        expires_in: data.expires_in,
        interval: data.interval || 5,
      };
    },
    pollToken: async (config, deviceCode) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: deviceCode,
        }),
      });
      let data;
      try {
        data = await response.json();
      } catch (e) {
        const text = await response.text();
        data = { error: "invalid_response", error_description: text };
      }
      return { ok: response.ok, data };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    }),
  },

  kilocode: {
    config: KILOCODE_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await fetch(config.initiateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Too many pending authorization requests. Please try again later.");
        }
        const error = await response.text();
        throw new Error(`Device auth initiation failed: ${error}`);
      }
      const data = await response.json();
      return {
        device_code: data.code,
        user_code: data.code,
        verification_uri: data.verificationUrl,
        verification_uri_complete: data.verificationUrl,
        expires_in: data.expiresIn || 300,
        interval: 3,
      };
    },
    pollToken: async (config, deviceCode) => {
      const response = await fetch(`${config.pollUrlBase}/${deviceCode}`);
      if (response.status === 202) return { ok: false, data: { error: "authorization_pending" } };
      if (response.status === 403) return { ok: false, data: { error: "access_denied", error_description: "Authorization denied by user" } };
      if (response.status === 410) return { ok: false, data: { error: "expired_token", error_description: "Authorization code expired" } };
      if (!response.ok) return { ok: false, data: { error: "poll_failed", error_description: `Poll failed: ${response.status}` } };
      const data = await response.json();
      if (data.status === "approved" && data.token) {
        // Fetch profile to get orgId for X-Kilocode-OrganizationID header
        let orgId = null;
        try {
          const profileRes = await fetch(`${config.apiBaseUrl}/api/profile`, {
            headers: { "Authorization": `Bearer ${data.token}` }
          });
          if (profileRes.ok) {
            const profile = await profileRes.json();
            orgId = profile.organizations?.[0]?.id || null;
          }
        } catch {}
        return { ok: true, data: { access_token: data.token, _userEmail: data.userEmail, _orgId: orgId } };
      }
      return { ok: false, data: { error: "authorization_pending" } };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: null,
      expiresIn: null,
      email: tokens._userEmail,
      ...(tokens._orgId ? { providerSpecificData: { orgId: tokens._orgId } } : {}),
    }),
  },

  "grok-cli": {
    config: GROK_CLI_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const body = new URLSearchParams({
        client_id: config.clientId,
        scope: config.scope,
      });
      // Official CLI sends referrer=grok-build
      if (config.referrer) body.set("referrer", config.referrer);

      const response = await fetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)",
        },
        body,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Grok CLI device code request failed: ${error}`);
      }

      return await response.json();
    },
    pollToken: async (config, deviceCode) => {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: config.clientId,
        }),
      });

      let data;
      try {
        data = await response.json();
      } catch {
        const text = await response.text();
        data = { error: "invalid_response", error_description: text };
      }

      // Device flow: 400 + authorization_pending is expected while user authorizes
      const pending =
        data?.error === "authorization_pending" ||
        data?.error === "slow_down";
      return {
        ok: response.ok || pending,
        data,
      };
    },
    postExchange: async (tokens) => {
      // Best-effort user profile from cli-chat-proxy (non-fatal)
      try {
        const res = await fetch("https://cli-chat-proxy.grok.com/v1/user", {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Accept: "application/json",
            "User-Agent": "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)",
            "x-xai-token-auth": "xai-grok-cli",
            "x-grok-client-version": "0.2.93",
          },
        });
        if (res.ok) return { user: await res.json() };
      } catch {
        /* ignore */
      }
      return { user: null };
    },
    mapTokens: (tokens, extra) => {
      const email =
        decodeXaiIdTokenEmail(tokens.id_token) ||
        extractEmailFromAccessToken(tokens.access_token) ||
        extra?.user?.email ||
        null;
      const userId =
        extra?.user?.userId ||
        extra?.user?.principalId ||
        null;
      const displayName = [extra?.user?.firstName, extra?.user?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() || null;

      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null;

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresIn: tokens.expires_in,
        // Surface an absolute expiry so the proactive refresh path
        // (shouldRefreshCredentials / checkAndRefreshToken) can refresh the
        // xAI token before it silently expires ~40-45 min after login.
        // Without this, only the reactive 401 path in chatCore would refresh,
        // causing intermittent "token expired" failures for Grok CLI.
        expiresAt,
        scope: tokens.scope,
        // Top-level for dashboard connection cards
        email: email || undefined,
        displayName: displayName || undefined,
        // Mirror identity into providerSpecificData so GrokCliExecutor can set
        // x-email / x-userid without depending on top-level credential shape.
        providerSpecificData: {
          authMethod: "device_code",
          idToken: tokens.id_token || null,
          email: email || null,
          userId,
          hasGrokCodeAccess: extra?.user?.hasGrokCodeAccess ?? null,
          subscriptionTier: extra?.user?.subscriptionTier ?? null,
        },
      };
    },
    },

  clinepass: {
    config: CLINEPASS_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri) => {
      const params = new URLSearchParams({
        client_type: "extension",
        callback_url: redirectUri,
        redirect_uri: redirectUri,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      try {
        // Cline encodes token data as base64 in the code param
        let base64 = code;
        const padding = 4 - (base64.length % 4);
        if (padding !== 4) base64 += "=".repeat(padding);
        const decoded = Buffer.from(base64, "base64").toString("utf-8");
        const lastBrace = decoded.lastIndexOf("}");
        if (lastBrace === -1) throw new Error("No JSON found in decoded code");
        const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1));
        return {
          access_token: tokenData.accessToken,
          refresh_token: tokenData.refreshToken,
          email: tokenData.email,
          firstName: tokenData.firstName,
          lastName: tokenData.lastName,
          expires_at: tokenData.expiresAt,
        };
      } catch {
        const response = await fetch(config.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ grant_type: "authorization_code", code, client_type: "extension", redirect_uri: redirectUri }),
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`ClinePass token exchange failed: ${error}`);
        }
        const data = await response.json();
        return {
          access_token: data.data?.accessToken || data.accessToken,
          refresh_token: data.data?.refreshToken || data.refreshToken,
          email: data.data?.userInfo?.email || "",
          expires_at: data.data?.expiresAt || data.expiresAt,
        };
      }
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_at
        ? Math.floor((new Date(tokens.expires_at).getTime() - Date.now()) / 1000)
        : 3600,
      email: tokens.email,
      providerSpecificData: { firstName: tokens.firstName, lastName: tokens.lastName },
    }),
  },

  cline: {
    config: CLINE_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri) => {
      const params = new URLSearchParams({
        client_type: "extension",
        callback_url: redirectUri,
        redirect_uri: redirectUri,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      try {
        // Cline encodes token data as base64 in the code param
        let base64 = code;
        const padding = 4 - (base64.length % 4);
        if (padding !== 4) base64 += "=".repeat(padding);
        const decoded = Buffer.from(base64, "base64").toString("utf-8");
        const lastBrace = decoded.lastIndexOf("}");
        if (lastBrace === -1) throw new Error("No JSON found in decoded code");
        const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1));
        return {
          access_token: tokenData.accessToken,
          refresh_token: tokenData.refreshToken,
          email: tokenData.email,
          firstName: tokenData.firstName,
          lastName: tokenData.lastName,
          expires_at: tokenData.expiresAt,
        };
      } catch (e) {
        const response = await fetch(config.tokenExchangeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ grant_type: "authorization_code", code, client_type: "extension", redirect_uri: redirectUri }),
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Cline token exchange failed: ${error}`);
        }
        const data = await response.json();
        return {
          access_token: data.data?.accessToken || data.accessToken,
          refresh_token: data.data?.refreshToken || data.refreshToken,
          email: data.data?.userInfo?.email || "",
          expires_at: data.data?.expiresAt || data.expiresAt,
        };
      }
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_at
        ? Math.floor((new Date(tokens.expires_at).getTime() - Date.now()) / 1000)
        : 3600,
      email: tokens.email,
      providerSpecificData: { firstName: tokens.firstName, lastName: tokens.lastName },
    }),
  },
  // GitLab Duo - Authorization Code Flow with PKCE
  // Supports two login modes via loginMode metadata: "oauth" (default) or "pat"
  gitlab: {
    config: GITLAB_CONFIG,
    flowType: "authorization_code_pkce",
    buildAuthUrl: (config, redirectUri, state, codeChallenge, meta = {}) => {
      const baseUrl = meta.baseUrl || config.defaultBaseUrl;
      const clientId = meta.clientId || "";
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        scope: config.scope,
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
      });
      return `${baseUrl}${config.authorizeUrlPath}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta = {}) => {
      const baseUrl = meta.baseUrl || config.defaultBaseUrl;
      const clientId = meta.clientId || "";
      const clientSecret = meta.clientSecret || "";
      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      if (clientSecret) body.set("client_secret", clientSecret);
      const response = await fetch(`${baseUrl}${config.tokenUrlPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
      if (!response.ok) throw new Error(`GitLab token exchange failed: ${await response.text()}`);
      const tokens = await response.json();
      // Fetch user info
      const userRes = await fetch(`${baseUrl}${config.userInfoUrlPath}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const user = userRes.ok ? await userRes.json() : {};
      return { ...tokens, _user: user, _baseUrl: baseUrl, _clientId: clientId };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      providerSpecificData: {
        username: tokens._user?.username || "",
        email: tokens._user?.email || tokens._user?.public_email || "",
        name: tokens._user?.name || "",
        baseUrl: tokens._baseUrl,
        clientId: tokens._clientId,
        authKind: "oauth",
      },
    }),
  },

  // CodeBuddy (Tencent) - Browser OAuth Polling Flow
  codebuddy: createCodeBuddyDeviceProvider(CODEBUDDY_CONFIG),
  "codebuddy-cn": createCodeBuddyDeviceProvider(CODEBUDDY_CN_CONFIG),
  trae: traeProvider,
  windsurf: windsurfProvider,
  zed: zedProvider,
};

/**
 * Get provider handler
 */
export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

/**
 * Get all provider names
 */
export function getProviderNames() {
  return Object.keys(PROVIDERS);
}

/**
 * Generate auth data for a provider
 * @param {object} [meta] - Provider-specific metadata (e.g. gitlab clientId/baseUrl)
 */
export async function generateAuthData(providerName, redirectUri, meta) {
  const provider = getProvider(providerName);
  const config = provider.prepareConfig
    ? await provider.prepareConfig(provider.config, meta || {})
    : provider.config;
  const { codeVerifier: pkceVerifier, codeChallenge, state: pkceState } = generatePKCE(provider.pkceVerifierBytes);
  const state = config.loginTraceID || config.systemId || pkceState;
  const codeVerifier = config.privateKeyVerifier || pkceVerifier;

  let authUrl;
  if (provider.flowType === "device_code") {
    // Device code flow doesn't have auth URL upfront
    authUrl = null;
  } else if (provider.flowType === "authorization_code_pkce") {
    authUrl = provider.buildAuthUrl(config, redirectUri, state, codeChallenge, meta || {});
  } else {
    authUrl = provider.buildAuthUrl(config, redirectUri, state, undefined, meta || {});
  }

  return {
    authUrl,
    state,
    codeVerifier,
    codeChallenge,
    redirectUri,
    flowType: provider.flowType,
    fixedPort: provider.fixedPort,
    callbackPath: provider.callbackPath || "/callback",
  };
}

/**
 * Exchange code for tokens
 * @param {object} [meta] - Provider-specific metadata (e.g. gitlab clientId/baseUrl)
 */
export async function exchangeTokens(providerName, code, redirectUri, codeVerifier, state, meta) {
  const provider = getProvider(providerName);
  const config = provider.prepareConfig && provider.prepareOnExchange !== false
    ? await provider.prepareConfig(provider.config, meta || {})
    : provider.config;

  const tokens = await provider.exchangeToken(config, code, redirectUri, codeVerifier, state, meta || {});

  let extra = null;
  if (provider.postExchange) {
    extra = await provider.postExchange(tokens);
  }

  return provider.mapTokens(tokens, extra);
}

/**
 * Request device code (for device_code flow)
 */
export async function requestDeviceCode(providerName, codeChallenge, options) {
  const provider = getProvider(providerName);
  if (provider.flowType !== "device_code") {
    throw new Error(`Provider ${providerName} does not support device code flow`);
  }
  return await provider.requestDeviceCode(provider.config, codeChallenge, options || {});
}

/**
 * Poll for token (for device_code flow)
 * @param {string} providerName - Provider name
 * @param {string} deviceCode - Device code from requestDeviceCode
 * @param {string} codeVerifier - PKCE code verifier (optional for some providers)
 * @param {object} extraData - Extra data from device code response (e.g. clientId/clientSecret for Kiro)
 */
export async function pollForToken(providerName, deviceCode, codeVerifier, extraData) {
  const provider = getProvider(providerName);
  if (provider.flowType !== "device_code") {
    throw new Error(`Provider ${providerName} does not support device code flow`);
  }

  const result = await provider.pollToken(provider.config, deviceCode, codeVerifier, extraData);

  if (result.ok) {
    // For device code flows, success is only when we have an access token
    if (result.data.access_token) {
      // Call postExchange to get additional data (copilotToken, userInfo, etc.)
      let extra = null;
      if (provider.postExchange) {
        extra = await provider.postExchange(result.data);
      }
      const tokens = provider.mapTokens(result.data, extra);
      // Kiro IDC/Builder-ID tokens lack profileArn; resolve it to avoid 403
      if (providerName === "kiro" && !tokens.providerSpecificData?.profileArn) {
        const profileArn = await fetchKiroProfileArn(tokens.accessToken);
        if (profileArn) tokens.providerSpecificData.profileArn = profileArn;
      }
      return { success: true, tokens };
    } else {
      // Check if it's still pending authorization
      if (result.data.error === 'authorization_pending' || result.data.error === 'slow_down') {
        // This is not a failure, just still waiting
        return {
          success: false,
          error: result.data.error,
          errorDescription: result.data.error_description || result.data.message,
          pending: result.data.error === 'authorization_pending'
        };
      } else {
        // Actual error
        return {
          success: false,
          error: result.data.error || 'no_access_token',
          errorDescription: result.data.error_description || result.data.message || 'No access token received'
        };
      }
    }
  }

  return { success: false, error: result.data.error, errorDescription: result.data.error_description };
}

// Run-once guard across the process lifetime
let codexBackfillDone = false;

// Backfill email + chatgpt account info for existing codex OAuth connections missing them
export async function backfillCodexEmails() {
  if (codexBackfillDone) return;
  codexBackfillDone = true;
  try {
    const { getProviderConnections, updateProviderConnection } = await import("@/lib/localDb");
    const connections = await getProviderConnections();
    const targets = connections.filter((c) => {
      if (c.provider !== "codex" || c.authType !== "oauth" || !c.idToken) return false;
      const hasEmail = !!c.email;
      const hasAccountInfo = !!c.providerSpecificData?.chatgptAccountId;
      return !hasEmail || !hasAccountInfo;
    });
    for (const conn of targets) {
      const info = extractCodexAccountInfo(conn.idToken);
      if (!info.email && !info.chatgptAccountId) continue;
      const patch = {};
      if (!conn.email && info.email) patch.email = info.email;
      if (info.chatgptAccountId || info.chatgptPlanType) {
        patch.providerSpecificData = {
          ...(conn.providerSpecificData || {}),
          chatgptAccountId: info.chatgptAccountId,
          chatgptPlanType: info.chatgptPlanType,
        };
      }
      if (Object.keys(patch).length) {
        await updateProviderConnection(conn.id, patch);
      }
    }
  } catch (err) {
    codexBackfillDone = false;
    console.log("backfillCodexEmails failed:", err?.message || err);
  }
}
