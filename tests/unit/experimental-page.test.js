/**
 * Settings re-organisation: the auto-compact toggle moved to Token Saver, and the
 * provider-transfer + daily check-in toggles moved to a new /dashboard/experimental
 * page.
 *
 * These are source guards, because the failure mode they prevent is invisible in
 * a browser: a half-move. The component keeps rendering, the switch still flips,
 * and nothing tells you that the page no longer owns the key it PATCHes (so the
 * setting silently stops being saved), or that the same toggle is rendered in two
 * places and they disagree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel) => readFileSync(abs(rel), "utf8");
const literal = (lang) => JSON.parse(read(`public/i18n/literals/${lang}.json`));

const PROFILE = "src/app/(dashboard)/dashboard/profile/page.js";
const TOKEN_SAVER = "src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js";
const EXPERIMENTAL = "src/app/(dashboard)/dashboard/experimental/ExperimentalClient.js";
const SIDEBAR = "src/shared/components/Sidebar.js";
const HEADER = "src/shared/components/Header.js";
const NEW_DESCRIPTION = "Beta toggles for provider transfer and daily credit check-ins";

// The four beta toggles that left Settings, with the settings key each one writes.
const MOVED_TOGGLES = [
  ["OAuth import / export", "codeBuddyOAuthImport"],
  ["Qoder auto daily credit claim", "qoderCheckin"],
  ["CodeBuddy daily active session", "codeBuddyIntlSession"],
  ["CodeBuddy CN auto daily check-in", "codeBuddyCheckin"],
];

describe("settings reorganisation", () => {
  it("ships the experimental page", () => {
    expect(existsSync(abs("src/app/(dashboard)/dashboard/experimental/page.js"))).toBe(true);
    expect(existsSync(abs(EXPERIMENTAL))).toBe(true);
  });

  it("renders every beta toggle on the experimental page and PATCHes its own key", () => {
    const src = read(EXPERIMENTAL);
    for (const [label, key] of MOVED_TOGGLES) {
      expect(src).toContain(`translate("${label}")`);
      // The key has to appear inside a PATCH body, not just as a read.
      expect(src).toMatch(new RegExp(`\\{\\s*${key}:`));
    }
    expect(src).toMatch(/fetch\("\/api\/settings",\s*\{[\s\S]*method:\s*"PATCH"/);
  });

  it("leaves nothing behind in Settings", () => {
    const src = read(PROFILE);
    for (const [label, key] of MOVED_TOGGLES) {
      expect(src).not.toContain(`translate("${label}")`);
      expect(src).not.toContain(key);
    }
    expect(src).not.toContain("Auto-compact oversized context");
    expect(src).not.toContain("autoCompactEnabled");
    expect(src).not.toContain("autoCompactRatio");
  });

  it("keeps the trial-provider toggle in Settings", () => {
    const src = read(PROFILE);
    expect(src).toContain('translate("Show trial providers")');
    expect(src).toContain("showCommunityProviders");
  });

  it("re-homes auto-compact in Token Saver, still defaulting to ON", () => {
    const src = read(TOKEN_SAVER);
    expect(src).toContain('translate("Auto-compact oversized context")');
    expect(src).toContain('translate("Trigger threshold")');
    expect(src).toContain("autoCompactEnabled: value");
    expect(src).toContain("autoCompactRatio: ratio");
    // Default-on: the stored flag is an opt-out, so the read must be `!== false`.
    expect(src).toContain("setAutoCompactEnabled(data.autoCompactEnabled !== false)");
    expect(src).not.toContain("data.autoCompactEnabled === true");
  });

  it("places auto-compact below the Lazy senior dev (Ponytail) row", () => {
    // Requested layout: the bottom "be lazy about it" group — Ponytail, then
    // auto-compact, then the (currently hidden) PXPIPE row.
    const src = read(TOKEN_SAVER);
    const lazy = src.indexOf("Lazy senior dev");
    const autoCompact = src.indexOf('translate("Auto-compact oversized context")');
    const pxpipe = src.indexOf("Compress prompts as images");
    expect(lazy).toBeGreaterThan(-1);
    expect(autoCompact).toBeGreaterThan(lazy);
    expect(pxpipe).toBeGreaterThan(autoCompact);
  });

  it("puts the sidebar entry between Console Log and Settings", () => {
    const src = read(SIDEBAR);
    const consoleLog = src.indexOf("/dashboard/console-log");
    const experimental = src.indexOf("/dashboard/experimental");
    const settings = src.indexOf('href="/dashboard/profile"');
    expect(consoleLog).toBeGreaterThan(-1);
    expect(experimental).toBeGreaterThan(consoleLog);
    expect(settings).toBeGreaterThan(experimental);
  });

  it("gives the new route a header title and description", () => {
    const src = read(HEADER);
    const start = src.indexOf('pathname.includes("/experimental")');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('if (pathname === "/dashboard")'));
    expect(block).toContain('title: "Experimental"');
    expect(block).toContain(NEW_DESCRIPTION);
  });

  it("has both Chinese dictionaries for every string the move introduced", () => {
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = literal(lang);
      expect(dict["Experimental"]).toBeTruthy();
      expect(dict[NEW_DESCRIPTION]).toBeTruthy();
      for (const [label] of MOVED_TOGGLES) expect(dict[label]).toBeTruthy();
      expect(dict["Auto-compact oversized context"]).toBeTruthy();
    }
  });
});
