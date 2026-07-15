import { describe, expect, it, vi } from "vitest";
import {
  __test__,
  CodeBuddyCnAutomationManager,
} from "../../src/lib/oauth/services/codebuddyCnAutomationManager.js";

describe("CodeBuddy CN automation manager helpers", () => {
  it("parses credential objects and count-based placeholders", () => {
    const parsedObject = __test__.parseCodeBuddyCnAutomationAccounts([
      {
        email: "user@example.com",
        accessToken: "access-token",
      },
    ]);

    expect(parsedObject.invalidLines).toEqual([]);
    expect(parsedObject.parsed[0]).toMatchObject({
      email: "user@example.com",
      accessToken: "access-token",
      hasCredentials: true,
    });

    const parsedCount = __test__.parseCodeBuddyCnAutomationAccounts([], 2);
    expect(parsedCount.parsed).toHaveLength(2);
    expect(parsedCount.parsed[0].label).toBe("Account 1");
    expect(parsedCount.parsed[1].label).toBe("Account 2");
  });

  it("builds lookup response with recoverable flag for active jobs", () => {
    const response = __test__.buildLookupResponse({
      jobId: "cbcn-1",
      status: "running",
    });

    expect(response.found).toBe(true);
    expect(response.recoverable).toBe(true);
    expect(response.job.jobId).toBe("cbcn-1");
  });

  it("normalizes phone numbers and extracts OTP codes", () => {
    expect(__test__.normalizePhoneNumber("852 9123 4567")).toBe("+85291234567");
    expect(__test__.normalizePhoneNumber("+852 9123 4567")).toBe("+85291234567");
    expect(__test__.splitCodeBuddyCnPhoneForLogin("+852 5355 2982")).toEqual({
      dialCode: "+852",
      localNumber: "53552982",
      fullNumber: "+85253552982",
    });
    expect(__test__.extractOtpCodeFromText("Your CodeBuddy code is 483920")).toBe("483920");
    expect(__test__.extractOtpCodeFromText("no code here")).toBe("");
  });

  function createDialCodeScope({ selected = "+86", updateOnOptionClick = true } = {}) {
    const clicks = [];
    let opened = false;
    let current = selected;
    return {
      clicks,
      locator: vi.fn((selector) => ({
        first: () => ({
          isVisible: async () => {
            if (selector === ".kc-country-selector") return true;
            if (selector.includes("+852")) return opened;
            return false;
          },
          textContent: async () => current,
          click: async () => {
            clicks.push(selector);
            if (selector === ".kc-country-selector") opened = true;
            if (selector.includes("+852") && updateOnOptionClick) current = "+852";
          },
        }),
      })),
      evaluate: async (_callback, value) => current.includes(value),
    };
  }

  it("selects and verifies the 852 country code before phone entry", async () => {
    const scope = createDialCodeScope();

    await expect(__test__.selectPhoneDialCode(scope, "+852")).resolves.toBe(true);

    expect(scope.clicks).toEqual([
      ".kc-country-selector",
      ".kc-country-option:has-text('+852')",
    ]);
  });

  it("does not report the 852 country code selected until the visible selector changes", async () => {
    const scope = createDialCodeScope({ updateOnOptionClick: false });

    await expect(__test__.selectPhoneDialCode(scope, "+852")).resolves.toBe(false);
  });

  function createOtpButtonScope({
    visibleSelector = "input[type='button']",
    visibleSelectors = null,
    disabledSelectors = [],
  } = {}) {
    const clicks = [];
    const visible = new Set(visibleSelectors || [visibleSelector]);
    const disabled = new Set(disabledSelectors);
    return {
      clicks,
      locator: vi.fn((selector) => ({
        first: () => ({
          isVisible: async () => visible.has(selector),
          isEnabled: async () => !disabled.has(selector),
          click: async () => clicks.push(selector),
        }),
      })),
      evaluate: vi.fn(async () => false),
    };
  }

  it("clicks the CodeBuddy CN OTP button in the auth frame before polling 5sim", async () => {
    const loginSurface = createOtpButtonScope();
    const page = { evaluate: vi.fn(async () => false) };

    await expect(__test__.clickCodeBuddyCnOtpRequestButton(loginSurface, page)).resolves.toEqual({
      clicked: true,
      source: "auth_frame_locator",
    });

    expect(loginSurface.clicks).toEqual(["input[type='button']"]);
    expect(loginSurface.evaluate).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("skips disabled CodeBuddy CN OTP button locators", async () => {
    const loginSurface = createOtpButtonScope({
      visibleSelectors: ["input.code-btn", "input[type='button']"],
      disabledSelectors: ["input.code-btn"],
    });
    const page = { evaluate: vi.fn(async () => false) };

    await expect(__test__.clickCodeBuddyCnOtpRequestButton(loginSurface, page, { timeoutMs: 0 })).resolves.toEqual({
      clicked: true,
      source: "auth_frame_locator",
    });

    expect(loginSurface.clicks).toEqual(["input[type='button']"]);
    expect(loginSurface.evaluate).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("retries when the CodeBuddy CN login button renders late", async () => {
    const clicks = [];
    let loginButtonChecks = 0;
    const page = {
      locator: vi.fn((selector) => ({
        first: () => ({
          isVisible: async () => {
            if (selector !== "button.btn-login") return false;
            loginButtonChecks += 1;
            return loginButtonChecks > 1;
          },
          isEnabled: async () => true,
          click: async () => clicks.push(selector),
        }),
      })),
      evaluate: vi.fn(async () => false),
    };

    await expect(__test__.clickPrimaryCodeBuddyCnLoginButton(page, {
      timeoutMs: 5_000,
      retryIntervalMs: 0,
      postClickDelayMs: 0,
    })).resolves.toBe(true);

    expect(loginButtonChecks).toBeGreaterThan(1);
    expect(clicks).toEqual(["button.btn-login"]);
  });

  it("recognizes phone auth inputs inside login-frame child iframes", async () => {
    const authFrame = {
      locator: vi.fn((selector) => ({
        first: () => ({
          isVisible: async () => selector === "#phoneNumber",
        }),
      })),
      evaluate: vi.fn(async () => false),
    };
    const loginFrame = {
      locator: vi.fn((selector) => ({
        first: () => ({
          elementHandle: async () => selector === "iframe[src*='auth']"
            ? { contentFrame: async () => authFrame }
            : null,
          isVisible: async () => false,
        }),
      })),
      evaluate: vi.fn(async () => false),
    };
    const page = { frames: () => [] };

    await expect(__test__.findCodeBuddyCnPhoneAuthSurface(page, loginFrame)).resolves.toBe(authFrame);
  });

  it("opens alternate SMS login mode labels in the CodeBuddy CN modal", async () => {
    const clicks = [];
    const loginFrame = {
      url: () => "https://www.codebuddy.cn/login?platform=website",
      locator: vi.fn((selector) => ({
        first: () => ({
          isVisible: async () => selector === "text=短信登录",
          isEnabled: async () => true,
          click: async () => clicks.push(selector),
        }),
      })),
      evaluate: vi.fn(async () => false),
    };
    const page = {
      frames: () => [loginFrame],
    };

    await expect(__test__.clickPhoneLoginInModal(page)).resolves.toBe(true);

    expect(clicks).toContain("text=短信登录");
  });

  it("resolves 5sim order config from account-specific overrides", () => {
    const config = __test__.getFiveSimOrderConfig({
      options: {
        fiveSimCountry: "hongkong",
        fiveSimOperator: "any",
        fiveSimProduct: "other",
      },
    }, {
      fiveSimCountry: "indonesia",
      fiveSimOperator: "telkomsel",
      fiveSimProduct: "wechat",
    });

    expect(config).toEqual({
      country: "indonesia",
      operator: "telkomsel",
      product: "wechat",
    });
  });

  it("defaults automatic SMS registration to enow's HK 5sim route", () => {
    expect(__test__.getFiveSimOrderConfig({ options: {} }, {})).toEqual({
      country: "hongkong",
      operator: "virtual54",
      product: "codebuddy",
    });
  });

  function createFiveSimFlowDeps({ loginSurface = {}, orderNumber = null, clickOtpButton = null, waitForOtp = null } = {}) {
    return {
      getProfile: vi.fn(async () => ({ balance: 1 })),
      openLoginUi: vi.fn(async () => loginSurface),
      orderNumber: orderNumber || vi.fn(async () => ({
        id: "order-1",
        phone: "+85290510602",
        country: "hongkong",
        operator: "virtual54",
        product: "codebuddy",
        price: 0.13,
      })),
      fillPhone: vi.fn(async () => true),
      clickOtpButton: clickOtpButton || vi.fn(async () => ({ clicked: true, source: "auth_frame_locator" })),
      waitForOtp: waitForOtp || vi.fn(async () => ({ code: "483920", order: { id: "order-1" } })),
      fillOtp: vi.fn(async () => true),
      clickSubmit: vi.fn(async () => true),
      waitForCredentials: vi.fn(async () => ({ apiKey: "cbcn-api-key" })),
      setOrderStatus: vi.fn(async () => null),
    };
  }

  it("opens the CodeBuddy CN SMS form before buying a 5sim number", async () => {
    const callOrder = [];
    const steps = [];
    const loginSurface = { name: "login-surface" };
    const deps = createFiveSimFlowDeps({ loginSurface });
    deps.getProfile.mockImplementation(async () => {
      callOrder.push("profile");
      return { balance: 1 };
    });
    deps.openLoginUi.mockImplementation(async () => {
      callOrder.push("open-login");
      return loginSurface;
    });
    deps.orderNumber.mockImplementation(async () => {
      callOrder.push("order-number");
      return {
        id: "order-1",
        phone: "+85290510602",
        country: "hongkong",
        operator: "virtual54",
        product: "codebuddy",
        price: 0.13,
      };
    });
    deps.fillPhone.mockImplementation(async (surface, phone) => {
      callOrder.push("fill-phone");
      expect(surface).toBe(loginSurface);
      expect(phone).toBe("+85290510602");
      return true;
    });
    deps.clickOtpButton.mockImplementation(async () => {
      callOrder.push("click-otp");
      return { clicked: true, source: "auth_frame_locator" };
    });
    deps.waitForOtp.mockImplementation(async (_job, orderId, _onStep, { retryOtpRequest }) => {
      callOrder.push("wait-otp");
      expect(orderId).toBe("order-1");
      expect(retryOtpRequest).toBeTypeOf("function");
      return { code: "483920", order: { id: "order-1" } };
    });
    deps.fillOtp.mockImplementation(async () => {
      callOrder.push("fill-otp");
      return true;
    });
    deps.clickSubmit.mockImplementation(async () => {
      callOrder.push("submit");
      return true;
    });
    deps.waitForCredentials.mockImplementation(async () => {
      callOrder.push("credentials");
      return { apiKey: "cbcn-api-key" };
    });
    deps.setOrderStatus.mockImplementation(async () => {
      callOrder.push("finish-order");
      return null;
    });

    const account = { providerSpecificData: {} };
    const result = await __test__.runFiveSimRegistrationFlow(
      { options: { fiveSimApiKey: "five-token" }, cancelRequested: false },
      account,
      {},
      (step) => steps.push(step),
      deps,
    );

    expect(result).toEqual({ apiKey: "cbcn-api-key" });
    expect(callOrder).toEqual([
      "profile",
      "open-login",
      "order-number",
      "fill-phone",
      "click-otp",
      "wait-otp",
      "fill-otp",
      "submit",
      "credentials",
      "finish-order",
    ]);
    expect(steps.indexOf("opening_sms_login")).toBeLessThan(steps.indexOf("ordering_5sim_number"));
    expect(account.providerSpecificData.fiveSimOrderId).toBe("order-1");
    expect(deps.setOrderStatus).toHaveBeenCalledWith("five-token", "finish", "order-1");
  });

  it("does not buy a 5sim number when the CodeBuddy CN SMS form is unavailable", async () => {
    const orderNumber = vi.fn();
    const deps = createFiveSimFlowDeps({ loginSurface: null, orderNumber });
    const steps = [];

    await expect(__test__.runFiveSimRegistrationFlow(
      { options: { fiveSimApiKey: "five-token" }, cancelRequested: false },
      { providerSpecificData: {} },
      {},
      (step) => steps.push(step),
      deps,
    )).rejects.toThrow("before buying a 5sim number");

    expect(steps).toContain("opening_sms_login");
    expect(orderNumber).not.toHaveBeenCalled();
  });

  it("does not buy a 5sim number when cancellation arrives after the SMS form opens", async () => {
    const job = { options: { fiveSimApiKey: "five-token" }, cancelRequested: false };
    const orderNumber = vi.fn();
    const deps = createFiveSimFlowDeps({ orderNumber });
    deps.openLoginUi.mockImplementation(async () => {
      job.cancelRequested = true;
      return { name: "login-surface" };
    });

    await expect(__test__.runFiveSimRegistrationFlow(
      job,
      { providerSpecificData: {} },
      {},
      () => null,
      deps,
    )).rejects.toThrow("Job cancelled");

    expect(orderNumber).not.toHaveBeenCalled();
  });

  it("caps CodeBuddy CN OTP request retries while waiting for 5sim", async () => {
    const clickOtpButton = vi.fn(async () => ({ clicked: true, source: "auth_frame_locator" }));
    const waitForOtp = vi.fn(async (_job, _orderId, _onStep, { retryOtpRequest }) => {
      await retryOtpRequest();
      await retryOtpRequest();
      await retryOtpRequest();
      return { code: "483920", order: { id: "order-1" } };
    });
    const deps = createFiveSimFlowDeps({ clickOtpButton, waitForOtp });
    const steps = [];

    await __test__.runFiveSimRegistrationFlow(
      { options: { fiveSimApiKey: "five-token" }, cancelRequested: false },
      { providerSpecificData: {} },
      {},
      (step) => steps.push(step),
      deps,
    );

    expect(clickOtpButton).toHaveBeenCalledTimes(3);
    expect(clickOtpButton).toHaveBeenNthCalledWith(1, expect.any(Object), {});
    expect(clickOtpButton).toHaveBeenNthCalledWith(2, expect.any(Object), {}, { timeoutMs: 3_000 });
    expect(clickOtpButton).toHaveBeenNthCalledWith(3, expect.any(Object), {}, { timeoutMs: 3_000 });
    expect(steps.filter((step) => step === "requesting_otp_retry")).toHaveLength(2);
  });

  it("selects the recovered CodeBuddy CN mainland region after login", async () => {
    const selectOption = vi.fn(async () => undefined);
    const click = vi.fn(async () => undefined);
    const page = {
      locator: vi.fn((selector) => {
        if (selector.includes("region-select")) {
          return { count: async () => 1, selectOption };
        }
        return { count: async () => 1, first: () => ({ click }) };
      }),
      waitForTimeout: vi.fn(async () => undefined),
    };

    const result = await __test__.selectCodeBuddyCnRegion(page);

    expect(result).toEqual({ selected: true, region: "china-mainland" });
    expect(selectOption).toHaveBeenCalledWith("china-mainland");
    expect(click).toHaveBeenCalledOnce();
  });

  it("infers one automation slot when only 5sim api key is provided", () => {
    expect(__test__.getEffectiveAutomationCount({
      accounts: [],
      count: 0,
      fiveSimApiKey: "five-sim-token",
    })).toBe(1);

    expect(__test__.getEffectiveAutomationCount({
      accounts: ["someone@example.com"],
      count: 0,
      fiveSimApiKey: "five-sim-token",
    })).toBe(0);
  });

  it("finishes an authenticated account in enow lifecycle order", async () => {
    const order = [];
    const lifecycleRunner = vi.fn(async ({ beforeActivation }) => {
      order.push("gateway");
      await beforeActivation();
      order.push("activation");
      return {
        activation: { status: "activated", method: "browser" },
        gateway: { authenticated: true, blocked: false, probation: false, message: "" },
      };
    });
    const createApiKey = vi.fn(async () => {
      order.push("api-key");
      return "cbcn-api-key";
    });
    const usageLoader = vi.fn(async () => {
      order.push("quota");
      return {
        providerSpecificDataPatch: {
          codebuddyCnCreditLimit: 100,
        },
      };
    });
    const saveConnection = vi.fn(async (account) => {
      order.push("save");
      expect(account.providerSpecificData).toMatchObject({
        activationStatus: "activated",
        activationMethod: "browser",
        gatewayAuthenticated: true,
        gatewayBlocked: false,
        gatewayProbation: false,
      });
      return { connection: { id: "cbcn-connection" } };
    });
    const manager = new CodeBuddyCnAutomationManager({
      lifecycleRunner,
      createApiKey,
      usageLoader,
      saveConnection,
      storageName: "codebuddy-cn-lifecycle-order-test",
    });
    const account = {
      accessToken: "",
      apiKey: "",
      providerSpecificData: {},
      logs: [],
    };

    const result = await manager.finishAuthenticatedAccount({
      job: { cancelRequested: false, options: {} },
      account,
      page: {},
      extracted: { accessToken: "access-token", cookiesJson: "[]" },
    });

    expect(order).toEqual(["api-key", "gateway", "quota", "activation", "save"]);
    expect(account.providerSpecificData.codebuddyCnCreditLimit).toBe(100);
    expect(result.connection.id).toBe("cbcn-connection");
  });

  it("opens the official OAuth URL through the browser and returns OAuth tokens", async () => {
    const goto = vi.fn(async () => undefined);
    const page = {
      goto,
      url: vi.fn(() => "https://www.codebuddy.cn/home/"),
      evaluate: vi.fn(async () => false),
      context: vi.fn(() => ({ cookies: vi.fn(async () => []) })),
    };
    const requestDeviceCode = vi.fn(async () => ({
      verification_uri: "https://www.codebuddy.cn/auth/realms/copilot/device",
      device_code: "oauth-state",
    }));
    const pollForToken = vi.fn(async () => ({
      success: true,
      tokens: {
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        providerSpecificData: { domain: "www.codebuddy.cn" },
      },
    }));

    const result = await __test__.waitForCodeBuddyCnOAuthTokens(
      { cancelRequested: false, options: { smsTimeoutMs: 30_000, pollIntervalMs: 1 } },
      page,
      { requestDeviceCode, pollForToken }
    );

    expect(requestDeviceCode).toHaveBeenCalledWith("codebuddy-cn");
    expect(pollForToken).toHaveBeenCalledWith("codebuddy-cn", "oauth-state");
    expect(goto).toHaveBeenNthCalledWith(1, "https://www.codebuddy.cn/auth/realms/copilot/device", expect.any(Object));
    expect(result).toMatchObject({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      providerSpecificData: { domain: "www.codebuddy.cn" },
    });
  });

  it("does not create an API key for a proxy-routed OAuth login", async () => {
    const createApiKey = vi.fn();
    const saveConnection = vi.fn(async (account) => {
      expect(account.apiKey).toBeFalsy();
      expect(account.accessToken).toBe("oauth-access");
      expect(account.refreshToken).toBe("oauth-refresh");
      return { connection: { id: "oauth-connection" } };
    });
    const manager = new CodeBuddyCnAutomationManager({
      createApiKey,
      lifecycleRunner: vi.fn(async ({ beforeActivation }) => {
        await beforeActivation();
        return {
          activation: { status: "already_active", method: "status" },
          gateway: { authenticated: true, blocked: false, probation: false, message: "" },
        };
      }),
      usageLoader: vi.fn(async () => null),
      saveConnection,
      storageName: "codebuddy-cn-proxy-oauth-test",
    });

    await manager.finishAuthenticatedAccount({
      job: { cancelRequested: false, options: { wrapLogin: true } },
      account: { proxyWrappedLogin: true, providerSpecificData: {}, logs: [] },
      page: { locator: vi.fn(() => ({ count: vi.fn(async () => 0) })) },
      extracted: {
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        providerSpecificData: { authKind: "access_token" },
      },
    });

    expect(createApiKey).not.toHaveBeenCalled();
    expect(saveConnection).toHaveBeenCalledOnce();
  });

  it("picks the first CN login-reachable proxy before starting wrap login", async () => {
    const browserLauncher = vi.fn(async () => ({
      newContext: vi.fn(async () => ({
        newPage: vi.fn(async () => ({
          goto: vi.fn(async () => null),
          url: vi.fn(() => "https://www.codebuddy.cn/login"),
          evaluate: vi.fn(async () => false),
          context: vi.fn(() => ({ cookies: vi.fn(async () => []) })),
        })),
        close: vi.fn(async () => null),
      })),
      close: vi.fn(async () => null),
    }));
    const proxyBrowserPicker = vi.fn(async ({ proxyUrls, testUrl, browserLauncher: launch }) => {
      expect(proxyUrls).toEqual(["http://bad:8080", "http://good:8080"]);
      expect(testUrl).toBe("https://www.codebuddy.cn/login");
      return {
        browser: await launch("camofox", { headless: false, proxy: "http://good:8080" }),
        proxyUrl: "http://good:8080",
        checked: 2,
        error: null,
      };
    });
    const manager = new CodeBuddyCnAutomationManager({
      browserLauncher,
      proxyBrowserPicker,
      storageName: "codebuddy-cn-proxy-picker-test",
    });

    await manager.startJob({
      accounts: [],
      count: 1,
      concurrent: 1,
      wrapLogin: true,
      proxyUrl: "http://bad:8080 http://good:8080",
    });

    expect(proxyBrowserPicker).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(browserLauncher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ proxy: "http://good:8080" })
    ));
  });

  it("does not save a connection when cancellation arrives during lifecycle checks", async () => {
    const job = { cancelRequested: false, options: {} };
    const saveConnection = vi.fn();
    const manager = new CodeBuddyCnAutomationManager({
      lifecycleRunner: vi.fn(async ({ beforeActivation }) => {
        await beforeActivation();
        job.cancelRequested = true;
        return {
          activation: { status: "activation_skipped", error: "cancelled" },
          gateway: { authenticated: false, blocked: false, probation: true, message: "probation" },
        };
      }),
      createApiKey: vi.fn(async () => "late-api-key"),
      usageLoader: vi.fn(async () => null),
      saveConnection,
      storageName: "codebuddy-cn-lifecycle-cancel-test",
    });

    await expect(manager.finishAuthenticatedAccount({
      job,
      account: { providerSpecificData: {}, logs: [] },
      page: {},
      extracted: { accessToken: "access-token" },
    })).rejects.toThrow("Job cancelled");

    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("immediately finalizes active live accounts when cancelling a job", () => {
    const manager = new CodeBuddyCnAutomationManager({
      storageName: "codebuddy-cn-live-cancel-test",
    });
    const close = vi.fn(async () => null);
    const createdAt = "2026-06-24T00:00:00.000Z";
    manager.jobs.set("job-cancel-test", {
      jobId: "job-cancel-test",
      status: "running",
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      concurrency: 3,
      browserChoice: "camoufox",
      browser: { close },
      cancelRequested: false,
      options: {},
      error: null,
      accounts: [
        { line: 1, label: "Account 1", status: "running", workerId: 1, currentStep: "worker_assigned", logs: [] },
        { line: 2, label: "Account 2", status: "queued", workerId: null, currentStep: "queued", logs: [] },
        { line: 3, label: "Account 3", status: "needs_manual", workerId: 3, currentStep: "awaiting_manual_login", logs: [] },
        { line: 4, label: "Account 4", status: "success", workerId: 4, currentStep: "connection_saved", logs: [], connectionId: "conn-1" },
      ],
    });

    const cancelled = manager.cancelJob("job-cancel-test");

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).toBeTruthy();
    expect(cancelled.summary).toMatchObject({
      queued: 0,
      running: 0,
      needs_manual: 0,
      cancelled: 3,
      success: 1,
    });
    expect(cancelled.accounts.slice(0, 3).map((account) => account.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(cancelled.accounts[0].currentStep).toBe("cancelled");
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps cancelled accounts cancelled when late browser callbacks finish", () => {
    const manager = new CodeBuddyCnAutomationManager({
      storageName: "codebuddy-cn-cancel-overwrite-test",
    });
    const account = {
      line: 1,
      label: "Account 1",
      status: "cancelled",
      error: "Job cancelled",
      connectionId: null,
      currentStep: "cancelled",
      logs: [],
    };

    expect(manager.finalizeAccount(account, "success", {
      connectionId: "late-connection",
      step: "connection_saved",
      message: "Late success",
    })).toBe(account);
    expect(manager.setAccountStep(account, "saving_connection", "Late callback")).toBeNull();

    expect(account.status).toBe("cancelled");
    expect(account.connectionId).toBeNull();
    expect(account.currentStep).toBe("cancelled");
    expect(account.logs).toEqual([]);
  });

  it("serializes CodeBuddy CN browser context creation per job", async () => {
    const order = [];
    let active = 0;
    let maxActive = 0;
    const browser = {
      newContext: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start-${browser.newContext.mock.calls.length}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          newPage: vi.fn(async () => ({})),
        };
      }),
    };
    const job = { browser, cancelRequested: false };

    await Promise.all([
      __test__.createCodeBuddyCnWorkerContext(job),
      __test__.createCodeBuddyCnWorkerContext(job),
      __test__.createCodeBuddyCnWorkerContext(job),
    ]);

    expect(browser.newContext).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start-1", "start-2", "start-3"]);
  });

  it("preserves activation and gateway metadata during the first credit refresh", () => {
    const merged = __test__.mergeCodeBuddyCnUsageMetadata({
      activationStatus: "activated",
      gatewayProbation: true,
      gatewayMessage: "probation",
    }, {
      providerSpecificDataPatch: {
        activationStatus: "stale-overwrite",
        gatewayProbation: false,
        codebuddyCnCreditLimit: 100,
      },
    });

    expect(merged).toMatchObject({
      activationStatus: "activated",
      gatewayProbation: true,
      gatewayMessage: "probation",
      codebuddyCnCreditLimit: 100,
    });
  });
});
