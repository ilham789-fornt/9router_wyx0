/**
 * otpImapReader.js — Node port of D:\porto vibe\bot farm2\github-farm-edu\otp_reader.py
 *
 * Polls a Gmail (or any IMAP) inbox for a verification code addressed to a
 * catch-all recipient email, extracts the OTP (default 6-digit), and
 * optionally also captures a direct-confirm URL from the same mail body.
 *
 * Used by codebuddyGithubBulkImportManager to fulfil GitHub's "Device
 * Verification" surface: GitHub emails an 8-digit code to the signup
 * address (typically {random}@{catch-all-domain}) and blocks the OAuth
 * flow until the code is entered on github.com/sessions/verified-device.
 *
 * Uses `imapflow` for IMAP transport and `mailparser` to decode multipart
 * MIME bodies. Both were added to package.json.
 *
 * Config sourced from process.env (matching the Python .env contract):
 *   IMAP_USER   — mailbox login (e.g. you@gmail.com)
 *   IMAP_PASS   — Gmail App Password / IMAP password
 *   IMAP_HOST   — default: imap.gmail.com
 *   IMAP_PORT   — default: 993
 *
 * A helper `otpReaderFromEnv()` returns null when IMAP_USER/PASS are not
 * present, so callers can degrade gracefully instead of crashing when the
 * operator has not opted into IMAP OTP reading.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// CSS colours and placeholder digits that look like OTPs but are not.
// Kept identical to the Python blocklist so behaviour matches farm.py.
const DEFAULT_BLOCKLIST = new Set([
  "181818", "666666", "808080", "111111", "000000",
]);

const DEFAULT_OTP_PATTERN = /\b(\d{6,8})\b/g;
const DEFAULT_SENDER_MATCH = "github";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 180_000;

// Escape a raw string for embedding into IMAP SEARCH FROM criteria.
function escapeSearchLiteral(value) {
  return String(value || "").replace(/["\\]/g, "\\$&");
}

/**
 * OTP reader class.
 *
 * @param {object}  opts
 * @param {string}  opts.imapUser       — full email address
 * @param {string}  opts.imapPass       — password / app password
 * @param {string}  [opts.senderMatch]  — substring match against FROM header (default "github")
 * @param {RegExp|string} [opts.otpPattern]     — regex to pull the code out of the mail body
 * @param {RegExp|string} [opts.confirmUrlPattern] — optional regex for a direct-confirm URL
 * @param {string}  [opts.imapHost]     — default imap.gmail.com
 * @param {number}  [opts.imapPort]     — default 993
 * @param {number}  [opts.pollIntervalMs] — poll cadence (default 5s)
 * @param {Iterable<string>} [opts.blocklist] — codes to skip (CSS values etc)
 */
