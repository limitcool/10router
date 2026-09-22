import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  // Read-only on purpose: /api/health must never initialise the DB (a health
  // probe that opens SQLite is its own outage). Report what the driver layer
  // has ALREADY settled on, or null before it runs.
  //   driver           → which SQLite driver won (better-sqlite3 / node:sqlite / sql.js)
  //   lastDriverError  → why a preferred driver was skipped (e.g. a broken
  //                      better-sqlite3 in the global tree), else null
  const dbState = global._dbAdapter;
  return NextResponse.json(
    {
      ok: true,
      driver: dbState?.instance?.driver ?? null,
      lastDriverError: dbState?.lastDriverError ?? null,
    },
    { headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
