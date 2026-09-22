// Issue #19 — Tavily half: pin the integration end-to-end at the unit level.
//
// The review note (docs/zh-CN/full-review-2026-09-19.md:107) carried Tavily as
// "只差前端接线" (frontend wiring only, SiliconFlow CN already shipped, Rerank
// deferred to 1.2). Auditing the tree shows the wiring is in fact complete on
// both sides, registry-driven:
//   backend  registry/tavily.js (searchConfig + fetchConfig) → search callers
//            (buildTavilyRequest) → normalizers (normalizeTavily) → /v1/search,
//            /v1/web/fetch routes; fetch handler dispatch; /api/providers/validate
//            generic probe
//   frontend constants/providers.js builds AI_PROVIDERS from the registry, so
//            Tavily surfaces automatically through getProvidersByKind() on
//            dashboard/media-providers/web (Web Search + Web Fetch), the main
//            providers page, and the Cowork/MCP default-plugin list.
// This file locks that contract so a future registry edit cannot silently drop
// it (the exact failure mode the stale note describes).
import { describe, it, expect } from "vitest";
import tavily from "open-sse/providers/registry/tavily.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { buildSearchRequest, resolveBaseUrl } from "open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "open-sse/handlers/search/normalizers.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers.js";

const searchCfg = tavily.searchConfig;

function params(overrides = {}) {
  return {
    query: "latest ai news",
    token: "tvly-secret",
    searchType: "web",
    maxResults: 5,
    domainFilter: [],
    providerOptions: undefined,
    providerSpecificData: undefined,
    ...overrides,
  };
}

describe("issue #19: tavily registry contract", () => {
  it("is an apikey provider offering both webSearch and webFetch", () => {
    expect(tavily.category).toBe("apikey");
    expect(tavily.authType).toBe("apikey");
    expect(tavily.serviceKinds).toEqual(expect.arrayContaining(["webSearch", "webFetch"]));
    expect(tavily.hidden).toBeFalsy();
  });

  it("ships both search and fetch configs", () => {
    expect(searchCfg?.baseUrl).toBe("https://api.tavily.com/search");
    expect(tavily.fetchConfig?.baseUrl).toBe("https://api.tavily.com/extract");
    expect(searchCfg.searchTypes).toEqual(expect.arrayContaining(["web", "news"]));
  });

  it("is exported through the registry index", () => {
    expect(REGISTRY.find((p) => p.id === "tavily")).toBeTruthy();
  });
});

describe("issue #19: tavily surfaces on the frontend (registry-driven)", () => {
  it("is present in AI_PROVIDERS with its media config intact", () => {
    const entry = AI_PROVIDERS.tavily;
    expect(entry).toBeTruthy();
    expect(entry.serviceKinds).toEqual(expect.arrayContaining(["webSearch", "webFetch"]));
    // buildProviderEntry copies the media keys the web page relies on.
    expect(entry.searchConfig?.baseUrl).toBe("https://api.tavily.com/search");
    expect(entry.fetchConfig?.baseUrl).toBe("https://api.tavily.com/extract");
  });

  it("is listed by getProvidersByKind for both web kinds", () => {
    expect(getProvidersByKind("webSearch").map((p) => p.id)).toContain("tavily");
    expect(getProvidersByKind("webFetch").map((p) => p.id)).toContain("tavily");
  });
});

describe("issue #19: tavily search request builder", () => {
  it("POSTs Bearer-authed JSON to the configured search endpoint", () => {
    const { url, init } = buildSearchRequest({ id: "tavily", ...searchCfg }, params());
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tvly-secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ query: "latest ai news", max_results: 5, topic: "general" });
  });

  it("maps news search type onto Tavily's topic field", () => {
    const { init } = buildSearchRequest({ id: "tavily", ...searchCfg }, params({ searchType: "news" }));
    expect(JSON.parse(init.body).topic).toBe("news");
  });

  it("translates domain filters and country into Tavily fields", () => {
    const { init } = buildSearchRequest(
      { id: "tavily", ...searchCfg },
      params({ domainFilter: ["arxiv.org", "-reddit.com"], country: "US" })
    );
    const body = JSON.parse(init.body);
    expect(body.include_domains).toEqual(["arxiv.org"]);
    expect(body.exclude_domains).toEqual(["reddit.com"]);
    expect(body.country).toBe("US");
  });

  it("honors a per-connection baseUrl override (SSRF-guarded)", () => {
    const { url } = buildSearchRequest(
      { id: "tavily", ...searchCfg },
      params({ providerSpecificData: { baseUrl: "https://proxy.example.com/tavily" } })
    );
    expect(url).toBe("https://proxy.example.com/tavily");
    expect(resolveBaseUrl(searchCfg, params())).toBe("https://api.tavily.com/search");
  });
});

describe("issue #19: tavily response normalizer", () => {
  const payload = {
    results: [
      {
        title: "AI Weekly",
        url: "https://example.com/ai?utm=1",
        content: "A summary of the week in AI.",
        score: 0.92,
        published_date: "2026-09-18T00:00:00Z",
        raw_content: "# Full text\nbody",
      },
      { title: "Second", url: "https://example.org/x", content: "snippet two", score: 2 },
    ],
  };

  it("maps Tavily results onto the unified SearchResult shape", () => {
    const { results, totalResults } = normalizeSearchResponse("tavily", payload, "ai", "web");
    expect(results).toHaveLength(2);
    expect(totalResults).toBe(2);
    const [first, second] = results;
    expect(first.title).toBe("AI Weekly");
    expect(first.url).toBe("https://example.com/ai?utm=1");
    expect(first.display_url).toBe("example.com/ai");
    expect(first.snippet).toBe("A summary of the week in AI.");
    expect(first.score).toBeCloseTo(0.92);
    expect(first.published_at).toBe("2026-09-18T00:00:00Z");
    expect(first.content).toMatchObject({ format: "text", text: "# Full text\nbody" });
    expect(first.position).toBe(1);
    expect(first.citation.provider).toBe("tavily");
    // score is clamped into [0,1]
    expect(second.score).toBe(1);
    expect(second.content).toBeNull();
  });

  it("degrades gracefully on an unexpected payload", () => {
    expect(normalizeSearchResponse("tavily", { results: null }, "ai", "web")).toEqual({
      results: [],
      totalResults: null,
    });
  });
});
