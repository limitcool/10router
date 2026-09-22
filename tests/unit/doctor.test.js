/**
 * `10router doctor` (issue #24 §5.4) — the check decision table, the report
 * contract, and the read-only guarantee.
 *
 * Everything here is hermetic on purpose: no subprocess, no real port, no real
 * ~/.10router. `collectChecks()` takes every machine-touching dependency as an
 * argument, so the only integration case below runs against temp dirs and an
 * injected fetch/exec, and never connects to anything.
 *
 * The two guards worth knowing about:
 *   - every emitted (check, status/reason) pair must have a string in ALL THREE
 *     locales, or the report silently degrades to printing "doctor.port.foreign"
 *     at a user;
 *   - every message placeholder must be satisfied by the facts the check
 *     produces, or the report prints a literal "{port}".
 * Both are exercised against the real dictionaries.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const LANGS = ["en", "zh-CN", "zh-TW"];
const CLI = fileURLToPath(new URL("../../cli/cli.js", import.meta.url));

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const dict = (lang) => JSON.parse(readFileSync(abs(`cli/src/cli/i18n/locales/${lang}/core.json`), "utf8"));

const originalLang = process.env.TENROUTER_LANG;
afterAll(() => {
  if (originalLang === undefined) delete process.env.TENROUTER_LANG;
  else process.env.TENROUTER_LANG = originalLang;
});

/** doctor.js captures `t` at require time, so reload it per language. */
function loadDoctor(lang) {
  process.env.TENROUTER_LANG = lang;
  for (const key of Object.keys(require.cache)) {
    const k = key.replace(/\\/g, "/");
    if (k.includes("/cli/src/cli/doctor.js") || k.includes("/cli/src/cli/i18n/")) delete require.cache[key];
  }
  return require("../../cli/src/cli/doctor.js");
}

const doctor = loadDoctor("en");

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "10router-doctor-"));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// The decision table, one row per reachable outcome
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(tmpdir(), "10router-doctor-fake-data");

