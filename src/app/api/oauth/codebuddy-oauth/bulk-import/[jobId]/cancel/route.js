import { NextResponse } from "next/server";
import { getCodeBuddyOAuthBulkImportManager } from "@/lib/oauth/services/codebuddyOAuthBulkImportManager";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  const { jobId } = await params;
  const manager = getCodeBuddyOAuthBulkImportManager();
  const job = manager.cancelJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Bulk import job not found" }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    job,
  });
}
