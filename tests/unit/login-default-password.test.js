import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  cookieStore: {},
  setDashboardAuthCookie: vi.fn(),
  isOidcConfigured: vi.fn(() => false),
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "198.51.100.20"),
  isLocalRequest: vi.fn(() => false),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init = {}) => ({
      body,
      status: init.status || 200,
      headers: init.headers || {},
    })),
  },
}));

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => mocks.cookieStore) }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/dashboardSession", () => ({ setDashboardAuthCookie: mocks.setDashboardAuthCookie }));
vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: mocks.isOidcConfigured }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));

const { POST } = await import("../../src/app/api/auth/login/route.js");
const originalInitialPassword = process.env.INITIAL_PASSWORD;

function request(password = "123456") {
  return {
    json: vi.fn(async () => ({ password })),
    headers: new Headers({ host: "router.example.com" }),
  };
}

describe("fresh-install default-password login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INITIAL_PASSWORD;
    mocks.getSettings.mockResolvedValue({ password: null, authMode: "password" });
    mocks.isLocalRequest.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalInitialPassword === undefined) delete process.env.INITIAL_PASSWORD;
    else process.env.INITIAL_PASSWORD = originalInitialPassword;
  });

  it("rejects remote default-password login without issuing a session", async () => {
    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(response.body.mustChangePassword).toBe(true);
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("keeps local first-run login available", async () => {
    mocks.isLocalRequest.mockReturnValue(true);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, mustChangePassword: false });
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledWith(mocks.cookieStore, expect.anything());
  });

  it("allows a configured initial password remotely", async () => {
    process.env.INITIAL_PASSWORD = "configured-secret";

    const response = await POST(request("configured-secret"));

    expect(response.status).toBe(200);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });
});
