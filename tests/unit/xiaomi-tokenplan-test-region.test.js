import { describe, it, expect, vi } from "vitest";

describe("xiaomi-tokenplan test endpoint routing", () => {
  it("resolves correct regional base URL for tokenplan", async () => {
    const { resolveXiaomiTokenplanBaseUrl } = await import("../../open-sse/config/providers.js");
    
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: { region: "cn" } }))
      .toBe("https://token-plan-cn.xiaomimimo.com/v1");
      
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: { region: "ams" } }))
      .toBe("https://token-plan-ams.xiaomimimo.com/v1");
      
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: { region: "sgp" } }))
      .toBe("https://token-plan-sgp.xiaomimimo.com/v1");

    // Empty region falls back to the default cluster, which is `cn` (matching
    // MiMo Desktop's own plan preset), not the legacy `sgp` default.
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: {} }))
      .toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });
});
