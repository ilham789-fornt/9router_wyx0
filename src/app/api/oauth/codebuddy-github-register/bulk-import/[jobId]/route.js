import { NextResponse } from "next/server";
import {
  buildLookupResponse,
  getCodeBuddyGithubBulkRegisterManager,
} from "@/lib/oauth/services/codebuddyGithubBulkRegisterManager";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { jobId } = await params;
  const manager = getCodeBuddyGithubBulkRegisterManager();
  const job = await manager.getJobWithPreview(jobId);

  if (!job) {
    return NextResponse.json(
      {
        success: false,
        ...buildLookupResponse(null, { stale: true }),
        error: "Bulk register job not found",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, ...buildLookupResponse(job) });
}
