import { describe, expect, it, vi } from "vitest";
import { detectCodeBuddyCnRestriction, __test__ } from "../../src/lib/oauth/services/codebuddyCnBypass.js";

function page({ url = "https://www.codebuddy.cn/home/", restricted = false } = {}) {
  return { url: () => url, evaluate: vi.fn(async () => restricted) };
}

describe("CodeBuddy CN restriction detection", () => {
  it("detects the upstream CN restriction text", async () => {
    expect(await detectCodeBuddyCnRestriction(page({ restricted: true }))).toBe(true);
  });

  it("detects a restricted route without evaluating the DOM", async () => {
    const target = page({ url: "https://www.codebuddy.cn/no-permission" });
    expect(await detectCodeBuddyCnRestriction(target)).toBe(true);
    expect(target.evaluate).not.toHaveBeenCalled();
  });

  it("does not mark a normal console page restricted", async () => {
    expect(await detectCodeBuddyCnRestriction(page())).toBe(false);
  });

  it("contains the observed Chinese restriction markers", () => {
    expect(__test__.CN_RESTRICTION_PATTERNS).toEqual(expect.arrayContaining([
      "账号访问受限", "安全策略限制", "暂无法访问",
    ]));
  });
});
