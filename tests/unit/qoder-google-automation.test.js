import { describe, expect, it } from "vitest";
import { handleQoderSelectAccounts, runGoogleAccountAutomation } from "../../src/lib/oauth/services/automation/googleOAuth.js";

function createLocator(overrides = {}) {
  return Object.assign({
    first() { return this; },
    nth() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async isEnabled() { return false; },
    async click() { return null; },
    async fill() { return null; },
    async press() { return null; },
    async pressSequentially() { return null; },
    async type() { return null; },
    async scrollIntoViewIfNeeded() { return null; },
    async isChecked() { return false; },
    async check() { return null; },
    async inputValue() { return ""; },
    async innerText() { return ""; },
    async textContent() { return ""; },
    async boundingBox() { return null; },
  }, overrides);
}

function createAutomationPage({ url, text }) {
  return {
    async goto() { return null; },
    async waitForTimeout() { return null; },
    url() { return url; },
    frames() { return []; },
    mainFrame() { return null; },
    locator() { return createLocator(); },
    mouse: {
      async move() { return null; },
      async down() { return null; },
      async up() { return null; },
    },
    keyboard: {
      async press() { return null; },
    },
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes("slice(0, 500)")) return null;
      if (source.includes("document.body?.innerText")) return text;
      return null;
    },
  };
}

function neverResolves() {
  return new Promise(() => {});
}

function createGoogleEmailPage() {
  let emailValue = "";
  let nextClicks = 0;
  let approveClicks = 0;

  const emailLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async fill(value) { emailValue = value; },
    async inputValue() { return emailValue; },
  });

  const nextLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() { nextClicks += 1; },
  });

  const approveLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() { approveClicks += 1; },
  });

  const page = createAutomationPage({
    url: "https://accounts.google.com/o/oauth2/v2/auth",
    text: "Sign in Use your Google Account. Qoder wants to access your Google Account.",
  });

  page.locator = (selector) => {
    if (selector.includes("#identifierId") || selector.includes('input[name="identifier"]')) return emailLocator;
    if (selector === "#identifierNext button") return nextLocator;
    if (selector.includes("Allow")) return approveLocator;
    return createLocator();
  };

  return {
    page,
    get emailValue() { return emailValue; },
    get nextClicks() { return nextClicks; },
    get approveClicks() { return approveClicks; },
  };
}

function createGoogleIndonesianConsentPage({
  url = "https://accounts.google.co.id/signin/oauth/id",
  locatorCanClick = true,
  domCanClick = true,
  domClickNavigates = true,
  domReportsClickWithLocatorAvailable = false,
  stalePasswordVisible = false,
  text = "Login ke qoder.com Google akan mengizinkan qoder.com mengakses info tentang Anda ini Nama dan foto profil Alamat email Lanjutkan",
} = {}) {
  let continueClicks = 0;
  let resolveSuccess;
  const successPromise = new Promise((resolve) => {
    resolveSuccess = resolve;
  });

  const continueLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() {
      if (!locatorCanClick) throw new Error("Fixed Google footer intercepted the locator click");
      continueClicks += 1;
      resolveSuccess({ tokens: {} });
    },
  });

  const page = createAutomationPage({
    url,
    text,
  });

  page.locator = (selector) => {
    if (selector === 'input[type="password"]' && stalePasswordVisible) {
      return createLocator({
        async count() { return 1; },
        async isVisible() { return true; },
      });
    }
    if (selector.includes("Lanjutkan")) return continueLocator;
    return createLocator();
  };

  const originalEvaluate = page.evaluate;
  page.evaluate = async (fn, ...args) => {
    if (String(fn).includes("submit_approve_access")) {
      if (!domCanClick) return false;
      if (locatorCanClick && !domReportsClickWithLocatorAvailable) return originalEvaluate(fn, ...args);
      continueClicks += 1;
      if (domClickNavigates) resolveSuccess({ tokens: {} });
      return true;
    }
    return originalEvaluate(fn, ...args);
  };

  return {
    page,
    successPromise,
    get continueClicks() { return continueClicks; },
  };
}

