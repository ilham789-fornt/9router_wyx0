import { NextResponse } from "next/server";
import { getCodeBuddyBulkImportManager } from "@/lib/oauth/services/codebuddyBulkImportManager";
import { assertProviderEnabled } from "@/lib/providerDisabled";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    await assertProviderEnabled("codebuddy");
    const body = await request.json().catch(() => ({}));
    const proxyPoolId = String(body?.proxyPoolId || "").trim();
    const browser = String(body?.browser || "").trim();
    if (!proxyPoolId) {
      return NextResponse.json({ error: "Select an active proxy pool" }, { status: 400 });
    }

    const job = await getCodeBuddyBulkImportManager().startJob({
      wrapLogin: true,
      proxyPoolId,
      browser: browser || undefined,
      concurrency: 1,
    });
    return NextResponse.json({ success: true, job });
  } catch (error) {
    return NextResponse.json(
      { error: error?.error || error?.message || "Failed to start CodeBuddy login wrapping" },
      { status: error?.status || 500 }
    );
  }
}
