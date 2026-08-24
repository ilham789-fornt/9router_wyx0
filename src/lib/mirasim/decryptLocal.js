// Read + decrypt the local Mirasim desktop credentials (~/.mirasim) so they can be
// imported into 9router as a provider connection — enabling app-less use of the account.
//
// Mirasim stores sensitive setting.json fields as AES-256-GCM envelopes:
//   "mrs1:" + base64([12B IV][16B GCM tag][ciphertext])
// The 32-byte master key is obtained from:
//   - env MIRASIM_SECRET_KEY (64 hex), else
//   - the OS keychain. On Windows that is ~/.mirasim/secret.key, a user-scoped DPAPI blob
//     unwrapped via PowerShell (ConvertTo-SecureString). macOS uses `security`, Linux libsecret.
//
// This only works when run as the same OS user that installed Mirasim.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const ENVELOPE = "mrs1:";

export function mirasimHome() {
  return process.env.MIRASIM_HOME || path.join(os.homedir(), ".mirasim");
}

function loadMasterKey() {
  const env = (process.env.MIRASIM_SECRET_KEY || "").trim();
  if (/^[0-9a-f]{64}$/i.test(env)) return Buffer.from(env, "hex");

  const platform = process.platform;
  const keyFile = path.join(mirasimHome(), "secret.key");

  if (platform === "win32") {
    const blob = fs.readFileSync(keyFile, "utf8").trim();
    if (!blob) throw new Error("mirasim secret.key is empty");
    const ps = `$s=ConvertTo-SecureString '${blob}';$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (!/^[0-9a-f]{64}$/i.test(out)) throw new Error("DPAPI unwrap did not return a 64-hex key (run 9router as the same Windows user as Mirasim)");
    return Buffer.from(out, "hex");
  }

  if (platform === "darwin") {
    const out = execFileSync("/usr/bin/security", ["find-generic-password", "-s", "mirasim", "-a", "config-secret-key", "-w"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (!/^[0-9a-f]{64}$/i.test(out)) throw new Error("macOS keychain did not return a 64-hex key");
    return Buffer.from(out, "hex");
  }

  // linux: secret-tool (libsecret)
  const out = execFileSync("secret-tool", ["lookup", "service", "mirasim", "account", "config-secret-key"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  if (!/^[0-9a-f]{64}$/i.test(out)) throw new Error("libsecret did not return a 64-hex key; or set MIRASIM_SECRET_KEY");
  return Buffer.from(out, "hex");
}

function decryptField(value, key) {
  if (typeof value !== "string" || !value.startsWith(ENVELOPE)) return value;
  const buf = Buffer.from(value.slice(ENVELOPE.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return d.update(ct) + d.final("utf8");
}

function jwtPayload(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length !== 3) return {};
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Read and decrypt local Mirasim credentials.
 * @returns {{ accessToken, refreshToken, devicePrivateKey, userId, email, name, expiresAt }}
 */
export function readLocalMirasimCredentials() {
  const home = mirasimHome();
  const settingPath = path.join(home, "setting.json");
  if (!fs.existsSync(settingPath)) {
    throw new Error(`Mirasim setting.json not found at ${settingPath} — is the desktop app installed for this user?`);
  }
  const setting = JSON.parse(fs.readFileSync(settingPath, "utf8"));
  const auth = setting.auth || {};
  const device = setting.device || {};
  if (!auth.token) throw new Error("Mirasim setting.json has no auth.token — sign in to the Mirasim app once first");
  if (!device.privateKey) throw new Error("Mirasim setting.json has no device.privateKey");

  const key = loadMasterKey();
  const accessToken = decryptField(auth.token, key);
  const refreshToken = decryptField(auth.refreshToken, key);
  const devicePrivateKey = decryptField(device.privateKey, key);

  if (!devicePrivateKey.startsWith("-----BEGIN")) {
    throw new Error("decrypted device key is not a PEM — master key mismatch");
  }

  const payload = jwtPayload(accessToken);
  const expSec = typeof payload.exp === "number" ? payload.exp : (typeof auth.exp === "number" ? auth.exp : null);

  return {
    accessToken,
    refreshToken,
    devicePrivateKey,
    userId: auth.userId || payload.userId || payload.sub || null,
    email: payload.email || auth.name || null,
    name: auth.name || payload.email || null,
    expiresAt: expSec ? new Date(expSec * 1000).toISOString() : null,
  };
}