export class OtpImapReader {
  constructor({
    imapUser,
    imapPass,
    senderMatch = DEFAULT_SENDER_MATCH,
    otpPattern = DEFAULT_OTP_PATTERN,
    confirmUrlPattern = null,
    imapHost = "imap.gmail.com",
    imapPort = 993,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    blocklist = DEFAULT_BLOCKLIST,
  } = {}) {
    if (!imapUser || !imapPass) {
      throw new Error("OtpImapReader requires imapUser and imapPass");
    }
    this.imapUser = imapUser;
    this.imapPass = imapPass;
    this.senderMatch = String(senderMatch || "").toLowerCase();
    this.otpPattern = otpPattern instanceof RegExp
      ? new RegExp(otpPattern.source, otpPattern.flags.includes("g") ? otpPattern.flags : `${otpPattern.flags}g`)
      : new RegExp(otpPattern, "g");
    this.confirmUrlPattern = confirmUrlPattern
      ? (confirmUrlPattern instanceof RegExp ? confirmUrlPattern : new RegExp(confirmUrlPattern))
      : null;
    this.imapHost = imapHost;
    this.imapPort = Number(imapPort) || 993;
    this.pollIntervalMs = pollIntervalMs;
    this.blocklist = new Set(blocklist);
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Wait for an OTP delivered to `targetEmail`. Returns the code string,
   * or null on timeout.
   */
  async waitForOtp(targetEmail, { timeoutMs = DEFAULT_TIMEOUT_MS, onStep = null } = {}) {
    const result = await this.waitForOtpWithUrl(targetEmail, { timeoutMs, onStep });
    return result ? result.code : null;
  }

  /**
   * Wait for an OTP + optionally a direct-confirm URL.
   * Returns { code, confirmUrl } or null.
   */
  async waitForOtpWithUrl(targetEmail, { timeoutMs = DEFAULT_TIMEOUT_MS, onStep = null } = {}) {
    const start = Date.now();
    onStep?.("imap_otp_waiting", `Polling IMAP for OTP addressed to ${targetEmail} (timeout=${Math.round(timeoutMs / 1000)}s)`);
    while (Date.now() - start < timeoutMs) {
      try {
        const hit = await this._tryRead(targetEmail);
        if (hit) {
          onStep?.(
            "imap_otp_received",
            hit.confirmUrl
              ? `Received OTP for ${targetEmail} (+ direct-confirm URL)`
              : `Received OTP ${hit.code} for ${targetEmail}`
          );
          return hit;
        }
      } catch (err) {
        onStep?.("imap_otp_error", `IMAP read error: ${err?.message || err}`);
      }
      // Sleep between polls; abort quickly if the deadline is close.
      const remaining = timeoutMs - (Date.now() - start);
      const sleep = Math.max(0, Math.min(this.pollIntervalMs, remaining));
      if (sleep <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
    onStep?.("imap_otp_timeout", `Timed out waiting for OTP after ${Math.round(timeoutMs / 1000)}s`);
    return null;
  }

  // ── Internals ──────────────────────────────────────────────────

  async _tryRead(targetEmail) {
    const client = new ImapFlow({
      host: this.imapHost,
      port: this.imapPort,
      secure: this.imapPort === 993,
      auth: { user: this.imapUser, pass: this.imapPass },
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Newest first, then filter by From (case-insensitive on server side
        // via `from` criterion — imapflow accepts partial-match search).
        const from = escapeSearchLiteral(this.senderMatch);
        const uids = await client.search({ from }, { uid: true });
        if (!uids || uids.length === 0) return null;

        // Only look at the newest 15 messages.
        const recent = uids.slice(-15).reverse();
        for (const uid of recent) {
          const fetched = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!fetched?.source) continue;

          const parsed = await simpleParser(fetched.source).catch(() => null);
          if (!parsed) continue;

          const toValue = String(parsed.to?.text || parsed.headers?.get?.("to") || "").toLowerCase();
          if (!toValue.includes(String(targetEmail).toLowerCase())) continue;

          const body = parsed.text || parsed.html || "";
          const code = this._extractOtp(body);
          if (!code) continue;

          const confirmUrl = this._extractConfirmUrl(body);

          // Mark as seen so we do not reuse it on the next poll.
          try { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } catch { /* ignore */ }
          return { code, confirmUrl };
        }
        return null;
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  _extractConfirmUrl(body) {
    if (!this.confirmUrlPattern) return null;
    const match = String(body || "").match(this.confirmUrlPattern);
    return match ? match[0] : null;
  }

  _extractOtp(body) {
    const text = String(body || "");

    // Strategy 1: constructor-provided regex.
    const primary = new RegExp(this.otpPattern.source, this.otpPattern.flags);
    let m;
    while ((m = primary.exec(text)) !== null) {
      const code = m[1] || m[0];
      if (!this.blocklist.has(code)) return code;
    }

    // Strategy 2: digits inside common tags (<span>...</span> etc).
    const tagRe = />\s*(\d{6,8})\s*</g;
    while ((m = tagRe.exec(text)) !== null) {
      const code = m[1];
      if (!this.blocklist.has(code)) return code;
    }

    // Strategy 3: digits near verification keywords.
    const nearKeywordRe = /(?:code|verification|verify|confirm)[^<]{0,50}?(\d{6,8})/gi;
    while ((m = nearKeywordRe.exec(text)) !== null) {
      const code = m[1];
      if (!this.blocklist.has(code)) return code;
    }

    return null;
  }
}

/**
 * Build an OtpImapReader from process.env. Returns null when IMAP_USER or
 * IMAP_PASS is missing so callers can degrade to needs_manual.
 *
 * @param {object} [opts]
 * @param {string} [opts.senderMatch]
 * @param {RegExp|string} [opts.otpPattern]
 * @param {RegExp|string} [opts.confirmUrlPattern]
 */
export function otpReaderFromEnv(opts = {}) {
  const imapUser = process.env.IMAP_USER || "";
  const imapPass = process.env.IMAP_PASS || "";
  if (!imapUser || !imapPass) return null;
  return new OtpImapReader({
    imapUser,
    imapPass,
    imapHost: process.env.IMAP_HOST || "imap.gmail.com",
    imapPort: Number(process.env.IMAP_PORT || 993),
    senderMatch: opts.senderMatch,
    otpPattern: opts.otpPattern,
    confirmUrlPattern: opts.confirmUrlPattern,
  });
}
