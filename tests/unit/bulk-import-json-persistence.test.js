import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaseBulkImportManager, writeJsonFile } from "../../src/lib/oauth/services/automation/baseBulkImportManager.js";

const testDirs = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bulk import JSON persistence", () => {
  it("uses collision-free temporary files for rapid repeated writes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-json-persistence-"));
    testDirs.push(dir);
    const file = path.join(dir, "meta.json");

    for (let index = 0; index < 50; index += 1) {
      writeJsonFile(file, { latestJobId: `job-${index}` });
    }

    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ latestJobId: "job-49" });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("returns live job state when preview persistence is temporarily locked", async () => {
    const manager = new BaseBulkImportManager({ storageName: `status-read-${Date.now()}` });
    manager.capturePreview = async () => null;
    manager.persistJobSnapshot = async () => {
      throw Object.assign(new Error("file locked"), { code: "EPERM" });
    };
    manager.jobs.set("job-locked", {
      jobId: "job-locked",
      status: "failed",
      concurrency: 1,
      browserChoice: "camofox",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: "proxy rejected HTTPS CONNECT",
      lastPreview: null,
      accounts: [],
    });

    await expect(manager.getJobWithPreview("job-locked")).resolves.toMatchObject({
      jobId: "job-locked",
      status: "failed",
      error: "proxy rejected HTTPS CONNECT",
    });
  });
});
