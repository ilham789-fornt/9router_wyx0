/**
 * tempMailOrgClient.js — temp-mail.org DOM-based client (no RapidAPI).
 *
 * TWO transport modes are supported:
 *
 *   • "dom" (DEFAULT for tempmailorg provider): drives temp-mail.org's
 *     WEBSITE via a Camoufox page. Reads the current email address off the
 *     DOM (visible in the "Your Temporary Email Address" input field),
 *     polls the inbox by observing the messages list DOM, opens messages
 *     to extract body text. This mimics what a real user does in the
 *     browser and is completely immune to the web2 API changes we hit
 *     during previous integration attempts. Cloudflare's Bot Fight also
 *     lets Camoufox through because it IS a real Firefox process.
 *
 *   • "http" (legacy, kept for interface completeness): plain HTTP calls
 *     against web2.temp-mail.org. This path is Cloudflare-blocked from
 *     Node fetch and the underlying API contract has drifted since 2024,
 *     so it is effectively unused. Retained only so existing tests /
 *     integration points that pass a fetch mock keep compiling.
 *
 * Why we use temp-mail.org over Privatix (RapidAPI):
 *   Privatix's 10 rotating domains (@amozix.com, @cevipsa.com, …) have
 *   been used for years as disposable-email farms → GitHub's abuse team
 *   blocklists them at signup time, causing accounts to be shadow-banned
 *   within seconds of creation. temp-mail.org's website rotates through a
 *   larger, less-flagged pool (e.g. @kierko.com, @jobraux.com, verified
 *   working across multiple manual GitHub signups by the operator).
 *
 * Public API mirrors PrivatixTempMailClient so the register manager can
 * accept either client through a common interface:
 *   - allocateAddress()                → { email, domain, id }
 *   - allocateUniqueAddresses(count)   → { addresses, requested, allocated,
 *                                          available, capped }
 *   - allocateRandomBatch(opts)        → wraps allocateUniqueAddresses with
 *                                          a random count in [min, max]
 *   - listMessages(emailOrId)          → array of message previews
 *   - deleteMessage(mailId)            → no-op
 *   - waitForOtp(emailOrId, opts)      → poll for OTP by sender substring
 *
 * For DOM mode, `id` is the email address itself (there is no separate
 * token — the browser session's cookies own the mailbox).
 */

const DEFAULT_BASE_URL = "https://web2.temp-mail.org";
const DEFAULT_HOMEPAGE_URL = "https://temp-mail.org/";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_ALLOCATE_MAX_ATTEMPTS = 40;

// ── DOM selectors (defensive; the site updates its markup periodically) ────
//
// We probe multiple candidates because temp-mail.org has redesigned the UI
// several times. The first selector that matches wins. Order goes from most
// specific/stable to most generic fallback.
const DOM_EMAIL_INPUT_SELECTORS = [
  '#mail',                             // classic id
  'input[id="mail"]',
  'input[name="mail"]',
  'input[readonly][class*="mail"]',
  'input[data-testid*="mail" i]',
  'input[aria-label*="email" i]',
  '.email-address input',
  '.mailbox-input',
  '[data-original-title*="Copy" i] + input',
  // Fallback: any text input that shows an @ somewhere.
  'input[type="text"][value*="@"]',
];

const DOM_CHANGE_BUTTON_SELECTORS = [
  '#click-to-change',
  'button:has-text("Change")',
  'button[aria-label*="Change" i]',
  'a:has-text("Change")',
  '.change-mail',
];

// The visible "Refresh" button on temp-mail.org. The UI is often
// localized (English/Russian/Indonesian, seen in real screenshots) so we
// match the English label and fall back to icon-only selectors.
const DOM_REFRESH_BUTTON_SELECTORS = [
  '#click-to-refresh',
  'button.refresh',
  'button[data-testid*="refresh" i]',
  'button[aria-label*="Refresh" i]',
  'button:has-text("Refresh")',
  'button:has-text("Обновить")',
  'button:has-text("Segarkan")',   // Indonesian
  'button:has-text("Muat Ulang")',
  'a:has-text("Refresh")',
  '.refresh-mail',
  '[role="button"]:has-text("Refresh")',
  '[role="button"]:has-text("Segarkan")',
  '[role="button"]:has-text("Muat Ulang")',
];

// Rows of messages in the inbox pane. Real UI (screenshot 1, Dec 2025):
// each email row is inside a container that lists sender, subject, and an
// arrow to open. Sender email lives in the row too so we can filter with
// haystack.includes("github").
const DOM_MESSAGE_ROW_SELECTORS = [
  // Modern UI: rows are direct clickable elements with the noreply address
  // visible in the row body. Prefer more specific selectors first.
  'a[href*="/mailbox"] tr',
  'tbody tr[data-id]',
  'tbody tr:has(a[href*="mail"])',
  '.inbox-dataList li',
  '.inbox-dataList tr',
  '.inbox li',
  '.inbox tr',
  '.inboxSection li',
  '[data-msg-id]',
  // Very generic fallback: any <tr> whose text contains "@" (an email addr)
  // in a scrollable container. Kept last so it never wins over the
  // specific selectors above.
  'tr:has(td:has-text("@"))',
];

const DOM_MESSAGE_SENDER_SELECTORS = [
  '.sender', '.from', '[class*="sender"]', '[data-field="from"]',
  // The visible column header in Indonesian is "PENGIRIM" — its cells
  // are typically the first <td> in the row.
  'td:nth-child(1)',
];
const DOM_MESSAGE_SUBJECT_SELECTORS = [
  '.subject', '.title', '[class*="subject"]', '[data-field="subject"]',
  // Second column ("POKOK" in Indonesian).
  'td:nth-child(2)',
];

// Message body view — text container after clicking a row. Real UI
// (screenshots 2 & 3) shows body text inside a large panel with the OTP
// rendered as plain text. Sometimes the body is in an iframe, sometimes
// inline; we probe both.
const DOM_MESSAGE_BODY_SELECTORS = [
  '.message-content',
  '.inbox-message-body',
  '.email-content',
  '[class*="message-body"]',
  '#message-body',
  // Modern iframe pattern.
  'iframe[title*="message" i]',
  'iframe[src*="message" i]',
  // Fallback: the main content region after row click.
  'main',
  'article',
];

