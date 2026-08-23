/**
 * OAuth Configuration Constants — static data lives in registry, re-exported here for consumers.
 */
import { platform, arch } from "os";
import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js";
import { PROVIDER_OAUTH, PROVIDERS as REGISTRY_PROVIDERS } from "open-sse/providers/index.js";

/**
 * Get the platform enum value based on the current OS.
 * Matches Antigravity binary's ClientMetadata.Platform enum.
 */
function getOAuthPlatformEnum() {
  const os = platform();
  const architecture = arch();
  if (os === "darwin") return architecture === "arm64" ? 2 : 1;
  if (os === "linux") return architecture === "arm64" ? 4 : 3;
  if (os === "win32") return 5;
  return 0;
}

// Claude OAuth Configuration (Authorization Code Flow with PKCE)
export const CLAUDE_CONFIG = { ...PROVIDER_OAUTH["claude"] };

// Codex (OpenAI) OAuth Configuration (Authorization Code Flow with PKCE)
export const CODEX_CONFIG = { ...PROVIDER_OAUTH["codex"] };

// Gemini (Google) OAuth Configuration (Standard OAuth2)
// clientId/clientSecret from GOOGLE_OAUTH_CLIENT (shared.js) — not stored in registry
export const GEMINI_CONFIG = { ...GOOGLE_OAUTH_CLIENT, ...PROVIDER_OAUTH["gemini-cli"] };

// Qwen OAuth Configuration (Device Code Flow with PKCE)
export const QWEN_CONFIG = { ...PROVIDER_OAUTH["qwen"] };

// Qoder OAuth Configuration (Device Token Flow with PKCE).
// Device tokens are long-lived (~30 days for access, ~360 for refresh).
// The upstream refresh endpoint at center.qoder.sh returns 403 for our
// flow — we accept that and surface it to the user as "re-login" instead
// of attempting to silently rotate.
export const QODER_CONFIG = { ...PROVIDER_OAUTH["qoder"] };

// iFlow OAuth Configuration (Authorization Code)
export const IFLOW_CONFIG = { ...PROVIDER_OAUTH["iflow"] };

// Antigravity OAuth Configuration (Standard OAuth2 with Google)
// clientId/clientSecret from ANTIGRAVITY_OAUTH_CLIENT (shared.js) — not stored in registry
// loadCodeAssistClientMetadata is dynamic (runtime platform detection)
export const ANTIGRAVITY_CONFIG = {
  ...ANTIGRAVITY_OAUTH_CLIENT,
  ...PROVIDER_OAUTH["antigravity"],
  loadCodeAssistClientMetadata: JSON.stringify({ ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 }),
};

/**
 * Get client metadata using numeric enum values for API calls.
 * @returns {{ ideType: number, platform: number, pluginType: number }}
 */
export function getOAuthClientMetadata() {
  return { ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 };
}

// OpenAI OAuth Configuration (Authorization Code Flow with PKCE)
export const OPENAI_CONFIG = { ...PROVIDER_OAUTH["openai"] };

// GitHub Copilot OAuth Configuration (Device Code Flow)
export const GITHUB_CONFIG = { ...PROVIDER_OAUTH["github"] };

// Kiro OAuth Configuration (multi-method: AWS Builder ID / IDC / Social / Import Token)
export const KIRO_CONFIG = { ...PROVIDER_OAUTH["kiro"] };

// AWS region allowlist pattern — prevents SSRF via region injection into upstream URLs (GHSA-6mwv-4mrm-5p3m)
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

// Reject any region that is not a valid AWS region before interpolating it into a URL
export function assertValidAwsRegion(region) {
  if (typeof region !== "string" || !AWS_REGION_PATTERN.test(region)) {
    throw new Error("Invalid region");
  }
  return region;
}

// Cursor OAuth Configuration (Import Token from Cursor IDE)
// tokenStoragePaths: user-reference only, not stored in registry
export const CURSOR_CONFIG = {
  ...PROVIDER_OAUTH["cursor"],
  tokenStoragePaths: {
    linux: "~/.config/Cursor/User/globalStorage/state.vscdb",
    macos: "/Users/<user>/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    windows: "%APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb",
  },
};

