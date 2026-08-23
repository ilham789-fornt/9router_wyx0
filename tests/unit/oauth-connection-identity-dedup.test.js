import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let connectionsRepo;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wyx-oauth-dedup-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("OAuth connection identity deduplication", () => {
  it("keeps same-email accounts with different provider usernames", async () => {
    const first = await connectionsRepo.createProviderConnection({
      provider: "kimchi",
      authType: "oauth",
      email: "shared@example.com",
      accessToken: "first-token",
      providerSpecificData: { username: "github-user" },
    });
    const second = await connectionsRepo.createProviderConnection({
      provider: "kimchi",
      authType: "oauth",
      email: "shared@example.com",
      accessToken: "second-token",
      providerSpecificData: { username: "google-user" },
    });

    expect(second.id).not.toBe(first.id);
    expect(await connectionsRepo.getProviderConnections({ provider: "kimchi" }))
      .toHaveLength(2);
  });

  it("still updates an exact same-email and username identity", async () => {
    const first = await connectionsRepo.createProviderConnection({
      provider: "kimchi",
      authType: "oauth",
      email: "shared@example.com",
      accessToken: "first-token",
      providerSpecificData: { username: "same-user" },
    });
    const updated = await connectionsRepo.createProviderConnection({
      provider: "kimchi",
      authType: "oauth",
      email: "SHARED@example.com",
      accessToken: "updated-token",
      providerSpecificData: { username: "SAME-user" },
    });

    expect(updated.id).toBe(first.id);
    expect(updated.accessToken).toBe("updated-token");
    expect(await connectionsRepo.getProviderConnections({ provider: "kimchi" }))
      .toHaveLength(1);
  });
});
