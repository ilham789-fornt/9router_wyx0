import { describe, expect, it, vi } from "vitest";
import { runGithubSignupAutomation, detectState } from "../../src/lib/oauth/services/automation/githubSignupAutomation.js";

// ── Fake Playwright page ───────────────────────────────────────────────────
//
// The signup helper only touches a small slice of the Playwright surface:
// locator/count/isVisible/type/fill/press/getAttribute/click, plus
// goto/url/content/waitForTimeout/waitForLoadState/context.cookies/keyboard.
// This fake reifies exactly that slice so tests can steer the state machine
// deterministically without a real browser.

function createFakePage({
  gotoTracker = [],
  urlStages = ["https://github.com/signup"],
  htmlStages = ["<html><body></body></html>"],
  visibleSelectors = new Set(),
  cookiesByUrl = {},
  clickTracker = [],
  fillTracker = [],
  typeTracker = [],
  keyboardTracker = [],
  advanceOn = {},
} = {}) {
  let stage = 0;
  function currentUrl() {
    return urlStages[Math.min(stage, urlStages.length - 1)];
  }
  function currentHtml() {
    return htmlStages[Math.min(stage, htmlStages.length - 1)];
  }
  // The fake advances stage on specific triggers so tests can simulate
  // GitHub's page transitions. We clamp to whichever of the two stage arrays
  // is longer so a test can vary just the HTML while keeping a single URL
  // stage (common for signup → captcha where the URL doesn't change).
  const maxStage = Math.max(urlStages.length, htmlStages.length) - 1;
  function advance(trigger) {
    if (advanceOn[trigger]) stage = Math.min(stage + 1, maxStage);
  }

  const context = {
    async cookies(url) { return cookiesByUrl[url] || []; },
  };

  const page = {
    goto: async (url) => {
      gotoTracker.push(url);
      advance("goto");
      return null;
    },
    url: () => currentUrl(),
    content: async () => currentHtml(),
    context: () => context,
    waitForLoadState: async () => null,
    waitForTimeout: async () => null,
    keyboard: {
      press: async (key) => { keyboardTracker.push(key); return null; },
    },
    locator: (selector) => {
      const isVisible = visibleSelectors.has(selector);
      const locator = {
        first() { return this; },
        nth() { return this; },
        count: async () => (isVisible ? 1 : 0),
        isVisible: async () => isVisible,
        scrollIntoViewIfNeeded: async () => null,
        click: async () => {
          clickTracker.push({ selector });
          advance("click");
        },
        type: async (ch) => { typeTracker.push({ selector, ch }); },
        fill: async (value) => {
          fillTracker.push({ selector, value });
          if (value !== "") advance("fill");
        },
        pressSequentially: async (value) => { fillTracker.push({ selector, value, sequential: true }); },
        press: async () => null,
        getAttribute: async () => null,
        innerText: async () => "",
      };
      return locator;
    },
  };
  return { page, gotoTracker, clickTracker, fillTracker, typeTracker, keyboardTracker };
}

function makeTempMailStub({ code = "12345678", confirmUrl = null, waitCalls = [] } = {}) {
  return {
    waitForOtp: vi.fn(async (email, opts) => {
      waitCalls.push({ email, opts });
      if (code === null && confirmUrl === null) return null;
      return { code, confirmUrl, message: {} };
    }),
  };
}

const S = {
  email: 'input[name="user[email]"]',
  password: 'input.js-password-with-confirmation',
  passwordConfirm: 'input.js-password-confirm',
  username: 'input[name="user[login]"]',
  verifyBtn: '.js-octocaptcha-load-captcha',
};

