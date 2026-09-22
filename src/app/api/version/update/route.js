import { NextResponse } from "next/server";
import https from "node:https";
import { killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";
import { UPDATER_CONFIG } from "@/shared/constants/config.js";

// Issue #9, item 6: the updater installs a PINNED version and verifies it landed.
// The version is resolved here, server-side, from the registry the app already
// trusts for update checks — never from the request body, so a caller cannot ask
// for an arbitrary version to be installed.
function fetchLatestPublishedVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${UPDATER_CONFIG.npmPackageName}/latest`,
      { timeout: 5000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).version || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

export async function POST() {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (10router CLI)" },
      { status: 403 }
    );
  }

  // No version, no update: refuse up front rather than installing whatever the
  // registry serves at that moment (the pre-#9 behaviour).
  const targetVersion = await fetchLatestPublishedVersion();
  if (!targetVersion) {
    return NextResponse.json(
      { success: false, message: "Could not resolve the latest version — nothing was installed. Retry, or update with the install command." },
      { status: 503 }
    );
  }

  try {
    // Kill sibling processes (cloudflared, MITM, stray next-server) to release file locks on Windows
    await killAppProcesses();
  } catch { /* best effort */ }

  // Schedule detached updater then exit current server process
  spawnUpdaterAndExit(targetVersion);

  return NextResponse.json({ success: true, message: `Updater started for ${targetVersion}. This app will exit shortly.` });
}
