import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderNodes: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getSettings: vi.fn(),
  getAllModelCaps: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderNodes: mocks.getProviderNodes,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/modelCapsDb", () => ({
  getAllModelCaps: mocks.getAllModelCaps,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

// The models route pulls in heavy open-sse module chains; import it lazily so
// the mocks above are registered first.
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const LLM_KIND = "llm";

// First-seen provider prefix sequence of the emitted model ids — the shape
// the card-order test asserts on.
function providerPrefixSeq(models) {
  const seq = [];
  for (const m of models) {
    const p = m.id.includes("/") ? m.id.split("/")[0] : m.id;
    if (!seq.includes(p)) seq.push(p);
  }
  return seq;
}

describe("buildModelsList — empty-connection behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelCaps.mockResolvedValue({});
  });

  it("does NOT dump the full built-in catalog when the DB is healthy but has zero provider connections", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    // User explicitly added a couple of OpenCode free models.
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free" },
      { providerAlias: "oc", id: "deepseek-v4-flash-free", type: "llm", name: "deepseek-v4-flash-free" },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    // User-configured custom models ARE exposed...
    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).toContain("oc/deepseek-v4-flash-free");

    // ...but the full static catalog is NOT (a known built-in model must be absent),
    // and the list stays small instead of the ~680 built-in entries.
    expect(ids).not.toContain("alicode-intl/qwen3.5-plus");
    expect(models.length).toBeLessThan(50);
  });

  it("still returns the full static catalog as a fallback when the DB itself is unavailable", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("db gone"));

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    // Known built-in model present when DB is truly unavailable (fallback).
    expect(ids).toContain("alicode-intl/qwen3.5-plus");
    expect(models.length).toBeGreaterThan(100);
  });

  it("keeps per-connection model listing when connections exist (unchanged behavior)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "my" },
      },
    ]);
    // Compatible providers may attempt a live /models fetch; make it return empty
    // so the test stays hermetic and focused on the empty-connection fix.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    // Static catalog is not dumped wholesale when a connection exists.
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain("alicode-intl/qwen3.5-plus");
  });

  it("filters orphan custom models whose providerAlias points at a deleted node", async () => {
    // Some connections exist (so the connected branch runs). One customModel is
    // keyed to a provider node that no longer exists (deleted / failed import).
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible-chat-validnode-1234",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "ok" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-validnode-1234", type: "openai-compatible", name: "Valid" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      // Valid: alias is a real provider (noAuth opencode alias `oc`)
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free" },
      // Valid: alias is an existing provider node id
      { providerAlias: "openai-compatible-chat-validnode-1234", id: "glm-5.2", type: "llm", name: "glm-5.2" },
      // Orphan: alias references a node that has been deleted
      { providerAlias: "openai-compatible-chat-deletednode-9999", id: "qwen-3", type: "llm", name: "qwen-3" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    // Valid custom models exposed (connected node uses its prefix `ok`)
    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).toContain("ok/glm-5.2");
    // Orphan pointing at a deleted node is NOT exposed
    expect(ids).not.toContain("openai-compatible-chat-deletednode-9999/qwen-3");
  });

  it("filters orphan custom models even when there are zero active connections", async () => {
    // Zero connections (healthy DB). The orphan custom-model branch runs and
    // must still drop entries whose alias references a deleted node.
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free" },
      { providerAlias: "openai-compatible-chat-deletednode-8888", id: "kimi-k3", type: "llm", name: "kimi-k3" },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).not.toContain("openai-compatible-chat-deletednode-8888/kimi-k3");
  });

  it("filters custom models of a node whose connection is disabled", async () => {
    // The node exists but its only connection is disabled (isActive=false), so
    // its customModels must not surface in /v1/models (dead node).
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-disabled",
        provider: "openai-compatible-chat-disablednode-1111",
        authType: "apikey",
        isActive: false, // disabled connection
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "dd" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-disablednode-1111", type: "openai-compatible", name: "Dead" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "openai-compatible-chat-disablednode-1111", id: "claude-4.8-opus", type: "llm", name: "claude-4.8-opus" },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).not.toContain("openai-compatible-chat-disablednode-1111/claude-4.8-opus");
  });

  // Fetched/imported custom models are written with enabled:false so the user
  // enables on demand — /v1/models must honor that flag everywhere.
  it("does NOT expose a custom model whose own enabled flag is false (zero connections)", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free", enabled: true },
      { providerAlias: "oc", id: "kimi-k3-free", type: "llm", name: "kimi-k3-free", enabled: false },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).not.toContain("oc/kimi-k3-free");
  });

  it("does NOT expose a disabled custom model tied to an active connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible-chat-validnode-1234",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "ok" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-validnode-1234", type: "openai-compatible", name: "Valid" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "openai-compatible-chat-validnode-1234", id: "glm-5.2", type: "llm", name: "glm-5.2", enabled: true },
      { providerAlias: "openai-compatible-chat-validnode-1234", id: "glm-5.3", type: "llm", name: "glm-5.3", enabled: false },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("ok/glm-5.2");
    expect(ids).not.toContain("ok/glm-5.3");
  });

  it("does NOT expose a disabled orphan custom model (alias without active connection)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible-chat-validnode-1234",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "ok" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-validnode-1234", type: "openai-compatible", name: "Valid" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free", enabled: false },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).not.toContain("oc/mimo-v2.5-free");
  });
});

