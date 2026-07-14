import { beforeEach, describe, expect, it, vi } from "vitest";

const managerMock = { startJob: vi.fn() };
const assertProviderEnabled = vi.fn(async () => {});

vi.mock("next/server", () => ({
  NextResponse: { json: vi.fn((body, init) => ({ status: init?.status || 200, body, json: async () => body })) },
}));
vi.mock("@/lib/oauth/services/codebuddyCnAutomationManager", () => ({
  getCodeBuddyCnAutomationManager: vi.fn(() => managerMock),
}));
vi.mock("@/lib/providerDisabled", () => ({ assertProviderEnabled }));

describe("CodeBuddy CN proxy login route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerMock.startJob.mockResolvedValue({ jobId: "proxy-login-1", status: "running" });
  });

  it("honors the provider safety gate and passes only the proxy pool id", async () => {
    const { POST } = await import("../../src/app/api/tools/automation/cbcn/wrap-login/route.js");
    const response = await POST({ json: async () => ({ proxyPoolId: "pool-1", browser: "chromium" }) });
    expect(response.status).toBe(200);
    expect(assertProviderEnabled).toHaveBeenCalledWith("codebuddy-cn");
    expect(managerMock.startJob).toHaveBeenCalledWith(expect.objectContaining({
      accounts: [], count: 1, concurrent: 1, browser: "chromium", wrapLogin: true, proxyPoolId: "pool-1",
    }));
    expect(managerMock.startJob.mock.calls[0][0]).not.toHaveProperty("proxyUrl");
  });

  it("rejects a missing proxy pool", async () => {
    const { POST } = await import("../../src/app/api/tools/automation/cbcn/wrap-login/route.js");
    const response = await POST({ json: async () => ({ browser: "camofox" }) });
    expect(response.status).toBe(400);
    expect(managerMock.startJob).not.toHaveBeenCalled();
  });

  it("returns the provider-disabled error without starting a job", async () => {
    assertProviderEnabled.mockRejectedValueOnce(Object.assign(new Error("provider disabled"), { status: 409 }));
    const { POST } = await import("../../src/app/api/tools/automation/cbcn/wrap-login/route.js");
    const response = await POST({ json: async () => ({ proxyPoolId: "pool-1" }) });
    expect(response.status).toBe(409);
    expect(managerMock.startJob).not.toHaveBeenCalled();
  });
});