// "Back to list" button — real screenshot 3 shows "KEMBALI KE DAFTAR"
// (Indonesian). We probe multiple locales so subsequent poll ticks can
// return to the inbox list.
const DOM_BACK_TO_LIST_SELECTORS = [
  'button:has-text("KEMBALI KE DAFTAR")',
  'a:has-text("KEMBALI KE DAFTAR")',
  'button:has-text("Back to list")',
  'a:has-text("Back to list")',
  'button:has-text("Back")',
  'a:has-text("Back")',
  '[aria-label*="back" i]',
  '.back-to-list',
];

// Headers copied from the reference reverse-engineered client. Servers
// occasionally 403 the raw fetch UA — the browser-style headers below have
// been stable for the reference clients over multiple months. Note that
// web2.temp-mail.org sits behind Cloudflare Bot Fight, so a plain Node
// fetch with these headers will STILL be blocked (challenge_platform)
// unless it carries a valid cf_clearance cookie. To defeat Cloudflare, run
// the request through a Camoufox page context (see setBrowserTransport).
const DEFAULT_HEADERS = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.6",
  "content-type": "application/json",
  "priority": "u=1, i",
  "sec-ch-ua": "\"Not(A:Brand\";v=\"99\", \"Brave\";v=\"133\", \"Chromium\";v=\"133\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "\"Windows\"",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "sec-gpc": "1",
  "Referer": "https://temp-mail.org/",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// ── Transport strategies ───────────────────────────────────────────────────
//
// The client's HTTP layer is pluggable: any object with `.fetchJson(url,
// { method, headers, body })` returning `{ status, ok, text }` works. We
// ship two implementations:
//
//   nodeTransport(fetchImpl)     → uses Node's fetch directly. Fast, but
//                                   blocked by Cloudflare Bot Fight on
//                                   web2.temp-mail.org (403 challenge).
//
//   browserTransport(page)       → runs fetch INSIDE a Camoufox page via
//                                   page.evaluate(). The browser process
//                                   already carries a valid cf_clearance
//                                   cookie (from prior page visits) and a
//                                   real Firefox TLS fingerprint, so
//                                   Cloudflare's challenge passes without
//                                   any explicit solver step.
//
// The register manager creates the client in Node-transport mode at boot,
// then swaps to browser-transport after Camoufox is launched — see
// setBrowserTransport() below.

export function nodeTransport(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("nodeTransport requires a fetch implementation");
  }
  return {
    kind: "node",
    async fetchJson(url, { method = "GET", headers = {}, body } = {}) {
      const response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text().catch(() => "");
      return { status: response.status, ok: response.ok, text };
    },
  };
}

/**
 * Build a transport that dispatches requests THROUGH a Camoufox page. The
 * page must already be at some page under temp-mail.org (any subpath —
 * the / homepage works) so it carries the cf_clearance cookie.
 *
 * The transport uses page.evaluate to execute fetch() inside the page's
 * origin. This bypasses:
 *   • Cloudflare Bot Fight (browser TLS fingerprint + cf_clearance cookie)
 *   • CORS (fetch is same-origin from the page's POV)
 *   • Node's inability to hold onto Cloudflare's rotating cookies
 *
 * Caller is responsible for keeping the page alive between requests.
 */
export function browserTransport(page) {
  if (!page || typeof page.evaluate !== "function") {
    throw new Error("browserTransport requires a Playwright/Camoufox page");
  }
  return {
    kind: "browser",
    page,
    async fetchJson(url, { method = "GET", headers = {}, body } = {}) {
      // The evaluate callback runs inside the browser context. We pass a
      // plain-object argument (fetch-ready init) and let the page fetch
      // for us. The result is JSON.stringify-round-trip-safe.
      const requestInit = {
        method,
        headers,
        // fetch() inside the page still needs a string body.
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "include",
      };
      const result = await page.evaluate(async ([targetUrl, init]) => {
        try {
          const response = await fetch(targetUrl, init);
          const text = await response.text();
          return {
            status: response.status,
            ok: response.ok,
            text,
          };
        } catch (err) {
          return { status: 0, ok: false, text: "", error: String(err?.message || err) };
        }
      }, [url, requestInit]);
      if (result?.error && result.status === 0) {
        throw new Error(`browserTransport network error: ${result.error}`);
      }
      return result;
    },
  };
}

// ── OTP extraction helpers (identical strategy to tempMailClient.js) ───────
//
// We re-export slim copies so the two clients can be swapped without the
// caller having to import extractOtp / extractConfirmUrl separately from
// one or the other. Deliberately duplicated (not moved to a shared module)
// so future divergence between provider quirks stays local.

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

