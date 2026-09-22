// Issue #9, items 7, 8 and 11 — the leftovers from the audit's list.
//
//   7.  MITM: the stored sudo password was encrypted with a key that fell back to
//       a constant baked into this repository.
//   8.  The session cookie lived 24h (a leaked token stayed usable all day).
//   11. /api/version and /api/init were world-readable, so any remote caller
//       could fingerprint the build without authenticating.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// fileURLToPath (not url.pathname) — the repo path contains a space, which
// pathname would hand back percent-encoded.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("issue #9 item 6 — updater status server is not readable by web pages", () => {
  const updater = read("src/lib/updater/updater.js");

  it("no longer answers with a wildcard CORS header", () => {
    // The comment explains what was removed, so check executable text only.
    const code = updater
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");
    expect(code).not.toContain("Access-Control-Allow-Origin");
    expect(code).not.toContain('setHeader("Access-Control"');
  });

  it("still binds loopback and still serves the status for a human/curl", () => {
    expect(updater).toContain('server.listen(port, "127.0.0.1"');
    expect(updater).toContain('"/update/status"');
  });

  it("nothing in the app polls the old endpoint any more (why dropping it is safe)", () => {
    const files = ["src/shared/components/Sidebar.js", "src/lib/appUpdater.js", "src/app/api/version/route.js"];
    for (const f of files) expect(read(f)).not.toMatch(/https?:\/\/127\.0\.0\.1:20129|:20129\/update/);
  });
});

