/**
 * Theme-token guard.
 *
 * This fork's palette was rewritten (`--color-bg` / `--color-surface` / …), but
 * class strings copied from the upstream theme were not: `bg-background`,
 * `bg-bg-subtle`, `bg-input`, `text-error`, `text-text-primary` and friends all
 * name tokens that `@theme inline` in globals.css does not define. Tailwind
 * emits NOTHING for an unknown token — no warning, class present in the markup,
 * no rule in the stylesheet.
 *
 * That is not cosmetic: it is how the per-model caps panel ended up with no
 * background at all, so the model rows behind it were legible through the panel
 * and the whole thing looked broken.
 *
 * The check is static on purpose (it resolves the token list from globals.css and
 * the built stylesheet is never needed), so it runs in CI and names the file.
 *
 * Rule: a `bg-*` / `text-*` / `border-*` / … class is only policed when its token
 * *looks like* one of this theme's own tokens (its first segment is a registered
 * token stem, or a known drift name such as `error`/`input`/`base`). Tailwind
 * built-ins (`text-sm`, `bg-red-500`, `border-dashed`, `bg-cover`) and arbitrary
 * values are left alone, which keeps this from flagging half the codebase.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const globalsCss = readFileSync(path.join(REPO, "src/app/globals.css"), "utf8");

const themeStart = globalsCss.indexOf("@theme inline");
const themeBlock = globalsCss.slice(themeStart, globalsCss.indexOf("}", themeStart));
/** Every colour class Tailwind can actually build: `.bg-<token>` etc. */
const TOKENS = new Set([...themeBlock.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]));

/** Hand-written utilities in globals.css (e.g. `.bg-vibrancy`) are valid too. */
const CUSTOM_CLASSES = new Set([...globalsCss.matchAll(/^\.([a-zA-Z][A-Za-z0-9_-]*)/gm)].map((m) => m[1]));

/**
 * First segments that mean "this was meant to be one of our tokens". Derived from
 * the registered tokens so a palette rename keeps the guard honest, plus the
 * upstream names this fork's rewrite left behind.
 */
const STEMS = new Set([
  ...TOKENS,
].map((t) => t.split("-")[0]));
for (const drift of [
  "error",
  "input",
  "base",
  "secondary",
  "tertiary",
  "subtle",
  "hover",
  "background",
  "foreground",
  "primary",
  "accent",
]) {
  STEMS.add(drift);
}

const PREFIXES = ["bg", "text", "border", "fill", "ring", "divide", "outline", "stroke", "placeholder", "decoration"];

/**
 * Real Tailwind utilities that collide with a drift name. `text-base` is the
 * font-size utility, not the upstream `--color-bg-base` token.
 */
const TAILWIND_COLLISIONS = new Set(["text-base"]);

const CLASS_RE = /^(bg|text|border|fill|ring|divide|outline|stroke|placeholder|decoration)-([A-Za-z][A-Za-z0-9-]*)$/;

/** Is this class one Tailwind can actually build? */
function isKnownClass(full) {
  const m = CLASS_RE.exec(full);
  if (!m) return true; // not a colour utility — not our business
  const token = m[2];
  if (TOKENS.has(token) || CUSTOM_CLASSES.has(full) || TAILWIND_COLLISIONS.has(full)) return true;
  // Anything else is fine unless it looks like one of our own tokens. That keeps
  // Tailwind built-ins (text-sm, bg-red-500, border-dashed, bg-cover) out.
  return !STEMS.has(token.split("-")[0]);
}

/**
 * Drop comments but KEEP string bodies — class names live in string literals and
 * template literals, while prose about a class must not be read as a usage.
 */
function stripComments(src) {
  let out = "";
  let mode = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === null) {
      if (c === "/" && next === "/") { mode = "line"; i++; continue; }
      if (c === "/" && next === "*") { mode = "block"; i++; continue; }
      // Store the delimiter itself, not the word "string": the exit test below
      // compares `c === mode`, so a sentinel that is not one character never
      // matches and the scanner would stay "in a string" for the rest of the file.
      if (c === '"' || c === "'" || c === "`") { mode = c; out += c; continue; }
      out += c;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = null; out += c; }
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = null; i++; }
      continue;
    }
    // inside a string literal / template literal
    if (c === "\\") { out += c + (next ?? ""); i++; continue; }
    if (c === mode) mode = null;
    out += c;
  }
  return out;
}

function sourceFiles(dir = path.join(REPO, "src")) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
}

/** Every theme-looking colour class used in src/, with where it is used. */
function findProblems() {
  const problems = [];
  for (const file of sourceFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const prefix of PREFIXES) {
      const re = new RegExp("\\b" + prefix + "-([A-Za-z][A-Za-z0-9-]*)", "g");
      for (const m of code.matchAll(re)) {
        const full = `${prefix}-${m[1]}`;
        if (isKnownClass(full)) continue;
        problems.push(`${full}  (${path.relative(REPO, file).replace(/\\/g, "/")})`);
      }
    }
  }
  return [...new Set(problems)];
}

describe("theme tokens used in src/", () => {
  it("registers the tokens this guard depends on", () => {
    // If the palette moves again, the guard must fail loudly rather than start
    // passing everything by comparing against an empty set.
    expect(TOKENS.size).toBeGreaterThan(20);
    for (const token of ["bg", "surface", "surface-2", "surface-3", "sidebar", "border", "text", "text-muted", "danger", "primary"]) {
      expect(TOKENS.has(token), `--color-${token} must exist`).toBe(true);
    }
    expect(STEMS.has("bg")).toBe(true);
    expect(STEMS.has("error")).toBe(true);
  });

  it("never uses a class whose token the theme does not define", () => {
    const problems = findProblems();
    expect(problems, `unresolvable theme classes:\n${problems.join("\n")}`).toEqual([]);
  });

  it("would have caught the original bug", () => {
    const wouldCatch = (className) => !isKnownClass(className);
    // The exact strings that shipped: a bg utility with no token, and the
    // upstream names that silently did nothing across ~18 files.
    for (const dead of ["bg-background", "bg-bg-base", "bg-bg-subtle", "bg-input", "bg-error", "text-error", "text-text-primary", "bg-surface-secondary"]) {
      expect(wouldCatch(dead), `${dead} should be recognised as dead`).toBe(true);
    }
    // …and must not fire on the replacements, on ordinary Tailwind, or on the
    // hand-written utilities in globals.css.
    for (const good of [
      "bg-surface",
      "bg-bg-alt",
      "bg-surface-2",
      "bg-danger",
      "text-danger",
      "text-text",
      "text-text-subtle",
      "bg-red-500",
      "text-sm",
      "text-base",
      "bg-vibrancy",
      "bg-cover",
      "text-center",
      "border-dashed",
      "placeholder-text-muted",
    ]) {
      expect(wouldCatch(good), `${good} should be accepted`).toBe(false);
    }
  });
});
