import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BaseBulkImportManager } from "../../src/lib/oauth/services/automation/baseBulkImportManager.js";

class SnapshotTestBulkImportManager extends BaseBulkImportManager {
  constructor(storageName) {
    super({
      storageName,
      providerLabel: "Snapshot Test",
      browserLauncher: async () => new Promise(() => {}),
    });
  }

  async processAccount() {}
}

describe("BaseBulkImportManager", () => {
  it("persists the initial job snapshot before startJob returns", () => {
    const storageName = `base-bulk-import-start-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const manager = new SnapshotTestBulkImportManager(storageName);

    try {
      const job = manager.startJob({
        parsedAccounts: [{ line: 1, email: "user@example.com", password: "secret" }],
        concurrency: 1,
      });
      const jobFile = path.join(manager.storageDir, `${job.jobId}.json`);

      expect(fs.existsSync(jobFile)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      expect(persisted.jobId).toBe(job.jobId);
      expect(persisted.status).toBe("running");
      expect(persisted.accounts[0]).not.toHaveProperty("password");

      const recovered = new SnapshotTestBulkImportManager(storageName).getJob(job.jobId);
      expect(recovered?.jobId).toBe(job.jobId);
      expect(recovered?.summary.total).toBe(1);
    } finally {
      fs.rmSync(manager.storageDir, { recursive: true, force: true });
    }
  });
});