/**
 * The per-model context/max-output editor (issue: "the caps popup is transparent
 * and unusable").
 *
 * The bug was a theme token that does not exist (`bg-background`), which makes
 * Tailwind emit no background at all — the guard for that class of mistake is
 * tests/unit/theme-token-usage.test.js. This file pins the rest of the fix:
 *
 *   - the panel is a portal, so a row's overflow/stacking context cannot clip it
 *     or paint a later row over it;
 *   - `baseCaps` (the un-pinned values) reaches the editor, so it can show what a
 *     pin replaces. `getBaseCaps` is `resolveCaps(…, {})`, which is asserted here
 *     directly;
 *   - every string the panel renders exists in both non-English dictionaries, so
 *     it cannot fall back to printing English at a Chinese user.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveCaps } from "@/shared/hooks/useModelCaps";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel) => readFileSync(abs(rel), "utf8");
const literal = (lang) => JSON.parse(read(`public/i18n/literals/${lang}.json`));

const MODEL_ROW = "src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js";
const PAGE = "src/app/(dashboard)/dashboard/providers/[id]/page.js";

const rowSrc = read(MODEL_ROW);
const pageSrc = read(PAGE);

describe("caps editor — base vs effective caps", () => {
  const byFull = { "stepp-cn/step-3.7-flash": { contextWindow: 256000, maxOutput: 64000, vision: true } };
  const byId = { "step-3.7-flash": { contextWindow: 256000, maxOutput: 64000 } };
  const overrides = { "stepp-cn": { "step-3.7-flash": { contextWindow: 1000, maxOutput: 200 } } };

  it("folds a pin into the effective caps", () => {
    const caps = resolveCaps(byFull, byId, overrides, "stepp-cn/step-3.7-flash");
    expect(caps.contextWindow).toBe(1000);
    expect(caps.maxOutput).toBe(200);
    // untouched fields survive the merge
    expect(caps.vision).toBe(true);
  });

  it("returns the un-pinned values when given no overrides (what getBaseCaps does)", () => {
    const base = resolveCaps(byFull, byId, {}, "stepp-cn/step-3.7-flash");
    expect(base.contextWindow).toBe(256000);
    expect(base.maxOutput).toBe(64000);
  });

  it("falls back to the capability resolver for an unknown model", () => {
    const caps = resolveCaps({}, {}, {}, "stepp-cn/definitely-not-a-model");
    expect(caps).toHaveProperty("contextWindow");
    expect(caps).toHaveProperty("maxOutput");
  });
});

describe("caps editor — wiring", () => {
  it("the panel uses a background token the theme actually defines", () => {
    // Regression: `bg-background` is not a token here, so the panel had NO
    // background and the model rows behind it were legible through it.
    expect(rowSrc).not.toMatch(/className="[^"]*\bbg-background\b/);
    const panel = rowSrc.slice(rowSrc.indexOf('role="dialog"'));
    expect(panel.slice(0, 900)).toContain("bg-surface");
  });

  it("renders through a portal so no row can clip or cover it", () => {
    expect(rowSrc).toContain('import { createPortal } from "react-dom"');
    expect(rowSrc).toContain("createPortal(");
    expect(rowSrc).toContain("document.body");
    // the old inline-popup trap must be gone
    expect(rowSrc).not.toContain("fixed inset-0 z-20");
  });

  it("shows the built-in value and can flip above the button", () => {
    expect(rowSrc).toContain("baseCaps");
    expect(rowSrc).toContain('translate("Built-in")');
    expect(rowSrc).toMatch(/flip = below < h/);
    expect(rowSrc).toContain("window.innerHeight");
  });

  it("validates input and closes on Escape / click-away", () => {
    expect(rowSrc).toMatch(/const badCw = cw\.trim\(\) !== "" && parsedCw === null/);
    expect(rowSrc).toMatch(/disabled=\{!canSave\}/);
    expect(rowSrc).toContain('e.key === "Escape"');
    expect(rowSrc).toContain('document.addEventListener("mousedown"');
  });

  it("the page hands baseCaps to every model row", () => {
    expect(pageSrc).toContain("getBaseCaps");
    const rows = pageSrc.match(/<ModelRow/g) || [];
    const bases = pageSrc.match(/baseCaps=\{getBaseCaps\(/g) || [];
    expect(rows.length).toBeGreaterThan(0);
    expect(bases.length).toBe(rows.length);
  });
});

describe("caps editor — strings exist in both dictionaries", () => {
  const NEW_STRINGS = [
    "Model limits",
    "Overridden",
    "Built-in",
    "Not set",
    "Restore built-in",
    "Enter a whole number greater than 0",
    "Max output is larger than the context window",
  ];

  for (const lang of ["zh-CN", "zh-TW"]) {
    it(`${lang} covers every new string`, () => {
      const dict = literal(lang);
      for (const s of NEW_STRINGS) {
        expect(typeof dict[s], `${lang}: ${s}`).toBe("string");
        expect(dict[s].length, `${lang}: ${s}`).toBeGreaterThan(0);
      }
    });
  }

  it("the editor's translated strings are all present in the source", () => {
    // Scoped to the editor's own body (CapsField + CapsEditor), so unrelated row
    // strings like "Night-free window" cannot drift into this assertion.
    const editor = rowSrc.slice(rowSrc.indexOf("const CAPS_PANEL_W"), rowSrc.indexOf("export default function ModelRow"));
    expect(editor.length).toBeGreaterThan(500);
    const preExisting = new Set(["Context window", "Max output", "Save", "Overrides the built-in catalog values"]);
    const used = [...editor.matchAll(/translate\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(4);
    for (const s of used) {
      expect(NEW_STRINGS.includes(s) || preExisting.has(s), `unexpected caps string: ${s}`).toBe(true);
    }
  });
});