// Kimi Coding OAuth Configuration (Device Code Flow)
// clientId uses env override — dynamic, not stored in registry
export const KIMI_CODING_CONFIG = {
  ...PROVIDER_OAUTH["kimi-coding"],
  clientId: process.env.KIMI_CODING_OAUTH_CLIENT_ID || REGISTRY_PROVIDERS["kimi-coding"]?.clientId,
};

// KiloCode OAuth Configuration (Custom Device Auth Flow)
export const KILOCODE_CONFIG = { ...PROVIDER_OAUTH["kilocode"] };

// Cline OAuth Configuration (Local Callback Flow via app.cline.bot)
export const CLINE_CONFIG = { ...PROVIDER_OAUTH["cline"] };

// GitLab Duo OAuth Configuration (Authorization Code Flow with PKCE)
export const GITLAB_CONFIG = { ...PROVIDER_OAUTH["gitlab"] };

// CodeBuddy (Tencent) OAuth Configuration (Browser OAuth Polling Flow)
export const CODEBUDDY_CONFIG = { ...PROVIDER_OAUTH["codebuddy"] };
export const CODEBUDDY_CN_CONFIG = { ...PROVIDER_OAUTH["codebuddy-cn"] };

// Trae (ByteDance marscode) browser OAuth and SOLO API defaults.
export const TRAE_CONFIG = {
  clientId: "ono9krqynydwx5",
  clientSecret: "-",
  loginGuidanceUrls: [
    "https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance",
    "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
    "https://www.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
  ],
  apiOrigins: [
    "https://api.marscode.com",
    "https://api.trae.ai",
    "https://www.trae.ai",
    "https://www.marscode.com",
  ],
  exchangeTokenPath: "/cloudide/api/v3/trae/oauth/ExchangeToken",
  getUserInfoPath: "/cloudide/api/v3/trae/GetUserInfo",
  authorizationPath: "/authorization",
  callbackPath: "/callback",
  defaultAppVersion: "3.5.54",
  defaultAppType: "stable",
  defaultPluginVersion: "local",
  defaultDeviceId: "0",
  userAgent: "Trae/1.0.0 antigravity-cockpit-tools",
  tokenLifetimeDays: 14,
  oauthTimeoutMs: 600_000,
};

// Windsurf browser OAuth and SeatManagement API defaults.
export const WINDSURF_CONFIG = {
  clientId: "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u",
  authBaseUrl: "https://www.windsurf.com",
  signInPath: "/windsurf/signin",
  registerApiBaseUrl: "https://register.windsurf.com",
  registerPath: "/exa.seat_management_pb.SeatManagementService/RegisterUser",
  oneTimeAuthPath: "/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken",
  currentUserPath: "/exa.seat_management_pb.SeatManagementService/GetCurrentUser",
  defaultApiServerUrl: "https://server.codeium.com",
  apiOrigins: [
    "https://server.codeium.com",
    "https://server.self-serve.windsurf.com",
  ],
  callbackPath: "/windsurf-auth-callback",
  userAgent: "antigravity-cockpit-tools",
  oauthTimeoutMs: 600_000,
};

// Kept ready for the separate Zed provider port; the callback proxy is already
// hardened here, but registry/executor wiring lands with its prerequisite batch.
export const ZED_HOSTED_CONFIG = {
  webBaseUrl: "https://zed.dev",
  cloudBaseUrl: "https://cloud.zed.dev",
  llmBaseUrl: "https://cloud.zed.dev",
  defaultNativeAppPort: 58443,
  oauthTimeoutMs: 600_000,
};

// OAuth timeout (5 minutes)
export const OAUTH_TIMEOUT = 300000;

// Provider list
export const PROVIDERS = {
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini-cli",
  QWEN: "qwen",
  QODER: "qoder",
  IFLOW: "iflow",
  ANTIGRAVITY: "antigravity",
  OPENAI: "openai",
  GITHUB: "github",
  KIRO: "kiro",
  CURSOR: "cursor",
  KIMI_CODING: "kimi-coding",
  KILOCODE: "kilocode",
  CLINE: "cline",
  GITLAB: "gitlab",
  CODEBUDDY: "codebuddy",
  CODEBUDDY_CN: "codebuddy-cn",
  TRAE: "trae",
  WINDSURF: "windsurf",
  ZED: "zed",
};