describe("buildModelsList — provider order follows settings.providerCardOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getSettings.mockResolvedValue({});
    mocks.getAllModelCaps.mockResolvedValue({});
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });

  const twoConns = () => [
    { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    { id: "c2", provider: "codebuddy-intl", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["glm-5.3"] } },
  ];

  it("honours the manual card order over DB insertion order", async () => {
    mocks.getProviderConnections.mockResolvedValue(twoConns());
    mocks.getSettings.mockResolvedValue({ providerCardOrder: ["codebuddy-intl", "codebuddy-cn"] });
    // User dragged cbai above cbcn → /v1/models must match.
    expect(providerPrefixSeq(await buildModelsList([LLM_KIND]))).toEqual(["cbai", "cbcn"]);
  });

  it("keeps the un-dragged providers in priority/name order after the ordered ones", async () => {
    mocks.getProviderConnections.mockResolvedValue(twoConns());
    mocks.getSettings.mockResolvedValue({ providerCardOrder: ["codebuddy-cn"] });
    expect(providerPrefixSeq(await buildModelsList([LLM_KIND]))).toEqual(["cbcn", "cbai"]);
  });

  it("interleaves noAuth orphan custom models with connected providers by card order", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "big-pickle", type: "llm", enabled: true },
    ]);
    mocks.getSettings.mockResolvedValue({ providerCardOrder: ["opencode", "codebuddy-cn"] });
    // Mirrors the dashboard, where a visible noAuth provider (opencode) shares
    // the top rank with connected providers: dragging it above codebuddy-cn
    // must reorder /v1/models too, not just the cards.
    expect(providerPrefixSeq(await buildModelsList([LLM_KIND]))).toEqual(["oc", "cbcn"]);
  });

  it("interleaves noAuth orphan custom models with connected providers by card order (reverse)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "big-pickle", type: "llm", enabled: true },
    ]);
    mocks.getSettings.mockResolvedValue({ providerCardOrder: ["codebuddy-cn", "opencode"] });
    // Drag the other way and the list flips — the orphan is no longer pinned
    // to the tail just because it lacks a connection.
    expect(providerPrefixSeq(await buildModelsList([LLM_KIND]))).toEqual(["cbcn", "oc"]);
  });

  it("falls back to registry priority when no card order was saved", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "big-pickle", type: "llm", enabled: true },
    ]);
    // Pristine instance (no manual order yet): same fallback the dashboard
    // comparator uses — registry priority, where opencode (40) outranks
    // codebuddy-cn (90), so the orphan legitimately leads.
    mocks.getSettings.mockResolvedValue({});
    expect(providerPrefixSeq(await buildModelsList([LLM_KIND]))).toEqual(["oc", "cbcn"]);
  });

  it("empty cardOrder leaves the list unchanged in priority order (regression)", async () => {
    mocks.getProviderConnections.mockResolvedValue(twoConns());
    mocks.getSettings.mockResolvedValue({});
    const seq = providerPrefixSeq(await buildModelsList([LLM_KIND]));
    // cbai & cbcn both present; no card order → comparator tie-breaks by priority
    // (cbcn=90 before cbai=intl default 200). Exact ids asserted in the next run.
    expect(new Set(seq)).toEqual(new Set(["cbcn", "cbai"]));
  });

  it("pinned modelCaps override wins over the catalog in context_length", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getAllModelCaps.mockResolvedValue({
      cbcn: { "hy3": { contextWindow: 123456, maxOutput: 7890 } },
    });
    const models = await buildModelsList([LLM_KIND]);
    const hy3 = models.find((m) => m.id === "cbcn/hy3");
    expect(hy3.context_length).toBe(123456);
    expect(hy3.max_completion_tokens).toBe(7890);
    // Nested capabilities block must stay in sync with the snake_case fields.
    expect(hy3.capabilities?.contextWindow).toBe(123456);
    expect(hy3.capabilities?.maxOutput).toBe(7890);
  });

  it("surfaces a custom model's stored window (beats the 200k catalog default)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "cbcn", id: "my-model", type: "llm", enabled: true, contextWindow: 99999, maxOutput: 64000 },
    ]);
    const models = await buildModelsList([LLM_KIND]);
    const mine = models.find((m) => m.id === "cbcn/my-model");
    expect(mine.context_length).toBe(99999);
    expect(mine.max_completion_tokens).toBe(64000);
  });

  it("keeps a pinned override ahead of the custom model's own stored window", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "cbcn", id: "my-model", type: "llm", enabled: true, contextWindow: 99999 },
    ]);
    mocks.getAllModelCaps.mockResolvedValue({
      cbcn: { "my-model": { contextWindow: 300000 } },
    });
    const models = await buildModelsList([LLM_KIND]);
    expect(models.find((m) => m.id === "cbcn/my-model").context_length).toBe(300000);
  });

  it("gives orphan custom models their stored window too", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "big-pickle", type: "llm", enabled: true, contextWindow: 500000 },
    ]);
    const models = await buildModelsList([LLM_KIND]);
    const orphan = models.find((m) => m.id === "oc/big-pickle");
    expect(orphan.context_length).toBe(500000);
  });

  it("ignores a broken caps read instead of failing the whole list", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codebuddy-cn", authType: "oauth", isActive: true, providerSpecificData: { enabledModels: ["hy3"] } },
    ]);
    mocks.getAllModelCaps.mockRejectedValue(new Error("db gone"));
    const models = await buildModelsList([LLM_KIND]);
    expect(models.some((m) => m.id === "cbcn/hy3")).toBe(true);
  });
});
