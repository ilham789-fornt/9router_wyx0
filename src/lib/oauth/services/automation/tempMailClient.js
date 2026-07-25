/**
 * tempMailClient.js — Privatix Temp-Mail (RapidAPI) client.
 *
 * Wraps the Privatix disposable-email API at
 * https://privatix-temp-mail-v1.p.rapidapi.com/ so bulk-register automations
 * can generate throwaway addresses, poll their inbox for verification emails,
 * and extract OTP codes / confirm URLs.
 *
 * API contract summary (see docs/tempmailapi.md for raw curl reference):
 *   GET /request/domains/                       → array of active "@domain.com"
 *   GET /request/mail/id/{md5}/                 → list of emails for one address
 *   GET /request/one_mail/id/{mail_id}/         → single email detail
 *   GET /request/delete/id/{mail_id}/           → discard a delivered message
 *                                                (Privatix uses GET, not DELETE)
 *   GET /request/source/id/{mail_id}/           → raw MIME source (unused here)
 *   GET /request/attachments/id/{mail_id}/      → attachment list (unused here)
 *   GET /request/one_attachment/id/{mail_id}/{atId}/  → single attachment binary
 *
 * Address identity: the `md5` in the URL is the lowercase-hex MD5 hash of
 * the *full* email address (e.g. md5("john2847@steveix.com")). The address
 * itself is implicit — Privatix does not require registration.
 *
 * Auth: every request needs two headers (lowercase per Privatix docs; HTTP
 * itself is case-insensitive but we mirror the spec to avoid surprises):
 *   x-rapidapi-key:  <TEMPMAIL_RAPIDAPI_KEY>
 *   x-rapidapi-host: privatix-temp-mail-v1.p.rapidapi.com
 *
 * Callers should treat mailboxes as short-lived; Privatix rotates and purges
 * addresses aggressively. Compose flows must poll for the verification email
 * within a few minutes of triggering the signup.
 */

import { createHash } from "node:crypto";

const RAPIDAPI_HOST = "privatix-temp-mail-v1.p.rapidapi.com";
const BASE_URL = `https://${RAPIDAPI_HOST}`;

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 180_000;

// Small built-in first-name corpus. Kept intentionally short and generic so
// generated prefixes look human enough without shipping a big dataset. The
// combined `<name><4-digit-number>` shape (max ~14 chars) fits inside the
// GitHub username rules and stays lowercase-alnum as Privatix requires.
const DEFAULT_NAME_CORPUS = [
  "alex", "amy", "andy", "anna", "ava", "ben", "beth", "bill", "brad", "cara",
  "carl", "chad", "chris", "cindy", "dan", "dave", "dean", "elle", "emma",
  "eric", "evan", "faye", "finn", "gina", "greg", "hank", "hugo", "ian", "ivy",
  "jack", "jade", "jake", "jane", "jason", "jay", "jean", "jenn", "jess",
  "jill", "jim", "joe", "john", "jose", "josh", "june", "kara", "kate", "ken",
  "kim", "kyle", "lara", "leo", "liam", "lila", "lisa", "liz", "luke", "mark",
  "matt", "max", "mia", "mike", "molly", "nate", "neil", "nick", "noah", "nora",
  "olga", "olive", "owen", "paige", "paul", "peter", "phil", "quinn", "raj",
  "riley", "rob", "rose", "ryan", "sage", "sam", "sara", "seth", "sofia",
  "steve", "sue", "tara", "ted", "tim", "tom", "tony", "troy", "vera", "wade",
  "will", "yara", "zach", "zara", "zoe",
];

/**
 * MD5 hex of a full email address.
 * Privatix expects the hash in lowercase hex.
 */
export function md5EmailId(email) {
  return createHash("md5").update(String(email || "").trim().toLowerCase()).digest("hex");
}

/**
 * Build a plausible-looking prefix in `<name><4-digit-number>` form. Uses only
 * lowercase alphanumerics so Privatix does not reject it.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.nameCorpus]  Override the default first-name pool.
 * @param {() => number} [opts.rng]     Optional deterministic RNG (0..1).
 */
export function generateEmailPrefix({ nameCorpus = DEFAULT_NAME_CORPUS, rng = Math.random } = {}) {
  const pool = Array.isArray(nameCorpus) && nameCorpus.length > 0 ? nameCorpus : DEFAULT_NAME_CORPUS;
  const name = pool[Math.floor(rng() * pool.length)] || "user";
  const digits = Math.floor(rng() * 9000) + 1000; // 1000..9999
  return `${name}${digits}`;
}