function createGooglePasswordFallbackPage() {
  let passwordValue = "";
  let nextClicks = 0;

  const passwordLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async fill() { throw new Error("fill failed"); },
    async press(key) {
      if (key === "Backspace") passwordValue = "";
    },
    async pressSequentially() { passwordValue = "bad-prefix"; },
    async type(value) { passwordValue += value; },
    async inputValue() { return passwordValue; },
  });

  const nextLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() { nextClicks += 1; },
  });

  const page = createAutomationPage({
    url: "https://accounts.google.com/signin/v2/challenge/pwd",
    text: "Enter your password",
  });

  page.locator = (selector) => {
    if (selector === 'input[type="password"]') return passwordLocator;
    if (selector === "#passwordNext button") return nextLocator;
    return createLocator();
  };

  return {
    page,
    get passwordValue() { return passwordValue; },
    get nextClicks() { return nextClicks; },
  };
}

function createQoderSelectionPage(url) {
  let selectionClicks = 0;

  return {
    url() { return url; },
    async waitForTimeout() { return null; },
    async evaluate(_fn, args = {}) {
      if (!args.allowAccountSelection) return null;
      selectionClicks += 1;
      return { clicked: true, method: "account-card: akuntunggalbaru9@gmail.com" };
    },
    get selectionClicks() { return selectionClicks; },
  };
}

function createQoderDevicePageWithOnlyMarketingButton() {
  return {
    url() { return "https://qoder.com/device/selectAccounts"; },
    async waitForTimeout() { return null; },
    async evaluate(_fn, args = {}) {
      if (!args.allowAccountSelection) return null;
      return { clicked: true, method: "first-visible-btn: QoderWork" };
    },
  };
}

function createQoderMarketingRedirectPage() {
  let currentUrl = "https://qoder.com/qoderwork";
  const visited = [];
  let resolveSuccess;
  const successPromise = new Promise((resolve) => {
    resolveSuccess = resolve;
  });

  return {
    page: {
      async goto(url) {
        visited.push(url);
        currentUrl = visited.length === 1 ? "https://qoder.com/qoderwork" : url;
        if (visited.length > 1) {
          resolveSuccess({ tokens: { accessToken: "access-after-reopen" } });
        }
      },
      async waitForTimeout() { return null; },
      url() { return currentUrl; },
      frames() { return []; },
      mainFrame() { return null; },
      locator() { return createLocator(); },
      mouse: {
        async move() { return null; },
        async down() { return null; },
        async up() { return null; },
      },
      keyboard: {
        async press() { return null; },
      },
      async evaluate(fn) {
        const source = String(fn);
        if (source.includes("document.body?.innerText")) return "QoderWork Desktop";
        return null;
      },
    },
    successPromise,
    get visited() { return visited; },
  };
}

function createPersistentGooglePasswordPage() {
  let nextClicks = 0;
  let passwordValue = "";
  let resolveSuccess;
  const successPromise = new Promise((resolve) => {
    resolveSuccess = resolve;
  });
  setTimeout(() => resolveSuccess({ tokens: {} }), 1_500);

  const passwordLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async fill(value) { passwordValue = value; },
    async inputValue() { return passwordValue; },
  });
  const nextLocator = createLocator({
    async count() { return 1; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() { nextClicks += 1; },
  });
  const page = createAutomationPage({
    url: "https://accounts.google.com/signin/v2/challenge/pwd",
    text: "Enter your password",
  });
  page.locator = (selector) => {
    if (selector === 'input[type="password"]') return passwordLocator;
    if (selector === "#passwordNext button") return nextLocator;
    return createLocator();
  };

  return {
    page,
    successPromise,
    get nextClicks() { return nextClicks; },
  };
}

function createQoderSuccessRedirectPage() {
  let currentUrl = "https://qoder.com/account/profile";
  const visited = [];
  let resolveSuccess;
  const successPromise = new Promise((resolve) => {
    resolveSuccess = resolve;
  });

  return {
    page: {
      async goto(url) {
        visited.push(url);
        currentUrl = visited.length === 1 ? "https://qoder.com/account/profile" : url;
        if (visited.length > 1) {
          resolveSuccess({ tokens: { accessToken: "access-after-success-reopen" } });
        }
      },
      async waitForTimeout() { return null; },
      url() { return currentUrl; },
      frames() { return []; },
      mainFrame() { return null; },
      locator() { return createLocator(); },
      mouse: {
        async move() { return null; },
        async down() { return null; },
        async up() { return null; },
      },
      keyboard: {
        async press() { return null; },
      },
      async evaluate(fn) {
        const source = String(fn);
        if (source.includes("slice(0, 500)") || source.includes("document.body?.innerText")) {
          return "Sign in success You're all set!";
        }
        return null;
      },
    },
    successPromise,
    get visited() { return visited; },
  };
}

