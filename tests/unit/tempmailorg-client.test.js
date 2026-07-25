import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TempMailOrgClient,
  TempMailOrgDomClient,
  extractOtp,
  extractConfirmUrl,
  tempMailOrgClientFromEnv,
  browserTransport,
  nodeTransport,
} from "../../src/lib/oauth/services/automation/tempMailOrgClient.js";

// Some tests toggle TEMPMAIL_HTTP to exercise the legacy HTTP factory path.
// Clean up after each test so the flag never leaks between suites.
afterEach(() => {
  delete process.env.TEMPMAIL_HTTP;
});

function buildFetchResponse({ status = 200, body = null } = {}) {
  const payload = body === null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return payload; },
  };
}

// Helper: build a deterministic /mailbox response for a given index.
function mailboxResponse(index, { domain } = {}) {
  const d = domain || `@d${index}.com`;
  return {
    mailbox: `user${1000 + index}${d}`,
    token: `token-${index}`,
  };
}

describe("tempMailOrgClient (web2.temp-mail.org)", () => {
  it("extractOtp handles the 6-digit + blocklist path (parity with Privatix client)", () => {
    expect(extractOtp("Your verification code is 483920. Ignore #181818.")).toBe("483920");
  });

  it("extractConfirmUrl matches only when a pattern is provided", () => {
    const body = "Please visit https://github.com/account_verifications/confirm/abc123 to verify.";
    const url = extractConfirmUrl(body, /https:\/\/github\.com\/account_verifications\/confirm\/[A-Za-z0-9]+/);
    expect(url).toBe("https://github.com/account_verifications/confirm/abc123");
    expect(extractConfirmUrl(body, null)).toBeNull();
  });

  it("throws when constructed without a fetch implementation", () => {
    // Node's global fetch may or may not exist depending on the runtime;
    // we deliberately pass fetchImpl=null to trigger the guard.
    expect(() => new TempMailOrgClient({ fetchImpl: null })).toThrow(/fetch/);
  });

  it("allocateAddress calls POST /mailbox and returns { email, domain, id: token }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      buildFetchResponse({ status: 200, body: mailboxResponse(1, { domain: "@kierko.com" }) })
    );
    const client = new TempMailOrgClient({ fetchImpl });

    const address = await client.allocateAddress();
    expect(address).toEqual({
      email: "user1001@kierko.com",
      domain: "@kierko.com",
      id: "token-1",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://web2.temp-mail.org/mailbox",
      expect.objectContaining({ method: "POST" }),
    );
    // Verify the required browser-style header is present.
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Referer).toBe("https://temp-mail.org/");
  });

  it("allocateUniqueAddresses provisions N mailboxes across distinct domains", async () => {
    // Simulate the server rotating through 3 different domains.
    const responses = [
      mailboxResponse(1, { domain: "@kierko.com" }),
      mailboxResponse(2, { domain: "@fakomail.com" }),
      mailboxResponse(3, { domain: "@mymailix.com" }),
    ];
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return buildFetchResponse({ status: 200, body });
    });
    const client = new TempMailOrgClient({ fetchImpl });

    const result = await client.allocateUniqueAddresses(3);
    expect(result.allocated).toBe(3);
    expect(result.requested).toBe(3);
    expect(result.capped).toBe(false);
    const domains = new Set(result.addresses.map((a) => a.domain));
    expect(domains.size).toBe(3);
    expect(domains).toEqual(new Set(["@kierko.com", "@fakomail.com", "@mymailix.com"]));
  });

  it("allocateUniqueAddresses caps + flags capped=true when the server keeps returning duplicate domains", async () => {
    // Server perpetually returns the same 2 domains no matter how many
    // times we ask — after 8 consecutive duplicates the loop bails out.
    const domains = ["@only1.com", "@only2.com"];
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      const body = mailboxResponse(call, { domain: domains[call % 2] });
      call += 1;
      return buildFetchResponse({ status: 200, body });
    });
    const client = new TempMailOrgClient({ fetchImpl });

    const result = await client.allocateUniqueAddresses(5);
    expect(result.requested).toBe(5);
    expect(result.allocated).toBe(2);
    expect(result.available).toBe(2);
    expect(result.capped).toBe(true);
  });

  it("allocateRandomBatch picks a count in [min,max] and delegates to allocateUniqueAddresses", async () => {
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      const body = mailboxResponse(call, { domain: `@d${call}.com` });
      call += 1;
      return buildFetchResponse({ status: 200, body });
    });
    const client = new TempMailOrgClient({ fetchImpl });
    // countRng returns 0.5 → picks the middle of 5..7 (6).
    const result = await client.allocateRandomBatch({ min: 5, max: 7, countRng: () => 0.5 });
    expect(result.requested).toBe(6);
    expect(result.allocated).toBe(6);
  });

  it("listMessages presents the bearer token as Authorization: Bearer <token>", async () => {
    const messages = [
      { _id: "m1", from: "noreply@github.com", subject: "verify", bodyPreview: "code 111222" },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ status: 200, body: { messages } }));
    const client = new TempMailOrgClient({ fetchImpl });

    const result = await client.listMessages("token-xyz");
    expect(result).toEqual(messages);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://web2.temp-mail.org/messages");
    expect(init.headers.authorization).toBe("Bearer token-xyz");
  });

  it("listMessages accepts an email if the token was cached during allocation", async () => {
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) return buildFetchResponse({ body: mailboxResponse(1, { domain: "@kierko.com" }) });
      return buildFetchResponse({ body: { messages: [] } });
    });
    const client = new TempMailOrgClient({ fetchImpl });
    const address = await client.allocateAddress();
    await client.listMessages(address.email);
    const [, secondInit] = fetchImpl.mock.calls[1];
    expect(secondInit.headers.authorization).toBe(`Bearer ${address.id}`);
  });

  it("listMessages throws with a helpful hint when the email is unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: [] }));
    const client = new TempMailOrgClient({ fetchImpl });
    await expect(client.listMessages("stranger@kierko.com")).rejects.toThrow(/No token cached/);
  });

  it("waitForOtp returns the code after the sender-matched message arrives (via readMessage)", async () => {
    // Server timeline:
    //   call 1: POST /mailbox (allocateAddress)
    //   call 2: GET /messages → empty
    //   call 3: GET /messages → contains one GitHub email preview
    //   call 4: GET /messages/{id} → full body with the OTP
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      call += 1;
      if (url.endsWith("/mailbox")) {
        return buildFetchResponse({ body: mailboxResponse(1, { domain: "@kierko.com" }) });
      }
      if (url.endsWith("/messages")) {
        if (call === 2) return buildFetchResponse({ body: { messages: [] } });
        return buildFetchResponse({
          body: { messages: [{ _id: "msg-42", from: "noreply@github.com", subject: "verify", bodyPreview: "..." }] },
        });
      }
      if (url.includes("/messages/msg-42")) {
        return buildFetchResponse({
          body: {
            _id: "msg-42",
            from: "noreply@github.com",
            subject: "GitHub launch code",
            bodyText: "Your GitHub launch code is 483920.",
          },
        });
      }
      return buildFetchResponse({ status: 404 });
    });
    const client = new TempMailOrgClient({ fetchImpl, pollIntervalMs: 5 });
    const address = await client.allocateAddress();

    const hit = await client.waitForOtp(address.id, {
      senderMatch: "github",
      timeoutMs: 500,
    });
    expect(hit).not.toBeNull();
    expect(hit.code).toBe("483920");
    expect(hit.message._id).toBe("msg-42");
  });

  it("waitForOtp times out cleanly when no matching message arrives", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith("/mailbox")) return buildFetchResponse({ body: mailboxResponse(1) });
      return buildFetchResponse({ body: { messages: [] } });
    });
    const client = new TempMailOrgClient({ fetchImpl, pollIntervalMs: 5 });
    const address = await client.allocateAddress();

    const hit = await client.waitForOtp(address.id, {
      senderMatch: "github",
      timeoutMs: 30,
    });
    expect(hit).toBeNull();
  });

  it("waitForOtp ignores unrelated senders", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith("/mailbox")) return buildFetchResponse({ body: mailboxResponse(1) });
      if (url.endsWith("/messages")) {
        return buildFetchResponse({
          body: { messages: [{ _id: "m1", from: "noreply@spam.example", subject: "spam", bodyPreview: "123456" }] },
        });
      }
      if (url.includes("/messages/m1")) {
        return buildFetchResponse({ body: { _id: "m1", from: "noreply@spam.example", bodyText: "spam 123456" } });
      }
      return buildFetchResponse({ status: 404 });
    });
    const client = new TempMailOrgClient({ fetchImpl, pollIntervalMs: 5 });
    const address = await client.allocateAddress();

    const hit = await client.waitForOtp(address.id, {
      senderMatch: "github",
      timeoutMs: 30,
    });
    expect(hit).toBeNull();
  });

  it("deleteMessage is a no-op that always resolves true (parity with Privatix client)", async () => {
    const fetchImpl = vi.fn();
    const client = new TempMailOrgClient({ fetchImpl });
    await expect(client.deleteMessage("anything")).resolves.toBe(true);
    // Must NOT hit the network — temp-mail.org has no delete endpoint.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tempMailOrgClientFromEnv returns the DOM client by default (recommended path)", () => {
    const client = tempMailOrgClientFromEnv();
    expect(client).toBeInstanceOf(TempMailOrgDomClient);
  });

  it("tempMailOrgClientFromEnv returns the legacy HTTP client when TEMPMAIL_HTTP=1", () => {
    process.env.TEMPMAIL_HTTP = "1";
    const client = tempMailOrgClientFromEnv();
    expect(client).toBeInstanceOf(TempMailOrgClient);
  });

  it("propagates a 4xx as a terminal error (no infinite retry)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ status: 403, body: { errorMessage: "forbidden" } }));
    const client = new TempMailOrgClient({ fetchImpl, maxRetries: 3 });
    await expect(client.allocateAddress()).rejects.toMatchObject({ status: 403 });
    // Must have called fetch exactly once (no retry on 4xx).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ── Transport strategies ───────────────────────────────────────────────────

describe("nodeTransport", () => {
  it("throws when no fetch is provided", () => {
    expect(() => nodeTransport(null)).toThrow(/fetch/);
  });

  it("passes method + headers + body to the underlying fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      async text() { return JSON.stringify({ mailbox: "u@d.com", token: "t" }); },
    });
    const transport = nodeTransport(fetchImpl);
    const result = await transport.fetchJson("https://example.com/mailbox", {
      method: "POST",
      headers: { "x-h": "1" },
      body: { hello: "world" },
    });
    expect(result).toEqual({ status: 200, ok: true, text: JSON.stringify({ mailbox: "u@d.com", token: "t" }) });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["x-h"]).toBe("1");
    expect(init.body).toBe(JSON.stringify({ hello: "world" }));
  });
});

