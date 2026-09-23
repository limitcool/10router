// Unprefixed model routing.
//
// A bare model id such as `gpt-6-astra` carries no provider hint. Left to
// inferProviderFromModelName() the `^gpt-` rule sends it to the built-in
// `openai` provider, which has no credentials, and the request dies with
// "No active credentials for provider: openai" (404). The explicit
// `<prefix>/<model>` form was never affected.
//
// getModelInfo() therefore consults the custom-model registry for a bare id,
// but ONLY accepts an unambiguous owner: if the same id hangs off two nodes we
// cannot know which upstream was meant, and guessing would silently serve the
// wrong provider. These tests pin both halves of that contract.
import { describe, it, expect, vi, beforeEach } from "vitest";

const NODE_A = "openai-compatible-responses-a01fd047-bf20-45fd-95eb-265e67251676";
const NODE_B = "openai-compatible-responses-1353f820-2d33-4e7f-861c-c605f1c4a9dd";

const mocks = vi.hoisted(() => ({
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getComboByName: vi.fn(),
  getProviderNodes: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getComboByName: mocks.getComboByName,
  getProviderNodes: mocks.getProviderNodes,
}));

const { getModelInfo } = await import("@/sse/services/model.js");

const custom = (id, providerAlias, type = "llm") => ({ id, providerAlias, type });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getComboByName.mockResolvedValue(null);
  mocks.getProviderNodes.mockResolvedValue([]);
});

describe("getModelInfo — prefixed form", () => {
  it("routes <prefix>/<model> to the node owning that prefix", async () => {
    mocks.getProviderNodes.mockImplementation(async ({ type }) =>
      type === "openai-compatible"
        ? [{ id: NODE_A, type: "openai-compatible", prefix: "cpa.meetsy.top", apiType: "responses" }]
        : []
    );

    const info = await getModelInfo("cpa.meetsy.top/gpt-6-astra");

    expect(info).toEqual({ provider: NODE_A, model: "gpt-6-astra" });
  });

  it("keeps built-in provider ids working even when a node shares the name", async () => {
    // A user-defined node must not be able to shadow `openai`.
    mocks.getProviderNodes.mockResolvedValue([
      { id: NODE_A, type: "openai-compatible", prefix: "openai", apiType: "chat" },
    ]);

    const info = await getModelInfo("openai/gpt-4o");

    expect(info.provider).toBe("openai");
    expect(info.model).toBe("gpt-4o");
  });
});

describe("getModelInfo — bare id via the custom-model registry", () => {
  it("resolves a registered bare id to its single owning node", async () => {
    mocks.getCustomModels.mockResolvedValue([
      custom("gpt-6-astra", NODE_A),
      custom("gpt-6-sol", NODE_A),
    ]);

    const info = await getModelInfo("gpt-6-astra");

    expect(info).toEqual({ provider: NODE_A, model: "gpt-6-astra" });
  });

  it("resolves image models the same way", async () => {
    mocks.getCustomModels.mockResolvedValue([custom("gpt-image-2", NODE_A)]);

    const info = await getModelInfo("gpt-image-2");

    expect(info).toEqual({ provider: NODE_A, model: "gpt-image-2" });
  });

  it("picks the right node when several nodes each own distinct ids", async () => {
    mocks.getCustomModels.mockResolvedValue([
      custom("gpt-6-astra", NODE_A),
      custom("gpt-5.2", NODE_B),
    ]);

    expect(await getModelInfo("gpt-6-astra")).toEqual({ provider: NODE_A, model: "gpt-6-astra" });
    expect(await getModelInfo("gpt-5.2")).toEqual({ provider: NODE_B, model: "gpt-5.2" });
  });

  it("refuses to guess when the id is registered on two nodes", async () => {
    mocks.getCustomModels.mockResolvedValue([
      custom("shared-model", NODE_A),
      custom("shared-model", NODE_B),
    ]);

    const info = await getModelInfo("shared-model");

    // Falls through to prefix inference rather than silently choosing a node.
    expect(info.provider).not.toBe(NODE_A);
    expect(info.provider).not.toBe(NODE_B);
  });

  it("ignores non-llm registrations so they cannot create a second owner", async () => {
    mocks.getCustomModels.mockResolvedValue([
      custom("gpt-6-sol", NODE_A),
      custom("gpt-6-sol", "custom-embedding-xyz", "embedding"),
    ]);

    expect(await getModelInfo("gpt-6-sol")).toEqual({ provider: NODE_A, model: "gpt-6-sol" });
  });

  it("leaves an unregistered bare id on the previous inference path", async () => {
    mocks.getCustomModels.mockResolvedValue([custom("gpt-6-astra", NODE_A)]);

    // `gpt-4o` is not registered anywhere -> inference still says `openai`.
    expect(await getModelInfo("gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("does not fail the request when the registry read throws", async () => {
    mocks.getCustomModels.mockRejectedValue(new Error("db down"));

    // Must degrade to inference, never propagate.
    expect(await getModelInfo("gpt-6-astra")).toEqual({ provider: "openai", model: "gpt-6-astra" });
  });

  it("still prefers a combo over custom-model resolution", async () => {
    mocks.getComboByName.mockResolvedValue({ name: "gpt-6-astra", models: ["a", "b"] });

    const info = await getModelInfo("gpt-6-astra");

    // provider:null is the combo signal the caller keys off.
    expect(info).toEqual({ provider: null, model: "gpt-6-astra" });
  });
});
