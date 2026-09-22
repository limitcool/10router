/**
 * §3 — stale-build self-heal (cli/src/cli/staleServer.js).
 *
 * The launcher must stop a server left behind by a PREVIOUS build (an upgrade
 * replaces the package dir under a detached server, which then serves chunk
 * hashes that no longer exist → blank dashboard), but only when it can prove the
 * port really is an older build of ours. These cases pin that narrowness: no
 * response / same version / no version ⇒ never kill.
 *
 * Everything is injected (fetch, kill, taskkill) so no process is ever touched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const stale = require("../../cli/src/cli/staleServer.js");

let dataDir;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "10router-stale-"));
});
afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** fetch stub for probeServerVersion: answers /api/version with `version`. */
function fetchAnswering(version) {
  return async () => ({ ok: true, json: async () => ({ currentVersion: version }) });
}
function fetchRefusing() {
  return async () => { throw new Error("ECONNREFUSED"); };
}

describe("isVersionMismatch", () => {
  it("detects an older or different build", () => {
    expect(stale.isVersionMismatch("1.1.1", "1.1.2")).toBe(true);
    expect(stale.isVersionMismatch("1.1.2", "1.1.1")).toBe(true);
  });

  it("treats a test build as different (inequality, never ordering)", () => {
    expect(stale.isVersionMismatch("1.1.2", "1.1.2-test.3")).toBe(true);
    expect(stale.isVersionMismatch("1.1.2-test.3", "1.1.2")).toBe(true);
  });

  it("does not flag the same build", () => {
    expect(stale.isVersionMismatch("1.1.2", "1.1.2")).toBe(false);
    expect(stale.isVersionMismatch("1.1.2-test.3", "1.1.2-test.3")).toBe(false);
  });

  it("never flags when either side is missing", () => {
    expect(stale.isVersionMismatch(null, "1.1.2")).toBe(false);
    expect(stale.isVersionMismatch("1.1.2", null)).toBe(false);
    expect(stale.isVersionMismatch(undefined, undefined)).toBe(false);
  });
});

describe("probeServerVersion", () => {
  it("reports unreachable when nothing is listening", async () => {
    const r = await stale.probeServerVersion(20128, { fetchImpl: fetchRefusing() });
    expect(r).toEqual({ reachable: false, version: null });
  });

  it("reports reachable + version when our server answers", async () => {
    const r = await stale.probeServerVersion(20128, { fetchImpl: fetchAnswering("1.1.1") });
    expect(r).toEqual({ reachable: true, version: "1.1.1" });
  });

  it("reports reachable but no version when a foreign service answers", async () => {
    const r = await stale.probeServerVersion(20128, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ hello: "world" }) }),
    });
    expect(r).toEqual({ reachable: true, version: null });
  });

  it("treats a non-2xx as reachable-without-version", async () => {
    const r = await stale.probeServerVersion(20128, {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    expect(r).toEqual({ reachable: true, version: null });
  });
});

describe("healStaleServer", () => {
  it("does nothing (and never kills) when the port is free", async () => {
    const killed = [];
    const r = await stale.healStaleServer({
      port: 20128, version: "1.1.2", dataDir,
      fetchImpl: fetchRefusing(),
      killImpl: (p) => killed.push(p),
    });
    expect(r.action).toBe("none");
    expect(r.reason).toBe("unreachable");
    expect(killed).toEqual([]);
  });

  it("does nothing when the running build is the same version", async () => {
    const killed = [];
    stale.writePidFile(dataDir, process.pid);
    const r = await stale.healStaleServer({
      port: 20128, version: "1.1.2", dataDir,
      fetchImpl: fetchAnswering("1.1.2"),
      killImpl: (p) => killed.push(p),
    });
    expect(r.action).toBe("none");
    expect(r.reason).toBe("same-version");
    expect(killed).toEqual([]);
    // someone else's server is not ours to clean up
    expect(existsSync(stale.pidFilePath(dataDir))).toBe(true);
  });

  it("does nothing when the port answers without a version", async () => {
    const killed = [];
    const r = await stale.healStaleServer({
      port: 20128, version: "1.1.2", dataDir,
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      killImpl: (p) => killed.push(p),
    });
    expect(r.reason).toBe("no-version");
    expect(killed).toEqual([]);
  });

  it("warns (does not kill) when the stale server left no pidfile", async () => {
    const killed = [];
    const r = await stale.healStaleServer({
      port: 20128, version: "1.1.2", dataDir,
      fetchImpl: fetchAnswering("1.1.1"),
      killImpl: (p) => killed.push(p),
    });
    expect(r.action).toBe("warn");
    expect(r.reason).toBe("stale-without-pidfile");
    expect(r.running).toBe("1.1.1");
    expect(killed).toEqual([]);
  });

  it("kills the stale server when a pidfile identifies it, then clears the file", async () => {
    const killed = [];
    stale.writePidFile(dataDir, 4242);
    let calls = 0;
    const r = await stale.healStaleServer({
      port: 20128, version: "1.1.2", dataDir,
      // first probe: stale; after the kill: gone
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: true, json: async () => ({ currentVersion: "1.1.1" }) };
        throw new Error("ECONNREFUSED");
      },
      killImpl: (p) => killed.push(p),
      // Must pin the platform: on this win32 box killPid would otherwise ignore
      // killImpl and run a real `taskkill`.
      platform: "linux",
      releaseTimeoutMs: 200,
    });
    expect(r.action).toBe("killed");
    expect(r.pid).toBe(4242);
    expect(r.running).toBe("1.1.1");
    expect(killed).toEqual([4242]);
    expect(existsSync(stale.pidFilePath(dataDir))).toBe(false);
  });
});

