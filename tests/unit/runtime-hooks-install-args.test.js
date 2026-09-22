/**
 * §1 regression guard — the two runtime install hooks must never pass
 * `--no-save` to npm.
 *
 * Why this matters: `cli/hooks/sqliteRuntime.js` and `cli/hooks/trayRuntime.js`
 * install into ONE shared npm project (`<dataDir>/runtime`, see
 * `getRuntimeDir()`). A package that exists in node_modules but is missing from
 * `runtime/package.json` is "extraneous", so the next `npm install` run in that
 * directory prunes it. With `--no-save` the two hooks therefore uninstalled each
 * other in a ping-pong (better-sqlite3 ↔ systray2), and neither binary ever
 * survived on Linux/macOS. Saving the install records it as a real dependency,
 * so npm keeps both.
 *
 * Harness note: the plan suggested `vi.mock("child_process")`, but the hooks are
 * CommonJS and vitest loads them through Node's native `require`, so a
 * `vi.mock` factory never intercepts them (verified: the real `spawnSync` ran).
 * Instead we patch `child_process.spawnSync` and drop the hooks from the require
 * cache so their top-level `const { spawnSync } = require("child_process")`
 * destructuring picks up the fake.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const SQLITE_HOOK = "../../cli/hooks/sqliteRuntime.js";
const TRAY_HOOK = "../../cli/hooks/trayRuntime.js";

/** Load both hooks with `child_process.spawnSync` swapped for `fake`. */
function loadHooksWithFakeSpawn(fake) {
  const cp = require("child_process");
  const original = cp.spawnSync;
  cp.spawnSync = fake;
  for (const rel of [SQLITE_HOOK, TRAY_HOOK]) delete require.cache[require.resolve(rel)];
  const sqlite = require(SQLITE_HOOK);
  const tray = require(TRAY_HOOK);
  return { sqlite, tray, restore: () => { cp.spawnSync = original; } };
}

function recordingFake() {
  const calls = [];
  const fake = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: "", stderr: "" };
  };
  return { fake, calls };
}

let dataDir;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "10router-hook-args-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("runtime install hooks — npm args", () => {
  it("sqlite hook: better-sqlite3 install never uses --no-save", () => {
    const { fake, calls } = recordingFake();
    const { sqlite, restore } = loadHooksWithFakeSpawn(fake);
    try {
      sqlite.npmInstall(["better-sqlite3@12.6.2"], { optional: true, silent: true });
      expect(calls).toHaveLength(1);
      const { args } = calls[0];
      expect(args[0]).toBe("install");
      expect(args).toContain("better-sqlite3@12.6.2");
      expect(args).not.toContain("--no-save");
      // the shared baseline flags must survive the edit
      expect(args).toEqual(expect.arrayContaining(["--no-audit", "--no-fund", "--prefer-online"]));
    } finally {
      restore();
    }
  });

  it("sqlite hook: a stale { optional: true } caller no longer flips into --no-save", () => {
    const { fake, calls } = recordingFake();
    const { sqlite, restore } = loadHooksWithFakeSpawn(fake);
    try {
      // The removed `optional` option was the only source of --no-save. Even if
      // some caller still passes it, the args must stay clean (defensive).
      sqlite.npmInstall(["better-sqlite3@12.6.2"], { optional: true, silent: true });
      expect(calls[0].args).not.toContain("--no-save");
    } finally {
      restore();
    }
  });

  it("tray hook: systray2 install never uses --no-save", () => {
    const { fake, calls } = recordingFake();
    const { tray, restore } = loadHooksWithFakeSpawn(fake);
    try {
      tray.npmInstall(["systray2"], { silent: true });
      expect(calls).toHaveLength(1);
      const { args } = calls[0];
      expect(args[0]).toBe("install");
      expect(args).toContain("systray2");
      expect(args).not.toContain("--no-save");
      expect(args).toEqual(expect.arrayContaining(["--no-audit", "--no-fund", "--prefer-online"]));
    } finally {
      restore();
    }
  });

  it("both hooks install into the SAME runtime project (the premise of the bug)", () => {
    const { fake, calls } = recordingFake();
    const { sqlite, tray, restore } = loadHooksWithFakeSpawn(fake);
    try {
      sqlite.npmInstall(["better-sqlite3@12.6.2"], { silent: true });
      tray.npmInstall(["systray2"], { silent: true });
      expect(calls).toHaveLength(2);
      expect(calls[0].opts.cwd).toBe(path.join(dataDir, "runtime"));
      expect(calls[1].opts.cwd).toBe(calls[0].opts.cwd);
    } finally {
      restore();
    }
  });

  it("win32 keeps shell: true; POSIX uses shell: false", () => {
    const { fake, calls } = recordingFake();
    const { sqlite, restore } = loadHooksWithFakeSpawn(fake);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      // Both branches are asserted explicitly: the host platform must not decide
      // what this test checks, or it only ever passes on the machine it was
      // written on (the first CI run on ubuntu failed exactly here).
      // runNpmInstall() reads process.platform at call time, so this works.
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      sqlite.npmInstall(["better-sqlite3@12.6.2"], { silent: true });
      expect(calls[0].opts.shell).toBe(true);
      expect(calls[0].cmd).toBe("npm.cmd");

      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      sqlite.npmInstall(["better-sqlite3@12.6.2"], { silent: true });
      expect(calls[1].opts.shell).toBe(false);
      expect(calls[1].cmd).toBe("npm");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      restore();
    }
  });

  it("static: neither hook source contains a --no-save flag", () => {
    for (const rel of [SQLITE_HOOK, TRAY_HOOK]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src).not.toContain("--no-save");
      expect(src).not.toMatch(/no-save/);
    }
  });
});
