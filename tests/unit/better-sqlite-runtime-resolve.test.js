/**
 * §4 — resolve better-sqlite3 from the runtime copy, not the global tree.
 *
 * The app ships under <prefix>/lib/node_modules/@techysy/10router/app, and Node
 * resolves bare specifiers by walking UPWARD before consulting NODE_PATH — so a
 * half-built better-sqlite3 anywhere in the global tree shadows the good copy the
 * CLI installs at <dataDir>/runtime/node_modules and the app silently degrades to
 * node:sqlite. loadBetterSqlite() must therefore find the runtime copy by
 * absolute path and only fall back to the bare specifier when it is absent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir;
let stubDir;

function writeRuntimeStub(marker) {
  stubDir = path.join(dataDir, "runtime", "node_modules", "better-sqlite3");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(
    path.join(stubDir, "index.js"),
    `module.exports = function StubDatabase() {};\nmodule.exports.__marker = ${JSON.stringify(marker)};\n`,
  );
}

/** Load driver.js fresh so paths.js computes DATA_DIR from the stubbed env. */
async function loadDriver() {
  vi.resetModules();
  return import("../../src/lib/db/driver.js");
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "10router-dbresolve-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("loadBetterSqlite — runtime copy resolution", () => {
  it("prefers the runtime copy under <dataDir>/runtime/node_modules", async () => {
    writeRuntimeStub("runtime-stub");
    const { loadBetterSqlite } = await loadDriver();
    const Database = await loadBetterSqlite();
    expect(typeof Database).toBe("function");
    expect(Database.__marker).toBe("runtime-stub");
  });

  it("falls back to the bare specifier when the runtime copy is absent", async () => {
    // No stub written: whatever the bare specifier yields (the real addon, or
    // null), it must NOT be the runtime stub.
    const { loadBetterSqlite } = await loadDriver();
    const Database = await loadBetterSqlite();
    expect(Database?.__marker).not.toBe("runtime-stub");
  });

  it("prefers the runtime copy over a sibling copy higher up the data dir", async () => {
    // Node's upward walk from <dataDir>/runtime legitimately reaches
    // <dataDir>/node_modules, so a copy there IS resolvable — the guarantee is
    // ORDER: the runtime copy must win. (The real hazard this guards is a copy
    // somewhere in the global tree, which the runtime path pre-empts.)
    const sibling = path.join(dataDir, "node_modules", "better-sqlite3");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "0.0.0", main: "index.js" }));
    writeFileSync(path.join(sibling, "index.js"), `module.exports = function Sibling() {};\nmodule.exports.__marker = "sibling";\n`);

    writeRuntimeStub("runtime-stub");
    const { loadBetterSqlite } = await loadDriver();
    const Database = await loadBetterSqlite();
    expect(Database?.__marker).toBe("runtime-stub");
  });
});

describe("createBetterSqliteAdapter — injected driver", () => {
  it("uses the injected Database constructor instead of importing its own", async () => {
    writeRuntimeStub("runtime-stub");
    const { loadBetterSqlite } = await loadDriver();
    const Database = await loadBetterSqlite();

    const { createBetterSqliteAdapter } = await import("../../src/lib/db/adapters/betterSqliteAdapter.js");
    // The injected constructor records the file it was opened with.
    const opened = [];
    function RecordingDatabase(file) {
      opened.push(file);
      this.exec = () => {};
      this.pragma = () => {};
      this.prepare = () => ({ run: () => {}, get: () => {}, all: () => {} });
      this.transaction = (fn) => () => fn();
      this.close = () => {};
    }
    const adapter = createBetterSqliteAdapter("/tmp/whatever.sqlite", RecordingDatabase);
    expect(opened).toEqual(["/tmp/whatever.sqlite"]);
    expect(adapter.driver).toBe("better-sqlite3");
    expect(typeof Database).toBe("function");
    adapter.close();
  });
});