describe("issue #9 item 7 — Root CA key is owner-only on Windows too", () => {
  const rootCA = read("src/mitm/cert/rootCA.js");

  it("no longer returns early on win32", () => {
    const fn = /function hardenKeyPermissions\(\) \{[\s\S]*?\n\}/.exec(rootCA);
    expect(fn, "hardenKeyPermissions disappeared").toBeTruthy();
    expect(fn[0]).not.toMatch(/if \(process\.platform === "win32"\) return;/);
  });

  it("uses icacls with inheritance removed and a single account grant", () => {
    const fn = /function hardenKeyPermissions\(\) \{[\s\S]*?\n\}/.exec(rootCA)[0];
    expect(fn).toContain('process.platform === "win32"');
    expect(fn).toContain("icacls");
    expect(fn).toContain("/inheritance:r");
    expect(fn).toContain("/grant:r");
    // (F), not (R,W): the owner must still be able to unlink its own key when the
    // CA expires, and (R,W) omits DELETE.
    expect(fn).toContain(":(F)`");
    expect(fn).toMatch(/USERDOMAIN|userInfo\(\)\.username/);
  });

  it("keeps the POSIX path and stays best-effort on both", () => {
    const fn = /function hardenKeyPermissions\(\) \{[\s\S]*?\n\}/.exec(rootCA)[0];
    expect(fn).toContain("chmodSync(ROOT_CA_KEY_PATH, 0o600)");
    // Two warning paths (win32 + posix) — neither throws.
    expect((fn.match(/console\.warn/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(fn).not.toMatch(/throw /);
  });

  it("runs for existing and freshly generated keys alike", () => {
    const calls = (rootCA.match(/hardenKeyPermissions\(\);/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("issue #9 item 7 — MITM password key has no constant fallback", () => {
  const manager = read("src/mitm/manager.js");

  it("derives the key only from the machine id", () => {
    expect(manager).toContain("function deriveKey()");
    // The old shape: catch → hash the salt alone.
    expect(manager).not.toMatch(/catch\s*\{\s*return crypto\.createHash\("sha256"\)\.update\(ENCRYPT_SALT\)\.digest\(\);/);
  });

  it("refuses when the machine id is unavailable instead of weakening", () => {
    const fn = /function deriveKey\(\) \{[\s\S]*?\n\}/.exec(manager);
    expect(fn, "deriveKey disappeared").toBeTruthy();
    expect(fn[0]).toContain("throw new Error");
    expect(fn[0]).toContain("machineIdSync()");
  });

  it("keeps the failure contained — storing is best-effort, reading is guarded", () => {
    expect(manager).toMatch(/function saveMitmSettings[\s\S]*?catch/);
    expect(manager).toMatch(/function loadEncryptedPassword[\s\S]*?catch/);
  });
});

describe("issue #9 item 8 — short session that slides while you work", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-"));
    process.env.DATA_DIR = tempDir;
    process.env.JWT_SECRET = "test-secret-for-sliding-session";
    vi.resetModules();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    delete process.env.JWT_SECRET;
  });

  it("issues a 2h token whose cookie maxAge agrees", async () => {
    const session = await import("@/lib/auth/dashboardSession.js");
    const { decodeJwt } = await import("jose");
    const token = await session.createDashboardAuthToken({});
    const payload = decodeJwt(token);
    expect(payload.exp - payload.iat).toBe(2 * 60 * 60);

    const calls = [];
    await session.setDashboardAuthCookie({ set: (...a) => calls.push(a) }, null, {});
    // set(name, value, options)
    expect(calls[0][2].maxAge).toBe(2 * 60 * 60);
  });

  it("does not renew a fresh token", async () => {
    const session = await import("@/lib/auth/dashboardSession.js");
    const calls = [];
    const renewed = await session.renewDashboardAuthCookie(
      { set: (...a) => calls.push(a) },
      null,
      { iat: Math.floor(Date.now() / 1000) },
    );
    expect(renewed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("renews once the token is past half its life, keeping the identity claims", async () => {
    const session = await import("@/lib/auth/dashboardSession.js");
    const calls = [];
    const iat = Math.floor(Date.now() / 1000) - (2 * 60 * 60) / 2 - 60;
    const renewed = await session.renewDashboardAuthCookie(
      { set: (...a) => calls.push(a) },
      null,
      { iat, oidcName: "Someone", oidc: true },
    );
    expect(renewed).toBe(true);
    expect(calls).toHaveLength(1);
    const { decodeJwt } = await import("jose");
    const payload = decodeJwt(calls[0][1]);
    expect(payload.oidcName).toBe("Someone");
    expect(payload.oidc).toBe(true);
  });

  it("is wired into /api/auth/status, which the dashboard calls on every navigation", () => {
    const route = read("src/app/api/auth/status/route.js");
    expect(route).toContain("renewDashboardAuthCookie");
    // Header.js is the caller that makes the sliding window work.
    expect(read("src/shared/components/Header.js")).toContain("/api/auth/status");
  });
});

describe("issue #9 item 11 — version/init are no longer open to the network", () => {
  const guard = read("src/dashboardGuard.js");

  it("removed them from the public list", () => {
    const publicList = /const PUBLIC_API_PATHS = \[[\s\S]*?\];/.exec(guard);
    expect(publicList, "PUBLIC_API_PATHS disappeared").toBeTruthy();
    expect(publicList[0]).not.toContain('"/api/version"');
    expect(publicList[0]).not.toContain('"/api/init"');
  });

  it("keeps local callers (CLI, tray, same-machine dashboard) working", () => {
    const localList = /const LOCAL_OR_AUTH_API_PATHS = \[[\s\S]*?\];/.exec(guard);
    expect(localList, "LOCAL_OR_AUTH_API_PATHS disappeared").toBeTruthy();
    expect(localList[0]).toContain('"/api/version"');
    expect(localList[0]).toContain('"/api/init"');

    const gate = /LOCAL_OR_AUTH_API_PATHS\.some[\s\S]*?\n  \}/.exec(guard);
    expect(gate, "the local-or-auth gate disappeared").toBeTruthy();
    expect(gate[0]).toContain("isLocalRequest(request)");
    expect(gate[0]).toContain("hasValidCliToken(request)");
    expect(gate[0]).toContain("isAuthenticated(request)");
  });

  it("still requires a token for shutdown/update (they match the same prefix)", () => {
    const always = /const ALWAYS_PROTECTED = \[[\s\S]*?\];/.exec(guard);
    expect(always[0]).toContain("/api/version/shutdown");
    expect(always[0]).toContain("/api/version/update");
    // …and the always-protected block is evaluated first.
    expect(guard.indexOf("ALWAYS_PROTECTED.some")).toBeLessThan(guard.indexOf("LOCAL_OR_AUTH_API_PATHS.some"));
  });
});
