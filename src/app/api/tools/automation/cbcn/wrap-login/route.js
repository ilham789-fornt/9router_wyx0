import { NextResponse } from "next/server";
import { getCodeBuddyCnAutomationManager } from "@/lib/oauth/services/codebuddyCnAutomationManager";
import { assertProviderEnabled } from "@/lib/providerDisabled";

export const dynamic = "force-dynamic";

// Opens the official CodeBuddy CN OAuth authorization page through a selected
// server-side browser proxy. Tokens come from the OAuth token endpoint; this
// flow does not create an API key or override upstream account policy.
export async function POST(request) {
  try {
    await assertProviderEnabled("codebuddy-cn");
    const body = await request.json().catch(() => ({}));
    const proxyPoolId = String(body?.proxyPoolId || "").trim();
    const browser = String(body?.browser || "").trim();
    if (!proxyPoolId) {
      return NextResponse.json({ error: "Select an active proxy pool" }, { status: 400 });
    }

    const manager = getCodeBuddyCnAutomationManager();
    const job = await manager.startJob({
      accounts: [],
      count: 1,
      concurrent: 1,
      browser: browser || undefined,
      wrapLogin: true,
      proxyPoolId,
      smsTimeout: body?.smsTimeout,
      maxRetries: body?.maxRetries,
    });

    return NextResponse.json({ success: true, job });
  } catch (error) {
    return NextResponse.json(
      { error: error?.error || error?.message || "Failed to start CodeBuddy CN login wrapping" },
      { status: error?.status || 500 }
    );
  }
}