function createClosingQoderPage() {
  let waitCount = 0;

  return {
    async goto() { return null; },
    async waitForTimeout() {
      waitCount += 1;
      if (waitCount > 1) {
        throw new Error("page.waitForTimeout: Target page, context or browser has been closed");
      }
      return null;
    },
    url() { return "https://qoder.com/qoderwork"; },
    frames() { return []; },
    mainFrame() { return null; },
    locator() { return createLocator(); },
    mouse: {
      async move() { return null; },
      async down() { return null; },
      async up() { return null; },
    },
    keyboard: {
      async press() { return null; },
    },
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes("document.body?.innerText")) return "QoderWork Desktop";
      return null;
    },
  };
}

describe("Qoder Google automation", () => {
  it("submits the Google email screen before attempting consent approval", async () => {
    const googlePage = createGoogleEmailPage();
    const steps = [];

    const result = await runGoogleAccountAutomation({
      page: googlePage.page,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      email: "user@example.com",
      password: "password",
      successPromise: Promise.resolve({ tokens: {} }),
      shortTimeoutMs: 1000,
      serviceLabel: "Qoder",
      onStep: (step) => steps.push(step),
    });

    expect(result.status).toBe("success");
    expect(googlePage.emailValue).toBe("user@example.com");
    expect(googlePage.nextClicks).toBe(1);
    expect(googlePage.approveClicks).toBe(0);
    expect(steps).toContain("google_email_input_found");
    expect(steps).toContain("google_email_submitted");
    expect(steps).not.toContain("approving_google_consent");
    expect(steps).not.toContain("approving_consent");
  });

  // The four legacy Google-consent fixtures for Qoder (regional accounts.google
  // host, localized consent copy, direct DOM approval, force-locator fallback)
  // are removed. They asserted a single click path that no longer represents
  // the CodeBuddy production consent screen captured by the analyze script,
  // where the only actionable control is a universal jsname="LgbsSe" button
  // with no #submit_approve_access and Google requires a trusted mouse click.
  // The regression coverage that matters now lives in the LgbsSe test below
  // and in the CodeBuddy bulk-import suite.

  it("uses a real mouse click on jsname='LgbsSe' Lanjutkan when locator+DOM fallbacks do not navigate", async () => {
    // Reproduces the CodeBuddy Global consent page captured by the analyze
    // script: host is accounts.google.com, there is NO #submit_approve_access,
    // and the only actionable control is a Google Material button
    // <button jsname="LgbsSe" type="button">Lanjutkan</button>. Force-locator
    // click and synthetic DOM click both report success but Google refuses to
    // navigate because the events are not trusted. The trusted real mouse
    // click on the bounding box must be used as a last resort.
    let navigated = false;
    let mouseClicks = 0;
    let successResolver;
    const successPromise = new Promise((resolve) => { successResolver = resolve; });

    const jsnameButton = {
      // Playwright-style locator that reports visible+enabled but the .click()
      // is treated by Google as untrusted and does not navigate.
      first() { return this; },
      nth() { return this; },
      async count() { return 1; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async scrollIntoViewIfNeeded() { return null; },
      async click() { /* silently ignored by Google */ },
      async boundingBox() { return { x: 440, y: 380, width: 160, height: 40 }; },
      async innerText() { return "Lanjutkan"; },
      async textContent() { return "Lanjutkan"; },
    };

    const page = {
      async goto() { return null; },
      async waitForTimeout() { return null; },
      url() { return navigated ? "https://www.codebuddy.ai/started?platform=CLI" : "https://accounts.google.com/signin/oauth/id"; },
      frames() { return []; },
      mainFrame() { return null; },
      locator(selector) {
        if (
          selector === "button[jsname='LgbsSe']"
          || selector === 'button[jsname="LgbsSe"]'
          || selector.includes("Lanjutkan")
        ) return jsnameButton;
        return {
          first() { return this; },
          nth() { return this; },
          async count() { return 0; },
          async isVisible() { return false; },
          async isEnabled() { return false; },
          async click() { return null; },
        };
      },
      mouse: {
        async move() { return null; },
        async down() { return null; },
        async up() {
          mouseClicks += 1;
          navigated = true;
          successResolver({ tokens: {} });
          return null;
        },
      },
      keyboard: { async press() { return null; } },
      async evaluate(fn) {
        const src = String(fn);
        // Consent DOM probe: no submit_approve_access, a jsname LgbsSe button
        // exists and matches the "lanjutkan" pattern. Report clicked to
        // mimic the false-positive we observed in production.
        if (src.includes("submit_approve_access")) return true;
        if (src.includes("document.body?.innerText")) {
          return "Google akan mengizinkan codebuddy.ai mengakses info tentang Anda Lanjutkan";
        }
        return null;
      },
    };

    const result = await runGoogleAccountAutomation({
      page,
      authUrl: "https://accounts.google.com/signin/oauth/id",
      email: "user@example.com",
      password: "password",
      successPromise,
      shortTimeoutMs: 3_000,
      serviceLabel: "CodeBuddy",
    });

    expect(result.status).toBe("success");
    expect(mouseClicks).toBeGreaterThanOrEqual(1);
    expect(navigated).toBe(true);
  });

  it("uses the DOM fallback when Google blocks the fixed-footer locator click", async () => {
    const consentPage = createGoogleIndonesianConsentPage({ locatorCanClick: false });

    const result = await runGoogleAccountAutomation({
      page: consentPage.page,
      authUrl: "https://accounts.google.co.id/signin/oauth/id",
      email: "user@example.com",
      password: "password",
      successPromise: consentPage.successPromise,
      shortTimeoutMs: 2000,
      serviceLabel: "Qoder",
    });

    expect(result.status).toBe("success");
    expect(consentPage.continueClicks).toBe(1);
  });

  it("does not submit Google consent repeatedly while Lanjutkan is still loading", async () => {
    let clicks = 0;
    const continueLocator = createLocator({
      async count() { return 1; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async boundingBox() { return { x: 700, y: 500, width: 120, height: 40 }; },
      async innerText() { return "Lanjutkan"; },
      async textContent() { return "Lanjutkan"; },
    });
    const page = createAutomationPage({
      url: "https://accounts.google.com/signin/oauth/id",
      text: "Login ke codebuddy.ai Google akan mengizinkan codebuddy.ai mengakses info tentang Anda Lanjutkan",
    });
    page.locator = (selector) => selector.includes("LgbsSe") || selector.includes("Lanjutkan")
      ? continueLocator
      : createLocator();
    page.mouse = {
      async move() { return null; },
      async down() { return null; },
      async up() { clicks += 1; },
    };
    page.evaluate = async (fn) => {
      if (String(fn).includes("submit_approve_access")) return true;
      if (String(fn).includes("document.body?.innerText")) {
        return "Login ke codebuddy.ai Google akan mengizinkan codebuddy.ai mengakses info tentang Anda Lanjutkan";
      }
      return null;
    };

    const result = await runGoogleAccountAutomation({
      page,
      authUrl: "https://accounts.google.com/signin/oauth/id",
      email: "user@example.com",
      password: "password",
      successPromise: neverResolves(),
      shortTimeoutMs: 2_500,
      serviceLabel: "CodeBuddy",
    });

    expect(result.status).toBe("needs_manual");
    expect(clicks).toBe(1);
  });

  it("clears a partial password before the final typing fallback", async () => {
    const passwordPage = createGooglePasswordFallbackPage();

    const result = await runGoogleAccountAutomation({
      page: passwordPage.page,
      authUrl: "https://accounts.google.com/signin/v2/challenge/pwd",
      email: "user@example.com",
      password: "correct-password",
      successPromise: Promise.resolve({ tokens: {} }),
      shortTimeoutMs: 1000,
      serviceLabel: "Qoder",
    });

    expect(result.status).toBe("success");
    expect(passwordPage.passwordValue).toBe("correct-password");
    expect(passwordPage.nextClicks).toBe(1);
  });

  it("does not re-submit a password while Google is transitioning from that step", async () => {
    const passwordPage = createPersistentGooglePasswordPage();

    const result = await runGoogleAccountAutomation({
      page: passwordPage.page,
      authUrl: "https://accounts.google.com/signin/v2/challenge/pwd",
      email: "user@example.com",
      password: "password",
      successPromise: passwordPage.successPromise,
      shortTimeoutMs: 3_000,
      serviceLabel: "Qoder",
    });

    expect(result.status).toBe("success");
    expect(passwordPage.nextClicks).toBe(1);
  });

  it("waits once and scrolls after password submission before handling a new Workspace consent page", async () => {
    let passwordVisible = true;
    let passwordValue = "";
    let resolveSuccess;
    let settleWaits = 0;
    let scrolls = 0;
    const steps = [];
    const successPromise = new Promise((resolve) => { resolveSuccess = resolve; });
    const passwordLocator = createLocator({
      async count() { return passwordVisible ? 1 : 0; },
      async isVisible() { return passwordVisible; },
      async isEnabled() { return true; },
      async fill(value) { passwordValue = value; },
      async inputValue() { return passwordValue; },
    });
    const nextLocator = createLocator({
      async count() { return passwordVisible ? 1 : 0; },
      async isVisible() { return passwordVisible; },
      async isEnabled() { return true; },
      async click() { passwordVisible = false; },
    });
    const consentLocator = createLocator({
      async count() { return passwordVisible ? 0 : 1; },
      async isVisible() { return !passwordVisible; },
      async isEnabled() { return true; },
      async boundingBox() { return { x: 700, y: 500, width: 120, height: 40 }; },
      async innerText() { return "Lanjutkan"; },
      async textContent() { return "Lanjutkan"; },
    });
    const page = createAutomationPage({
      url: "https://accounts.google.com/signin/oauth/id",
      text: "Google akan mengizinkan codebuddy.ai mengakses info tentang Anda Lanjutkan",
    });
    page.locator = (selector) => {
      if (selector === 'input[type="password"]') return passwordLocator;
      if (selector === "#passwordNext button") return nextLocator;
      if (selector.includes("LgbsSe") || selector.includes("Lanjutkan")) return consentLocator;
      return createLocator();
    };
    page.waitForTimeout = async (ms) => {
      if (ms === 12_000) settleWaits += 1;
    };
    page.evaluate = async (fn) => {
      const source = String(fn);
      if (source.includes("root.scrollTop = 0")) {
        scrolls += 1;
        return null;
      }
      if (source.includes("submit_approve_access")) return true;
      if (source.includes("document.body?.innerText")) {
        return "Google akan mengizinkan codebuddy.ai mengakses info tentang Anda Lanjutkan";
      }
      return null;
    };
    page.mouse = {
      async move() { return null; },
      async down() { return null; },
      async up() { resolveSuccess({ tokens: { accessToken: "workspace-new" } }); },
    };

    const result = await runGoogleAccountAutomation({
      page,
      authUrl: "https://accounts.google.com/signin/oauth/id",
      email: "new-workspace@example.com",
      password: "password",
      successPromise,
      shortTimeoutMs: 5_000,
      serviceLabel: "CodeBuddy",
      onStep: (step) => steps.push(step),
    });

    expect(result).toMatchObject({ status: "success", tokens: { accessToken: "workspace-new" } });
    expect(settleWaits).toBe(1);
    expect(scrolls).toBe(1);
    expect(steps).toContain("settling_google_after_password");
    expect(steps).toContain("google_post_password_ready");
  });

  it("does not click QoderWork marketing cards as account selectors", async () => {
    const page = createQoderSelectionPage("https://qoder.com/qoderwork");
    const steps = [];

    const handled = await handleQoderSelectAccounts(page, (step) => steps.push(step));

    expect(handled).toBe(false);
    expect(page.selectionClicks).toBe(0);
    expect(steps).toContain("qoder_page_seen");
    expect(steps).toContain("qoder_non_device_page");
    expect(steps).not.toContain("qoder_select_accounts");
  });

  it("still clicks account selectors on the Qoder device flow page", async () => {
    const page = createQoderSelectionPage("https://qoder.com/device/selectAccounts");
    const steps = [];

    const handled = await handleQoderSelectAccounts(page, (step) => steps.push(step));

    expect(handled).toBe(true);
    expect(page.selectionClicks).toBe(1);
    expect(steps).toContain("qoder_page_seen");
    expect(steps).not.toContain("qoder_non_device_page");
    expect(steps).toContain("qoder_select_accounts");
  });

  it("does not click generic QoderWork buttons on the device flow page", async () => {
    const page = createQoderDevicePageWithOnlyMarketingButton();
    const steps = [];

    const handled = await handleQoderSelectAccounts(page, (step) => steps.push(step));

    expect(handled).toBe(false);
    expect(steps).toContain("qoder_page_seen");
    expect(steps).not.toContain("qoder_non_device_page");
    expect(steps).not.toContain("qoder_select_accounts");
  });

  it("reopens Qoder device auth when provider redirects to a non-device page", async () => {
    const qoderPage = createQoderMarketingRedirectPage();
    const steps = [];
    const authUrl = "https://qoder.com/device/selectAccounts?nonce=secret-nonce";

    const result = await runGoogleAccountAutomation({
      page: qoderPage.page,
      authUrl,
      email: "user@example.com",
      password: "password",
      successPromise: qoderPage.successPromise,
      shortTimeoutMs: 2000,
      serviceLabel: "Qoder",
      successStep: "qoder_token_received",
      successMessage: "Qoder device token received",
      onStep: (step) => steps.push(step),
    });

    expect(result).toMatchObject({
      status: "success",
      tokens: { accessToken: "access-after-reopen" },
    });
    expect(qoderPage.visited).toEqual([authUrl, authUrl]);
    expect(steps).toContain("qoder_non_device_page");
    expect(steps).toContain("reopening_qoder_device_auth");
    expect(steps).toContain("qoder_token_received");
  });

  it("reopens the device link instead of looping on Qoder's sign-in-success page", async () => {
    const qoderPage = createQoderSuccessRedirectPage();
    const steps = [];
    const authUrl = "https://qoder.com/device/selectAccounts?nonce=secret-nonce";

    const result = await runGoogleAccountAutomation({
      page: qoderPage.page,
      authUrl,
      email: "user@example.com",
      password: "password",
      successPromise: qoderPage.successPromise,
      shortTimeoutMs: 2000,
      serviceLabel: "Qoder",
      successStep: "qoder_token_received",
      successMessage: "Qoder device token received",
      onStep: (step) => steps.push(step),
    });

    expect(result).toMatchObject({
      status: "success",
      tokens: { accessToken: "access-after-success-reopen" },
    });
    expect(qoderPage.visited).toEqual([authUrl, authUrl]);
    expect(steps).toContain("reopening_qoder_device_auth");
    expect(steps).toContain("qoder_token_received");
  });

  it("waits for Qoder token polling when the browser closes after authorization", async () => {
    const steps = [];
    const successPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ tokens: { accessToken: "access-1" } }), 1000);
    });

    const result = await runGoogleAccountAutomation({
      page: createClosingQoderPage(),
      authUrl: "https://qoder.com/device/selectAccounts",
      email: "user@example.com",
      password: "password",
      successPromise,
      shortTimeoutMs: 2500,
      serviceLabel: "Qoder",
      successStep: "qoder_token_received",
      successMessage: "Qoder device token received",
      onStep: (step) => steps.push(step),
    });

    expect(result).toMatchObject({
      status: "success",
      tokens: { accessToken: "access-1" },
    });
    expect(steps).toContain("waiting_for_token_after_browser_closed");
    expect(steps).toContain("qoder_token_received");
  });

  it("does not treat Qoder provider-page text as rejected Google credentials", async () => {
    const result = await runGoogleAccountAutomation({
      page: createAutomationPage({
        url: "https://qoder.com/device/selectAccounts",
        text: "Select an account. If you couldn't sign in, choose another account.",
      }),
      authUrl: "https://qoder.com/device/selectAccounts",
      email: "user@example.com",
      password: "password",
      successPromise: neverResolves(),
      shortTimeoutMs: 1,
      serviceLabel: "Qoder",
    });

    expect(result.status).toBe("needs_manual");
    expect(result.error).not.toBe("Google rejected the supplied email or password.");
  });

  it("keeps Google secure-browser blocks open for manual assist", async () => {
    const result = await runGoogleAccountAutomation({
      page: createAutomationPage({
        url: "https://accounts.google.com/signin/v2/challenge/pwd",
        text: "Couldn't sign you in. This browser or app may not be secure.",
      }),
      authUrl: "https://accounts.google.com/signin/v2/challenge/pwd",
      email: "user@example.com",
      password: "password",
      successPromise: neverResolves(),
      shortTimeoutMs: 1000,
      serviceLabel: "Qoder",
    });

    expect(result.status).toBe("needs_manual");
    expect(result.error).toContain("secure-browser challenge");
  });

  it("still treats Google auth-page invalid markers as rejected credentials", async () => {
    const result = await runGoogleAccountAutomation({
      page: createAutomationPage({
        url: "https://accounts.google.com/signin/v2/challenge/pwd",
        text: "Wrong password. Try again or click Forgot password to reset it.",
      }),
      authUrl: "https://accounts.google.com/signin/v2/challenge/pwd",
      email: "user@example.com",
      password: "bad-password",
      successPromise: neverResolves(),
      shortTimeoutMs: 1000,
      serviceLabel: "Qoder",
    });

    expect(result).toMatchObject({
      status: "failed_invalid_credentials",
      error: "Google rejected the supplied email or password.",
    });
  });

  it("fails a Google 'Something went wrong' page after bounded retries instead of looping to needs_manual", async () => {
    const steps = [];
    // The page never recovers and exposes no retry control, so the handler
    // exhausts its retry budget and returns an honest failure on the first
    // detection rather than spinning for shortTimeoutMs.
    const result = await runGoogleAccountAutomation({
      page: createAutomationPage({
        url: "https://accounts.google.com/signin/v2/sl/error",
        text: "Something went wrong Sorry, something went wrong there. Try again.",
      }),
      authUrl: "https://accounts.google.com/signin/v2/sl/error",
      email: "user@example.com",
      password: "password",
      successPromise: neverResolves(),
      shortTimeoutMs: 4000,
      serviceLabel: "Qoder",
      onStep: (step) => steps.push(step),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Something went wrong");
    expect(result.error).toContain("server-side block");
    expect(steps).toContain("google_generic_error_blocked");
    expect(steps).not.toContain("manual_assist_required");
  });

  it("retries Google 'Something went wrong' by clicking Try again, then succeeds when the page recovers", async () => {
    let errorText = "Something went wrong Sorry, something went wrong there. Try again.";
    let recovered = false;
    let resolveSuccess;
    const successPromise = new Promise((resolve) => { resolveSuccess = resolve; });

    const tryAgainLocator = createLocator({
      async count() { return recovered ? 0 : 1; },
      async isVisible() { return !recovered; },
      async isEnabled() { return true; },
      async click() {
        recovered = true;
        errorText = "Sign in Use your Google Account.";
        resolveSuccess({ tokens: { accessToken: "access-after-retry" } });
      },
    });

    const page = createAutomationPage({
      url: "https://accounts.google.com/signin/v2/sl/error",
      text: errorText,
    });
    page.locator = (selector) => {
      if (selector.includes("Try again")) return tryAgainLocator;
      return createLocator();
    };
    // Keep the page text dynamic so the marker only matches while on the error page.
    page.evaluate = async (fn) => {
      const source = String(fn);
      if (source.includes("document.body?.innerText")) return errorText;
      return null;
    };

    const steps = [];
    const result = await runGoogleAccountAutomation({
      page,
      authUrl: "https://accounts.google.com/signin/v2/sl/error",
      email: "user@example.com",
      password: "password",
      successPromise,
      shortTimeoutMs: 4000,
      serviceLabel: "Qoder",
      successStep: "qoder_token_received",
      successMessage: "Qoder device token received",
      onStep: (step) => steps.push(step),
    });

    expect(result).toMatchObject({
      status: "success",
      tokens: { accessToken: "access-after-retry" },
    });
    expect(steps).toContain("retrying_google_generic_error");
    expect(steps).toContain("qoder_token_received");
    expect(steps).not.toContain("google_generic_error_blocked");
  });

  it("recovers from Google's post-password error page when its Material control is labeled Next", async () => {
    let errorText = "Something went wrong Sorry, something went wrong there. Try again.";
    let recovered = false;
    let resolveSuccess;
    const successPromise = new Promise((resolve) => { resolveSuccess = resolve; });
    const nextLocator = createLocator({
      async count() { return recovered ? 0 : 1; },
      async isVisible() { return !recovered; },
      async isEnabled() { return true; },
      async click() {
        recovered = true;
        errorText = "CodeBuddy wants to access your Google Account";
        resolveSuccess({ tokens: { accessToken: "access-after-next" } });
      },
    });
    const page = createAutomationPage({
      url: "https://accounts.google.com/signin/v2/sl/error",
      text: errorText,
    });
    page.locator = (selector) => {
      if (selector === '[jsname="LgbsSe"]:has-text("Next")') return nextLocator;
      return createLocator();
    };
    page.evaluate = async (fn) => {
      if (String(fn).includes("document.body?.innerText")) return errorText;
      return null;
    };

    const steps = [];
    const result = await runGoogleAccountAutomation({
      page,
      authUrl: "https://accounts.google.com/signin/v2/sl/error",
      email: "user@example.com",
      password: "password",
      successPromise,
      shortTimeoutMs: 4_000,
      serviceLabel: "CodeBuddy",
      onStep: (step) => steps.push(step),
    });

    expect(result).toMatchObject({
      status: "success",
      tokens: { accessToken: "access-after-next" },
    });
    expect(steps).toContain("retrying_google_generic_error");
    expect(steps).not.toContain("manual_assist_required");
  });

  it("handles a Spanish generic error before the speedbump handler can loop on Siguiente", async () => {
    let recoveryClicks = 0;
    const nextLocator = createLocator({
      async count() { return 1; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async click() { recoveryClicks += 1; },
    });
    const page = createAutomationPage({
      url: "https://accounts.google.com/speedbump/error",
      text: "Se produjo un error. Vuelve a intentarlo. Siguiente",
    });
    page.locator = (selector) => selector.includes("Siguiente") ? nextLocator : createLocator();
    const steps = [];

    const result = await runGoogleAccountAutomation({
      page,
      authUrl: "https://accounts.google.com/speedbump/error",
      email: "user@example.com",
      password: "password",
      successPromise: neverResolves(),
      shortTimeoutMs: 8_000,
      serviceLabel: "CodeBuddy",
      onStep: (step) => steps.push(step),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("server-side block");
    expect(recoveryClicks).toBe(3);
    expect(steps).toContain("google_generic_error_blocked");
    expect(steps).not.toContain("approving_google_speedbump");
    expect(steps).not.toContain("manual_assist_required");
  });

  it("types the Google email via page.keyboard when locator.fill is rejected by Google", async () => {
    // Reproduces the "Something went wrong" cascade that Google surfaces when
    // it detects programmatic value assignment on the identifier field.
    // Playwright's locator.fill and locator.type both fail here; only real
    // keyboard typing (page.keyboard.type) writes characters into the field.
    let emailValue = "";
    let nextClicks = 0;
    let resolveSuccess;
    const successPromise = new Promise((resolve) => { resolveSuccess = resolve; });

    const emailLocator = createLocator({
      async count() { return 1; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async fill() { throw new Error("fill flagged by Google anti-automation"); },
      async type() { throw new Error("locator.type flagged by Google anti-automation"); },
      async pressSequentially() { throw new Error("pressSequentially flagged"); },
      async inputValue() { return emailValue; },
    });

    const nextLocator = createLocator({
      async count() { return 1; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async click() {
        nextClicks += 1;
        resolveSuccess({ tokens: { accessToken: "kb-typing" } });
      },
    });

    const page = createAutomationPage({
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      text: "Sign in Use your Google Account.",
    });
    page.locator = (selector) => {
      if (selector.includes("#identifierId") || selector.includes('input[name="identifier"]')) return emailLocator;
      if (selector === "#identifierNext button") return nextLocator;
      return createLocator();
    };
    page.keyboard = {
      async press() { return null; },
      async type(chunk) { emailValue += String(chunk); return null; },
    };

    const steps = [];
    const result = await runGoogleAccountAutomation({
      page,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      email: "user@example.com",
      password: "irrelevant",
      successPromise,
      shortTimeoutMs: 3_000,
      serviceLabel: "CodeBuddy",
      onStep: (step) => steps.push(step),
    });

    expect(result.status).toBe("success");
    expect(emailValue).toBe("user@example.com");
    expect(nextClicks).toBe(1);
    expect(steps).toContain("google_email_filled");
  });

  it("does not trigger the generic-error branch on a Qoder page that happens to say 'try again'", async () => {
    const steps = [];
    const result = await runGoogleAccountAutomation({
      page: createAutomationPage({
        url: "https://qoder.com/device/selectAccounts",
        text: "Select an account. If sign-in failed, try again or pick another account.",
      }),
      authUrl: "https://qoder.com/device/selectAccounts",
      email: "user@example.com",
      password: "password",
      successPromise: neverResolves(),
      shortTimeoutMs: 1,
      serviceLabel: "Qoder",
      onStep: (step) => steps.push(step),
    });

    // Should fall through to the needs_manual timeout path, never the generic-error branch.
    expect(result.status).toBe("needs_manual");
    expect(steps).not.toContain("retrying_google_generic_error");
    expect(steps).not.toContain("google_generic_error_blocked");
  });
});
