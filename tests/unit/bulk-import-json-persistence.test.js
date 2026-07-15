import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonFile } from "../../src/lib/oauth/services/automation/baseBulkImportManager.js";

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
});
