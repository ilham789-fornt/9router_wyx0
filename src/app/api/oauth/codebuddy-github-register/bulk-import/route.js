import { NextResponse } from "next/server";
import { getCodeBuddyGithubBulkRegisterManager } from "@/lib/oauth/services/codebuddyGithubBulkRegisterManager";
import { assertProviderEnabled } from "@/lib/providerDisabled";

export const dynamic = "force-dynamic";

// POST /api/oauth/codebuddy-github-register/bulk-import
//
// Kicks off a bulk-register job that provisions fresh GitHub accounts via
// Privatix temp-mail and immediately chains each one into the CodeBuddy
// Global OAuth flow. Operators only supply a count (or omit it to let the
// manager pick a random 20..30 batch) and a proxy pool ID; the automation
// generates emails, usernames, and passwords.
//
// Body shape:
//   {
//     "count": number?,          // 1..N. Omit for auto-random 20..30.
//     "concurrency": number?,    // Clamped by baseBulkImportManager.
//     "browser": string?,        // Camoufox is the only supported runtime.
//     "proxyPoolId": string,     // REQUIRED. Must be an active pool with
//                                //   >= count unique proxies. GitHub blocks
//                                //   repeat signups from the same exit IP,
//                                //   so round-robin is NOT allowed here.
//     "headless": boolean?       // Default true. Pass false to open Camoufox
//                                //   visibly (recommended for smoke tests).
//   }
export async function POST(request) {
  try {
    // Saved connections land under provider="codebuddy"; enforce the same
    // provider-disabled gate as the other CodeBuddy bulk flows.
    await assertProviderEnabled("codebuddy");

    const body = await request.json().catch(() => ({}));
    const manager = getCodeBuddyGithubBulkRegisterManager();

    const rawProxyPoolId = typeof body?.proxyPoolId === "string" ? body.proxyPoolId.trim() : "";
    if (!rawProxyPoolId) {
      return NextResponse.json(
        { error: "proxyPoolId is required for the GitHub register flow" },
        { status: 400 }
      );
    }

    // headless defaults to true so bulk runs stay unattended. Pass
    // {"headless": false} to open a visible Camoufox window per worker.
    const headless = body?.headless === false || body?.headless === "false"
      ? false
      : true;

    const parsedCount = Number.isFinite(Number(body?.count)) ? Number(body.count) : undefined;

    const job = await manager.startJob({
      count: parsedCount && parsedCount > 0 ? parsedCount : undefined,
      concurrency: body?.concurrency,
      browser: body?.browser,
      proxyPoolId: rawProxyPoolId,
      headless,
    });

    return NextResponse.json({ success: true, job });
  } catch (error) {
    const status = error?.status || 500;
    return NextResponse.json(
      {
        error: error?.error || error?.message || "Failed to start CodeBuddy GitHub register bulk job",
        ...(error?.code ? { code: error.code } : {}),
        ...(Number.isFinite(error?.available) ? { available: error.available } : {}),
        ...(Number.isFinite(error?.requested) ? { requested: error.requested } : {}),
      },
      { status }
    );
  }
}
