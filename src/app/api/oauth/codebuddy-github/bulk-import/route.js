import { NextResponse } from "next/server";
import {
  getCodeBuddyGithubBulkImportManager,
  parseCodeBuddyGithubBulkAccounts,
} from "@/lib/oauth/services/codebuddyGithubBulkImportManager";
import { assertProviderEnabled } from "@/lib/providerDisabled";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    // The saved connection ends up as provider="codebuddy"; enforce the same
    // provider-disabled gate the Google flow uses so both automations share
    // the same admin off-switch.
    await assertProviderEnabled("codebuddy");
    const body = await request.json();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const { parsed, invalidLines } = parseCodeBuddyGithubBulkAccounts(accounts);

    if (!parsed.length) {
      return NextResponse.json(
        { error: "At least one account entry is required" },
        { status: 400 }
      );
    }

    if (invalidLines.length > 0) {
      return NextResponse.json(
        {
          error: "Invalid account format. Use one account per line: github_username_or_email|password",
          invalidLines,
        },
        { status: 400 }
      );
    }

    const manager = getCodeBuddyGithubBulkImportManager();
    const rawProxyPoolId = typeof body?.proxyPoolId === "string" ? body.proxyPoolId.trim() : "";
    // headless defaults to true. Pass `headless: false` (or the JSON string
    // "false") to open a visible Camoufox window per worker so the operator
    // can watch and hand-hold flows that trip anti-automation surfaces.
    const headless = body?.headless === false || body?.headless === "false"
      ? false
      : true;
    const job = await manager.startJob({
      accounts,
      concurrency: body?.concurrency,
      browser: body?.browser,
      // proxyPoolId is optional; empty string => no proxy pool
      proxyPoolId: rawProxyPoolId ? rawProxyPoolId : null,
      headless,
    });

    return NextResponse.json({ success: true, job });
  } catch (error) {
    const status = Array.isArray(error?.invalidLines) ? 400 : (error?.status || 500);
    return NextResponse.json(
      {
        error: error?.error || error?.message || "Failed to start CodeBuddy (GitHub) bulk import",
        ...(Array.isArray(error?.invalidLines) ? { invalidLines: error.invalidLines } : {}),
      },
      { status }
    );
  }
}