const cases = [
  // --- version -------------------------------------------------------------
  {
    name: "version: all three agree",
    run: () => doctor.checkVersion({ port: 1, launcherVersion: "1.2.3", diskVersion: "1.2.3", server: { reachable: true, version: "1.2.3" } }),
    status: "ok",
    reason: "ok",
  },
  {
    name: "version: server differs from disk (the §3b stale banner)",
    run: () => doctor.checkVersion({ port: 1, launcherVersion: "1.2.3", diskVersion: "1.2.4", server: { reachable: true, version: "1.2.3" } }),
    status: "red",
    reason: "mismatch",
  },
  {
    // Regression: the first cut returned early when no server answered, which
    // hid a launcher/disk mismatch entirely.
    name: "version: launcher differs from disk with NOTHING running",
    run: () => doctor.checkVersion({ port: 1, launcherVersion: "1.2.3", diskVersion: "1.2.4", server: { reachable: false, version: null } }),
    status: "red",
    reason: "mismatch",
  },
  {
    name: "version: something answers but is not our API",
    run: () => doctor.checkVersion({ port: 1, launcherVersion: "1.2.3", diskVersion: "1.2.3", server: { reachable: true, version: null } }),
    status: "yellow",
    reason: "no-server-version",
  },

  // --- stale-process -------------------------------------------------------
  {
    name: "stale-process: idle, no pidfile",
    run: () => doctor.checkStaleProcess({ port: 1, dataDir: DATA_DIR, server: { reachable: false, version: null }, diskVersion: "1.2.3", launcherVersion: "1.2.3", pidFilePid: null, owners: [] }),
    status: "ok",
    reason: "idle",
  },
  {
    name: "stale-process: serving a different build",
    run: () => doctor.checkStaleProcess({ port: 1, dataDir: DATA_DIR, server: { reachable: true, version: "1.2.3" }, diskVersion: "1.2.4", launcherVersion: "1.2.4", pidFilePid: 42, owners: [42] }),
    status: "red",
    reason: "stale",
  },
  {
    name: "stale-process: no on-disk marker to compare against",
    run: () => doctor.checkStaleProcess({ port: 1, dataDir: DATA_DIR, server: { reachable: true, version: "1.2.3" }, diskVersion: null, launcherVersion: "1.2.3", pidFilePid: 42, owners: [42] }),
    status: "yellow",
    reason: "no-marker",
  },
  {
    name: "stale-process: pidfile we cannot match to a version",
    run: () => doctor.checkStaleProcess({ port: 1, dataDir: DATA_DIR, server: { reachable: true, version: null }, diskVersion: "1.2.3", launcherVersion: "1.2.3", pidFilePid: 42, owners: [] }),
    status: "yellow",
    reason: "unverified",
  },
  {
    name: "stale-process: same version, but another pid owns the port",
    run: () => doctor.checkStaleProcess({ port: 1, dataDir: DATA_DIR, server: { reachable: true, version: "1.2.3" }, diskVersion: "1.2.3", launcherVersion: "1.2.3", pidFilePid: 42, owners: [99] }),
    status: "yellow",
    reason: "pid-mismatch",
  },
  {
    name: "stale-process: fresh and matching",
    run: () => doctor.checkStaleProcess({ port: 1, dataDir: DATA_DIR, server: { reachable: true, version: "1.2.3" }, diskVersion: "1.2.3", launcherVersion: "1.2.3", pidFilePid: 42, owners: [42] }),
    status: "ok",
    reason: "ok",
  },

  // --- build ---------------------------------------------------------------
  {
    name: "build: complete and matching the launcher",
    run: () => doctor.checkBuild({ appDir: "/app", missing: [], appVersion: "1.2.3", launcherVersion: "1.2.3" }),
    status: "ok",
    reason: "ok",
  },
  {
    name: "build: missing the standalone output",
    run: () => doctor.checkBuild({ appDir: "/app", missing: [".next-cli-build/server"], appVersion: "1.2.3", launcherVersion: "1.2.3" }),
    status: "red",
    reason: "missing-files",
  },
  {
    name: "build: no readable package.json",
    run: () => doctor.checkBuild({ appDir: "/app", missing: [], appVersion: null, launcherVersion: "1.2.3" }),
    status: "red",
    reason: "no-version",
  },
  {
    name: "build: half-finished upgrade",
    run: () => doctor.checkBuild({ appDir: "/app", missing: [], appVersion: "1.2.2", launcherVersion: "1.2.3" }),
    status: "red",
    reason: "version-mismatch",
  },

  // --- driver --------------------------------------------------------------
  {
    name: "driver: a working preferred driver",
    run: () => doctor.checkDriver({ health: { driver: "better-sqlite3", lastDriverError: null }, runtimeCopy: true }),
    status: "ok",
    reason: "ok",
  },
  {
    name: "driver: not initialised yet (health never opens the DB)",
    run: () => doctor.checkDriver({ health: { driver: null, lastDriverError: null }, runtimeCopy: true }),
    status: "yellow",
    reason: "not-initialized",
  },
  {
    name: "driver: fell back to another driver",
    run: () => doctor.checkDriver({ health: { driver: "node:sqlite", lastDriverError: "better-sqlite3: missing" }, runtimeCopy: false }),
    status: "yellow",
    reason: "fallback",
  },
  {
    name: "driver: nothing to fall back to",
    run: () => doctor.checkDriver({ health: { driver: null, lastDriverError: "no sqlite at all" }, runtimeCopy: false }),
    status: "red",
    reason: "no-driver",
  },
  {
    name: "driver: server not running",
    run: () => doctor.checkDriver({ health: null, runtimeCopy: true }),
    status: "yellow",
    reason: "no-health",
  },

  // --- runtime-deps --------------------------------------------------------
  {
    name: "runtime-deps: installed, registered and usable",
    run: () => doctor.checkRuntimeDeps({ runtimeDir: tmp, declared: ["sql.js", "better-sqlite3"], installed: ["sql.js", "better-sqlite3"], broken: [], expected: ["sql.js", "better-sqlite3"] }),
    status: "ok",
    reason: "ok",
  },
  {
    // The §1 bug: present in node_modules, absent from package.json → the next
    // `npm install` in that dir treats it as extraneous and deletes it.
    name: "runtime-deps: installed but not registered (the §1 prune)",
    run: () => doctor.checkRuntimeDeps({ runtimeDir: tmp, declared: [], installed: ["sql.js", "better-sqlite3"], broken: [], expected: ["sql.js", "better-sqlite3"] }),
    status: "red",
    reason: "unregistered",
  },
  {
    // npm reports it as installed; the compiled binary was never built.
    name: "runtime-deps: installed but its artifact is missing",
    run: () => doctor.checkRuntimeDeps({ runtimeDir: tmp, declared: ["better-sqlite3"], installed: ["better-sqlite3"], broken: ["better-sqlite3"], expected: ["better-sqlite3"] }),
    status: "red",
    reason: "broken-artifact",
  },
  {
    name: "runtime-deps: not installed (fallbacks cover it)",
    run: () => doctor.checkRuntimeDeps({ runtimeDir: tmp, declared: [], installed: [], broken: [], expected: ["sql.js"] }),
    status: "yellow",
    reason: "missing",
  },
  {
    name: "runtime-deps: runtime dir does not exist yet",
    run: () => doctor.checkRuntimeDeps({ runtimeDir: path.join(tmp, "nope"), declared: [], installed: [], broken: [], expected: ["sql.js"] }),
    status: "yellow",
    reason: "no-runtime",
  },

  // --- port ----------------------------------------------------------------
  {
    name: "port: free",
    run: () => doctor.checkPort({ port: 1, dataDir: DATA_DIR, listening: false, owners: [], pidFilePid: null, server: { reachable: false, version: null } }),
    status: "ok",
    reason: "free",
  },
  {
    name: "port: free but a pidfile is left over",
    run: () => doctor.checkPort({ port: 1, dataDir: DATA_DIR, listening: false, owners: [], pidFilePid: 42, server: { reachable: false, version: null } }),
    status: "yellow",
    reason: "orphan-pidfile",
  },
  {
    name: "port: ours",
    run: () => doctor.checkPort({ port: 1, dataDir: DATA_DIR, listening: true, owners: [42], pidFilePid: 42, server: { reachable: true, version: "1.2.3" } }),
    status: "ok",
    reason: "ok",
  },
  {
    name: "port: our own pid, still booting",
    run: () => doctor.checkPort({ port: 1, dataDir: DATA_DIR, listening: true, owners: [42], pidFilePid: 42, server: { reachable: true, version: null } }),
    status: "ok",
    reason: "booting",
  },
  {
    name: "port: held by somebody else",
    run: () => doctor.checkPort({ port: 1, dataDir: DATA_DIR, listening: true, owners: [999], pidFilePid: null, server: { reachable: true, version: null } }),
    status: "red",
    reason: "foreign",
  },

  // --- tray ----------------------------------------------------------------
  {
    name: "tray: windows uses an in-process tray",
    run: () => doctor.checkTray({ platform: "win32", systrayInstalled: false }),
    status: "ok",
    reason: "bundled",
  },
  {
    name: "tray: systray2 missing on posix",
    run: () => doctor.checkTray({ platform: "linux", systrayInstalled: false }),
    status: "yellow",
    reason: "missing",
  },
  {
    name: "tray: available",
    run: () => doctor.checkTray({ platform: "darwin", systrayInstalled: true }),
    status: "ok",
    reason: "ok",
  },

  // --- data-dir ------------------------------------------------------------
  {
    name: "data-dir: present and writable",
    run: () => doctor.checkDataDir({ dataDir: "/d", exists: true, writable: true, legacyDir: "/l", legacyPending: false }),
    status: "ok",
    reason: "ok",
  },
  {
    name: "data-dir: not created yet",
    run: () => doctor.checkDataDir({ dataDir: "/d", exists: false, writable: false, legacyDir: "/l", legacyPending: false }),
    status: "yellow",
    reason: "missing",
  },
  {
    name: "data-dir: not writable",
    run: () => doctor.checkDataDir({ dataDir: "/d", exists: true, writable: false, legacyDir: "/l", legacyPending: false }),
    status: "red",
    reason: "not-writable",
  },
  {
    name: "data-dir: legacy 9Router data still pending",
    run: () => doctor.checkDataDir({ dataDir: "/d", exists: true, writable: true, legacyDir: "/l", legacyPending: true }),
    status: "yellow",
    reason: "legacy-pending",
  },
  {
    // The migration deliberately leaves ~/.9router behind, so this must NOT keep
    // warning once the data has actually been copied.
    name: "data-dir: legacy dir left over after a completed migration",
    run: () => doctor.checkDataDir({ dataDir: "/d", exists: true, writable: true, legacyDir: "/l", legacyPending: false }),
    status: "ok",
    reason: "ok",
  },
];

