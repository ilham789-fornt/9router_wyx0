// Smoke test for otpImapReader: connects to IMAP and prints a summary of
// the newest GitHub-from mails. Does not extract nor mark-seen anything.
//
// Usage:
//   node scripts/test-imap-otp.mjs [target-email]
//
// Reads IMAP_USER, IMAP_PASS, IMAP_HOST, IMAP_PORT from .env in project root.

import "dotenv/config";
import { OtpImapReader, otpReaderFromEnv } from "../src/lib/oauth/services/automation/otpImapReader.js";

const targetEmail = process.argv[2] || null;

console.log("[imap-smoke] IMAP_USER:", process.env.IMAP_USER || "(missing)");
console.log("[imap-smoke] IMAP_HOST:", process.env.IMAP_HOST || "imap.gmail.com");

const reader = otpReaderFromEnv({ senderMatch: "github" });
if (!reader) {
  console.error("[imap-smoke] ❌ IMAP_USER/IMAP_PASS not set — aborting.");
  process.exit(1);
}

if (targetEmail) {
  console.log(`[imap-smoke] Polling for OTP addressed to ${targetEmail} (30s max)...`);
  const hit = await reader.waitForOtpWithUrl(targetEmail, {
    timeoutMs: 30_000,
    onStep: (step, message) => console.log(`  [${step}] ${message}`),
  });
  if (hit) {
    console.log("[imap-smoke] ✅", hit);
  } else {
    console.log("[imap-smoke] ❌ No matching OTP found within 30s.");
  }
} else {
  // Just prove we can log in and list some sender:github mails.
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ from: "github" }, { uid: true });
    console.log(`[imap-smoke] Total GitHub mails in inbox: ${uids?.length || 0}`);
    const recent = (uids || []).slice(-5).reverse();
    for (const uid of recent) {
      const meta = await client.fetchOne(uid, { envelope: true }, { uid: true }).catch(() => null);
      if (!meta) continue;
      console.log(`  #${uid}  from=${meta.envelope?.from?.[0]?.address || "?"}  to=${meta.envelope?.to?.[0]?.address || "?"}  subject="${meta.envelope?.subject || "?"}"`);
    }
  } finally {
    lock.release();
    await client.logout();
  }
  console.log("[imap-smoke] ✅ Login + INBOX search works. Pass an email arg to test OTP extraction.");
}
