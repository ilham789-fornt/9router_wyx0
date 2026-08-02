import { NextResponse } from "next/server";
import { buildLookupResponse, getCodeBuddyOAuthBulkImportManager } from "@/lib/oauth/services/codebuddyOAuthBulkImportManager";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { jobId } = await params;
  const manager = getCodeBuddyOAuthBulkImportManager();
  const job = await manager.getJobWithPreview(jobId);

  if (!job) {
    return NextResponse.json({
      success: false,
      ...buildLookupResponse(null, { stale: true }),
      error: "Bulk import job not found",
    }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    ...buildLookupResponse(job),
  });
}
