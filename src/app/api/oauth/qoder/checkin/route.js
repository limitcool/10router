import { NextResponse } from "next/server";

/**
 * POST /api/oauth/qoder/checkin
 * Trigger a manual Qoder daily credit claim for active connections.
 * Scoped to provider "qoder" — the Qoder CN button has its own route, so a
 * manual claim on one provider never sweeps the other's accounts.
 */
export async function POST() {
  try {
    const { runQoderCheckinTick } = await import(
      "@/sse/services/qoderCheckin.js"
    );
    const results = await runQoderCheckinTick({ skipIfCheckedToday: false, provider: "qoder" });
    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error("Error running Qoder check-in:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