export function extractConfirmUrl(body, confirmUrlPattern) {
  if (!confirmUrlPattern) return null;
  const re = confirmUrlPattern instanceof RegExp ? confirmUrlPattern : new RegExp(confirmUrlPattern);
  const match = String(body || "").match(re);
  return match ? match[0] : null;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class TempMailOrgClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    transport = null,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxRetries = 3,
    headers = DEFAULT_HEADERS,
  } = {}) {
    // Transport precedence:
    //   1. Explicit `transport` (tests / browser-transport upgrade).
    //   2. `fetchImpl` wrapped in nodeTransport (default, Cloudflare-blocked).
    if (transport) {
      if (typeof transport.fetchJson !== "function") {
        throw new Error("TempMailOrgClient transport must expose fetchJson()");
      }
      this.transport = transport;
    } else {
      this.transport = nodeTransport(fetchImpl);
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.pollIntervalMs = pollIntervalMs;
    this.maxRetries = maxRetries;
    this.baseHeaders = { ...headers };
    // Map from email address → bearer token, so subsequent listMessages
    // calls on the same address reuse the token without a new /mailbox
    // provision. Cleared when the process restarts.
    this._tokensByEmail = new Map();
  }

  /**
   * Swap the transport at runtime — used by the register manager once
   * Camoufox is launched and the page has visited temp-mail.org (thereby
   * acquiring the cf_clearance cookie). Returns `this` for chaining.
   */
  setTransport(transport) {
    if (!transport || typeof transport.fetchJson !== "function") {
      throw new Error("setTransport requires an object with a fetchJson() method");
    }
    this.transport = transport;
    return this;
  }

  /**
   * Swap to a browser-backed transport. The `page` must already be at
   * some URL under temp-mail.org (typically the root https://temp-mail.org/)
   * so the Cloudflare clearance cookie is set for this browser context.
   */
  setBrowserTransport(page) {
    return this.setTransport(browserTransport(page));
  }

  // Note: temp-mail.org rejects requests without the browser-shaped headers
  // above. We keep them per-request rather than per-client so tests can
  // pass a fetch spy without smuggling in extra headers.
  _headers({ token = null } = {}) {
    const headers = { ...this.baseHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  async _request(path, { method = "GET", token = null, body = undefined } = {}) {
    const url = `${this.baseUrl}${path}`;
    let lastError = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      let result;
      try {
        result = await this.transport.fetchJson(url, {
          method,
          headers: this._headers({ token }),
          body,
        });
      } catch (err) {
        lastError = err;
        // Transport-level error — exponential back-off and try again.
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1) ** 2));
        continue;
      }

      let data = null;
      if (result?.text) {
        try { data = JSON.parse(result.text); } catch { data = result.text; }
      }
      if (!result.ok) {
        const message = typeof data === "string" ? data : (data?.errorMessage || data?.message || `HTTP ${result.status}`);
        const err = new Error(`temp-mail.org request failed: ${message}`);
        err.status = result.status;
        err.body = data;
        // 4xx errors are terminal — no point retrying a bad request.
        if (result.status >= 400 && result.status < 500) throw err;
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1) ** 2));
        continue;
      }
      return { status: result.status, data };
    }
    throw lastError || new Error("temp-mail.org request failed after retries");
  }

  /**
   * Provision ONE fresh mailbox. Returns { email, domain, id: token }.
   *
   * `id` is the temp-mail.org bearer token — every subsequent listMessages
   * call must present it. Callers should carry `{ email, id }` together so
   * a stateless caller can still reach the mailbox after client restart.
   */
  async allocateAddress() {
    const { data } = await this._request("/mailbox", { method: "POST" });
    const email = String(data?.mailbox || "").trim();
    const token = String(data?.token || "").trim();
    if (!email || !token) {
      throw new Error("temp-mail.org /mailbox returned an incomplete response");
    }
    const atIndex = email.lastIndexOf("@");
    const domain = atIndex >= 0 ? email.slice(atIndex) : "";
    this._tokensByEmail.set(email, token);
    return { email, domain, id: token };
  }

  /**
   * Allocate up to `count` mailboxes, each on a DIFFERENT domain. Because
   * the server chooses the domain, we call /mailbox in a loop and drop any
   * response whose domain we already have. We stop as soon as we hit
   * `count` unique domains OR the `maxAttempts` retry ceiling.
   *
   * Returns the same shape as PrivatixTempMailClient.allocateUniqueAddresses:
   *   { addresses, requested, allocated, available, capped }
   *
   * Notes:
   *   • `available` is best-effort: we do NOT ask the server how many
   *     domains it has — we return the count of distinct domains we
   *     observed during allocation. When the caller asks for 3 and gets 3,
   *     `available` will be 3; when they ask for 30 and only 12 unique
   *     domains show up before we exhaust retries, `available` = 12.
   *   • `capped` is true whenever allocated < requested.
   */
  async allocateUniqueAddresses(count, {
    maxAttempts = DEFAULT_ALLOCATE_MAX_ATTEMPTS,
  } = {}) {
    const requested = Number.parseInt(count, 10);
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("allocateUniqueAddresses requires a positive integer count");
    }

    const seenDomains = new Set();
    const addresses = [];
    let attempts = 0;
    let consecutiveDuplicates = 0;

    while (addresses.length < requested && attempts < maxAttempts) {
      attempts += 1;
      let allocated;
      try {
        allocated = await this.allocateAddress();
      } catch (err) {
        // Bubble up terminal server errors; retries at this layer are
        // already handled by _request's internal loop.
        if (attempts >= maxAttempts) throw err;
        continue;
      }
      if (!allocated?.domain) continue;
      if (seenDomains.has(allocated.domain)) {
        consecutiveDuplicates += 1;
        // If we keep getting duplicates in a row, the server's rotation is
        // stuck on a small subset — bail out early instead of hammering.
        if (consecutiveDuplicates >= 8) break;
        continue;
      }
      seenDomains.add(allocated.domain);
      addresses.push(allocated);
      consecutiveDuplicates = 0;
    }

    const allocatedCount = addresses.length;
    const capped = allocatedCount < requested;
    return {
      addresses,
      requested,
      allocated: allocatedCount,
      available: seenDomains.size,
      capped,
    };
  }

  /**
   * Convenience wrapper: allocate a random-size batch in [min, max]. Same
   * contract as PrivatixTempMailClient.allocateRandomBatch.
   */
  async allocateRandomBatch({
    min = 20,
    max = 30,
    countRng = Math.random,
    maxAttempts,
  } = {}) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
      throw new Error("allocateRandomBatch requires 1 <= min <= max");
    }
    const span = max - min + 1;
    const requested = min + Math.floor(countRng() * span);
    return this.allocateUniqueAddresses(requested, { maxAttempts });
  }

  /**
   * List messages in the mailbox identified by `emailOrToken`.
   *
   * The temp-mail.org contract identifies mailboxes by their bearer token,
   * NOT by email address. Callers should pass whatever they saved from
   * `allocateAddress().id`. As a convenience we also accept the email
   * string if it was allocated by THIS client instance (we remember the
   * token in `_tokensByEmail`).
   */
  async listMessages(emailOrToken) {
    const token = this._resolveToken(emailOrToken);
    const { data } = await this._request("/messages", { token });
    // temp-mail.org's actual response shape is either an array directly or
    // { messages: [...] }. Handle both defensively.
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.messages)) return data.messages;
    return [];
  }

  /**
   * Fetch a full message by its _id. temp-mail.org returns bodyText and
   * bodyHtml in the same payload.
   */
  async readMessage(messageId, emailOrToken) {
    if (!messageId) return null;
    const token = this._resolveToken(emailOrToken);
    const { data } = await this._request(`/messages/${encodeURIComponent(messageId)}`, { token });
    return data;
  }

  /**
   * No-op — temp-mail.org's web2 API does not expose a delete endpoint.
   * Kept for interface parity with PrivatixTempMailClient.
   */
  async deleteMessage() { return true; }

  /**
   * Poll the mailbox until a message from `senderMatch` arrives, then
   * extract the OTP (and optionally a direct-confirm URL) from its body.
   * Contract matches PrivatixTempMailClient.waitForOtp verbatim.
   */
  async waitForOtp(emailOrToken, {
    senderMatch = "",
    otpPattern,
    confirmUrlPattern,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = this.pollIntervalMs,
    onStep = null,
  } = {}) {
    const senderNeedle = String(senderMatch || "").toLowerCase();
    const start = Date.now();
    onStep?.("tempmail_waiting", `Polling temp-mail.org inbox (timeout=${Math.round(timeoutMs / 1000)}s)`);

    const token = this._resolveToken(emailOrToken);

    while (Date.now() - start < timeoutMs) {
      let messages = [];
      try {
        messages = await this._listMessagesByToken(token);
      } catch (err) {
        onStep?.("tempmail_error", `temp-mail.org poll error: ${err?.message || err}`);
      }

      for (const preview of messages) {
        const from = String(preview?.from || preview?.mail_from || "").toLowerCase();
        if (senderNeedle && !from.includes(senderNeedle)) continue;

        // Grab the full body — the list endpoint only returns a preview.
        let full = preview;
        if (preview?._id) {
          try {
            full = await this.readMessage(preview._id, token) || preview;
          } catch (err) {
            onStep?.("tempmail_read_error", `Failed to fetch full message: ${err?.message || err}`);
          }
        }

        const body = full?.bodyText || full?.mail_text_only || full?.bodyHtml || full?.mail_html || full?.bodyPreview || "";
        const code = extractOtp(body, otpPattern ? { otpPattern } : {});
        const confirmUrl = extractConfirmUrl(body, confirmUrlPattern);
        if (!code && !confirmUrl) continue;

        onStep?.(
          "tempmail_received",
          confirmUrl ? "Received OTP + direct-confirm URL" : `Received OTP ${code}`
        );
        return { code, confirmUrl: confirmUrl || null, message: full };
      }

      const remaining = timeoutMs - (Date.now() - start);
      const sleep = Math.max(0, Math.min(pollIntervalMs, remaining));
      if (sleep <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
    onStep?.("tempmail_timeout", `Timed out waiting for OTP after ${Math.round(timeoutMs / 1000)}s`);
    return null;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  _resolveToken(emailOrToken) {
    const value = String(emailOrToken || "");
    if (!value) throw new Error("temp-mail.org operations require an email or token");
    if (value.includes("@")) {
      const token = this._tokensByEmail.get(value);
      if (!token) {
        throw new Error(
          `No token cached for ${value}. Pass the token returned from allocateAddress() instead of the email.`
        );
      }
      return token;
    }
    return value;
  }

  async _listMessagesByToken(token) {
    const { data } = await this._request("/messages", { token });
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.messages)) return data.messages;
    return [];
  }
}

