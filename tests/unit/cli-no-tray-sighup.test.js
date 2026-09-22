/**
 * §5.1 / §5.2 / §5.3 of docs/zh-CN/impl-plan-issue24-25-agent.md.
 *
 * `cli/cli.js` is a launcher script, not a module: importing it starts a server.
 * It is also NOT safe to spawn here — the script calls ensureSqliteRuntime() at
 * module scope, so on any machine without a warmed ~/.10router/runtime (CI) it
 * shells out to `npm install sql.js better-sqlite3`, each with a 180s timeout and
 * a native build for the latter. Rendering the dictionary straight from
 * cli/src/cli/i18n tests the same strings without any of that, and the launcher's
 * argv handling is pinned against the source below instead.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const CLI = fileURLToPath(new URL("../../cli/cli.js", import.meta.url));
const LANGS = ["en", "zh-CN", "zh-TW"];

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(abs(rel), "utf8"));
const coreJson = (lang) => readJson(`cli/src/cli/i18n/locales/${lang}/core.json`);

const originalLang = process.env.TENROUTER_LANG;
afterAll(() => {
  if (originalLang === undefined) delete process.env.TENROUTER_LANG;
  else process.env.TENROUTER_LANG = originalLang;
});

/** The launcher's i18n binds its locale at require time, so reload it per language. */
function loadI18n(lang) {
  process.env.TENROUTER_LANG = lang;
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, "/").includes("/cli/src/cli/i18n/")) delete require.cache[key];
  }
  return require("../../cli/src/cli/i18n");
}

describe("CLI --help advertises --no-tray", () => {
  it("renders it in all three locales", () => {
    for (const lang of LANGS) {
      const { t, locale } = loadI18n(lang);
      expect(locale, lang).toBe(lang);
      const help = t("help.text", { bin: "10router", port: 20128, host: "0.0.0.0" });
      expect(help.length, lang).toBeGreaterThan(100);
      expect(help, lang).toContain("--no-tray");
      expect(help, lang).toContain("--tray");
      expect(help, lang).toContain("--skip-update");
    }
  });

  it("uses the localised wording", () => {
    expect(loadI18n("en").t("help.text")).toContain("Don't create a tray icon");
    expect(loadI18n("zh-CN").t("help.text")).toContain("不创建托盘图标");
    expect(loadI18n("zh-TW").t("help.text")).toContain("不建立托盤圖示");
  });
});

describe("CLI tray locale strings", () => {
  it("has the honest tray messages in every dictionary", () => {
    for (const lang of LANGS) {
      const dict = coreJson(lang);
      for (const key of ["launcher.trayUnavailable", "launcher.traySkipped"]) {
        expect(typeof dict[key], `${lang}:${key}`).toBe("string");
        expect(dict[key].length, `${lang}:${key}`).toBeGreaterThan(0);
      }
      // the warn site interpolates the real error message
      expect(dict["launcher.trayUnavailable"], lang).toContain("{error}");
    }
  });
});

describe("CLI launcher source guards", () => {
  const src = readFileSync(CLI, "utf8");

  it("parses --no-tray into a flag", () => {
    expect(src).toMatch(/args\[i\] === "--no-tray"[\s\S]{0,80}noTray = true/);
  });

  it("skips tray init when --no-tray was given", () => {
    expect(src).toMatch(/const initTrayIcon = \(\) => \{[\s\S]{0,400}if \(noTray\) return false;/);
  });

  it("reports a tray failure instead of swallowing it", () => {
    expect(src).toContain('t("launcher.trayUnavailable"');
    expect(src).not.toContain("// Tray not available - continue without it");
  });

  it("does not claim the tray is ready when no icon was created", () => {
    expect(src).toMatch(/if \(initTrayIcon\(\)\) \{[\s\S]{0,200}t\("launcher.trayReady"\)/);
  });

  it("ignores SIGHUP when there is no TTY (nohup / systemd)", () => {
    expect(src).toContain("const ignoreSighup = !process.stdout.isTTY;");
    expect(src).toMatch(/if \(ignoreSighup\) return;/);
    // and keeps the original shut-down path for an attached terminal
    expect(src).toContain('t("launcher.exiting")');
  });

  it("keeps tray mode's own SIGHUP exemption", () => {
    expect(src).toContain('process.removeAllListeners("SIGHUP")');
  });
});

describe("CLI publish metadata & docs", () => {
  it("points npm at the repository, readme and issue tracker", () => {
    const pkg = readJson("cli/package.json");
    expect(pkg.repository).toMatchObject({
      type: "git",
      url: "git+https://github.com/techysy/10router.git",
      directory: "cli",
    });
    expect(pkg.homepage).toContain("github.com/techysy/10router");
    expect(pkg.bugs?.url).toBe("https://github.com/techysy/10router/issues");
  });

  it("documents the headless start in both READMEs", () => {
    for (const rel of ["cli/README.md", "cli/README.zh-CN.md"]) {
      const md = readFileSync(abs(rel), "utf8");
      expect(md, rel).toContain("--no-tray");
      expect(md, rel).toMatch(/nohup/);
      expect(md, rel).toMatch(/systemd/);
    }
  });
});