describe("runGithubSignupAutomation", () => {
  it("returns failed when the page argument is missing", async () => {
    const result = await runGithubSignupAutomation({});
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/page/i);
  });

  it("returns failed when required credentials are missing", async () => {
    const { page } = createFakePage();
    const result = await runGithubSignupAutomation({ page, tempMailClient: makeTempMailStub() });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/email|username|password/i);
  });

  it("returns failed_rate_limited when landing on the rate-limit page", async () => {
    const { page } = createFakePage({
      urlStages: ["https://github.com/signup"],
      htmlStages: ["<html><body>Unusual activity detected. Please try again later.</body></html>"],
    });
    const result = await runGithubSignupAutomation({
      page,
      email: "auto1@steveix.com",
      username: "autouser1",
      password: "hunter2secretlong",
      tempMailClient: makeTempMailStub(),
    });
    expect(result.status).toBe("failed_rate_limited");
  });

  it("returns failed when the email input is not present", async () => {
    const { page } = createFakePage({ visibleSelectors: new Set() });
    const result = await runGithubSignupAutomation({
      page,
      email: "auto2@steveix.com",
      username: "autouser2",
      password: "hunter2secretlong",
      tempMailClient: makeTempMailStub(),
      shortTimeoutMs: 200,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/email input/i);
  });

  it("succeeds end-to-end via direct-confirm URL from the verification email", async () => {
    const visible = new Set([S.email, S.password, S.passwordConfirm, S.username, S.verifyBtn]);
    const urlStages = [
      "https://github.com/signup",
      "https://github.com/signup",
      "https://github.com/account_verifications/confirm",
      "https://github.com/welcome",
      "https://github.com/welcome",
    ];
    const htmlStages = [
      "<html><body>signup form</body></html>",
      "<html><body>signup form loaded</body></html>",
      "<html><body>launch code verify</body></html>",
      "<html><body>welcome to github</body></html>",
      "<html><body>welcome to github</body></html>",
    ];
    const { page, gotoTracker } = createFakePage({
      visibleSelectors: visible,
      urlStages,
      htmlStages,
      advanceOn: { click: true, goto: true },
    });

    const waitCalls = [];
    const tempMail = makeTempMailStub({
      code: "48392012",
      confirmUrl: "https://github.com/account_verifications/confirm/abc-uuid/48392012",
      waitCalls,
    });
    const stepLog = [];

    const result = await runGithubSignupAutomation({
      page,
      email: "auto3@steveix.com",
      username: "autouser3",
      password: "hunter2secretlong",
      tempMailClient: tempMail,
      captchaWaitMs: 500,
      onStep: (step, msg) => stepLog.push({ step, msg }),
    });

    expect(result.status).toBe("success");
    expect(result.email).toBe("auto3@steveix.com");
    expect(result.username).toBe("autouser3");
    expect(result.password).toBe("hunter2secretlong");
    expect(result.landingUrl).toMatch(/\/welcome/);

    expect(gotoTracker).toEqual(expect.arrayContaining([
      "https://github.com/signup",
      "https://github.com/account_verifications/confirm/abc-uuid/48392012",
    ]));
    expect(waitCalls[0].email).toBe("auto3@steveix.com");
    expect(waitCalls[0].opts.senderMatch).toBe("github");
    expect(waitCalls[0].opts.confirmUrlPattern).toBeInstanceOf(RegExp);
    expect(stepLog.some((entry) => entry.step === "otp_direct_confirm")).toBe(true);
  });

  it("hands off to needs_manual with reason=octocaptcha when captcha stalls the flow", async () => {
    const visible = new Set([S.email, S.password, S.passwordConfirm, S.username, S.verifyBtn]);
    const { page } = createFakePage({
      visibleSelectors: visible,
      urlStages: ["https://github.com/signup"],
      htmlStages: [
        "<html><body>signup form</body></html>",
        "<html><body>octocaptcha iframe here</body></html>",
      ],
      advanceOn: { click: true },
    });

    const result = await runGithubSignupAutomation({
      page,
      email: "auto4@steveix.com",
      username: "autouser4",
      password: "hunter2secretlong",
      tempMailClient: makeTempMailStub(),
      captchaWaitMs: 200,
    });

    expect(result.status).toBe("needs_manual");
    expect(result.reason).toBe("octocaptcha");
  });

  it("returns needs_manual with reason=otp_timeout when temp-mail delivers nothing", async () => {
    const visible = new Set([S.email, S.password, S.passwordConfirm, S.username, S.verifyBtn]);
    const urlStages = [
      "https://github.com/signup",
      "https://github.com/account_verifications",
    ];
    const htmlStages = [
      "<html><body>signup form</body></html>",
      "<html><body>launch code verify</body></html>",
    ];
    const { page } = createFakePage({
      visibleSelectors: visible,
      urlStages,
      htmlStages,
      advanceOn: { click: true },
    });

    const tempMail = { waitForOtp: vi.fn(async () => null) };

    const result = await runGithubSignupAutomation({
      page,
      email: "auto5@steveix.com",
      username: "autouser5",
      password: "hunter2secretlong",
      tempMailClient: tempMail,
      captchaWaitMs: 200,
      otpTimeoutMs: 50,
    });

    expect(result.status).toBe("needs_manual");
    expect(result.reason).toBe("otp_timeout");
  });

  it("surfaces failed_phone_verify when GitHub asks for a phone number after captcha", async () => {
    const visible = new Set([S.email, S.password, S.passwordConfirm, S.username, S.verifyBtn]);
    const { page } = createFakePage({
      visibleSelectors: visible,
      urlStages: ["https://github.com/signup"],
      htmlStages: [
        "<html><body>signup form</body></html>",
        "<html><body>Please verify your phone to continue.</body></html>",
      ],
      advanceOn: { click: true },
    });

    const result = await runGithubSignupAutomation({
      page,
      email: "auto6@steveix.com",
      username: "autouser6",
      password: "hunter2secretlong",
      tempMailClient: makeTempMailStub(),
      captchaWaitMs: 200,
    });

    expect(result.status).toBe("failed_phone_verify");
  });
});