describe("browserTransport", () => {
  it("throws when constructed without a page", () => {
    expect(() => browserTransport(null)).toThrow(/page/);
    expect(() => browserTransport({})).toThrow(/page/);
  });

  it("dispatches fetch inside page.evaluate and surfaces the response", async () => {
    // Fake Playwright page that pretends to run the evaluate callback.
    const page = {
      evaluate: vi.fn(async (fn, args) => {
        // We simulate what a real browser fetch would return.
        expect(Array.isArray(args)).toBe(true);
        expect(args[0]).toBe("https://web2.temp-mail.org/mailbox");
        expect(args[1].method).toBe("POST");
        // headers pass through
        expect(args[1].headers.Referer).toBe("https://temp-mail.org/");
        expect(args[1].credentials).toBe("include");
        return {
          status: 200,
          ok: true,
          text: JSON.stringify({ mailbox: "user@kierko.com", token: "browser-token-1" }),
        };
      }),
    };
    const transport = browserTransport(page);
    const result = await transport.fetchJson("https://web2.temp-mail.org/mailbox", {
      method: "POST",
      headers: { Referer: "https://temp-mail.org/" },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ mailbox: "user@kierko.com", token: "browser-token-1" });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("throws when the in-page fetch itself errored", async () => {
    const page = {
      evaluate: async () => ({ status: 0, ok: false, text: "", error: "TypeError: NetworkError when attempting to fetch" }),
    };
    const transport = browserTransport(page);
    await expect(transport.fetchJson("https://web2.temp-mail.org/mailbox", { method: "POST" })).rejects.toThrow(/network error/i);
  });
});

describe("TempMailOrgClient with browserTransport", () => {
  it("allocateAddress works end-to-end via a page-backed transport", async () => {
    const page = {
      evaluate: vi.fn(async (fn, [url]) => {
        expect(url).toBe("https://web2.temp-mail.org/mailbox");
        return {
          status: 200,
          ok: true,
          text: JSON.stringify({ mailbox: "abc123@kierko.com", token: "tok-browser-1" }),
        };
      }),
    };
    const client = new TempMailOrgClient({ transport: browserTransport(page) });
    const address = await client.allocateAddress();
    expect(address.email).toBe("abc123@kierko.com");
    expect(address.domain).toBe("@kierko.com");
    expect(address.id).toBe("tok-browser-1");
  });

  it("setBrowserTransport swaps the transport at runtime", async () => {
    // Start with a node transport (fetch spy). No calls should happen through
    // it once we swap to the browser transport.
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      async text() { return ""; },
    });
    const client = new TempMailOrgClient({ fetchImpl, maxRetries: 1 });

    const page = {
      evaluate: vi.fn(async () => ({
        status: 200,
        ok: true,
        text: JSON.stringify({ mailbox: "swap@fakomail.com", token: "swap-tok" }),
      })),
    };
    client.setBrowserTransport(page);

    const address = await client.allocateAddress();
    expect(address.email).toBe("swap@fakomail.com");
    // The node fetch spy must not have been touched.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});

// ── DOM client ─────────────────────────────────────────────────────────────
//
// Fake Playwright page implementing just enough of the locator API for the
// DOM client to read the visible email address, enumerate rows, and click
// buttons. Deliberately minimal — one selector matches, everything else
// returns 0.

function makeFakeDomPage({
  emails = ["user1@kierko.com"],
  onChangeClick = null,
  rowsPerRefresh = [],
  fullBody = { bodyText: "", bodyHtml: "" },
  urlAtStart = "https://temp-mail.org/",
} = {}) {
  let emailIndex = 0;
  let refreshIndex = 0;
  const clickTracker = [];
  const gotoTracker = [];

  function currentEmail() { return emails[Math.min(emailIndex, emails.length - 1)]; }
  function currentRows() { return rowsPerRefresh[Math.min(refreshIndex, rowsPerRefresh.length - 1)] || []; }

  const page = {
    url: () => urlAtStart,
    goto: async (u) => { gotoTracker.push(u); return null; },
    waitForLoadState: async () => null,
    waitForTimeout: async () => null,
    evaluate: async () => [],           // fallback scan returns nothing in tests
    screenshot: async () => null,       // no-op so screenshot calls don't crash
    content: async () => "",
    locator: (selector) => {
      // The email input matcher — only the first candidate matches so we
      // exercise the fallback path lightly.
      const isEmailSelector = selector === "#mail" || selector.includes('id="mail"') || selector.includes('name="mail"');
      const isChangeButton = /change|click-to-change/i.test(selector);
      const isRefreshButton = /refresh|click-to-refresh/i.test(selector);
      const isRowSelector = selector === ".inboxSection li";
      const isBodySelector = selector === ".message-content";

      const l = {
        first() { return this; },
        async all() {
          if (isRowSelector) {
            return currentRows().map((r) => {
              const rowText = `${r.from || ""} ${r.subject || ""}`.trim();
              return {
                locator: (childSelector) => ({
                  first() { return this; },
                  async count() {
                    return (childSelector.includes("sender") && r.from) ? 1
                      : (childSelector.includes("subject") && r.subject) ? 1
                        : 0;
                  },
                  async textContent() {
                    if (childSelector.includes("sender")) return r.from;
                    if (childSelector.includes("subject")) return r.subject;
                    return "";
                  },
                }),
                click: async () => { clickTracker.push({ what: "row", from: r.from }); },
                async textContent() { return rowText; },
              };
            });
          }
          return [];
        },
        async count() {
          if (isEmailSelector) return 1;
          if (isChangeButton) return 1;
          if (isRefreshButton) return 1;
          if (isBodySelector) return 1;
          return 0;
        },
        async isVisible() { return true; },
        async inputValue() { return isEmailSelector ? currentEmail() : null; },
        async textContent() {
          if (isBodySelector) return fullBody.bodyText;
          return null;
        },
        async innerHTML() { return isBodySelector ? fullBody.bodyHtml : ""; },
        async evaluate() { return isBodySelector ? "div" : ""; },
        contentFrame: async () => null,
        click: async () => {
          if (isChangeButton) {
            clickTracker.push({ what: "change" });
            if (onChangeClick) onChangeClick();
            emailIndex = Math.min(emailIndex + 1, emails.length - 1);
          } else if (isRefreshButton) {
            clickTracker.push({ what: "refresh" });
            refreshIndex = Math.min(refreshIndex + 1, rowsPerRefresh.length - 1);
          }
        },
      };
      return l;
    },
  };
  return { page, clickTracker, gotoTracker, advanceEmail: () => { emailIndex = Math.min(emailIndex + 1, emails.length - 1); } };
}

describe("TempMailOrgDomClient", () => {
  it("throws when allocateAddress is called before a page is bound", async () => {
    const client = new TempMailOrgDomClient();
    await expect(client.allocateAddress()).rejects.toThrow(/setPage/);
  });

  it("reads the visible email off the page DOM", async () => {
    const { page } = makeFakeDomPage({ emails: ["user1@kierko.com"] });
    const client = new TempMailOrgDomClient();
    await client.setPage(page, { ensureHomepage: false });

    const address = await client.allocateAddress();
    expect(address.email).toBe("user1@kierko.com");
    expect(address.domain).toBe("@kierko.com");
    expect(address.id).toBe("user1@kierko.com"); // DOM mode: id === email
  });

  it("clicks Change and reads the next visible email on subsequent allocations", async () => {
    const { page, clickTracker } = makeFakeDomPage({
      emails: ["one@a.com", "two@b.com", "three@c.com"],
    });
    const client = new TempMailOrgDomClient();
    await client.setPage(page, { ensureHomepage: false });

    const first = await client.allocateAddress();
    const second = await client.allocateAddress();
    const third = await client.allocateAddress();
    expect(first.email).toBe("one@a.com");
    expect(second.email).toBe("two@b.com");
    expect(third.email).toBe("three@c.com");
    // Change was clicked twice (once between the 2nd and 3rd allocations
    // as well).
    expect(clickTracker.filter((c) => c.what === "change")).toHaveLength(2);
  });

  it("allocateUniqueAddresses cycles domains until it hits the requested count", async () => {
    const { page } = makeFakeDomPage({
      emails: ["a@d1.com", "b@d2.com", "c@d3.com"],
    });
    const client = new TempMailOrgDomClient();
    await client.setPage(page, { ensureHomepage: false });

    const result = await client.allocateUniqueAddresses(3);
    expect(result.allocated).toBe(3);
    expect(new Set(result.addresses.map((a) => a.domain)).size).toBe(3);
    expect(result.capped).toBe(false);
  });

  it("waitForOtp reads the OTP from the DOM row's body content", async () => {
    const { page } = makeFakeDomPage({
      emails: ["u@kierko.com"],
      rowsPerRefresh: [
        [], // first refresh: empty
        [{ from: "noreply@github.com", subject: "🚀 Your GitHub launch code" }],
      ],
      fullBody: { bodyText: "Continue signing up for GitHub by entering the code below: 483920", bodyHtml: "" },
    });
    const client = new TempMailOrgDomClient();
    await client.setPage(page, { ensureHomepage: false });
    await client.allocateAddress();

    const hit = await client.waitForOtp("u@kierko.com", {
      senderMatch: "github",
      timeoutMs: 1200,
      pollIntervalMs: 5,
    });
    expect(hit).not.toBeNull();
    expect(hit.code).toBe("483920");
  });

  it("setBrowserTransport rebinds the page for interface parity with the HTTP client", async () => {
    const { page } = makeFakeDomPage({ emails: ["p@kierko.com"] });
    const client = new TempMailOrgDomClient();
    client.setBrowserTransport(page);
    const addr = await client.allocateAddress();
    expect(addr.email).toBe("p@kierko.com");
    expect(client.transport.kind).toBe("dom");
  });

  it("deleteMessage is a no-op", async () => {
    const client = new TempMailOrgDomClient();
    await expect(client.deleteMessage("anything")).resolves.toBe(true);
  });
});