/**
 * Extract a numeric OTP from a plain-text mail body.
 *
 * Uses three heuristics in order (identical strategy family to otpImapReader):
 *   1. constructor-provided regex,
 *   2. digits inside `>...<` tag-like fragments,
 *   3. digits within 50 chars of "code" / "verify" / "verification".
 *
 * Blocklist filters false positives (repeated digits used as CSS colours).
 */
export function extractOtp(body, {
  otpPattern = /\b(\d{6,8})\b/g,
  blocklist = new Set(["181818", "666666", "808080", "111111", "000000"]),
} = {}) {
  const text = String(body || "");
  if (!text) return null;

  const primary = new RegExp(otpPattern.source, otpPattern.flags.includes("g") ? otpPattern.flags : `${otpPattern.flags}g`);
  let m;
  while ((m = primary.exec(text)) !== null) {
    const code = m[1] || m[0];
    if (code && !blocklist.has(code)) return code;
  }

  const tagRe = />\s*(\d{6,8})\s*</g;
  while ((m = tagRe.exec(text)) !== null) {
    if (!blocklist.has(m[1])) return m[1];
  }

  const nearKeywordRe = /(?:code|verification|verify|confirm)[^<]{0,50}?(\d{6,8})/gi;
  while ((m = nearKeywordRe.exec(text)) !== null) {
    if (!blocklist.has(m[1])) return m[1];
  }

  return null;
}

/**
 * Extract a direct-confirm URL when the caller provides a pattern (e.g. GitHub
 * emails `/account_verifications/confirm/<token>` links).
 */
export function extractConfirmUrl(body, confirmUrlPattern) {
  if (!confirmUrlPattern) return null;
  const re = confirmUrlPattern instanceof RegExp ? confirmUrlPattern : new RegExp(confirmUrlPattern);
  const match = String(body || "").match(re);
  return match ? match[0] : null;
}

/**
 * Privatix Temp-Mail REST client.
 *
 * All network I/O goes through `fetch` (Node 18+); callers may inject a
 * custom `fetchImpl` in tests to avoid real HTTP calls.
 */
