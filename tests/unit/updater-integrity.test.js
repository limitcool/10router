// Issue #9, item 6 — the update chain must install exactly one thing: our
// package, at the version the dashboard told the user about.
//
// Before this, the detached updater ran `npm i -g <pkg> --prefer-online` where
// `<pkg>` came straight from an environment variable, and the version was
// whatever `latest` resolved to at install time. Two consequences worth a test
// each: one env var could redirect the install to any npm package, and a
// successful install was reported as success without ever asking what landed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const updater = read("src/lib/updater/updater.js");
const spawner = read("src/lib/appUpdater.js");
const route = read("src/app/api/version/update/route.js");
const config = read("src/shared/constants/config.js");

describe("selector: the package name cannot be redirected", () => {
  it("the updater has one hardcoded package and refuses anything else", () => {
    expect(updater).toContain('const EXPECTED_PACKAGE = "@techysy/10router"');
    // A mismatch is a refusal, not a log line.
    expect(updater).toMatch(/packageNameMismatch\s*=/);
    expect(updater).toContain("refusing to update: unexpected package name");
  });

  it("the spawner always passes the config's package, not a parameter", () => {
    expect(spawner).toContain("UPDATER_PKG_NAME: UPDATER_CONFIG.npmPackageName");
    // The old signature accepted a package name from the caller.
    expect(spawner).not.toMatch(/spawnUpdaterAndExit\(\s*packageName\s*=/);
    expect(spawner).toMatch(/export function spawnUpdaterAndExit\(targetVersion\)/);
  });

  it("config and updater agree on the scoped name", () => {
    expect(config).toContain('npmPackageName: "@techysy/10router"');
    expect(updater).toContain('"@techysy/10router"');
    expect(updater).not.toMatch(/UPDATER_PKG_NAME \|\| "10router"/);
  });
});

describe("version: pinned, required, and verified after install", () => {
  it("refuses to run without a valid target version", () => {
    expect(updater).toContain("UPDATER_TARGET_VERSION");
    expect(updater).toContain("refusing to update: no valid target version was provided");
    expect(updater).toMatch(/targetVersionValid = \/\^\\d\+\\\.\\d\+\\\.\\d\+/);
  });

  it("refuses pre-releases unless explicitly allowed", () => {
    expect(updater).toContain("UPDATER_ALLOW_PRERELEASE");
    expect(updater).toContain("refusing to update: ");
    expect(updater).toMatch(/is not a release version/);
  });

  it("installs the pinned spec, not the floating package", () => {
    expect(updater).toContain("const installSpec = `${packageName}@${targetVersion}`");
    expect(updater).toContain('const args = ["i", "-g", installSpec, "--prefer-online"]');
    expect(updater).not.toMatch(/const args = \["i", "-g", packageName,/);
  });

  it("verifies what actually landed before reporting success", () => {
    expect(updater).toContain("function readInstalledVersion()");
    expect(updater).toContain('["ls", "-g", packageName, "--json", "--depth=0"]');
    expect(updater).toMatch(/if \(installed && installed !== targetVersion\)/);
    expect(updater).toContain("installed ${installed}, expected ${targetVersion}");
  });

  it("a refusal is a terminal, visible state — never a silent no-op", () => {
    expect(updater).toMatch(/if \(refusal\) \{[\s\S]*?state\.phase = "refused"[\s\S]*?state\.error = refusal/);
    expect(updater).toContain("state.success = false");
  });

  it("surfaces the pinned version in the status payload", () => {
    expect(updater).toContain("targetVersion: targetVersionValid ? targetVersion : null");
  });
});

describe("trigger: the route resolves the version itself", () => {
  it("fetches the published version server-side", () => {
    expect(route).toContain("fetchLatestPublishedVersion");
    expect(route).toContain("registry.npmjs.org");
    expect(route).toContain("UPDATER_CONFIG.npmPackageName");
  });

  it("refuses when the version cannot be resolved", () => {
    expect(route).toMatch(/if \(!targetVersion\) \{/);
    expect(route).toContain("Could not resolve the latest version");
    // …and does not spawn in that case (spawn happens after the guard).
    expect(route.indexOf("if (!targetVersion)")).toBeLessThan(route.indexOf("spawnUpdaterAndExit(targetVersion)"));
  });

  it("never takes the version from the request body", () => {
    expect(route).not.toMatch(/request\.json\(\)|nextUrl\.searchParams|await request\./);
  });

  it("tells the user which version is being installed", () => {
    expect(route).toContain("Updater started for ${targetVersion}");
  });
});
