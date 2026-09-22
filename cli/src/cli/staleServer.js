"use strict";

/**
 * Stale-build self-heal.
 *
 * `npm i -g @techysy/10router@latest` (or an fpk / desktop update) replaces the
 * package directory on disk, but a server spawned by the *previous* version is
 * `detached` and keeps running: it still owns the port and serves an HTML shell
 * that references chunk hashes the new package no longer ships, so every chunk
 * request 500s and the dashboard goes blank (ChunkLoadError). The launcher had
 * no way to notice — it only ever spawned a server, never probed for one that
 * was already there.
 *
 * The probe is deliberately narrow: we only kill when the port *answers*
 * /api/version AND reports a version different from ours. Everything else (no
 * answer, same version, an unrelated service on the port) leaves the previous
 * behaviour untouched, so a recycled PID can never be killed on a guess.
 *
 * All process/DNS/fetch side effects are injectable so the logic is unit
 * testable without spawning or killing anything.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5000;
const RELEASE_POLL_INTERVAL_MS = 150;

function pidFilePath(dataDir) {
  return path.join(dataDir, "server.pid");
}

function diskVersionPath(dataDir) {
  return path.join(dataDir, ".disk-version");
}

function readPidFile(dataDir) {
  try {
    const pid = parseInt(fs.readFileSync(pidFilePath(dataDir), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(dataDir, pid) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(pidFilePath(dataDir), String(pid), "utf8");
    return true;
  } catch {
    return false;
  }
}

function removePidFile(dataDir) {
  try {
    fs.unlinkSync(pidFilePath(dataDir));
  } catch {
    /* already gone / never written */
  }
}

// The version the package directory currently holds. Written on install and on
// every launcher start, so a still-running OLD server can report "the disk has
// moved on" even though it cannot read the new package's code.
function writeDiskVersion(dataDir, version) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(diskVersionPath(dataDir), String(version), "utf8");
    return true;
  } catch {
    return false;
  }
}

function readDiskVersion(dataDir) {
  try {
    const v = fs.readFileSync(diskVersionPath(dataDir), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

// Inequality only — never an ordering. `1.1.1` vs `1.1.2` and `1.1.2` vs
// `1.1.2-test.3` are both "disk moved on", and `1.1.2-test.3` vs `1.1.2` is not
// (a test build of the same release must not look stale against itself).
function isVersionMismatch(runningVersion, diskVersion) {
  if (!runningVersion || !diskVersion) return false;
  return String(runningVersion) !== String(diskVersion);
}

/**
 * Probe http://127.0.0.1:<port>/api/version.
 * @returns {Promise<{reachable: boolean, version: string|null}>}
 *   reachable=false → nothing is listening (normal cold start).
 *   reachable=true, version=null → something is there but not our server / no JSON.
 */
async function probeServerVersion(port, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") return { reachable: false, version: null };
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/version`, {
      signal: controller ? controller.signal : undefined,
      cache: "no-store",
    });
    if (!res || !res.ok) return { reachable: true, version: null };
    const data = await res.json();
    return { reachable: true, version: data && data.currentVersion ? String(data.currentVersion) : null };
  } catch {
    return { reachable: false, version: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Kill a pid. POSIX uses SIGKILL on the group leader; win32 taskkills the tree. */
function killPid(pid, { platform = process.platform, killImpl, taskkillImpl } = {}) {
  if (!pid) return false;
  try {
    if (platform === "win32") {
      const run =
        taskkillImpl ||
        ((p) => require("child_process").spawnSync("taskkill", ["/PID", String(p), "/F", "/T"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 5000,
        }));
      run(pid);
      return true;
    }
    const kill = killImpl || ((p) => process.kill(p, "SIGKILL"));
    kill(pid);
    return true;
  } catch {
    return false;
  }
}

/** Poll until nothing answers on the port (or timeout). */
async function waitForPortRelease(port, options = {}) {
  const {
    timeoutMs = DEFAULT_RELEASE_TIMEOUT_MS,
    intervalMs = RELEASE_POLL_INTERVAL_MS,
    probe = probeServerVersion,
  } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { reachable } = await probe(port, options.probeOptions || {});
    if (!reachable) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Detect and clear a server left over from a different build.
 *
 * @returns {Promise<{action: "none"|"warn"|"killed", reason: string, running?: string, pid?: number|null}>}
 */
async function healStaleServer({
  port,
  version,
  dataDir,
  log: _log = () => {},
  fetchImpl,
  probeTimeoutMs,
  releaseTimeoutMs,
  platform,
  killImpl,
  taskkillImpl,
} = {}) {
  const probeOptions = { fetchImpl, timeoutMs: probeTimeoutMs };
  const probe = await probeServerVersion(port, probeOptions);

  if (!probe.reachable) return { action: "none", reason: "unreachable" };
  if (!probe.version) return { action: "none", reason: "no-version" };
  // Same build ⇒ this is our own server on a re-run; leave it alone (the
  // previous behaviour on an occupied port is preserved).
  if (!isVersionMismatch(probe.version, version)) return { action: "none", reason: "same-version" };

  const pid = readPidFile(dataDir);
  if (!pid) {
    // Proved it is our server (it answered /api/version) but we have no pid to
    // kill safely — a version that predates the pidfile. Report and carry on.
    return { action: "warn", reason: "stale-without-pidfile", running: probe.version, pid: null };
  }

  killPid(pid, { platform, killImpl, taskkillImpl });
  removePidFile(dataDir);
  await waitForPortRelease(port, {
    timeoutMs: releaseTimeoutMs,
    probeOptions,
    probe: (p, o) => probeServerVersion(p, o || {}),
  });

  return { action: "killed", reason: "stale-killed", running: probe.version, pid };
}

module.exports = {
  healStaleServer,
  isVersionMismatch,
  killPid,
  pidFilePath,
  diskVersionPath,
  probeServerVersion,
  readDiskVersion,
  readPidFile,
  removePidFile,
  waitForPortRelease,
  writeDiskVersion,
  writePidFile,
};