export class PrivatixTempMailClient {
  constructor({
    apiKey,
    baseUrl = BASE_URL,
    host = RAPIDAPI_HOST,
    fetchImpl = globalThis.fetch,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = {}) {
    if (!apiKey) throw new Error("PrivatixTempMailClient requires apiKey");
    if (typeof fetchImpl !== "function") {
      throw new Error("PrivatixTempMailClient requires a fetch implementation");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.host = host;
    this.fetchImpl = fetchImpl;
    this.pollIntervalMs = pollIntervalMs;
  }

  _headers() {
    // Header names use the exact casing Privatix's curl reference documents;
    // HTTP is case-insensitive but sticking to the docs avoids surprises with
    // aggressive proxies or gateways.
    return {
      "x-rapidapi-key": this.apiKey,
      "x-rapidapi-host": this.host,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
  }

  async _get(path) {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, { method: "GET", headers: this._headers() });
    // Privatix returns 404 when a mailbox exists but has no messages; treat
    // that as an empty array rather than an error so callers can keep polling.
    if (response.status === 404) return { status: 404, data: [] };
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      const message = typeof data === "string" ? data : (data && (data.message || data.error)) || `HTTP ${response.status}`;
      const err = new Error(`Privatix temp-mail request failed: ${message}`);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return { status: response.status, data };
  }

  /**
   * Fetch active domain list, e.g. ["@steveix.com","@cevipsa.com",...].
   * The list changes over time as Privatix rotates blocked domains, so callers
   * should not cache it across process restarts.
   */
  async listDomains() {
    const { data } = await this._get("/request/domains/");
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => String(entry || "").trim())
      .filter((entry) => entry.startsWith("@"));
  }

  /**
   * Generate a fresh address by combining a random prefix with one of the
   * active domains. Returns { email, domain, id } where id is the md5 hash
   * the server uses to look up the mailbox.
   *
   * `rng` and `nameCorpus` mirror generateEmailPrefix so tests can stub them.
   */
  async allocateAddress({ nameCorpus, rng, preferredDomain, domainRng } = {}) {
    const domains = await this.listDomains();
    if (domains.length === 0) throw new Error("Privatix returned no active domains");
    const chooseDomain = domainRng || rng || Math.random;
    const domain = preferredDomain && domains.includes(preferredDomain)
      ? preferredDomain
      : domains[Math.floor(chooseDomain() * domains.length)];
    const prefix = generateEmailPrefix({ nameCorpus, rng });
    const email = `${prefix}${domain}`;
    return { email, domain, id: md5EmailId(email) };
  }

  /**
   * Allocate up to `count` disposable addresses where each address lives on
   * a DIFFERENT Privatix domain. This is the primary allocation path used by
   * bulk-register flows: CodeBuddy Global's account-restriction heuristics
   * flag two signups from the same disposable-email domain that arrive
   * within a short window, so we spread across domains as widely as the
   * upstream Privatix domain rotation allows.
   *
   * Behaviour:
   *   1. Fetch the active domain list from Privatix.
   *   2. Fisher-Yates shuffle the domain list (uniform random pick without
   *      replacement).
   *   3. If `count > domains.length`, GRACEFULLY CAP to domains.length and
   *      return the `capped` flag on the result so the caller can surface a
   *      warning. Privatix typically exposes only 8-15 domains at any time,
   *      so hard-rejecting large requests would make the flow unusable —
   *      the operator explicitly opts into this batch shape by starting the
   *      job, and getting *some* accounts is strictly better than zero.
   *   4. Take the first `min(count, domains.length)` domains from the
   *      shuffled list and pair each with a freshly generated prefix.
   *      Prefixes are also generated without collisions inside this batch.
   *
   * @param {number} count                 Desired number of unique addresses.
   * @param {object} [options]
   * @param {string[]} [options.nameCorpus]  Custom first-name pool (for tests).
   * @param {() => number} [options.rng]     Deterministic RNG (0..1) for prefixes.
   * @param {() => number} [options.domainRng]  Deterministic RNG for domain shuffle.
   * @returns {Promise<{
   *   addresses: Array<{ email: string, domain: string, id: string }>,
   *   requested: number,
   *   allocated: number,
   *   available: number,
   *   capped: boolean,
   * }>}
   */
  async allocateUniqueAddresses(count, { nameCorpus, rng, domainRng } = {}) {
    const requested = Number.parseInt(count, 10);
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("allocateUniqueAddresses requires a positive integer count");
    }

    const domains = await this.listDomains();
    if (domains.length === 0) throw new Error("Privatix returned no active domains");

    const available = domains.length;
    const allocated = Math.min(requested, available);
    const capped = requested > available;

    // Fisher-Yates shuffle — uniform random permutation, O(n).
    const chooseDomain = domainRng || rng || Math.random;
    const shuffled = domains.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(chooseDomain() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const usedPrefixes = new Set();
    const addresses = [];
    for (let i = 0; i < allocated; i += 1) {
      const domain = shuffled[i];

      // Prefix collisions inside one batch are astronomically unlikely
      // (~100 names × 9000 digits = 900 000 combinations), but we still
      // retry a handful of times if the caller's RNG happens to repeat.
      let prefix = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = generateEmailPrefix({ nameCorpus, rng });
        if (!usedPrefixes.has(candidate)) { prefix = candidate; break; }
      }
      if (!prefix) prefix = `${generateEmailPrefix({ nameCorpus, rng })}${Date.now() % 1000}`;
      usedPrefixes.add(prefix);

      const email = `${prefix}${domain}`;
      addresses.push({ email, domain, id: md5EmailId(email) });
    }

    return { addresses, requested, allocated, available, capped };
  }

