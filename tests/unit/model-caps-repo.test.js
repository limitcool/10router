// modelCaps stores per-model context window / max output overrides keyed by
// the SAME canonical provider name disabled-model rows use, so every provider
// spelling (registry id / alias / uiAlias) resolves to one row, and reads
// publish under all sibling names for direct lookups.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

describe("model caps — per-provider canonical storage", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;
  let repo;
  let REGISTRY;

  // Same divergence shape as the disabled-models suite: id ≠ UI name.
  const MIXED = "xiaomi-mimo";

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-modelcaps-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    repo = await import("@/lib/db/repos/modelCapsRepo.js");
    REGISTRY = (await import("open-sse/providers/registry/index.js")).default;
    await db.initDb();
  });

  afterAll(() => {
    try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  const entry = () => REGISTRY.find((r) => r.id === MIXED);
  const storageName = () => {
    const e = entry();
    return e ? e.uiAlias || e.alias || e.id : MIXED;
  };

  it("stores under the canonical name and reads back through any sibling name", async () => {
    const names = [entry().id, entry().alias, entry().uiAlias].filter(Boolean);
    await repo.setModelCaps(MIXED, "model-a", { contextWindow: 150000, maxOutput: 32000 });
    for (const name of names) {
      const caps = await repo.getModelCapsForProvider(name);
      expect(caps["model-a"]).toEqual({ contextWindow: 150000, maxOutput: 32000 });
    }
    await repo.clearModelCaps(MIXED);
  });

  it("getAllModelCaps publishes each override under every provider name", async () => {
    await repo.setModelCaps(MIXED, "model-b", { contextWindow: 262144 });
    const all = await repo.getAllModelCaps();
    for (const name of [entry().id, entry().alias, entry().uiAlias].filter(Boolean)) {
      expect(all[name]?.["model-b"]).toEqual({ contextWindow: 262144 });
    }
    await repo.clearModelCaps(MIXED);
  });

  it("coerces string numbers and drops invalid ones", async () => {
    const saved = await repo.setModelCaps(MIXED, "model-c", { contextWindow: " 999000 ", maxOutput: -5 });
    expect(saved).toEqual({ contextWindow: 999000 });
    const caps = await repo.getModelCapsForProvider(MIXED);
    expect(caps["model-c"]).toEqual({ contextWindow: 999000 });
    await repo.clearModelCaps(MIXED);
  });

  it("clearing both fields removes the row entirely", async () => {
    await repo.setModelCaps(MIXED, "model-d", { contextWindow: 100, maxOutput: 200 });
    const cleared = await repo.setModelCaps(MIXED, "model-d", { contextWindow: null, maxOutput: "" });
    expect(cleared).toEqual({});
    const caps = await repo.getModelCapsForProvider(MIXED);
    expect(caps["model-d"]).toBeUndefined();
  });

  it("keeps non-registry provider keys (custom node ids) isolated and exact", async () => {
    const nodeId = "openai-compatible-chat-node-42";
    await repo.setModelCaps(nodeId, "gpt-x", { contextWindow: 61000 });
    expect((await repo.getModelCapsForProvider(nodeId))["gpt-x"]).toEqual({ contextWindow: 61000 });
    // Another node must not see it.
    expect(await repo.getModelCapsForProvider("openai-compatible-chat-node-43")).toEqual({});
    await repo.clearModelCaps(nodeId);
    expect(await repo.getModelCapsForProvider(nodeId)).toEqual({});
  });

  it("model ids containing | survive the split (first-pipe keying)", async () => {
    await repo.setModelCaps("someprovider", "a|b", { contextWindow: 700 });
    const caps = await repo.getModelCapsForProvider("someprovider");
    expect(caps["a|b"]).toEqual({ contextWindow: 700 });
    await repo.clearModelCaps("someprovider");
  });
});
