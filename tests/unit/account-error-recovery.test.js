import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

import { clearAccountError } from "@/sse/services/auth.js";

describe("account error recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  it("clears persisted error code and backoff after the last lock expires", async () => {
    await clearAccountError("connection-a", {
      id: "connection-a",
      testStatus: "unavailable",
      lastError: "temporary failure",
      errorCode: 502,
      lastErrorAt: "2026-01-01T00:00:00.000Z",
      backoffLevel: 2,
      modelLock___all: "2026-01-01T00:00:00.000Z",
    });

    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("connection-a", {
      modelLock___all: null,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
    });
  });
});