// ── DOM-driven client (recommended path) ──────────────────────────────────
//
// TempMailOrgDomClient reproduces the same PublicAPI as TempMailOrgClient
// but instead of hitting web2.temp-mail.org over HTTP it drives the
// temp-mail.org website itself through a Camoufox page. This is what a
// human user does — read the email address off the page, click Refresh
// to poll for new mail, click a row to open a message.
//
// Requirements:
//   • Caller must bind a Camoufox page via `setPage(page)` BEFORE any
//     allocation. The page must have already visited temp-mail.org so it
//     carries the cf_clearance cookie (the register manager handles this
//     inside _allocateTempMailForAccount).
//   • Address `id` returned equals the email string. Callers that stash
//     the id and pass it back get identical behavior to a token-based
//     handle, because DOM-mode uses the bound page's cookies as identity.

export class TempMailOrgDomClient {
  constructor({ homepageUrl = DEFAULT_HOMEPAGE_URL } = {}) {
    this.homepageUrl = homepageUrl;
    /** @type {import("playwright").Page|null} */
    this._page = null;
    this._boundEmail = null;
    this._seenDomains = new Set();
  }

  /**
   * Bind (or rebind) the Camoufox page this DOM client operates on. If the
   * page is not yet on temp-mail.org, we navigate to it here.
   */
  async setPage(page, { ensureHomepage = true } = {}) {
    if (!page || typeof page.locator !== "function") {
      throw new Error("TempMailOrgDomClient.setPage requires a Playwright/Camoufox page");
    }
    this._page = page;
    if (ensureHomepage) {
      const currentUrl = String(page.url?.() || "");
      if (!/temp-mail\.org/i.test(currentUrl)) {
        await page.goto(this.homepageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState?.("networkidle", { timeout: 15_000 }).catch(() => null);
        await page.waitForTimeout?.(1500);
      }
    }
    return this;
  }

  _requirePage() {
    if (!this._page) {
      throw new Error(
        "TempMailOrgDomClient is not bound to a Camoufox page. Call setPage(page) first."
      );
    }
    return this._page;
  }

  async _readEmailFromDom({ timeoutMs = 20_000 } = {}) {
    const page = this._requirePage();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Strategy A: known selector list (fast path).
      for (const selector of DOM_EMAIL_INPUT_SELECTORS) {
        try {
          const locator = page.locator(selector).first();
          const count = await locator.count().catch(() => 0);
          if (!count) continue;
          const value = await locator.inputValue?.().catch(() => null);
          const text = value && value.includes("@")
            ? value
            : (await locator.textContent?.().catch(() => null))?.trim();
          if (text && text.includes("@") && !text.includes(" ")) return text;
        } catch { /* try next selector */ }
      }

      // Strategy B: brute-force page-wide scan via page.evaluate. Runs
      // inside the browser context and walks EVERY input + text-holding
      // element looking for an "<name>@<domain>" that is not obviously
      // part of a paragraph / instruction. Screenshot 1 shows the address
      // rendered inside a read-only input; on other UI variants the
      // temp-mail.org homepage renders it inside <span> / <div>, so we
      // cannot rely on one selector shape.
      //
      // Rules:
      //   • The text must match /^\S+@\S+\.\S+$/ (single-token email).
      //   • Prefer values from <input> elements — those are the visible
      //     "current mailbox" input the user sees.
      //   • Fall back to any element whose text content is exactly one
      //     email address.
      try {
        const scanned = await page.evaluate(() => {
          const emailRe = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
          const looseRe = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;
          // First: prefer <input> and <textarea> values.
          for (const el of document.querySelectorAll("input, textarea")) {
            const v = String(el.value || "").trim();
            if (v && emailRe.test(v)) return { source: "input.value", value: v };
          }
          // Second: any element whose entire textContent is one email.
          for (const el of document.querySelectorAll("span, div, p, td, code, strong, b")) {
            const t = String(el.textContent || "").trim();
            if (t && emailRe.test(t)) return { source: "element.text", value: t };
          }
          // Third: elements whose textContent contains an email in a very
          // short string (< 60 chars). This catches labels like "Your
          // Temporary Email: xxx@yy.com" where the email is embedded.
          for (const el of document.querySelectorAll("span, div, p, td, code, strong, b, h1, h2, h3, h4")) {
            const t = String(el.textContent || "").trim();
            if (t.length > 0 && t.length <= 80) {
              const m = t.match(looseRe);
              if (m) return { source: "embedded.text", value: m[0], full: t };
            }
          }
          return null;
        }).catch(() => null);

        if (scanned?.value) return scanned.value;
      } catch { /* ignore, poll again */ }

      await page.waitForTimeout?.(500);
    }
    return null;
  }

