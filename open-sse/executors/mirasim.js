import { DefaultExecutor } from "./default.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { sanitizeMirasimBody } from "../shared/mirasimSanitize.js";
import {
  RELAY_BASE,
  ensureTicket,
  invalidateTicket,
  signatureHeaders,
  refreshAccountToken,
} from "../shared/mirasimSigner.js";

/**
 * Mirasim (relay.mirasim.ai) — app-less provider.
 *
 * Speaks Anthropic Messages (registry format:"claude", so the pipeline hands us an
 * already-translated Anthropic body). Auth is device-signed per request and gated by a
 * minted session ticket; see shared/mirasimSigner.js.
 *
 * Credentials shape (stored on the provider connection):
 *   accessToken  — Mirasim account JWT
 *   refreshToken — Mirasim account refresh token (auth.mirasim.ai)
 *   providerSpecificData.devicePrivateKey — ed25519 PKCS8 PEM (from ~/.mirasim, decrypted at import)
 */
export class MirasimExecutor extends DefaultExecutor {
  constructor() {
    super("mirasim");
  }

  buildUrl() {
    return `${RELAY_BASE}/v1/messages`;
  }

  buildHeaders(credentials, stream = true) {
    // Auth + signature are attached in signRequest (needs the final body bytes + async ticket).
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body) {
    return sanitizeMirasimBody(body);
  }

  #pem(credentials) {
    const pem = credentials?.providerSpecificData?.devicePrivateKey;
    if (!pem) throw new Error("mirasim: connection is missing providerSpecificData.devicePrivateKey");
    return pem;
  }

  // Attach the ticket Bearer + per-request ed25519 signature over the exact body bytes.
  async signRequest(headers, { url, body, credentials, proxyOptions, log }) {
    const pem = this.#pem(credentials);
    const accountToken = credentials?.accessToken || credentials?.apiKey;
    if (!accountToken) throw new Error("mirasim: connection is missing an account token (accessToken)");
    const path = new URL(url).pathname;

    let ticket;
    try {
      ticket = await ensureTicket({ pem, accountToken: credentials.accessToken || accountToken, proxyOptions, log });
    } catch (e) {
      // Account JWT likely expired — refresh once inline and re-mint. Persisting the new
      // token to storage is handled by the reactive refreshCredentials path on a 401/403.
      if ((e.status === 401 || e.status === 403) && credentials.refreshToken) {
        const refreshed = await refreshAccountToken({ refreshToken: credentials.refreshToken, proxyOptions });
        if (refreshed?.accessToken) {
          Object.assign(credentials, refreshed);
          invalidateTicket({ pem, accountToken });
          ticket = await ensureTicket({ pem, accountToken: refreshed.accessToken, proxyOptions, log });
        }
      }
      if (!ticket) throw e;
    }

    headers["Authorization"] = `Bearer ${ticket}`;
    Object.assign(headers, signatureHeaders({ pem, method: "POST", path, body }));
  }

  // Reactive refresh (chatCore calls this on a 401/403 and persists via onCredentialsRefreshed).
  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    try {
      const refreshed = await refreshAccountToken({ refreshToken: credentials.refreshToken, proxyOptions });
      if (!refreshed?.accessToken) return null;
      try { invalidateTicket({ pem: this.#pem(credentials), accountToken: credentials.accessToken }); } catch { /* ignore */ }
      log?.info?.("TOKEN", "mirasim account token refreshed");
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresIn: undefined,
        providerSpecificData: { ...(credentials.providerSpecificData || {}) },
        expiresAt: refreshed.expiresAt || undefined,
      };
    } catch (e) {
      log?.error?.("TOKEN", `mirasim refresh error: ${e.message}`);
      return null;
    }
  }
}

export default MirasimExecutor;