  /**
   * Convenience wrapper: allocate a "reasonable" random batch size.
   *
   * Default behaviour is `min .. max` uniformly at random. This is the
   * entrypoint bulk-register jobs use when the operator has not specified
   * an explicit count — the automation picks a number, then calls into
   * `allocateUniqueAddresses` which will gracefully cap if Privatix does
   * not currently expose that many domains.
   *
   * Real-world Privatix domain count fluctuates roughly in the 8-15 range,
   * so requesting 20-30 will almost always trigger the `capped` path. That
   * is intentional: we want the automation to soak up whatever unique
   * domain surface Privatix currently exposes, without the operator having
   * to poll the domain list first.
   *
   * @param {object}  [options]
   * @param {number}  [options.min]  Lower bound of the random range (inclusive).
   * @param {number}  [options.max]  Upper bound (inclusive).
   * @param {() => number} [options.countRng]  Deterministic RNG for the count
   *                                            pick (0..1). Domain-shuffle and
   *                                            prefix RNGs are separate.
   * @param {string[]} [options.nameCorpus]
   * @param {() => number} [options.rng]
   * @param {() => number} [options.domainRng]
   * @returns {Promise<Awaited<ReturnType<PrivatixTempMailClient["allocateUniqueAddresses"]>>>}
   */
  async allocateRandomBatch({
    min = 20,
    max = 30,
    countRng = Math.random,
    nameCorpus,
    rng,
    domainRng,
  } = {}) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
      throw new Error("allocateRandomBatch requires 1 <= min <= max");
    }
    const span = max - min + 1;
    const requested = min + Math.floor(countRng() * span);
    return this.allocateUniqueAddresses(requested, { nameCorpus, rng, domainRng });
  }

  /** List all messages currently addressed to {emailOrId}. */
  async listMessages(emailOrId) {
    const id = emailOrId.includes("@") ? md5EmailId(emailOrId) : String(emailOrId);
    const { data } = await this._get(`/request/mail/id/${id}/`);
    if (!Array.isArray(data)) return [];
    return data;
  }

  /**
   * Delete a specific message (best-effort). Privatix implements this as a
   * GET-with-side-effect at /request/delete/id/{mail_id}/ — unusual but that
   * is exactly how their curl reference and RapidAPI playground document it.
   */
  async deleteMessage(mailId) {
    if (!mailId) return false;
    try {
      await this._get(`/request/delete/id/${encodeURIComponent(mailId)}/`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Poll the inbox until a message matching `senderMatch` arrives, then
   * extract an OTP (and optionally a confirm URL) from its body.
   *
   * Returns { code, confirmUrl, message } on hit, or null on timeout. Failed
   * HTTP requests are surfaced through the `onStep` callback but do not stop
   * polling — the next tick just tries again.
   */
  async waitForOtp(emailOrId, {
    senderMatch = "",
    otpPattern,
    confirmUrlPattern,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = this.pollIntervalMs,
    onStep = null,
    deleteAfterRead = true,
  } = {}) {
    const senderNeedle = String(senderMatch || "").toLowerCase();
    const start = Date.now();
    onStep?.("tempmail_waiting", `Polling Privatix inbox for ${emailOrId} (timeout=${Math.round(timeoutMs / 1000)}s)`);

    while (Date.now() - start < timeoutMs) {
      let messages = [];
      try {
        messages = await this.listMessages(emailOrId);
      } catch (err) {
        onStep?.("tempmail_error", `Privatix poll error: ${err?.message || err}`);
      }

      for (const message of messages) {
        const from = String(message?.mail_from || "").toLowerCase();
        if (senderNeedle && !from.includes(senderNeedle)) continue;

        const body = message?.mail_text_only || message?.mail_html || message?.mail_subject || "";
        const code = extractOtp(body, otpPattern ? { otpPattern } : {});
        if (!code && !confirmUrlPattern) continue;
        const confirmUrl = extractConfirmUrl(body, confirmUrlPattern);
        if (!code && !confirmUrl) continue;

        if (deleteAfterRead && message?.mail_id) {
          this.deleteMessage(message.mail_id).catch(() => null);
        }
        onStep?.(
          "tempmail_received",
          confirmUrl ? `Received OTP for ${emailOrId} (+ direct-confirm URL)` : `Received OTP ${code} for ${emailOrId}`
        );
        return { code, confirmUrl: confirmUrl || null, message };
      }

      const remaining = timeoutMs - (Date.now() - start);
      const sleep = Math.max(0, Math.min(pollIntervalMs, remaining));
      if (sleep <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }

    onStep?.("tempmail_timeout", `Timed out waiting for OTP after ${Math.round(timeoutMs / 1000)}s`);
    return null;
  }
}

/**
 * Build a client from process.env. Returns null when TEMPMAIL_RAPIDAPI_KEY is
 * missing so callers can degrade to needs_manual instead of crashing.
 */
export function tempMailClientFromEnv(overrides = {}) {
  const apiKey = process.env.TEMPMAIL_RAPIDAPI_KEY || "";
  if (!apiKey) return null;
  return new PrivatixTempMailClient({ apiKey, ...overrides });
}