  async _clickFirstVisible(page, selectors, { timeoutMs = 4_000 } = {}) {
    // Strategy A: Playwright locator match on the known-good selector list.
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        const count = await locator.count().catch(() => 0);
        if (!count) continue;
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) continue;
        await locator.click({ timeout: timeoutMs }).catch(() => null);
        return true;
      } catch { /* try next */ }
    }
    // Strategy B: JS-side scan. temp-mail.org occasionally ships new
    // markup where the Refresh button is a <div role="button"> with
    // Material Icon text or an SVG only — none of the selectors above
    // would match. We evaluate a broad predicate in the page: for the
    // list of selectors that carried a text match, look for ANY element
    // whose visible text OR aria-label contains one of those keywords.
    // Keywords are extracted from the selector list itself so this
    // helper stays generic (works for Refresh, Change, Back-to-List, …).
    const keywords = selectors
      .map((s) => {
        const m = /has-text\("([^"]+)"\)|"([^"]+)"/.exec(s);
        return m ? (m[1] || m[2]) : null;
      })
      .filter(Boolean);
    if (keywords.length === 0) return false;

    try {
      const clicked = await page.evaluate((needles) => {
        const lowerNeedles = needles.map((n) => n.toLowerCase());
        const clickable = document.querySelectorAll(
          "button, a, [role='button'], [role='link'], div[onclick], span[onclick], div[data-testid], .btn, .Button"
        );
        for (const el of clickable) {
          if (!(el instanceof HTMLElement)) continue;
          const text = String(el.innerText || el.textContent || "").toLowerCase();
          const ariaLabel = String(el.getAttribute("aria-label") || "").toLowerCase();
          const title = String(el.getAttribute("title") || "").toLowerCase();
          const haystack = `${text} ${ariaLabel} ${title}`;
          if (lowerNeedles.some((n) => haystack.includes(n))) {
            // Rect check — skip hidden elements.
            const rect = el.getBoundingClientRect();
            if (rect.width < 3 || rect.height < 3) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
            el.click();
            return true;
          }
        }
        return false;
      }, keywords).catch(() => false);
      return Boolean(clicked);
    } catch { return false; }
  }

  async allocateAddress() {
    const page = this._requirePage();
    // If we already read an address on this page and it's still visible,
    // clicking "Change" gives us a fresh one on (potentially) a new domain.
    if (this._boundEmail) {
      await this._clickFirstVisible(page, DOM_CHANGE_BUTTON_SELECTORS);
      // The Change button triggers an in-page network call + DOM swap; the
      // email input momentarily loses focus/value before repopulating.
      await page.waitForTimeout?.(1500);
    }
    const email = await this._readEmailFromDom();
    if (!email) {
      throw new Error("Could not locate the temp-mail.org email address in the page DOM");
    }
    if (this._boundEmail === email) {
      // The Change click did not actually rotate the address. Wait and read once more.
      await page.waitForTimeout?.(1500);
      const refreshed = await this._readEmailFromDom();
      if (refreshed && refreshed !== this._boundEmail) return this._buildAddress(refreshed);
    }
    return this._buildAddress(email);
  }

  _buildAddress(email) {
    const atIndex = email.lastIndexOf("@");
    const domain = atIndex >= 0 ? email.slice(atIndex) : "";
    this._boundEmail = email;
    this._seenDomains.add(domain);
    // In DOM mode, the address IS the identifier — no separate token.
    return { email, domain, id: email };
  }

  async allocateUniqueAddresses(count, { maxAttempts = DEFAULT_ALLOCATE_MAX_ATTEMPTS } = {}) {
    const requested = Number.parseInt(count, 10);
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("allocateUniqueAddresses requires a positive integer count");
    }

    const domains = new Set();
    const addresses = [];
    let attempts = 0;
    let consecutiveDuplicates = 0;
    while (addresses.length < requested && attempts < maxAttempts) {
      attempts += 1;
      const addr = await this.allocateAddress();
      if (!addr?.domain) continue;
      if (domains.has(addr.domain)) {
        consecutiveDuplicates += 1;
        if (consecutiveDuplicates >= 8) break;
        continue;
      }
      domains.add(addr.domain);
      addresses.push(addr);
      consecutiveDuplicates = 0;
    }
    return {
      addresses,
      requested,
      allocated: addresses.length,
      available: domains.size,
      capped: addresses.length < requested,
    };
  }

  async allocateRandomBatch({ min = 20, max = 30, countRng = Math.random, maxAttempts } = {}) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
      throw new Error("allocateRandomBatch requires 1 <= min <= max");
    }
    const requested = min + Math.floor(countRng() * (max - min + 1));
    return this.allocateUniqueAddresses(requested, { maxAttempts });
  }

  async listMessages(_emailOrId) {
    // In DOM mode the mailbox identity is the bound page — we ignore the
    // argument and read whatever the page currently shows. We prefer the
    // structured selector list but ALSO fall back to a JS-side row scan
    // using page.evaluate() so brand-new UI markup still yields rows.
    const page = this._requirePage();

    // Structured selector attempt first — cheaper than evaluate().
    for (const rowSelector of DOM_MESSAGE_ROW_SELECTORS) {
      try {
        const locators = await page.locator(rowSelector).all().catch(() => []);
        if (!locators.length) continue;
        const rows = [];
        for (let i = 0; i < locators.length; i += 1) {
          const row = locators[i];
          const sender = await this._readTextFrom(row, DOM_MESSAGE_SENDER_SELECTORS);
          const subject = await this._readTextFrom(row, DOM_MESSAGE_SUBJECT_SELECTORS);
          const combinedText = (await row.textContent().catch(() => "")) || "";
          rows.push({
            _id: `dom-${i}`,
            from: sender || (combinedText.match(/[\w.+-]+@[\w.-]+/)?.[0] || ""),
            subject: subject || "",
            bodyPreview: subject || combinedText.slice(0, 120),
            _rowLocator: row,
            _rowText: combinedText,
          });
        }
        // Only return non-empty rows AND at least one row must contain an @
        // to be a plausible inbox listing.
        if (rows.some((r) => r._rowText?.includes("@"))) return rows;
      } catch { /* try next selector */ }
    }

    // Evaluate-based fallback: walk every clickable element on the page
    // and return only those whose text contains an email + a subject-like
    // string. The register manager only needs the sender + subject to
    // decide which row to click, and clicking is done via the row locator
    // we synthesize via nth-of-type once the caller commits to a hit.
    try {
      const scanned = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        const emailRe = /[\w.+-]+@[\w.-]+/;
        // Consider clickable rows: tr, li, a[href], [role="button"], div[data-msg-id].
        const candidates = document.querySelectorAll(
          "tr, li, a[href], [role='button'], [data-msg-id]"
        );
        for (const el of candidates) {
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || !emailRe.test(text)) continue;
          if (text.length > 400) continue; // full-page fallthrough guard
          if (seen.has(text)) continue;
          seen.add(text);
          const sender = text.match(emailRe)?.[0] || "";
          // Subject heuristic: the substring between the sender email and
          // any trailing arrow/date. Not perfect but adequate for filtering.
          const withoutSender = text.replace(emailRe, "").trim();
          out.push({
            text,
            sender,
            subject: withoutSender.slice(0, 200),
          });
        }
        return out;
      }).catch(() => []);
      if (Array.isArray(scanned) && scanned.length > 0) {
        return scanned.map((entry, index) => ({
          _id: `eval-${index}`,
          from: entry.sender || "",
          subject: entry.subject || "",
          bodyPreview: entry.text.slice(0, 200),
          _rowText: entry.text,
          // Row locator is synthesized below when the caller actually
          // wants to click this row. We store the visible text so we can
          // match a locator by :has-text.
          _rowLocatorHint: entry.text.slice(0, 60),
        }));
      }
    } catch { /* ignore */ }

    return [];
  }

  async _readTextFrom(rowLocator, selectors) {
    for (const selector of selectors) {
      try {
        const inner = rowLocator.locator(selector).first();
        const count = await inner.count().catch(() => 0);
        if (!count) continue;
        const text = (await inner.textContent().catch(() => ""))?.trim();
        if (text) return text;
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * Open the message in the browser and read its body. The caller may
   * pass a row locator directly (from listMessages structured mode) or a
   * text hint that we use to synthesize a locator (from the evaluate
   * fallback path). Returns { bodyText, bodyHtml, directConfirmUrl }
   * where directConfirmUrl is the pre-extracted GitHub confirm URL — real
   * screenshot 2 confirms that URL is embedded as a plain <a href> below
   * the OTP so we grab it directly instead of hoping the caller's regex
   * matches it later.
   */
  async readMessage(_messageId, _emailOrToken, { rowLocator, rowLocatorHint } = {}) {
    const page = this._requirePage();
    // Click the row so the detail pane shows up.
    let clicked = false;
    if (rowLocator && typeof rowLocator.click === "function") {
      await rowLocator.click({ timeout: 4_000 }).catch(() => null);
      clicked = true;
    } else if (rowLocatorHint) {
      const hint = String(rowLocatorHint).slice(0, 40);
      try {
        // Try clicking any element whose visible text contains the hint.
        const synthetic = page.locator(`text=${JSON.stringify(hint)}`).first();
        const count = await synthetic.count().catch(() => 0);
        if (count > 0) {
          await synthetic.click({ timeout: 4_000 }).catch(() => null);
          clicked = true;
        }
      } catch { /* ignore */ }
    }
    if (clicked) await page.waitForTimeout?.(1800);

    // Read the body: try structured selectors first, then fall back to
    // grabbing the whole document text.
    for (const selector of DOM_MESSAGE_BODY_SELECTORS) {
      try {
        const locator = page.locator(selector).first();
        const count = await locator.count().catch(() => 0);
        if (!count) continue;
        const tagName = await locator.evaluate?.((el) => el.tagName?.toLowerCase()).catch(() => "");
        let bodyText = "";
        let bodyHtml = "";
        if (tagName === "iframe") {
          const frame = await locator.contentFrame?.();
          if (frame) {
            bodyText = await frame.locator("body").textContent().catch(() => "") || "";
            bodyHtml = await frame.locator("body").innerHTML().catch(() => "") || "";
          }
        } else {
          bodyText = (await locator.textContent().catch(() => "")) || "";
          bodyHtml = (await locator.innerHTML().catch(() => "")) || "";
        }
        // Skip containers that are too small — probably the wrong element.
        if ((bodyText + bodyHtml).length < 40) continue;
        return { bodyText, bodyHtml, directConfirmUrl: this._extractGithubConfirmUrl(bodyHtml || bodyText) };
      } catch { /* try next */ }
    }

    // Last-resort: read the entire document. Works because the opened
    // email body is always on the page after the click; the OTP will be
    // in innerText somewhere.
    try {
      const bodyText = await page.evaluate(() => String(document.body?.innerText || "")).catch(() => "") || "";
      const bodyHtml = (await page.content?.()) || "";
      return { bodyText, bodyHtml, directConfirmUrl: this._extractGithubConfirmUrl(bodyHtml || bodyText) };
    } catch {
      return { bodyText: "", bodyHtml: "", directConfirmUrl: null };
    }
  }

  _extractGithubConfirmUrl(body) {
    // The direct-confirm URL follows a stable shape:
    //   https://github.com/account_verifications/confirm/<uuid>/<code>
    // Screenshot 2 confirms it is rendered as a clickable <a> below the
    // OTP; extracting it lets the caller navigate directly instead of
    // typing the OTP.
    if (!body) return null;
    const match = String(body).match(/https:\/\/github\.com\/account_verifications\/confirm\/[A-Za-z0-9\-]+\/\d{6,8}/);
    return match ? match[0] : null;
  }

  async _backToInbox() {
    const page = this._requirePage();
    // Reuse the selector-list + JS-text fallback pattern used for other
    // toolbar buttons. The DOM_BACK_TO_LIST_SELECTORS include the
    // Indonesian "KEMBALI KE DAFTAR" and English "Back to list" variants.
    const clicked = await this._clickFirstVisible(page, DOM_BACK_TO_LIST_SELECTORS, { timeoutMs: 3_000 });
    if (clicked) {
      await page.waitForTimeout?.(800);
    }
    return clicked;
  }

  async deleteMessage() { return true; }

  async waitForOtp(_emailOrToken, {
    senderMatch = "",
    otpPattern,
    confirmUrlPattern,
    // Legacy caller compat — the register manager still passes
    // timeoutMs/pollIntervalMs. In the new bounded-refresh algorithm
    // these are ignored beyond deriving the overall deadline.
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = 8_000,
    onStep = null,
    // Subject-line filter. Required to distinguish the Phase-A
    // "launch code" email from the Phase-B "verify your device" email
    // when both may be sitting in the inbox at the same time.
    subjectMatch = "",
    _seenRowKeys = new Set(),
    // Refresh budget. See docs/GITHUB_REGISTER_OTP_FLOW.md — the flow
    // is intentionally bounded so we never spam the temp-mail server.
    maxRefreshClicks = 2,
    // Initial wait before the FIRST refresh. Gives GitHub SMTP delivery
    // + temp-mail.org SMTP ingestion time to land the message.
    initialWaitMs = 5_000,
    // Wait between refresh clicks (settle time for the previous fetch).
    interRefreshWaitMs = 8_000,
  } = {}) {
    const page = this._requirePage();
    const senderNeedle = String(senderMatch || "").toLowerCase();
    const subjectNeedle = String(subjectMatch || "").toLowerCase();
    const start = Date.now();
    onStep?.(
      "tempmail_waiting",
      `Polling temp-mail.org inbox (max ${maxRefreshClicks} refreshes, sender=${senderNeedle || "*"}${subjectNeedle ? `, subject=${subjectNeedle}` : ""})`
    );

    // Give the email time to arrive before we even try the first refresh.
    // Empirically GitHub sends verification mails within 3-8 seconds of the
    // form submit; refreshing at t=0 always returns an empty list and just
    // wastes a click from our budget.
    if (initialWaitMs > 0) {
      onStep?.("tempmail_initial_wait", `Waiting ${Math.round(initialWaitMs / 1000)}s for the email to be delivered`);
      await page.waitForTimeout?.(initialWaitMs);
    }

    let refreshesUsed = 0;
    let lastSettleFinishAt = Date.now();

    while (Date.now() - start < timeoutMs && refreshesUsed < maxRefreshClicks) {
      refreshesUsed += 1;
      onStep?.("tempmail_refresh_attempt", `Refresh click ${refreshesUsed}/${maxRefreshClicks}`);

      // Step 1: click Refresh, then WAIT for the network to settle so the
      // inbox actually re-renders before we scan the DOM. If the click
      // fails (button not found), continue anyway — the SPA may have
      // auto-refreshed and the row could already be visible.
      const refreshClicked = await this._clickFirstVisible(page, DOM_REFRESH_BUTTON_SELECTORS).catch(() => false);
      if (refreshClicked) {
        try {
          await page.waitForLoadState?.("networkidle", { timeout: 8_000 });
        } catch { /* proceed anyway */ }
        // Small tail-end DOM settle so any client-side row swap lands.
        await page.waitForTimeout?.(1_000);
      } else {
        onStep?.("tempmail_refresh_button_missing", "Refresh button not found this tick — scanning inbox anyway");
        // Even without the click, the SPA may already have new rows.
        await page.waitForTimeout?.(500);
      }
      lastSettleFinishAt = Date.now();

      // Step 2: read the inbox rows.
      let rows = [];
      try { rows = await this.listMessages(); }
      catch (err) { onStep?.("tempmail_read_error", `${err?.message || err}`); }

      // Step 3: filter by sender AND subject. Both are lowered comparisons
      // over the full row-text haystack. Subject is critical to
      // distinguish Phase A ("launch code") from Phase B
      // ("verify your device") — the same inbox will hold BOTH by the
      // time the register flow reaches Phase B.
      const candidateRows = rows.filter((row) => {
        const haystack = `${row.from || ""} ${row.subject || ""} ${row._rowText || ""}`.toLowerCase();
        if (senderNeedle && !haystack.includes(senderNeedle)) return false;
        if (subjectNeedle && !haystack.includes(subjectNeedle)) return false;
        return true;
      });

      onStep?.(
        "tempmail_poll_debug",
        `Refresh ${refreshesUsed}/${maxRefreshClicks}: rows=${rows.length}, candidates=${candidateRows.length}`
      );

      // Step 4: open each unseen candidate and try to extract the OTP.
      for (const row of candidateRows) {
        const rowKey = row._rowText || row._rowLocatorHint || row.subject || row._id;
        if (_seenRowKeys.has(rowKey)) continue;
        _seenRowKeys.add(rowKey);

        onStep?.("tempmail_opening_row", `Clicking row: ${(row.subject || row.from || "").slice(0, 60)}`);
        const full = await this.readMessage(row._id, undefined, {
          rowLocator: row._rowLocator,
          rowLocatorHint: row._rowLocatorHint,
        });
        const body = full?.bodyText || full?.bodyHtml || "";

        // Prefer the direct-confirm URL for Phase A ("launch code"),
        // fall back to the OTP code (both flows need this).
        const preExtractedUrl = full?.directConfirmUrl;
        const confirmUrl = preExtractedUrl || extractConfirmUrl(body, confirmUrlPattern);
        const code = extractOtp(body, otpPattern ? { otpPattern } : {});

        if (code || confirmUrl) {
          onStep?.(
            "tempmail_received",
            confirmUrl
              ? `Received OTP ${code || "(url-only)"} + direct-confirm URL`
              : `Received OTP ${code}`
          );
          // Best-effort: click Back so the inbox is ready for the NEXT
          // OTP round. Ignore failures — the caller can also navigate.
          await this._backToInbox().catch(() => null);
          return { code, confirmUrl: confirmUrl || null, message: { ...row, ...full } };
        }

        onStep?.(
          "tempmail_row_no_otp",
          `Row "${(row.subject || "").slice(0, 40)}" opened but no OTP/URL parsed — retry after next refresh`
        );
        // Take a screenshot of the failing detail pane for post-mortem
        // (only when the run is heading to needs_manual) and go back.
        if (page.screenshot) {
          try {
            const path = `data/tempmail-body-empty-${Date.now()}.jpg`;
            await page.screenshot({ path, type: "jpeg", quality: 60 }).catch(() => null);
            onStep?.("tempmail_body_empty_screenshot", `Screenshot: ${path}`);
          } catch { /* best-effort */ }
        }
        await this._backToInbox().catch(() => null);
      }

      // Step 5: no candidate produced a hit — wait before the next refresh.
      // Skip the wait on the final iteration since there is no next refresh.
      if (refreshesUsed < maxRefreshClicks) {
        const remaining = timeoutMs - (Date.now() - start);
        const gap = Math.max(0, Math.min(interRefreshWaitMs, remaining));
        if (gap <= 0) break;
        onStep?.("tempmail_inter_refresh_wait", `Waiting ${Math.round(gap / 1000)}s before refresh ${refreshesUsed + 1}`);
        await page.waitForTimeout?.(gap);
      }
    }

    // Exhausted the refresh budget without finding a matching OTP.
    // Save a screenshot of the current inbox for post-mortem and return
    // null so the caller can flip the account to needs_manual.
    if (page.screenshot) {
      try {
        const path = `data/tempmail-otp-budget-exhausted-${Date.now()}.jpg`;
        await page.screenshot({ path, fullPage: true, type: "jpeg", quality: 70 }).catch(() => null);
        onStep?.("tempmail_timeout_screenshot", `Saved timeout screenshot to ${path}`);
      } catch { /* ignore */ }
    }
    // Use "tempmail_timeout" for backward-compat with existing tests that
    // check for this exact step name after a bounded-refresh miss.
    onStep?.(
      "tempmail_timeout",
      `OTP not found after ${refreshesUsed}/${maxRefreshClicks} refreshes — handing off to manual assist`
    );
    return null;
  }

  // Parity with TempMailOrgClient so the register manager's duck-typed
  // check (`typeof client.setBrowserTransport === 'function'`) still fires
  // for this class. Under the hood we just rebind the page.
  setBrowserTransport(page) {
    // Bind the page synchronously; the manager awaits an async setPage in
    // its bootstrap step, but this shim keeps the sync API compatible.
    // Fire-and-forget the async part — the register manager calls
    // allocateAddress() after this, which will await implicitly on the
    // page's own async operations.
    this._page = page;
    return this;
  }

  get transport() {
    // Reported for observability so the CLI/preflight can print the mode.
    return { kind: "dom", page: this._page };
  }
}

/**
 * Build a temp-mail.org client from env. temp-mail.org web2 API does NOT
 * need credentials, so the factory always returns a client — we keep the
 * factory shape for parity with tempMailClientFromEnv() so the register
 * manager can swap providers via a single env switch.
 *
 * Since the DOM client is the only reliable path today (Cloudflare blocks
 * plain HTTP and the web2 REST contract has drifted), we return the DOM
 * client by default. Setting TEMPMAIL_HTTP=1 falls back to the legacy HTTP
 * client for callers that specifically want to mock fetch in tests.
 */
export function tempMailOrgClientFromEnv(overrides = {}) {
  if (process.env.TEMPMAIL_HTTP === "1") {
    return new TempMailOrgClient(overrides);
  }
  return new TempMailOrgDomClient(overrides);
}
