// Analyze CodeBuddy Global Google OAuth consent DOM.
// You drive the browser and log in manually. This script only reads DOM after
// you press Enter. It does NOT export cookies, tokens, passwords, or emails.

import { createInterface } from "node:readline";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createAutomationBrowserLauncher } from "../src/lib/oauth/services/automationBrowserLauncher.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "analysis", "codebuddy-consent");

function waitForEnter(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

const launcher = createAutomationBrowserLauncher("camoufox", { headless: false });
const browser = await launcher();
let exitCode = 0;
try {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.codebuddy.ai/login?platform=CLI", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  console.log("\n>>> Login Google manually in the opened window.");
  console.log(">>> Stop at the 'Login ke codebuddy.ai / Lanjutkan' consent page.");
  console.log(">>> Do NOT click Lanjutkan yet.");
  await waitForEnter(">>> When the consent page is visible, press Enter here... ");

  const frameSummaries = page.frames().map((f) => ({ url: f.url(), name: f.name() }));

  const artifact = await page.evaluate(() => {
    const pick = (el) => el && {
      tag: el.tagName,
      id: el.id || null,
      jsname: el.getAttribute?.("jsname") || null,
      name: el.getAttribute?.("name") || null,
      aria: el.getAttribute?.("aria-label") || null,
      role: el.getAttribute?.("role") || null,
      disabled: el.hasAttribute?.("disabled") || false,
      text: (el.innerText || el.value || "").trim().slice(0, 80),
      outer: el.outerHTML.slice(0, 800),
    };

    const candidates = [...document.querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"], a'
    )].filter((el) => {
      const t = (el.innerText || el.value || "").toLowerCase().trim();
      return /lanjutkan|continue|izinkan|allow|setuju|oke|ok/.test(t);
    });

    const consentRoot =
      document.getElementById("submit_approve_access")?.closest("form, div") ||
      document.querySelector('form, [role="main"], #view_container, body');

    return {
      url: location.href,
      title: document.title,
      hasSubmitApprove: Boolean(document.getElementById("submit_approve_access")),
      consentRootTag: consentRoot?.tagName || null,
      consentRootHtmlSnippet: consentRoot?.outerHTML?.slice(0, 2000) || null,
      candidates: candidates.map(pick),
    };
  });

  await mkdir(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = resolve(OUT_DIR, `consent-${ts}.json`);
  await writeFile(outFile, JSON.stringify({ frameSummaries, artifact }, null, 2), "utf8");

  console.log(`\n>>> Artifact saved to: ${outFile}`);
  console.log(">>> Close the browser, then send that file's contents back.");
  await waitForEnter(">>> Press Enter to exit... ");
} catch (error) {
  exitCode = 1;
  console.error("Analyze script failed:", error?.stack || error?.message || error);
} finally {
  await browser.close().catch(() => null);
  process.exit(exitCode);
}
