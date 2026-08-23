import { describe, expect, it } from "vitest";

import { assertPublicUrl } from "../../src/shared/utils/ssrfGuard.js";

describe("SSRF guard IPv4-mapped IPv6 handling", () => {
  it.each([
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:192.168.1.10]/",
  ])("blocks private mapped address %s after URL canonicalization", (url) => {
    expect(() => assertPublicUrl(url)).toThrow("Blocked URL: private IP");
  });

  it("does not classify a public mapped address as private", () => {
    expect(() => assertPublicUrl("http://[::ffff:8.8.8.8]/")).not.toThrow();
  });
});
