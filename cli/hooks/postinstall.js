#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.10router/runtime so the first
// `10router` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime, getDataDir } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");
const { writeDiskVersion } = require("../src/cli/staleServer");

// Record the on-disk version FIRST: an upgrade runs this hook while the old
// server is still alive, and that old process (and the dashboard it serves)
// needs to see that the package directory already moved on. Best-effort.
try {
  writeDiskVersion(getDataDir(), require("../package.json").version);
} catch (e) {
  console.warn(`[10router] could not record disk version: ${e.message}`);
}

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[10router] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[10router] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[10router] tray runtime skipped: ${e.message}`);
}

process.exit(0);