/** What renderHuman would look up for this outcome. */
const messageKey = (c) => (c.status === "ok" ? `doctor.${c.id}.ok` : `doctor.${c.id}.${c.reason}`);

describe("doctor — check decision table", () => {
  for (const c of cases) {
    it(c.name, () => {
      const out = c.run();
      expect(out.status, c.name).toBe(c.status);
      expect(out.reason, c.name).toBe(c.reason);
      expect(typeof out.id).toBe("string");
      expect(out.facts).toBeTypeOf("object");
    });
  }

  it("covers every check id", () => {
    const ids = new Set(cases.map((c) => c.run().id));
    expect([...ids].sort()).toEqual([...doctor.ORDER].sort());
  });

  it("uses only the three statuses", () => {
    for (const c of cases) expect([doctor.OK, doctor.YELLOW, doctor.RED]).toContain(c.run().status);
  });
});

describe("doctor — messages exist in every locale", () => {
  const dicts = Object.fromEntries(LANGS.map((l) => [l, dict(l)]));

  it("every outcome the checks can produce has a string in all three locales", () => {
    for (const c of cases) {
      const key = messageKey(c.run());
      for (const lang of LANGS) {
        expect(typeof dicts[lang][key], `${lang}: ${key}`).toBe("string");
        expect(dicts[lang][key].length, `${lang}: ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("all three locales carry exactly the same doctor.* keys", () => {
    const keys = LANGS.map((l) => Object.keys(dicts[l]).filter((k) => k.startsWith("doctor.")).sort());
    expect(keys[0].length).toBeGreaterThan(30);
    expect(JSON.stringify(keys[1])).toBe(JSON.stringify(keys[0]));
    expect(JSON.stringify(keys[2])).toBe(JSON.stringify(keys[0]));
  });

  it("advertises the command in help.text", () => {
    for (const lang of LANGS) expect(dicts[lang]["help.text"]).toContain("doctor ");
  });
});

describe("doctor — rendered report", () => {
  it("leaves no unresolved {placeholder} behind, in any locale", () => {
    for (const lang of LANGS) {
      const d = loadDoctor(lang);
      const checks = cases.map((c) => c.run());
      const counts = { ok: 0, yellow: 0, red: 0 };
      for (const c of checks) counts[c.status]++;
      const text = d.renderHuman({
        schemaVersion: d.SCHEMA_VERSION,
        ok: false,
        version: "1.2.3",
        port: 20128,
        counts,
        checks,
      });
      expect(text, lang).not.toMatch(/\{[a-zA-Z]+\}/);
      // A missing key would be printed verbatim; t() falls back to the key.
      expect(text, lang).not.toMatch(/doctor\.[a-z-]+\.[a-zA-Z-]+/);
      expect(text.length, lang).toBeGreaterThan(100);
    }
  });

  it("reports ok when nothing is red", () => {
    const d = loadDoctor("en");
    const text = d.renderHuman({
      schemaVersion: d.SCHEMA_VERSION,
      ok: true,
      version: "1.2.3",
      port: 20128,
      counts: { ok: 8, yellow: 0, red: 0 },
      checks: [],
    });
    expect(text).toMatch(/All checks passed/);
    expect(text).toMatch(/Read-only/);
  });
});

describe("doctor — --json contract", () => {
  it("is versioned, carries ids and reasons, and no translated text", () => {
    const checks = cases.map((c) => c.run());
    const report = doctor.summarize(checks, { port: 20128, dataDir: DATA_DIR, launcherVersion: "1.2.3" });
    expect(report.schemaVersion).toBe(1);
    expect(report.port).toBe(20128);
    expect(report.version).toBe("1.2.3");
    expect(report.ok).toBe(false);
    for (const c of report.checks) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.reason).toBe("string");
      expect(c).not.toHaveProperty("message");
    }
    // A report for a machine must never contain human-language copy.
    expect(JSON.stringify(report)).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
  });

  it("ok is true exactly when no check is red", () => {
    const okOnly = [doctor.checkTray({ platform: "win32", systrayInstalled: false })];
    expect(doctor.summarize(okOnly, { launcherVersion: "1" }).ok).toBe(true);
    const withYellow = [doctor.checkTray({ platform: "linux", systrayInstalled: false })];
    expect(doctor.summarize(withYellow, { launcherVersion: "1" }).ok).toBe(true);
    const withRed = [doctor.checkBuild({ appDir: "/app", missing: ["x"], appVersion: "1", launcherVersion: "1" })];
    expect(doctor.summarize(withRed, { launcherVersion: "1" }).ok).toBe(false);
  });

  it("counts each status", () => {
    const report = doctor.summarize([...cases.map((c) => c.run())], { launcherVersion: "1" });
    expect(report.counts.ok + report.counts.yellow + report.counts.red).toBe(cases.length);
  });
});

describe("doctor — argument parsing", () => {
  it("defaults to the standard port and human output", () => {
    expect(doctor.parseArgs([])).toEqual({ json: false, help: false, port: 20128 });
  });

  it("accepts --json, --port and -p", () => {
    expect(doctor.parseArgs(["--json"]).json).toBe(true);
    expect(doctor.parseArgs(["--port", "9999"]).port).toBe(9999);
    expect(doctor.parseArgs(["-p", "9999"]).port).toBe(9999);
    expect(doctor.parseArgs(["--help"]).help).toBe(true);
  });

  it("ignores a nonsensical port instead of probing it", () => {
    for (const bad of ["0", "-1", "abc", "70000"]) {
      expect(doctor.parseArgs(["--port", bad]).port).toBe(20128);
    }
  });
});

describe("doctor — machine inspection", () => {
  it("readRuntimeState flags a module whose compiled artifact never built", () => {
    const rt = path.join(tmp, "runtime");
    mkdirSync(path.join(rt, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(path.join(rt, "package.json"), JSON.stringify({ dependencies: { "better-sqlite3": "^1" } }));
    writeFileSync(path.join(rt, "node_modules", "better-sqlite3", "package.json"), "{}");
    const state = doctor.readRuntimeState(rt);
    expect(state.declared).toContain("better-sqlite3");
    expect(state.installed).toContain("better-sqlite3");
    expect(state.broken).toContain("better-sqlite3");
  });

  it("readRuntimeState accepts a module whose artifact is a real binary", () => {
    const rt = path.join(tmp, "runtime");
    const release = path.join(rt, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(release, { recursive: true });
    writeFileSync(path.join(rt, "package.json"), JSON.stringify({ dependencies: { "better-sqlite3": "^1" } }));
    writeFileSync(path.join(rt, "node_modules", "better-sqlite3", "package.json"), "{}");
    const magic =
      process.platform === "linux"
        ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
        : process.platform === "darwin"
          ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
          : Buffer.from([0x4d, 0x5a]);
    writeFileSync(path.join(release, "better_sqlite3.node"), magic);
    const state = doctor.readRuntimeState(rt);
    expect(state.installed).toContain("better-sqlite3");
    expect(state.broken).toEqual([]);
  });

  it("readRuntimeState tolerates a missing runtime dir", () => {
    expect(doctor.readRuntimeState(path.join(tmp, "absent"))).toEqual({ declared: [], installed: [], broken: [] });
  });

  it("hasAppData recognises the SQLite db and the pre-SQLite json files", () => {
    const dir = path.join(tmp, "data");
    // Empty-ish dirs are NOT data: on Windows this path is also Electron's
    // userData profile, so Cache/ and friends would otherwise pin it true.
    mkdirSync(path.join(dir, "Cache"), { recursive: true });
    expect(doctor.hasAppData(dir)).toBe(false);
    mkdirSync(path.join(dir, "db"), { recursive: true });
    writeFileSync(path.join(dir, "db", "data.sqlite"), "");
    expect(doctor.hasAppData(dir)).toBe(true);
    const json = path.join(tmp, "data-json");
    mkdirSync(json, { recursive: true });
    writeFileSync(path.join(json, "db.json"), "{}");
    expect(doctor.hasAppData(json)).toBe(true);
    expect(doctor.hasAppData(path.join(tmp, "nothing"))).toBe(false);
  });

  it("findPortOwners parses win32 netstat output", () => {
    const execSync = () =>
      "  TCP    0.0.0.0:20128    0.0.0.0:0    LISTENING    4242\r\n" +
      "  TCP    127.0.0.1:20128  0.0.0.0:0    LISTENING    4242\r\n" +
      "  TCP    0.0.0.0:20129    0.0.0.0:0    ESTABLISHED  777\r\n";
    expect(doctor.findPortOwners(20128, { platform: "win32", execSync })).toEqual([4242]);
  });

  it("findPortOwners parses posix lsof output", () => {
    expect(doctor.findPortOwners(20128, { platform: "linux", execSync: () => "4242\n4243\n4242\n" })).toEqual([4242, 4243]);
  });

  it("findPortOwners returns nothing rather than throwing when the tool fails", () => {
    const boom = () => {
      throw new Error("lsof: command not found");
    };
    expect(doctor.findPortOwners(20128, { platform: "linux", execSync: boom })).toEqual([]);
    expect(doctor.findPortOwners(20128, { platform: "win32", execSync: boom })).toEqual([]);
  });

  it("probeHealth parses /api/health and stays silent on failure", async () => {
    const ok = async () => ({ ok: true, json: async () => ({ ok: true, driver: "node:sqlite", lastDriverError: null }) });
    expect(await doctor.probeHealth(20128, { fetchImpl: ok })).toMatchObject({ driver: "node:sqlite" });
    const bad = async () => ({ ok: false, json: async () => ({}) });
    expect(await doctor.probeHealth(20128, { fetchImpl: bad })).toBeNull();
    const boom = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await doctor.probeHealth(20128, { fetchImpl: boom })).toBeNull();
    expect(await doctor.probeHealth(20128, { fetchImpl: null })).toBeNull();
  });

  it("probeTcp sees a listening socket and a closed one", async () => {
    const net = require("node:net");
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      expect(await doctor.probeTcp(port)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await doctor.probeTcp(port)).toBe(false);
  });
});

describe("doctor — collectChecks (integration, still hermetic)", () => {
  it("returns every check, in a stable order, without touching the real machine", async () => {
    const dataDir = path.join(tmp, "data");
    const runtimeDir = path.join(tmp, "runtime");
    mkdirSync(path.join(runtimeDir, "node_modules"), { recursive: true });
    writeFileSync(path.join(runtimeDir, "package.json"), JSON.stringify({ dependencies: { "sql.js": "^1" } }));

    const checks = await doctor.collectChecks({
      // Deliberately not 20128: the developer's own gateway may be listening
      // there, and this test must not connect to (or describe) it.
      port: 65280,
      dataDir,
      runtimeDir,
      appDir: path.join(tmp, "app"),
      legacyDir: path.join(tmp, "no-legacy"),
      launcherVersion: "1.2.3",
      platform: "linux",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      execSyncImpl: () => "",
    });

    expect(checks.map((c) => c.id)).toEqual(doctor.ORDER);
    for (const c of checks) expect([doctor.OK, doctor.YELLOW, doctor.RED]).toContain(c.status);
    // Nothing was created for us: doctor must not write, not even a data dir.
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(true);
  });
});

describe("doctor — wiring and the read-only promise", () => {
  const cliSrc = readFileSync(CLI, "utf8");
  const doctorSrc = readFileSync(abs("cli/src/cli/doctor.js"), "utf8");

  it("is dispatched before the runtime self-heal hooks", () => {
    // Otherwise `10router doctor` would silently REPAIR the very runtime it was
    // asked to report on, and would never be able to show a broken one.
    const dispatch = cliSrc.indexOf('args[0] === "doctor"');
    const hooks = cliSrc.indexOf("ensureSqliteRuntime({ silent: true })");
    expect(dispatch).toBeGreaterThan(-1);
    expect(hooks).toBeGreaterThan(-1);
    expect(dispatch).toBeLessThan(hooks);
    // ...and before the on-disk version marker is stamped.
    expect(dispatch).toBeLessThan(cliSrc.indexOf("writeDiskVersion(getDataDir()"));
  });

  it("exits with the verdict", () => {
    expect(cliSrc).toMatch(/require\("\.\/src\/cli\/doctor"\)/);
    expect(doctorSrc).toMatch(/return report\.ok \? 0 : 1;/);
  });

  it("never writes, installs, kills or restarts", () => {
    for (const forbidden of [
      "writeFileSync",
      "mkdirSync",
      "unlinkSync",
      "ensureSqliteRuntime",
      "npmInstall",
      "killPid",
      "spawnSync",
      "exec(",
    ]) {
      expect(doctorSrc.includes(forbidden), `doctor.js must not contain ${forbidden}`).toBe(false);
    }
  });
});
