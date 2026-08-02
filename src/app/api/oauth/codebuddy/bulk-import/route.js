import { NextResponse } from "next/server";
import { getCodeBuddyBulkImportManager, parseCodeBuddyBulkAccounts } from "@/lib/oauth/services/codebuddyBulkImportManager";
import { assertProviderEnabled } from "@/lib/providerDisabled";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    await assertProviderEnabled("codebuddy");
    const body = await request.json();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const { parsed, invalidLines } = parseCodeBuddyBulkAccounts(accounts);

    if (!parsed.length) {
      return NextResponse.json(
        { error: "At least one account entry is required" },
        { status: 400 }
      );
    }

    if (invalidLines.length > 0) {
      return NextResponse.json(
        {
          error: "Invalid account format. Use one account per line: gmail@example.com|password",
          invalidLines,
        },
        { status: 400 }
      );
    }

    const manager = getCodeBuddyBulkImportManager();
    const job = await manager.startJob({
      accounts,
      concurrency: body?.concurrency,
      browser: body?.browser,
      proxyPoolId: typeof body?.proxyPoolId === "string" && body.proxyPoolId.trim() ? body.proxyPoolId.trim() : null,
      proxyUrl: typeof body?.proxyUrl === "string" && body.proxyUrl.trim() ? body.proxyUrl.trim() : null,
    });

    return NextResponse.json({
      success: true,
      job,
    });
  } catch (error) {
    const status = Array.isArray(error?.invalidLines) ? 400 : (error?.status || 500);
    return NextResponse.json(
      {
        error: error?.error || error?.message || "Failed to start CodeBuddy bulk import",
        ...(Array.isArray(error?.invalidLines) ? { invalidLines: error.invalidLines } : {}),
      },
      { status }
    );
  }
}
