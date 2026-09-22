// Standalone detached updater process.
// Spawns `npm i -g <pkg>@latest`, exposes progress via tiny HTTP server.
// Survives after parent Next server exits (detached + unref by spawner).

const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Normally passed in by spawnUpdaterAndExit from UPDATER_CONFIG. This standalone
// script can't import that ESM config, so the fallback is duplicated — keep it in
// step with UPDATER_CONFIG.npmPackageName; the bare `10router` on npm belongs to
// an unrelated fork.
const EXPECTED_PACKAGE = "@techysy/10router";
const packageName = process.env.UPDATER_PKG_NAME || EXPECTED_PACKAGE;

// Issue #9, item 6: this process is spawned by an authenticated route, but it runs
// npm as the user and used to trust UPDATER_PKG_NAME outright — one environment
// variable could point the "update" at an arbitrary npm package. Only our own
// package is ever installed, and the target version is pinned rather than left to
// whatever `latest` resolves to at install time (so the thing that lands is the
// thing the dashboard told the user about).
const packageNameMismatch = packageName !== EXPECTED_PACKAGE;
const targetVersion = (process.env.UPDATER_TARGET_VERSION || "").trim();
const targetVersionValid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(targetVersion);
const prereleaseAllowed = process.env.UPDATER_ALLOW_PRERELEASE === "1";
const refusal =
  packageNameMismatch
    ? `refusing to update: unexpected package name ${JSON.stringify(packageName)} (expected ${EXPECTED_PACKAGE})`
    : !targetVersionValid
      ? "refusing to update: no valid target version was provided (set UPDATER_TARGET_VERSION)"
      : !prereleaseAllowed && targetVersion.includes("-")
        ? `refusing to update: ${targetVersion} is not a release version (set UPDATER_ALLOW_PRERELEASE=1 to allow pre-releases)`
        : null;
const port = parseInt(process.env.UPDATER_PORT || "20129", 10);
const tailLines = parseInt(process.env.UPDATER_TAIL_LINES || "8", 10);
const maxRetries = parseInt(process.env.UPDATER_RETRIES || "3", 10);
const retryDelayMs = parseInt(process.env.UPDATER_RETRY_DELAY_MS || "5000", 10);
const lingerMs = parseInt(process.env.UPDATER_LINGER_MS || "30000", 10);
const waitMinMs = parseInt(process.env.UPDATER_WAIT_MIN_MS || "3000", 10);
const waitMaxMs = parseInt(process.env.UPDATER_WAIT_MAX_MS || "15000", 10);
const waitCheckMs = parseInt(process.env.UPDATER_WAIT_CHECK_MS || "500", 10);
const appPort = parseInt(process.env.UPDATER_APP_PORT || "20128", 10);

// Data directory (match mitm/paths.js logic)
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "10router");
  }
  return path.join(os.homedir(), ".10router");
}
const updateDir = path.join(getDataDir(), "update");
try { fs.mkdirSync(updateDir, { recursive: true }); } catch { /* best effort */ }
const statusFile = path.join(updateDir, "status.json");
const logFile = path.join(updateDir, "install.log");

const state = {
  phase: "starting",
  packageName,
  targetVersion: targetVersionValid ? targetVersion : null,
  startedAt: Date.now(),
  finishedAt: null,
  attempt: 0,
  maxRetries,
  done: false,
  success: false,
  exitCode: null,
  error: null,
  logTail: [],
};

function pushLog(line) {
  const trimmed = line.replace(/\r?\n$/, "");
  if (!trimmed) return;
  state.logTail.push(trimmed);
  if (state.logTail.length > tailLines) state.logTail = state.logTail.slice(-tailLines);
  try { fs.appendFileSync(logFile, `${trimmed}\n`); } catch { /* best effort */ }
}

function persistStatus() {
  try { fs.writeFileSync(statusFile, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
}

function setPhase(phase) {
  state.phase = phase;
  persistStatus();
}

// HTTP server exposing status on loopback (issue #9, item 6).
//
// It used to answer with `Access-Control-Allow-Origin: *`, which let any web page
// the operator happened to visit read this endpoint (package name, version,
// phase, log tail) — a free fingerprint of the install. Nothing needs the wide
// header any more: the dashboard's legacy status poll was replaced by the
// "copy install command + shutdown" flow, so the only readers left are the
// updater's own status.json and a human curling 127.0.0.1.
const server = http.createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/update/status" || req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(state));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.on("error", (e) => {
  state.error = `status server error: ${e.message}`;
  persistStatus();
});

server.listen(port, "127.0.0.1", () => {
  persistStatus();
  waitForAppExit().then(runInstall);
});

// Check if app port is still being listened on (= app server still alive)
function isAppPortBusy() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(appPort, "127.0.0.1");
  });
}

