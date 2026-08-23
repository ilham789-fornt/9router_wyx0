import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";

const adapters = [];
const tempDirs = [];

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("better-sqlite3 adapter parameter binding", () => {
  it("spreads positional arrays for run, get, and all", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wyx-sqlite-bind-"));
    const adapter = createBetterSqliteAdapter(path.join(tempDir, "test.sqlite"));
    tempDirs.push(tempDir);
    adapters.push(adapter);

    adapter.exec("CREATE TABLE sample (name TEXT, rank INTEGER)");
    adapter.run("INSERT INTO sample (name, rank) VALUES (?, ?)", ["alpha", 2]);
    adapter.run("INSERT INTO sample (name, rank) VALUES (?, ?)", ["beta", 1]);

    expect(adapter.get("SELECT rank FROM sample WHERE name = ?", ["alpha"]))
      .toEqual({ rank: 2 });
    expect(adapter.all("SELECT name FROM sample WHERE rank >= ? ORDER BY rank", [1]))
      .toEqual([{ name: "beta" }, { name: "alpha" }]);
  });
});
