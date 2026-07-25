import { NextResponse } from "next/server";
import { getCodeBuddyGithubBulkRegisterManager } from "@/lib/oauth/services/codebuddyGithubBulkRegisterManager";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  const { jobId } = await params;
  const manager = getCodeBuddyGithubBulkRegisterManager();
  const job = manager.cancelJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Bulk register job not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, job });
}
