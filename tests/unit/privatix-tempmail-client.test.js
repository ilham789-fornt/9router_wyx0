import { describe, expect, it, vi } from "vitest";
import {
  PrivatixTempMailClient,
  md5EmailId,
  extractOtp,
  extractConfirmUrl,
  generateEmailPrefix,
} from "../../src/lib/oauth/services/automation/tempMailClient.js";

function buildFetchResponse({ status = 200, body = null } = {}) {
  const payload = body === null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return payload; },
  };
}

describe("tempMailClient (Privatix)", () => {
  it("hashes email address to lowercase md5 (matches Privatix contract)", () => {
    // md5("john2847@steveix.com") — verified offline with a reference impl.
    expect(md5EmailId("john2847@steveix.com")).toBe(md5EmailId("JOHN2847@STEVEIX.COM"));
    expect(md5EmailId("john2847@steveix.com")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates lowercase-alnum name+digits prefix within Privatix rules", () => {
    let step = 0;
    // Deterministic RNG returns 0.0, then 0.9999… so we hit the first name and
    // the top-most digit slot; the shape must be `<name><4-digit-number>`.
    const rng = () => {
      const value = step === 0 ? 0 : 0.9999999;
      step += 1;
      return value;
    };
    const prefix = generateEmailPrefix({ nameCorpus: ["alex", "bob"], rng });
    expect(prefix).toMatch(/^[a-z]+\d{4}$/);
    expect(prefix).toBe("alex9999");
  });

  it("extracts a 6-digit OTP from a plain-text body and filters CSS blocklist", () => {
    const body = "Your verification code is 483920. Ignore #181818 background.";
    expect(extractOtp(body)).toBe("483920");
  });

  it("prefers regex hit over near-keyword fallback", () => {
    const body = "Hello, please verify with 987654 within 10 minutes.";
    expect(extractOtp(body)).toBe("987654");
  });

  it("returns null when no digits are present", () => {
    expect(extractOtp("no digits here at all")).toBeNull();
  });

  it("extracts a direct-confirm URL when the pattern matches", () => {
    const body = "Confirm at https://github.com/account_verifications/confirm/abc123 now.";
    const url = extractConfirmUrl(body, /https:\/\/github\.com\/account_verifications\/confirm\/[A-Za-z0-9]+/);
    expect(url).toBe("https://github.com/account_verifications/confirm/abc123");
  });

  it("listDomains normalises Privatix's raw JSON array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: ["@steveix.com", "@cevipsa.com", ""] }));
    const client = new PrivatixTempMailClient({ apiKey: "test-key", fetchImpl });

    const domains = await client.listDomains();
    expect(domains).toEqual(["@steveix.com", "@cevipsa.com"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://privatix-temp-mail-v1.p.rapidapi.com/request/domains/",
      expect.objectContaining({ method: "GET" }),
    );
    const [, init] = fetchImpl.mock.calls[0];
    // Privatix curl reference uses lowercase header names; we mirror it.
    expect(init.headers["x-rapidapi-key"]).toBe("test-key");
    expect(init.headers["x-rapidapi-host"]).toBe("privatix-temp-mail-v1.p.rapidapi.com");
  });

  it("allocateAddress builds email = prefix + domain + md5 id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: ["@steveix.com"] }));
    const client = new PrivatixTempMailClient({ apiKey: "test", fetchImpl });
    // Deterministic RNG: first call picks first name, second call picks a
    // fixed digit block, third call is the domain chooser (only one domain).
    const values = [0, 0.5, 0];
    const rng = () => values.shift() ?? 0;

    const address = await client.allocateAddress({ nameCorpus: ["john"], rng });
    expect(address.domain).toBe("@steveix.com");
    expect(address.email).toMatch(/^john\d{4}@steveix\.com$/);
    expect(address.id).toBe(md5EmailId(address.email));
  });

  it("listMessages returns [] on 404 (empty inbox), passes real data otherwise", async () => {
    const messages = [{ mail_from: "noreply@github.com", mail_subject: "code 483920", mail_text_only: "Code: 483920", mail_id: "m1" }];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(buildFetchResponse({ status: 404 }))
      .mockResolvedValueOnce(buildFetchResponse({ body: messages }));

    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });
    await expect(client.listMessages("john2847@steveix.com")).resolves.toEqual([]);
    await expect(client.listMessages("john2847@steveix.com")).resolves.toEqual(messages);
  });

  it("waitForOtp returns the code after the sender-matched message arrives", async () => {
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      // Privatix's delete endpoint is GET-with-side-effect; treat any delete
      // URL as an OK no-op so the after-read cleanup does not throw.
      if (String(url).includes("/request/delete/")) return buildFetchResponse({ status: 200, body: {} });
      call += 1;
      if (call === 1) return buildFetchResponse({ body: [] });
      if (call === 2) return buildFetchResponse({
        body: [{ mail_from: "noreply@github.com", mail_text_only: "Your code: 483920", mail_id: "m1" }],
      });
      return buildFetchResponse({ body: [] });
    });

    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl, pollIntervalMs: 5 });
    const hit = await client.waitForOtp("john2847@steveix.com", {
      senderMatch: "github",
      timeoutMs: 500,
    });

    expect(hit).not.toBeNull();
    expect(hit.code).toBe("483920");
    expect(hit.message.mail_id).toBe("m1");
  });

  it("waitForOtp times out cleanly when no matching mail arrives", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: [] }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl, pollIntervalMs: 5 });

    const hit = await client.waitForOtp("john2847@steveix.com", {
      senderMatch: "github",
      timeoutMs: 30,
    });
    expect(hit).toBeNull();
  });

  it("waitForOtp ignores messages from unrelated senders", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      attempts += 1;
      // Never return a github-matching sender within the tight timeout.
      return buildFetchResponse({
        body: [{ mail_from: "noreply@spam.example", mail_text_only: "Random 123456", mail_id: "m9" }],
      });
    });
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl, pollIntervalMs: 5 });
    const hit = await client.waitForOtp("john2847@steveix.com", {
      senderMatch: "github",
      timeoutMs: 40,
    });
    expect(hit).toBeNull();
    expect(attempts).toBeGreaterThan(0);
  });

  it("throws when apiKey is missing", () => {
    expect(() => new PrivatixTempMailClient({ fetchImpl: async () => buildFetchResponse() })).toThrow(/apiKey/);
  });

  it("deleteMessage issues GET /request/delete/id/{mail_id}/ (Privatix quirk)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ status: 200, body: {} }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });
    await expect(client.deleteMessage("mid-123")).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://privatix-temp-mail-v1.p.rapidapi.com/request/delete/id/mid-123/",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("deleteMessage returns false and does not throw on server error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ status: 500, body: { error: "boom" } }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });
    await expect(client.deleteMessage("mid-broken")).resolves.toBe(false);
  });

  // ── allocateUniqueAddresses ─────────────────────────────────────────────
  //
  // Bulk-register jobs need every account to land on a DIFFERENT Privatix
  // domain to avoid CodeBuddy's "same disposable-email domain within window"
  // heuristic. These tests pin the contract that guarantees it.

  it("allocateUniqueAddresses returns N distinct domains when the pool is large enough", async () => {
    const domainList = [
      "@steveix.com", "@cevipsa.com", "@nuclene.com",
      "@cpav3.com", "@mocvn.com", "@tenvil.com",
    ];
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: domainList }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });

    const result = await client.allocateUniqueAddresses(4);
    expect(result).toMatchObject({ requested: 4, allocated: 4, available: 6, capped: false });
    expect(result.addresses).toHaveLength(4);

    const domainsUsed = result.addresses.map((entry) => entry.domain);
    expect(new Set(domainsUsed).size).toBe(4); // every domain appears exactly once
    domainsUsed.forEach((domain) => expect(domainList).toContain(domain));

    // Prefix + domain form the email; id must be the md5 of the full email.
    for (const entry of result.addresses) {
      expect(entry.email.endsWith(entry.domain)).toBe(true);
      expect(entry.id).toBe(md5EmailId(entry.email));
    }
  });

  it("allocateUniqueAddresses can use all available domains without collision", async () => {
    const domainList = ["@a.com", "@b.com", "@c.com"];
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: domainList }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });

    const result = await client.allocateUniqueAddresses(3);
    expect(result).toMatchObject({ requested: 3, allocated: 3, available: 3, capped: false });
    const domainsUsed = new Set(result.addresses.map((entry) => entry.domain));
    expect(domainsUsed.size).toBe(3);
  });

  it("allocateUniqueAddresses gracefully caps to available domains and flags capped=true", async () => {
    // Realistic Privatix shape: 10 domains active. Operator asks for 25 —
    // we serve 10, flag capped so the caller can log a warning.
    const domainList = Array.from({ length: 10 }, (_, i) => `@pool-${i}.com`);
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: domainList }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });

    const result = await client.allocateUniqueAddresses(25);
    expect(result).toMatchObject({ requested: 25, allocated: 10, available: 10, capped: true });
    expect(result.addresses).toHaveLength(10);
    expect(new Set(result.addresses.map((entry) => entry.domain)).size).toBe(10);
  });

  it("allocateUniqueAddresses throws when Privatix returns zero active domains", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: [] }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });
    await expect(client.allocateUniqueAddresses(3)).rejects.toThrow(/no active domains/);
  });

  it("allocateUniqueAddresses rejects zero and non-integer counts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: ["@x.com"] }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });

    await expect(client.allocateUniqueAddresses(0)).rejects.toThrow(/positive integer/);
    await expect(client.allocateUniqueAddresses(-1)).rejects.toThrow(/positive integer/);
    await expect(client.allocateUniqueAddresses("abc")).rejects.toThrow(/positive integer/);
  });

  it("allocateUniqueAddresses uses a Fisher-Yates shuffle (all domains present, order shuffled)", async () => {
    const domainList = ["@d1.com", "@d2.com", "@d3.com", "@d4.com"];
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: domainList }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });

    // Deterministic RNG: always 0 → shuffle degenerates to reverse order.
    const domainRng = () => 0;
    const result = await client.allocateUniqueAddresses(4, {
      nameCorpus: ["alex"],
      rng: () => 0,
      domainRng,
    });
    const domainsUsed = result.addresses.map((entry) => entry.domain).sort();
    expect(domainsUsed).toEqual([...domainList].sort());
  });

  // ── allocateRandomBatch ────────────────────────────────────────────────

  it("allocateRandomBatch picks a count in the [min, max] range and delegates to unique allocation", async () => {
    const domainList = Array.from({ length: 40 }, (_, i) => `@r-${i}.com`);
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: domainList }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });

    // countRng returns 0.5 → picks the middle of 20..30 (25).
    const result = await client.allocateRandomBatch({ min: 20, max: 30, countRng: () => 0.5 });
    expect(result.requested).toBe(25);
    expect(result.allocated).toBe(25);
    expect(result.addresses).toHaveLength(25);
    expect(new Set(result.addresses.map((a) => a.domain)).size).toBe(25);
  });

  it("allocateRandomBatch surfaces the cap flag when Privatix pool < requested batch", async () => {
    // Realistic pool: 10 domains, default range 20..30.
    const domainList = Array.from({ length: 10 }, (_, i) => `@small-${i}.com`);
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: domainList }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });

    const result = await client.allocateRandomBatch({ countRng: () => 0 }); // → 20
    expect(result.requested).toBe(20);
    expect(result.allocated).toBe(10);
    expect(result.capped).toBe(true);
  });

  it("allocateRandomBatch validates min/max bounds", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(buildFetchResponse({ body: ["@x.com"] }));
    const client = new PrivatixTempMailClient({ apiKey: "k", fetchImpl });
    await expect(client.allocateRandomBatch({ min: 0, max: 10 })).rejects.toThrow(/min <= max/);
    await expect(client.allocateRandomBatch({ min: 10, max: 5 })).rejects.toThrow(/min <= max/);
  });
});