describe("detectState (Playwright-agnostic)", () => {
  function stubPage({ url, html = "", cookies = [] } = {}) {
    return {
      url: () => url,
      content: async () => html,
      context: () => ({ async cookies() { return cookies; } }),
    };
  }

  it("returns 'onboarding' for /welcome landings", async () => {
    const page = stubPage({ url: "https://github.com/welcome", html: "" });
    await expect(detectState(page)).resolves.toBe("onboarding");
  });

  it("returns 'logged_in' when landed on bare github.com with a user_session cookie", async () => {
    const page = stubPage({
      url: "https://github.com/",
      html: "",
      cookies: [{ name: "user_session", value: "x" }],
    });
    await expect(detectState(page)).resolves.toBe("logged_in");
  });

  it("returns 'device_verify' on account_verifications URLs", async () => {
    const page = stubPage({ url: "https://github.com/account_verifications/confirm/xyz", html: "" });
    await expect(detectState(page)).resolves.toBe("device_verify");
  });

  it("returns 'account_created' when the success copy appears on /login", async () => {
    const page = stubPage({
      url: "https://github.com/login",
      html: "<html><body>Your account was created successfully. Please sign in to continue.</body></html>",
    });
    await expect(detectState(page)).resolves.toBe("account_created");
  });

  it("returns 'captcha_present' when octocaptcha + iframe are on the page", async () => {
    const page = stubPage({
      url: "https://github.com/signup",
      html: "<html><body>octocaptcha frame <iframe src='https://octocaptcha.com'></iframe></body></html>",
    });
    await expect(detectState(page)).resolves.toBe("captcha_present");
  });

  it("returns 'rate_limited' on 'unusual activity' pages", async () => {
    const page = stubPage({
      url: "https://github.com/signup",
      html: "<html><body>Unusual activity, please try again later.</body></html>",
    });
    await expect(detectState(page)).resolves.toBe("rate_limited");
  });

  it("returns 'ok' for a plain signup form page", async () => {
    const page = stubPage({
      url: "https://github.com/signup",
      html: "<html><body>signup form</body></html>",
    });
    await expect(detectState(page)).resolves.toBe("ok");
  });
});
