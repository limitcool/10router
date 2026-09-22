"use strict";

/**
 * `10router doctor` — one command that answers "why is this install misbehaving?".
 *
 * Why it exists (issue #24): the three failure modes users hit all present the
 * same way — the dashboard serves a stale/blank page, or the app "installs fine
 * but will not start" — while every existing self-check answers "fine":
 *   §1  the two runtime hooks pruned each other's npm installs, so
 *       better-sqlite3 sat in node_modules but was absent from
 *       runtime/package.json: `npm ls` cannot see it and /api/health still said
 *       ok;
 *   §3  a server from the PREVIOUS build was still holding the port, so the
 *       binary that answered /api/health was the old one;
 *   §4  a global better-sqlite3 shadowed the runtime copy, and /api/health did
 *       not even name the driver it settled on.
 * All three needed a human to walk processes, node_modules and version markers
 * by hand. Doctor is that walk, scripted.
 *
 * Hard rules (see docs/zh-CN/spec-10router-doctor.md):
 *   - READ-ONLY. No DB initialisation (the same rule /api/health follows — a
 *     health probe that opens SQLite is its own outage), no file writes, no
 *     killing, no restarts. `--fix` is deliberately out of scope: the blast
 *     radius differs per finding (kill a process / reinstall a dependency /
 *     migrate data) and that is a product decision, not a diagnosis.
 *   - Every check is a pure function over already-collected facts, so the whole
 *     decision table is unit-testable without a port, a process or a real data
 *     dir. `collectChecks()` is the only part that touches the machine.
 *   - `--json` is a contract: it carries check IDs and reason codes, NEVER
 *     translated text, and is versioned by `schemaVersion`.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const { t } = require("./i18n");
const { getDataDir, getRuntimeDir, isBetterSqliteBinaryValid, isSqlJsWasmValid } = require("../../hooks/sqliteRuntime");
const {
  diskVersionPath,
  pidFilePath,
  probeServerVersion,
  readDiskVersion,
  readPidFile,
} = require("./staleServer");

const SCHEMA_VERSION = 1;
const DEFAULT_PORT = 20128;

/** `cli/app` — the built server this launcher spawns (`<repo>/cli/app`). */
const APP_DIR = path.join(__dirname, "..", "..", "app");
/** Written by cli/scripts/build-cli.js; its absence means "a half-finished upgrade". */
const BUILD_DIST_DIR = ".next-cli-build";
/** All three must exist for the launcher to have something to serve. */
const BUILD_MARKERS = ["custom-server.js", "server.js", path.join(BUILD_DIST_DIR, "server")];
/**
 * What the runtime dir is expected to hold. sql.js is the always-works fallback,
 * better-sqlite3 the speed path; systray2 only exists on macOS/Linux (Windows
 * gets an in-process tray), so it is not "missing" there.
 */
const RUNTIME_MODULES = ["sql.js", "better-sqlite3"];
const RUNTIME_MODULES_POSIX = ["systray2"];

const OK = "ok";
const YELLOW = "yellow";
const RED = "red";

const STATUS_ICON = { [OK]: "✅", [YELLOW]: "⚠️ ", [RED]: "❌" };

// ---------------------------------------------------------------------------
// Probes (the only side-effecting code in this file — all read-only)
// ---------------------------------------------------------------------------

