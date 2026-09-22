import { NextResponse } from "next/server";

/**
 * POST /api/oauth/qoder-cn/checkin
 * Trigger a manual Qoder CN daily credit claim for active connections.
 * Scoped to provider "qoder-cn" — the intl Qoder button has its own route.
 */
export async function POST() {
  try {
    const { runQoderCheckinTick } = await import(
      "@/sse/services/qoderCheckin.js"
    );
    const results = await runQoderCheckinTick({ skipIfCheckedToday: false, provider: "qoder-cn" });
    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error("Error running Qoder CN check-in:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
