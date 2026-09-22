/**
 * StepFun image generation is delisted.
 *
 * Upstream retires every image endpoint on 2026-10-10 and `step-1x-edit` already
 * refuses calls (docs/zh/guides/image-offline-notice); in practice the service was
 * already answering 503 days before that date, and the StepFun cards still sat at
 * the top of 【媒体提供商 -> 文本转图像】 because those accounts are connected for
 * LLM/TTS. So the channels stop advertising image at all: no `kind:"image"` model,
 * no `imageConfig`, no `"image"` in serviceKinds, and no adapter entry.
 *
 * Pinned because the four channels share a registry shape: dropping the bits from
 * one and forgetting another — or re-adding a model to a copy-pasted entry — puts a
 * dead provider back on the image page with nothing failing to tell you.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const ROOT = abs("");
const read = (rel) => readFileSync(abs(rel), "utf8");

/** Drop // and block comments — the registry headers deliberately name the
 *  retired models in their delisting notes, so only code counts here. */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CHANNELS = ["stepfun", "stepfun-plan", "stepfun-cn", "stepfun-plan-cn"];
const entryOf = (id) => REGISTRY.find((r) => r.id === id);

/** Every .js file under the given runtime dirs (no node_modules). */
function jsFilesUnder(dirs) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js")) out.push(full);
    }
  };
  for (const d of dirs) walk(abs(d));
  return out;
}

describe("StepFun image generation is delisted", () => {
  it("keeps the four channels registered — only image goes away", () => {
    for (const id of CHANNELS) expect(entryOf(id), id).toBeTruthy();
  });

  it("exposes no kind:'image' model on any channel", () => {
    for (const id of CHANNELS) {
      const imageModels = (entryOf(id).models || []).filter((m) => m.kind === "image");
      expect(imageModels, `${id} still lists ${imageModels.map((m) => m.id)}`).toEqual([]);
    }
  });

  it("drops 'image' from serviceKinds and the imageConfig block", () => {
    for (const id of CHANNELS) {
      expect(entryOf(id).serviceKinds || [], id).not.toContain("image");
      expect(entryOf(id).imageConfig, id).toBeUndefined();
      // …and in the built view the rest of the app actually reads.
      expect(PROVIDER_MEDIA[id]?.imageConfig, id).toBeUndefined();
      expect(PROVIDER_MEDIA[id]?.serviceKinds || [], id).not.toContain("image");
    }
  });

  it("drops the image adapter entries", () => {
    const src = read("open-sse/handlers/imageProviders/index.js");
    const start = src.indexOf("const ADAPTERS");
    const block = src.slice(start, start + 4000);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("createOpenAIAdapter"); // the map itself is still there
    for (const key of ["stepfun", "stepfun-cn", "stepfun-plan", "stepfun-plan-cn", "step", "step-cn", "stepp", "stepp-cn"]) {
      expect(block).not.toMatch(new RegExp(`(^|\\n)\\s*"?${key}"?:\\s*createOpenAIAdapter`));
    }
  });

  it("leaves the two retired model ids out of all runtime code", () => {
    const hits = jsFilesUnder(["src", "open-sse"])
      .filter((f) => /step-image-edit-2|step-2x-large/.test(codeOnly(readFileSync(f, "utf8"))))
      .map((f) => f.slice(ROOT.length));
    expect(hits, `still referenced in ${hits.join(", ")}`).toEqual([]);
  });

  it("delists only StepFun — the other image providers survive", () => {
    const withImage = REGISTRY.filter((r) => (r.serviceKinds || []).includes("image")).map((r) => r.id);
    for (const id of CHANNELS) expect(withImage, id).not.toContain(id);
    expect(withImage.length).toBeGreaterThan(3);
    expect(withImage).toContain("gemini");
  });
});
