import { beforeEach, describe, expect, it, vi } from "vitest";

const managerMock = { startJob: vi.fn() };
const assertProviderEnabled = vi.fn(async () => {});

vi.mock("next/server", () => ({
  NextResponse: { json: vi.fn((body, init) => ({ status: init?.status || 200, body, json: async () => body })) },
}));
vi.mock("@/lib/oauth/services/codebuddyBulkImportManager", () => ({
  getCodeBuddyBulkImportManager: vi.fn(() => managerMock),
}));
vi.mock("@/lib/providerDisabled", () => ({ assertProviderEnabled }));

describe("CodeBuddy Global proxy OAuth route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerMock.startJob.mockResolvedValue({ jobId: "global-wrap-1", status: "running" });
  });

  it("uses the Global provider gate and forwards the selected pool and browser", async () => {
    const { POST } = await import("../../src/app/api/oauth/codebuddy/wrap-login/route.js");
    const response = await POST({ json: async () => ({ proxyPoolId: "pool-1", proxyUrl: "http://ignored", browser: "chromium" }) });
    expect(response.status).toBe(200);
    expect(assertProviderEnabled).toHaveBeenCalledWith("codebuddy");
    expect(managerMock.startJob).toHaveBeenCalledWith({ wrapLogin: true, proxyPoolId: "pool-1", browser: "chromium", concurrency: 1 });
  });

  it("does not forward an empty browser string", async () => {
    const { POST } = await import("../../src/app/api/oauth/codebuddy/wrap-login/route.js");
    const response = await POST({ json: async () => ({ proxyPoolId: "pool-1", browser: "  " }) });
    expect(response.status).toBe(200);
    expect(managerMock.startJob).toHaveBeenCalledWith({ wrapLogin: true, proxyPoolId: "pool-1", browser: undefined, concurrency: 1 });
  });

  it("rejects a missing proxy pool", async () => {
    const { POST } = await import("../../src/app/api/oauth/codebuddy/wrap-login/route.js");
    const response = await POST({ json: async () => ({}) });
    expect(response.status).toBe(400);
    expect(managerMock.startJob).not.toHaveBeenCalled();
  });

  it("preserves provider-disabled status", async () => {
    assertProviderEnabled.mockRejectedValueOnce(Object.assign(new Error("provider disabled"), { status: 409 }));
    const { POST } = await import("../../src/app/api/oauth/codebuddy/wrap-login/route.js");
    const response = await POST({ json: async () => ({ proxyPoolId: "pool-1" }) });
    expect(response.status).toBe(409);
    expect(managerMock.startJob).not.toHaveBeenCalled();
  });
});
