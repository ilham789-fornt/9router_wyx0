import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectIdeInstalled: vi.fn(),
  assertProviderEnabled: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: vi.fn((body, init = {}) => ({ body, status: init.status || 200 })) },
}));
vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));
vi.mock("@/models", () => ({ createProviderConnection: vi.fn() }));
vi.mock("@/shared/constants/providers", () => ({ AI_PROVIDERS: {} }));
vi.mock("@/lib/providerDisabled", () => ({ assertProviderEnabled: mocks.assertProviderEnabled }));
vi.mock("@/lib/oauth/constants/oauth", () => ({ ZED_HOSTED_CONFIG: { defaultNativeAppPort: 58443 } }));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: mocks.detectIdeInstalled }));
vi.mock("@/lib/oauth/utils/server", () => ({
  startCodexProxy: vi.fn(), stopCodexProxy: vi.fn(), registerCodexSession: vi.fn(), getCodexSessionStatus: vi.fn(), clearCodexSession: vi.fn(),
  startXaiProxy: vi.fn(), stopXaiProxy: vi.fn(), registerXaiSession: vi.fn(), getXaiSessionStatus: vi.fn(), clearXaiSession: vi.fn(),
  startTraeProxy: vi.fn(), stopTraeProxy: vi.fn(), registerTraeSession: vi.fn(), getTraeSessionStatus: vi.fn(), clearTraeSession: vi.fn(),
  startWindsurfProxy: vi.fn(), stopWindsurfProxy: vi.fn(), registerWindsurfSession: vi.fn(), getWindsurfSessionStatus: vi.fn(), clearWindsurfSession: vi.fn(),
  startZedProxy: vi.fn(), stopZedProxy: vi.fn(), registerZedSession: vi.fn(), getZedSessionStatus: vi.fn(), clearZedSession: vi.fn(),
}));

const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

describe("OAuth IDE status route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks a supported IDE after enforcing provider availability", async () => {
    mocks.detectIdeInstalled.mockResolvedValue({ installed: true, path: "C:\\Trae\\Trae.exe" });

    const response = await GET(
      { url: "http://localhost/api/oauth/trae/ide-status" },
      { params: Promise.resolve({ provider: "trae", action: "ide-status" }) },
    );

    expect(mocks.assertProviderEnabled).toHaveBeenCalledWith("trae");
    expect(mocks.detectIdeInstalled).toHaveBeenCalledWith("trae");
    expect(response.body).toEqual({ installed: true, path: "C:\\Trae\\Trae.exe" });
  });

  it("rejects unsupported providers", async () => {
    const response = await GET(
      { url: "http://localhost/api/oauth/claude/ide-status" },
      { params: Promise.resolve({ provider: "claude", action: "ide-status" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.detectIdeInstalled).not.toHaveBeenCalled();
  });
});