// Wait for app process to fully exit before running npm (avoids Windows file-lock)
async function waitForAppExit() {
  setPhase("waitingForExit");
  pushLog(`[updater] waiting for app to exit (min ${Math.round(waitMinMs / 1000)}s)...`);

  // Hard minimum delay: OS needs time to release file handles
  await sleep(waitMinMs);

  // Poll app port until free or max timeout
  const deadline = Date.now() + (waitMaxMs - waitMinMs);
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (!busy) {
      pushLog(`[updater] app port :${appPort} is free, proceeding`);
      return;
    }
    await sleep(waitCheckMs);
  }
  pushLog(`[updater] timeout waiting for app, proceeding anyway`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// What actually gets installed: our package at the pinned version.
const installSpec = `${packageName}@${targetVersion}`;

function runInstall() {
  if (refusal) {
    // Refuse before touching npm. The dashboard surfaces state.error, so the
    // operator sees why nothing happened instead of a silent no-op.
    pushLog(`[updater] ${refusal}`);
    state.phase = "refused";
    state.error = refusal;
    state.done = true;
    state.success = false;
    state.finishedAt = Date.now();
    persistStatus();
    return;
  }

  state.attempt += 1;
  setPhase("installing");
  pushLog(`[updater] attempt ${state.attempt}/${maxRetries} — npm i -g ${installSpec} --prefer-online`);

  const isWin = process.platform === "win32";
  const cmd = isWin ? "npm.cmd" : "npm";
  const args = ["i", "-g", installSpec, "--prefer-online"];

  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: isWin,
  });

  child.stdout.on("data", (buf) => {
    buf.toString().split(/\r?\n/).forEach(pushLog);
    persistStatus();
  });
  child.stderr.on("data", (buf) => {
    buf.toString().split(/\r?\n/).forEach(pushLog);
    persistStatus();
  });

  child.on("error", (e) => {
    pushLog(`[updater] spawn error: ${e.message}`);
    finalize(false, null, e.message);
  });

  child.on("close", (code) => {
    pushLog(`[updater] npm exited with code ${code}`);
    if (code === 0) {
      const installed = readInstalledVersion();
      if (installed && installed !== targetVersion) {
        // npm succeeded but a different version is on disk: never report success
        // for something we cannot name. This is the "installed 1.2.0, reported
        // 1.2.1" class of surprise, now loud.
        const message = `installed ${installed}, expected ${targetVersion}`;
        pushLog(`[updater] ${message}`);
        finalize(false, code, message);
        return;
      }
      pushLog(`[updater] verified installed version: ${installed || targetVersion}`);
      finalize(true, code, null);
      return;
    }
    if (state.attempt < maxRetries) {
      pushLog(`[updater] retrying in ${Math.round(retryDelayMs / 1000)}s...`);
      setTimeout(runInstall, retryDelayMs);
      return;
    }
    finalize(false, code, `Install failed after ${maxRetries} attempts`);
  });
}

// Read back what npm actually put on disk. Best effort: an unreadable answer
// (unusual global prefix, npm missing) is not treated as a mismatch — the
// version is logged as unknown rather than failing an install that worked.
function readInstalledVersion() {
  try {
    const { execFileSync } = require("child_process");
    const isWin = process.platform === "win32";
    const out = execFileSync(isWin ? "npm.cmd" : "npm", ["ls", "-g", packageName, "--json", "--depth=0"], {
      encoding: "utf8",
      windowsHide: true,
      shell: isWin,
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out);
    return parsed?.dependencies?.[packageName]?.version || null;
  } catch (e) {
    // npm ls exits non-zero when the tree is odd; its stdout may still parse.
    const stdout = e && typeof e.stdout === "string" ? e.stdout : "";
    try {
      const parsed = JSON.parse(stdout);
      return parsed?.dependencies?.[packageName]?.version || null;
    } catch {
      return null;
    }
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? `open "${url}"`
    : platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  try { spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}

// Wait until app port is listening (server alive again), then open dashboard
async function waitForAppAndOpenBrowser() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (busy) {
      openBrowser(`http://localhost:${appPort}/dashboard`);
      pushLog(`[updater] app ready, opened dashboard`);
      return;
    }
    await sleep(1000);
  }
  pushLog(`[updater] app not responding within 30s, skip browser open`);
}

function relaunchApp() {
  if (process.env.UPDATER_RELAUNCH !== "1") return;
  const cmd = process.env.UPDATER_RELAUNCH_CMD;
  if (!cmd) return;
  let args = [];
  try { args = JSON.parse(process.env.UPDATER_RELAUNCH_ARGS || "[]"); } catch { /* noop */ }
  const isWin = process.platform === "win32";
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: isWin,
      env: { ...process.env, UPDATER_RELAUNCH: "", UPDATER_RELAUNCH_CMD: "", UPDATER_RELAUNCH_ARGS: "" },
    });
    child.unref();
    pushLog(`[updater] relaunched: ${cmd} ${args.join(" ")} (pid=${child.pid})`);
    // Wait for new app to come up, then auto-open browser so user sees the result
    waitForAppAndOpenBrowser();
  } catch (e) {
    pushLog(`[updater] relaunch failed: ${e.message}`);
  }
}

function finalize(success, exitCode, error) {
  state.done = true;
  state.success = success;
  state.exitCode = exitCode;
  state.error = error;
  state.finishedAt = Date.now();
  setPhase(success ? "done" : "error");
  if (success) relaunchApp();
  // Linger so browser can poll final status, then exit & close the port
  setTimeout(() => {
    try { server.close(); } catch { /* ignore */ }
    process.exit(success ? 0 : 1);
  }, lingerMs);
}
