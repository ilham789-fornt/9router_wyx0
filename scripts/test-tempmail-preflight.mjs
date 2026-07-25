// Quick pre-flight for the GitHub-register CLI: confirms the selected
// temp-mail provider is reachable.
//
// Provider selection follows the same env switch as the register manager:
//   TEMPMAIL_PROVIDER=tempmailorg  (default) → web2.temp-mail.org web API
//   TEMPMAIL_PROVIDER=privatix              → Privatix (RapidAPI)
//
// NOTE: web2.temp-mail.org sits behind Cloudflare Bot Fight, so this
// preflight can NOT test tempmailorg from plain Node fetch — it will 403.
// For a real tempmailorg check, run the full E2E script which routes the
// HTTP through Camoufox. This preflight only verifies:
//   • provider selection wiring,
//   • Privatix subscription (when configured).
//
// Usage:
//   node scripts/test-tempmail-preflight.mjs

import "dotenv/config";
import { tempMailClientFromEnv } from "../src/lib/oauth/services/automation/tempMailClient.js";
import { tempMailOrgClientFromEnv } from "../src/lib/oauth/services/automation/tempMailOrgClient.js";

const provider = String(process.env.TEMPMAIL_PROVIDER || "tempmailorg").toLowerCase().trim();
console.log(`[preflight] TEMPMAIL_PROVIDER: ${provider}`);

if (provider === "tempmailorg") {
  console.log("[preflight] ⚠️  tempmailorg uses Cloudflare-protected endpoints —");
  console.log("             a Node-only preflight cannot verify allocation.");
  console.log("             Run scripts/test-github-signup-e2e.mjs for a real test.");
  const client = tempMailOrgClientFromEnv();
  console.log(`[preflight] ✅ Client built (${client.constructor.name}). Transport: ${client.transport?.kind || "unknown"}.`);
  console.log("[preflight] Skipping HTTP round-trip. Preflight PASSED at the wiring level.");
  process.exit(0);
}

if (provider === "privatix") {
  console.log("[preflight] TEMPMAIL_RAPIDAPI_KEY:", process.env.TEMPMAIL_RAPIDAPI_KEY ? "(set)" : "(MISSING)");
  const client = tempMailClientFromEnv();
  if (!client) {
    console.error("[preflight] ❌ Privatix client build failed. Set TEMPMAIL_RAPIDAPI_KEY or switch TEMPMAIL_PROVIDER=tempmailorg.");
    process.exit(1);
  }

  try {
    console.log("\n[preflight] Allocating 1 unique address (dry test)…");
    const alloc = await client.allocateUniqueAddresses(1);
    const [address] = alloc.addresses;
    console.log(`[preflight] ✅ Address: ${address.email}`);
    console.log(`             Domain:  ${address.domain}`);
    console.log(`             ID:      ${String(address.id).slice(0, 24)}...`);
    if (alloc.capped) console.log(`[preflight] ⚠️  Batch capped (requested ${alloc.requested}, got ${alloc.allocated})`);

    console.log("\n[preflight] Peeking inbox (should be empty for a fresh address)…");
    const messages = await client.listMessages(address.email);
    console.log(`[preflight] ✅ Inbox has ${messages.length} messages.`);

    console.log("\n[preflight] ALL CHECKS PASSED — Privatix is reachable.");
    process.exit(0);
  } catch (err) {
    console.error(`[preflight] ❌ ${err?.message || err}`);
    if (err?.status) console.error(`             HTTP status: ${err.status}`);
    process.exit(2);
  }
}

console.error(`[preflight] ❌ Unknown TEMPMAIL_PROVIDER: "${provider}". Use "tempmailorg" or "privatix".`);
process.exit(1);