describe("pidfile + disk-version helpers", () => {
  it("round-trips a pid and returns null for a missing/garbage file", () => {
    expect(stale.readPidFile(dataDir)).toBeNull();
    stale.writePidFile(dataDir, 1234);
    expect(stale.readPidFile(dataDir)).toBe(1234);
    stale.removePidFile(dataDir);
    expect(stale.readPidFile(dataDir)).toBeNull();
    require("node:fs").writeFileSync(stale.pidFilePath(dataDir), "not-a-pid");
    expect(stale.readPidFile(dataDir)).toBeNull();
  });

  it("round-trips the on-disk version marker", () => {
    expect(stale.readDiskVersion(dataDir)).toBeNull();
    stale.writeDiskVersion(dataDir, "1.1.2");
    expect(stale.readDiskVersion(dataDir)).toBe("1.1.2");
  });
});

describe("killPid", () => {
  it("uses SIGKILL on POSIX and taskkill on Windows", () => {
    const posix = [];
    stale.killPid(77, { platform: "linux", killImpl: (p) => posix.push(p) });
    expect(posix).toEqual([77]);

    const win = [];
    stale.killPid(88, { platform: "win32", taskkillImpl: (p) => win.push(p) });
    expect(win).toEqual([88]);
  });

  it("swallows a kill failure and reports false-ish for a missing pid", () => {
    expect(stale.killPid(0, { killImpl: () => { throw new Error("nope"); } })).toBe(false);
    expect(stale.killPid(9, { platform: "linux", killImpl: () => { throw new Error("ESRCH"); } })).toBe(false);
  });
});

/**
 * §3.3 — WHO writes the marker, and WHEN. Both gaps below were found live, after
 * the marker itself already worked:
 *
 *   - cli.js stamped it even for `--help` / `--version`, because the write sat
 *     above the argv loop. Running this repo's launcher once (to check a build)
 *     advertised the checkout's version to an *installed* app that shares
 *     %APPDATA%/10router, so the dashboard claimed the on-disk build differed
 *     from the running one when nothing had changed.
 *   - the desktop shell never runs cli.js (it spawns custom-server.js directly),
 *     so on a desktop install nothing ever wrote the marker: the banner could not
 *     fire on exactly the install where a half-applied upgrade is most visible.
 */
describe("disk-version marker wiring", () => {
  const cliSrc = readFileSync(new URL("../../cli/cli.js", import.meta.url), "utf8");
  const shellSrc = readFileSync(new URL("../../desktop/main.js", import.meta.url), "utf8");

  it("writes the marker only after the read-only exits (--help / --version)", () => {
    const writeAt = cliSrc.indexOf("writeDiskVersion(getDataDir(), pkg.version)");
    const parseAt = cliSrc.indexOf("for (let i = 0; i < args.length; i++)");
    const versionExit = cliSrc.indexOf('args[i] === "--version"');
    expect(writeAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(-1);
    expect(versionExit).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(parseAt);
    expect(writeAt).toBeGreaterThan(versionExit);
  });

  it("has the desktop shell write the marker from the bundled build's version", () => {
    expect(shellSrc).toMatch(/function writeDiskVersionMarker\(\)/);
    expect(shellSrc).toMatch(/getServiceVersion\(\)/);
    expect(shellSrc).toMatch(/path\.join\(DATA_DIR, '\.disk-version'\)/);
  });

  it("writes it before the port is judged, so a still-running old server sees the new version", () => {
    // scope to the function body: checkHealth() is also awaited earlier in the file
    const body = shellSrc.slice(shellSrc.indexOf("async function startServer()"));
    const call = body.indexOf("writeDiskVersionMarker();");
    const health = body.indexOf("await checkHealth()");
    expect(call).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(-1);
    expect(call).toBeLessThan(health);
  });
});
