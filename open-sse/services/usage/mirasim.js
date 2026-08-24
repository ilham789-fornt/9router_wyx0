/**
 * Mirasim usage handler
 *
 * Reads the account's rolling quota windows from the relay's GET /v1/limits.
 * The call is device-signed like every other relay request but consumes no
 * upstream capacity, so quota stays readable even when no model upstream is
 * attached and chat returns 503.
 *
 * Relay response:
 *   { subject, suspended, unmetered, degraded,
 *     windows: [ { name: "5h", used: 7740.84, budget: 39200, reset_at: 1787593570 }, ... ] }
 */

import {
  RELAY_BASE,
  ensureTicket,
  invalidateTicket,
  signatureHeaders,
  refreshAccountToken,
} from "../../shared/mirasimSigner.js";
import { parseResetTime, toFiniteNumber, fetchWithTimeout } from "./shared.js";

const LIMITS_PATH = "/v1/limits";

// "5h" → "session (5h)", "7d" → "weekly (7d)", "7d_fable" → "weekly fable (7d)"
function labelForWindow(name) {
  if (name === "5h") return "session (5h)";
  if (name === "7d") return "weekly (7d)";
  const modelScoped = /^7d[_-](.+)$/.exec(name);
  if (modelScoped) return `weekly ${modelScoped[1]} (7d)`;
  return name;
}

function buildQuota(window) {
  const used = toFiniteNumber(window.used, 0);
  const total = toFiniteNumber(window.budget, 0);
  const unlimited = total <= 0;
  const remaining = unlimited ? 0 : Math.max(0, total - used);
  return {
    used: Math.round(used),
    total,
    remaining: Math.round(remaining),
    remainingPercentage: unlimited ? 100 : Math.max(0, Math.min(100, (remaining / total) * 100)),
    resetAt: parseResetTime(window.reset_at ?? window.resetAt),
    unlimited,
  };
}

async function readLimits(pem, accountToken, proxyOptions) {
  const ticket = await ensureTicket({ pem, accountToken, proxyOptions });
  const headers = {
    authorization: `Bearer ${ticket}`,
    ...signatureHeaders({ pem, method: "GET", path: LIMITS_PATH, body: "" }),
  };
  return await fetchWithTimeout(RELAY_BASE + LIMITS_PATH, { method: "GET", headers }, 10000, proxyOptions);
}

export async function getMirasimUsage(connection, proxyOptions = null) {
  const pem = connection?.providerSpecificData?.devicePrivateKey;
  if (!pem) {
    return { message: "Mirasim connected. Re-import the account to read usage (missing device key)." };
  }

  let accountToken = connection.accessToken;
  if (!accountToken) return { message: "Mirasim connected. No account token available." };

  try {
    let response = await readLimits(pem, accountToken, proxyOptions);

    // Account JWT expired — refresh once and retry. Persisting the rotated token is
    // handled by the executor's refreshCredentials on the request path.
    if ((response.status === 401 || response.status === 403) && connection.refreshToken) {
      const next = await refreshAccountToken({ refreshToken: connection.refreshToken, proxyOptions });
      if (next?.accessToken) {
        invalidateTicket({ pem, accountToken });
        accountToken = next.accessToken;
        response = await readLimits(pem, accountToken, proxyOptions);
      }
    }

    if (!response.ok) {
      return { message: `Mirasim connected. Unable to fetch usage: HTTP ${response.status}` };
    }

    const data = await response.json();
    const quotas = {};
    for (const window of Array.isArray(data.windows) ? data.windows : []) {
      if (!window?.name) continue;
      quotas[labelForWindow(window.name)] = buildQuota(window);
    }

    return {
      plan: data.unmetered ? "Mirasim (unmetered)" : "Mirasim Pro",
      ...(data.suspended ? { message: "Mirasim account is suspended." } : {}),
      ...(data.degraded ? { degraded: true } : {}),
      quotas,
    };
  } catch (error) {
    return { message: `Mirasim connected. Unable to fetch usage: ${error.message}` };
  }
}

export const _internal = { labelForWindow, buildQuota };