/** Is anything accepting TCP connections on the port? */
function probeTcp(port, { timeoutMs = 800, host = "127.0.0.1" } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** `/api/health` is read-only by design, so this cannot open the DB. */
async function probeHealth(port, { fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  if (typeof fetchImpl !== "function") return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal: controller ? controller.signal : undefined,
      cache: "no-store",
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** PIDs listening on the port. Read-only twin of cli.js's killProcessOnPort(). */
function findPortOwners(port, { platform = process.platform, execSync } = {}) {
  const run = execSync || require("child_process").execSync;
  try {
    if (platform === "win32") {
      const out = String(
        run(`netstat -ano | findstr :${port}`, {
          encoding: "utf8",
          shell: true,
          windowsHide: true,
          timeout: 5000,
        }) || "",
      ).trim();
      const pids = out
        .split("\n")
        .filter((line) => line.includes("LISTENING"))
        .map((line) => Number(line.trim().split(/\s+/).pop()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      return [...new Set(pids)];
    }
    const out = String(
      run(`lsof -ti:${port}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 5000,
      }) || "",
    ).trim();
    const pids = out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    return [...new Set(pids)];
  } catch {
    // Nothing listening, or netstat/lsof unavailable — "no owner known", never
    // "no owner", so callers must not conclude the port is free from this alone.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Small read-only filesystem helpers
// ---------------------------------------------------------------------------

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The runtime dir is one npm project shared by both hooks, so "installed but not
 * declared" is exactly the §1 state: the next `npm install` here prunes it.
 *
 * `broken` is the other half of that story: a module npm considers installed can
 * still be unusable (better-sqlite3 without its compiled binary, sql.js without
 * its wasm). That is the state §4 showed as "a fallback driver, and nothing says
 * why" — the directory looks complete, so only the artifact check catches it.
 */
function readRuntimeState(runtimeDir) {
  const pkg = readJsonFile(path.join(runtimeDir, "package.json"));
  const declared = Object.keys(pkg?.dependencies || {});
  const nodeModulesDir = path.join(runtimeDir, "node_modules");
  let installed = [];
  try {
    installed = fs
      .readdirSync(nodeModulesDir)
      .filter((name) => name !== ".package-lock.json" && !name.startsWith("."))
      .filter((name) => fs.existsSync(path.join(nodeModulesDir, name, "package.json")));
  } catch {
    installed = [];
  }
  const broken = [];
  if (installed.includes("better-sqlite3") && !isBetterSqliteBinaryValid(nodeModulesDir)) broken.push("better-sqlite3");
  if (installed.includes("sql.js") && !isSqlJsWasmValid(nodeModulesDir)) broken.push("sql.js");
  return { declared, installed, broken };
}

/** The legacy 9Router data dir, still waiting to be migrated. */
function legacyDirPath({ platform = process.platform } = {}) {
  return platform === "win32"
    ? path.join(process.env.APPDATA || "", "9router")
    : path.join(os.homedir(), ".9router");
}

// Mirror of src/lib/dataDir.js `hasAppData()` — deliberately NOT "is the dir
// non-empty": on Windows the data dir doubles as Electron's userData profile
// (Cache/, GPUCache/ …), so non-emptiness is always true and would pin the
// migration — and this check — off. Keeping the same file list means doctor and
// the app can never disagree about whether a migration is still pending.
const LEGACY_JSON_FILES = ["db.json", "usage.json", "disabledModels.json", "request-details.json"];

function hasAppData(dir) {
  if (fs.existsSync(path.join(dir, "db", "data.sqlite"))) return true;
  return LEGACY_JSON_FILES.some((name) => fs.existsSync(path.join(dir, name)));
}

// ---------------------------------------------------------------------------
// Checks — pure functions: (facts) -> { id, status, reason, facts }
// ---------------------------------------------------------------------------

const result = (id, status, reason, facts = {}) => ({ id, status, reason, facts });

function checkDataDir({ dataDir, exists, writable, legacyDir, legacyPending }) {
  const facts = { dir: dataDir };
  if (exists && !writable) return result("data-dir", RED, "not-writable", facts);
  // Only while the copy has genuinely not happened. The migration leaves the
  // legacy dir in place forever (so it can be retried by hand), so "legacy dir
  // exists" alone is a permanent condition and would be pure noise here.
  if (legacyPending) return result("data-dir", YELLOW, "legacy-pending", { ...facts, legacy: legacyDir });
  if (!exists) return result("data-dir", YELLOW, "missing", facts);
  return result("data-dir", OK, "ok", facts);
}

function checkBuild({ appDir, missing, appVersion, launcherVersion }) {
  const facts = { dir: appDir, version: appVersion || null, launcher: launcherVersion || null };
  if (missing.length) return result("build", RED, "missing-files", { ...facts, missing });
  if (!appVersion) return result("build", RED, "no-version", facts);
  if (appVersion !== launcherVersion) return result("build", RED, "version-mismatch", facts);
  return result("build", OK, "ok", facts);
}

function checkRuntimeDeps({ runtimeDir, declared, installed, broken, expected }) {
  const facts = {
    dir: runtimeDir,
    orphaned: expected.filter((m) => installed.includes(m) && !declared.includes(m)),
    broken: (broken || []).filter((m) => expected.includes(m)),
    missing: expected.filter((m) => !installed.includes(m)),
  };
  if (!fs.existsSync(runtimeDir)) return result("runtime-deps", YELLOW, "no-runtime", facts);
  if (facts.orphaned.length) return result("runtime-deps", RED, "unregistered", facts);
  if (facts.broken.length) return result("runtime-deps", RED, "broken-artifact", facts);
  if (facts.missing.length) return result("runtime-deps", YELLOW, "missing", facts);
  return result("runtime-deps", OK, "ok", facts);
}

/**
 * `driver: null` is NOT a failure: /api/health deliberately never initialises the
 * DB, so a freshly started server reports null until the first real query. Only
 * "no driver AND no runtime copy AND the driver layer said why" is fatal.
 */
function checkDriver({ health, runtimeCopy }) {
  const facts = { driver: health?.driver ?? null, error: health?.lastDriverError ?? null, runtimeCopy };
  if (!health) return result("driver", YELLOW, "no-health", facts);
  if (!health.driver && !runtimeCopy && health.lastDriverError) return result("driver", RED, "no-driver", facts);
  if (!health.driver) return result("driver", YELLOW, "not-initialized", facts);
  if (health.lastDriverError) return result("driver", YELLOW, "fallback", facts);
  return result("driver", OK, "ok", facts);
}

/** Launcher vs the on-disk marker vs what is actually answering on the port. */
function checkVersion({ port, launcherVersion, diskVersion, server }) {
  const facts = { port, launcher: launcherVersion, disk: diskVersion || null, server: server?.version || null };
  // Deliberately NOT gated on a running server: launcher ≠ on-disk marker means
  // two different builds are sharing one data dir, which is true regardless of
  // whether either of them is up right now.
  const known = [launcherVersion, diskVersion, server?.version].filter(Boolean);
  if (new Set(known).size > 1) return result("version", RED, "mismatch", facts);
  // Something holds the port but does not speak our /api/version.
  if (server?.reachable && !server.version) return result("version", YELLOW, "no-server-version", facts);
  return result("version", OK, "ok", facts);
}

function checkPort({ port, dataDir, listening, owners, pidFilePid, server }) {
  const facts = { port, owners: owners || [], pidFilePid: pidFilePid || null };
  if (!listening) {
    // A pidfile with nothing listening is a leftover from a crashed server; the
    // next start's heal would rewrite it, so it is informative, not broken.
    if (pidFilePid) return result("port", YELLOW, "orphan-pidfile", { ...facts, file: pidFilePath(dataDir) });
    return result("port", OK, "free", facts);
  }
  if (server?.version) return result("port", OK, "ok", facts);
  // Answers TCP but not our /api/version: our own server mid-boot (the pidfile
  // still matches) or somebody else's service (it does not).
  if (pidFilePid && owners.includes(pidFilePid)) return result("port", OK, "booting", facts);
  return result("port", RED, "foreign", facts);
}

/** The §3b scenario: the port is served by a build that is not the one on disk. */
function checkStaleProcess({ port, dataDir, server, diskVersion, launcherVersion, pidFilePid, owners }) {
  const disk = diskVersion || launcherVersion;
  const facts = {
    port,
    server: server?.version || null,
    disk: disk || null,
    pidFilePid: pidFilePid || null,
    owners: owners || [],
  };
  const running = server?.version || null;
  if (!running) {
    // Nothing verifiable is on the port. A pidfile we cannot match is worth a
    // look, but a stale build can only be PROVEN by a version, so never red.
    if (pidFilePid) return result("stale-process", YELLOW, "unverified", facts);
    return result("stale-process", OK, "idle", facts);
  }
  // Comparing against the launcher when the marker is absent keeps the red
  // signal: "what is serving is not what this launcher ships" is the same fault.
  if (running !== disk) return result("stale-process", RED, "stale", facts);
  // It matches, but with no marker on disk a still-running OLD build could never
  // have noticed an upgrade — the §3b mechanism is silently absent.
  if (!diskVersion) return result("stale-process", YELLOW, "no-marker", { ...facts, file: diskVersionPath(dataDir) });
  if (pidFilePid && owners.length && !owners.includes(pidFilePid)) {
    return result("stale-process", YELLOW, "pid-mismatch", facts);
  }
  return result("stale-process", OK, "ok", facts);
}

/** Informational only — a missing tray never breaks serving, so never red. */
function checkTray({ platform, systrayInstalled }) {
  const facts = { platform, systray: Boolean(systrayInstalled) };
  if (platform === "win32") return result("tray", OK, "bundled", facts);
  if (!systrayInstalled) return result("tray", YELLOW, "missing", facts);
  return result("tray", OK, "ok", facts);
}

// ---------------------------------------------------------------------------
// Collection — the only machine-touching part
// ---------------------------------------------------------------------------

const ORDER = ["version", "stale-process", "build", "driver", "runtime-deps", "port", "tray", "data-dir"];

/**
 * Gather every fact once, then run the pure checks. Injectable so tests never
 * touch a real port or a real ~/.10router.
 */
async function collectChecks({
  port = DEFAULT_PORT,
  dataDir = getDataDir(),
  launcherVersion = require("../../package.json").version,
  appDir = APP_DIR,
  runtimeDir = getRuntimeDir(),
  platform = process.platform,
  legacyDir = legacyDirPath({ platform }),
  fetchImpl,
  execSyncImpl,
  probeTimeoutMs,
} = {}) {
  const probeOptions = { fetchImpl, timeoutMs: probeTimeoutMs };

  const [server, health, listening] = await Promise.all([
    probeServerVersion(port, probeOptions),
    probeHealth(port, { fetchImpl, timeoutMs: probeTimeoutMs }),
    probeTcp(port),
  ]);
  const owners = listening ? findPortOwners(port, { platform, execSync: execSyncImpl }) : [];

  const missing = BUILD_MARKERS.filter((rel) => !fs.existsSync(path.join(appDir, rel)));
  const appVersion = readJsonFile(path.join(appDir, "package.json"))?.version || null;

  const runtime = readRuntimeState(runtimeDir);
  const expected = [...RUNTIME_MODULES, ...(platform === "win32" ? [] : RUNTIME_MODULES_POSIX)];

  const shared = {
    dataDir,
    server,
    listening,
    owners,
    port,
    pidFilePid: readPidFile(dataDir),
    diskVersion: readDiskVersion(dataDir),
    launcherVersion,
  };

  const checks = [
    checkVersion({ port, launcherVersion, diskVersion: shared.diskVersion, server }),
    checkStaleProcess({ ...shared }),
    checkBuild({ appDir, missing, appVersion, launcherVersion }),
    checkDriver({
      health,
      // "copy present" has to mean *usable*: §4 was a runtime copy that existed
      // but could not be loaded, which is indistinguishable from absent here.
      runtimeCopy:
        runtime.installed.includes("better-sqlite3") && !runtime.broken.includes("better-sqlite3"),
    }),
    checkRuntimeDeps({
      runtimeDir,
      declared: runtime.declared,
      installed: runtime.installed,
      broken: runtime.broken,
      expected,
    }),
    checkPort({ port, dataDir, listening, owners, pidFilePid: shared.pidFilePid, server }),
    checkTray({ platform, systrayInstalled: runtime.installed.includes("systray2") }),
    checkDataDir({
      dataDir,
      exists: fs.existsSync(dataDir),
      writable: isWritable(dataDir),
      legacyDir,
      legacyPending: fs.existsSync(legacyDir) && !hasAppData(dataDir),
    }),
  ];

  return ORDER.map((id) => checks.find((c) => c.id === id));
}

function summarize(checks, { port = DEFAULT_PORT, dataDir = getDataDir(), launcherVersion } = {}) {
  const counts = { [OK]: 0, [YELLOW]: 0, [RED]: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: counts[RED] === 0,
    version: launcherVersion || require("../../package.json").version,
    port,
    dataDir,
    counts,
    checks: checks.map(({ id, status, reason, facts }) => ({ id, status, reason, facts })),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One line per check. `doctor.<id>.ok` for a pass, `doctor.<id>.<reason>` for a
 * finding, so the text can name the actual cause instead of a generic warning.
 */
function renderHuman(report) {
  const lines = [t("doctor.title", { version: report.version, port: report.port }), ""];
  for (const c of report.checks) {
    const key = c.status === OK ? `doctor.${c.id}.ok` : `doctor.${c.id}.${c.reason}`;
    const params = {};
    for (const [name, value] of Object.entries(c.facts)) {
      if (Array.isArray(value)) params[name] = value.join(", ") || "—";
      // An absent fact (no marker, no pidfile, no driver) must not print as
      // "null" — every message would then read like a crash.
      else params[name] = value === null || value === undefined || value === "" ? "—" : value;
    }
    lines.push(`${STATUS_ICON[c.status]} ${c.id}: ${t(key, params)}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? t("doctor.summaryOk", { ok: report.counts[OK], yellow: report.counts[YELLOW] })
      : t("doctor.summaryRed", { red: report.counts[RED], yellow: report.counts[YELLOW] }),
  );
  lines.push(t("doctor.readOnlyHint"));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, help: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--port" || arg === "-p") {
      const next = parseInt(argv[i + 1], 10);
      if (Number.isInteger(next) && next > 0 && next < 65536) opts.port = next;
      i++;
    }
  }
  return opts;
}

async function run(argv = [], deps = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(t("doctor.help"));
    return 0;
  }
  const checks = await collectChecks({ ...deps, port: opts.port });
  const report = summarize(checks, { ...deps, port: opts.port });
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderHuman(report));
  return report.ok ? 0 : 1;
}

module.exports = {
  APP_DIR,
  BUILD_MARKERS,
  DEFAULT_PORT,
  OK,
  ORDER,
  RED,
  RUNTIME_MODULES,
  RUNTIME_MODULES_POSIX,
  SCHEMA_VERSION,
  YELLOW,
  checkBuild,
  checkDataDir,
  checkDriver,
  checkPort,
  checkRuntimeDeps,
  checkStaleProcess,
  checkTray,
  checkVersion,
  collectChecks,
  findPortOwners,
  hasAppData,
  legacyDirPath,
  parseArgs,
  probeHealth,
  probeTcp,
  readRuntimeState,
  renderHuman,
  run,
  summarize,
};
