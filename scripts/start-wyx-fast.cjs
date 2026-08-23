#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const standaloneDir = path.join(projectRoot, "cli", "app");
const customServerPath = path.join(standaloneDir, "custom-server.js");
const serverPath = path.join(standaloneDir, "server.js");

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnv() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = parseEnvValue(trimmed.slice(eq + 1));
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const port = process.env.PORT || "20129";
const host = process.env.HOSTNAME || "0.0.0.0";
const browserHost = process.env.WYX_BROWSER_HOST || "127.0.0.1";
const dataDir = process.env.DATA_DIR || "./.data-wyx0";

process.env.PORT = port;
process.env.HOSTNAME = host;
process.env.NODE_ENV = process.env.NODE_ENV || "production";
process.env.DATA_DIR = path.isAbsolute(dataDir) ? dataDir : path.join(projectRoot, dataDir);
process.env.BASE_URL = process.env.BASE_URL || `http://${browserHost}:${port}`;
process.env.NEXT_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || `http://${browserHost}:${port}`;

fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

if (!fs.existsSync(serverPath) || !fs.existsSync(customServerPath)) {
  console.error("Fast WYx0 bundle not found:");
  console.error(`  expected ${serverPath}`);
  console.error(`  expected ${customServerPath}`);
  console.error("Run this once from the project root:");
  console.error("  node cli/scripts/build-cli.js");
  process.exit(1);
}

console.log(`🚀 Starting 9Router WYx0 fast mode`);
console.log(`   Dashboard: http://${browserHost}:${port}/dashboard`);
console.log(`   API:       http://${browserHost}:${port}/v1`);
console.log(`   Data dir:  ${process.env.DATA_DIR}`);
console.log("");

process.chdir(standaloneDir);
require(customServerPath);
require(serverPath);
