import { beforeEach, describe, expect, it, vi } from "vitest";

const managerMock = {
  startJob: vi.fn(),
  cancelJob: vi.fn(),
};
const assertProviderEnabled = vi.fn();

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("@/lib/oauth/services/codebuddyBulkImportManager", () => ({
  getCodeBuddyBulkImportManager: vi.fn(() => managerMock),
  parseCodeBuddyBulkAccounts: vi.fn((accounts = []) => ({
    parsed: (accounts || [])
      .filter(Boolean)
      .filter((line) => String(line).includes("|"))
      .map((line, index) => {
        const [email, password] = String(line).split("|");
        return { line: index + 1, email, password };
      }),
    invalidLines: (accounts || [])
      .map((line, index) => (!String(line).includes("|") ? index + 1 : null))
      .filter(Boolean),
  })),
}));

vi.mock("@/lib/providerDisabled", () => ({
  assertProviderEnabled,
}));

describe("CodeBuddy bulk import routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels a known job", async () => {
    managerMock.cancelJob.mockReturnValue({
      jobId: "job-1",
      status: "cancelled",
      summary: { total: 1, queued: 0, running: 0, success: 0, failed: 0, needs_manual: 0 },
      accounts: [],
      concurrency: 1,
      createdAt: "2026-06-13T00:00:00.000Z",
      startedAt: "2026-06-13T00:00:01.000Z",
      finishedAt: "2026-06-13T00:00:02.000Z",
    });

    const { POST } = await import("../../src/app/api/oauth/codebuddy/bulk-import/[jobId]/cancel/route.js");
    const response = await POST({}, { params: Promise.resolve({ jobId: "job-1" }) });

    expect(response.status).toBe(200);
    expect(managerMock.cancelJob).toHaveBeenCalledWith("job-1");
    expect(response.body.job.status).toBe("cancelled");
  });

  it("returns 409 when CodeBuddy is disabled", async () => {
    const error = new Error("CodeBuddy is disabled. Re-enable it from the Providers tab to use this feature.");
    error.status = 409;
    assertProviderEnabled.mockRejectedValueOnce(error);

    const { POST } = await import("../../src/app/api/oauth/codebuddy/bulk-import/route.js");
    const response = await POST({
      json: async () => ({
        accounts: ["user@example.com|secret"],
      }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("disabled");
    expect(managerMock.startJob).not.toHaveBeenCalled();
  });

  it("forwards only the selected proxy pool to bulk jobs", async () => {
    managerMock.startJob.mockResolvedValue({ jobId: "job-proxy", status: "running" });
    const { POST } = await import("../../src/app/api/oauth/codebuddy/bulk-import/route.js");
    const response = await POST({
      json: async () => ({
        accounts: ["user@example.com|secret"],
        concurrency: 2,
        proxyPoolId: " pool-1 ",
        proxyUrl: "http://ignored:8080",
      }),
    });

    expect(response.status).toBe(200);
    expect(managerMock.startJob).toHaveBeenCalledWith(expect.objectContaining({
      proxyPoolId: "pool-1",
    }));
    expect(managerMock.startJob.mock.calls[0][0]).not.toHaveProperty("proxyUrl");
  });

  it("returns JSON when the job is missing", async () => {
    managerMock.cancelJob.mockReturnValue(null);

    const { POST } = await import("../../src/app/api/oauth/codebuddy/bulk-import/[jobId]/cancel/route.js");
    const response = await POST({}, { params: Promise.resolve({ jobId: "missing" }) });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Bulk import job not found");
  });
});
