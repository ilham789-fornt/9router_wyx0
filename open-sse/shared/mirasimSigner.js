// Mirasim relay device-signing + session-ticket lifecycle.
//
// Lets 9router talk to relay.mirasim.ai directly, without the Mirasim desktop app
// running, by replicating the app's `mrs-sig-v1` ed25519 request signing and the
// device-session ticket mint. See the protocol notes in the project memory.
//
// Every relay call carries:
//   Authorization: Bearer <ticket>            (minted from the account JWT + device key)
//   x-mirasim-device / -ts / -nonce / -sig     (per-request ed25519 signature)
//   x-mirasim-client: <app version>
//
// The ticket is MANDATORY for /v1/messages — a raw account token (even signed) is
// rejected with 403 "this client is not supported".

import crypto from "crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const RELAY_BASE = (process.env.MIRASIM_RELAY_BASE || "https://relay.mirasim.ai").replace(/\/+$/, "");
export const LOGIN_BASE = (process.env.MIRASIM_LOGIN_BASE || "https://auth.mirasim.ai").replace(/\/+$/, "");
export const CLIENT_VERSION = process.env.MIRASIM_APP_VERSION || "0.0.220";
const SIG_PREFIX = "mrs-sig-v1";
const DEVICE_SESSION_PATH = "/v1/device/session";

// --- device identity (cached per PEM) ---
const identityCache = new Map(); // pem -> { pk, pub, deviceId }

export function deriveIdentity(pem) {
  if (!pem) throw new Error("mirasim: missing device private key");
  const hit = identityCache.get(pem);
  if (hit) return hit;
  const pk = crypto.createPrivateKey(pem);
  const pub = crypto.createPublicKey(pk).export({ format: "der", type: "spki" }).toString("base64");
  const deviceId = crypto.createHash("sha256").update(pub).digest("base64url").slice(0, 22);
  const id = { pk, pub, deviceId };
  identityCache.set(pem, id);
  return id;
}

// --- per-request signature headers (vfe / mrs-sig-v1) ---
export function signatureHeaders({ pem, method, path, body }) {
  const { pk, deviceId } = deriveIdentity(pem);
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString("base64url");
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  const bodySha = crypto.createHash("sha256").update(bodyBuf).digest("hex");
  const canonical = [SIG_PREFIX, method.toUpperCase(), path, ts, nonce, bodySha].join("\n");
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), pk).toString("base64url");
  return {
    "x-mirasim-device": deviceId,
    "x-mirasim-ts": ts,
    "x-mirasim-nonce": nonce,
    "x-mirasim-sig": sig,
    "x-mirasim-client": CLIENT_VERSION,
  };
}

// --- session ticket mint ---
export async function mintTicket({ pem, accountToken, proxyOptions = null }) {
  const { pub, deviceId } = deriveIdentity(pem);
  const bodyStr = JSON.stringify({ publicKey: pub, deviceId });
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer " + accountToken,
    ...signatureHeaders({ pem, method: "POST", path: DEVICE_SESSION_PATH, body: bodyStr }),
  };
  const res = await proxyAwareFetch(RELAY_BASE + DEVICE_SESSION_PATH, { method: "POST", headers, body: bodyStr }, proxyOptions);
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(`mirasim mint failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  let j = {};
  try { j = JSON.parse(text); } catch { /* ignore */ }
  const ticket = j.ticket || j.token || j.sessionToken || null;
  if (!ticket) throw new Error("mirasim mint: no ticket in response");
  return { ticket, expiresAtMs: resolveExpiryMs(j) };
}

// The relay may report a duration (expiresIn, seconds) or an absolute instant
// (expiresAt in seconds, or expiresAtMs in ms). Normalize to an absolute ms timestamp.
function resolveExpiryMs(j) {
  if (j.expiresIn != null && Number.isFinite(Number(j.expiresIn))) return Date.now() + Number(j.expiresIn) * 1000;
  if (j.expiresAtMs != null && Number.isFinite(Number(j.expiresAtMs))) return Number(j.expiresAtMs);
  if (j.expiresAt != null && Number.isFinite(Number(j.expiresAt))) {
    const n = Number(j.expiresAt);
    return n < 1e12 ? n * 1000 : n; // < 1e12 → seconds
  }
  return Date.now() + 5 * 60 * 1000;
}

// --- ticket cache with in-flight de-duplication (keyed by deviceId + accountToken) ---
const RENEW_LEAD_MS = 60 * 1000; // re-mint 60s before expiry
const ticketCache = new Map(); // key -> { ticket, expiresAtMs }
const inflight = new Map();     // key -> Promise

function cacheKey(deviceId, accountToken) {
  return deviceId + ":" + crypto.createHash("sha256").update(accountToken).digest("base64url").slice(0, 16);
}

export async function ensureTicket({ pem, accountToken, proxyOptions = null, log = null }) {
  const { deviceId } = deriveIdentity(pem);
  const key = cacheKey(deviceId, accountToken);
  const cached = ticketCache.get(key);
  if (cached && Date.now() < cached.expiresAtMs - RENEW_LEAD_MS) return cached.ticket;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const minted = await mintTicket({ pem, accountToken, proxyOptions });
    ticketCache.set(key, minted);
    log?.info?.("MIRASIM", `ticket minted (expires in ${Math.round((minted.expiresAtMs - Date.now()) / 1000)}s)`);
    return minted.ticket;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

export function invalidateTicket({ pem, accountToken }) {
  try {
    const { deviceId } = deriveIdentity(pem);
    ticketCache.delete(cacheKey(deviceId, accountToken));
  } catch { /* ignore */ }
}

// --- account JWT refresh (auth.mirasim.ai) ---
export async function refreshAccountToken({ refreshToken, proxyOptions = null }) {
  if (!refreshToken) return null;
  const res = await proxyAwareFetch(LOGIN_BASE + "/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }, proxyOptions);
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j || typeof j.access_token !== "string" || !j.access_token) return null;
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : refreshToken,
    expiresAt: jwtExpiryIso(j.access_token),
  };
}

// Decode a JWT's `exp` (seconds) into an ISO string, if present.
export function jwtExpiryIso(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}
