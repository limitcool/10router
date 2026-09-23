// Image generation on user-defined openai-compatible nodes.
//
// getImageAdapter() used to be keyed purely by built-in provider id, so a node
// id like `openai-compatible-responses-<uuid>` resolved to null and every image
// request was rejected with
//   "Provider '<node id>' does not support image generation"
// even when the upstream served /v1/images/generations fine.
//
// The adapter reads the node's Base URL from its credentials. It must NOT fall
// back to api.openai.com when the node has no Base URL — that would ship the
// prompt and the node's API key to OpenAI.
import { describe, it, expect } from "vitest";

import { getImageAdapter, isImageProvider } from "open-sse/handlers/imageProviders/index.js";

const NODE = "openai-compatible-responses-a01fd047-bf20-45fd-95eb-265e67251676";
const credsWith = (baseUrl) => ({ apiKey: "sk-test", providerSpecificData: { baseUrl } });

describe("getImageAdapter — built-in providers", () => {
  it("resolves a known provider id", () => {
    expect(getImageAdapter("openai")).toBeTruthy();
    expect(getImageAdapter("gemini")).toBeTruthy();
  });

  it("returns null for an unknown, non-node id", () => {
    expect(getImageAdapter("definitely-not-a-provider")).toBeNull();
    expect(getImageAdapter(undefined)).toBeNull();
  });
});

describe("getImageAdapter — openai-compatible nodes", () => {
  it("resolves a node id instead of returning null", () => {
    expect(getImageAdapter(NODE)).toBeTruthy();
    expect(isImageProvider(NODE)).toBe(true);
  });

  it("builds the images/generations URL from the node Base URL", () => {
    const adapter = getImageAdapter(NODE);
    expect(adapter.buildUrl("gpt-image-2", credsWith("https://cpa.meetsy.top/v1")))
      .toBe("https://cpa.meetsy.top/v1/images/generations");
  });

  it("strips a trailing slash without doubling it", () => {
    const adapter = getImageAdapter(NODE);
    expect(adapter.buildUrl("gpt-image-2", credsWith("https://cpa.meetsy.top/v1/")))
      .toBe("https://cpa.meetsy.top/v1/images/generations");
  });

  it("strips a full pasted endpoint so the segment is not duplicated", () => {
    const adapter = getImageAdapter(NODE);
    expect(adapter.buildUrl("gpt-image-2", credsWith("https://host/v1/images/generations")))
      .toBe("https://host/v1/images/generations");
    expect(adapter.buildUrl("gpt-image-2", credsWith("https://host/v1/images/edits")))
      .toBe("https://host/v1/images/generations");
  });

  it("refuses instead of leaking to api.openai.com when Base URL is missing", () => {
    const adapter = getImageAdapter(NODE);
    expect(() => adapter.buildUrl("gpt-image-2", credsWith(""))).toThrow(/Base URL/i);
    expect(() => adapter.buildUrl("gpt-image-2", {})).toThrow(/Base URL/i);
    expect(() => adapter.buildUrl("gpt-image-2", credsWith("   "))).toThrow(/Base URL/i);
  });

  it("authorizes with the node credentials", () => {
    const adapter = getImageAdapter(NODE);
    const headers = adapter.buildHeaders(credsWith("https://host/v1"));
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("accepts an accessToken in place of apiKey", () => {
    const adapter = getImageAdapter(NODE);
    const headers = adapter.buildHeaders({ accessToken: "tok-123", providerSpecificData: {} });
    expect(headers.Authorization).toBe("Bearer tok-123");
  });
});
