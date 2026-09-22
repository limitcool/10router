// MiMo Token Plan (xiaomi-tokenplan) wiring.
//
// Three things this pins, all from a real report: the card name was a mouthful
// ("Xiaomi MiMo (Token Plan)"), the registry banner had no zh-CN/zh-TW text, and
// adding a `tp-` key produced a row that said
// "Usage API not implemented for xiaomi-tokenplan" — because no usage handler was
// registered, the quota table fell through to the generic not-implemented string.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => fs.readFileSync(path.join(REPO_ROOT, ...parts), "utf8");
const readJson = (...parts) => JSON.parse(read(...parts));

const BANNER =
  "Xiaomi MiMo Token Plan subscription (API key starts with tp-). Token Plan keys are cluster-specific — select the region matching your subscription.";
const NO_QUOTA_MESSAGE =
  "Token Plan does not expose a quota API for standalone keys — check your plan usage in the MiMo console.";

// The account lookup must be mocked (vi.mock is hoisted, so it has to live at the
// module's top level): the real one reads this machine's MiMo Desktop session, so
// an unmocked test asserts something about the *host* — it passed while the
// session was unreadable and failed the moment it became readable. `{}` = no
// session, `{ percent }` = a readable weekly allowance.
const mockAccount = vi.hoisted(() => ({ getMimoAccountUsage: vi.fn(async () => ({})) }));
vi.mock("../../open-sse/shared/mimoAccount.js", () => ({
  getMimoAccountUsage: mockAccount.getMimoAccountUsage,
}));

describe("MiMo Token Plan registry", () => {
  it("uses the short display name", () => {
    const registry = read("open-sse/providers/registry/xiaomi-tokenplan.js");
    expect(registry).toContain('name: "MiMo Token Plan"');
    expect(registry).not.toContain("Xiaomi MiMo (Token Plan)");
  });

  it("ships its own brand icon instead of the generic material glyph", () => {
    // The card falls back to display.icon/textIcon when the asset is missing, so
    // the presence of the file is what makes the logo show up.
    expect(fs.existsSync(path.join(REPO_ROOT, "public/providers/xiaomi-tokenplan.png"))).toBe(true);
  });

  it("leaves the transport untouched (the rename is display-only)", () => {
    const registry = read("open-sse/providers/registry/xiaomi-tokenplan.js");
    expect(registry).toContain("https://token-plan-cn.xiaomimimo.com/v1");
    const baseline = readJson("tests/__baseline__/providers-baseline.json");
    expect(baseline["xiaomi-tokenplan"]).toBeTruthy();
  });
});

describe("MiMo Token Plan banner is translated", () => {
  it("has zh-CN and zh-TW text for the registry notice", () => {
    expect(readJson("public/i18n/literals/zh-CN.json")[BANNER]).toBeTruthy();
    expect(readJson("public/i18n/literals/zh-TW.json")[BANNER]).toBeTruthy();
  });
});

describe("MiMo Token Plan usage row", () => {
  it("is registered, so the row no longer says 'not implemented'", () => {
    const usage = read("open-sse/services/usage.js");
    expect(usage).toContain('"xiaomi-tokenplan"');
    expect(usage).toContain("getXiaomiTokenPlanUsage");
  });

  it("explains the missing quota API in both locales", () => {
    expect(readJson("public/i18n/literals/zh-CN.json")[NO_QUOTA_MESSAGE]).toBeTruthy();
    expect(readJson("public/i18n/literals/zh-TW.json")[NO_QUOTA_MESSAGE]).toBeTruthy();
  });

  // Both branches of the usage row, with the account lookup controlled.
  it("says so honestly when there is no session and no quota to read", async () => {
    mockAccount.getMimoAccountUsage.mockResolvedValue({});
    const { getXiaomiTokenPlanUsage } = await import("../../open-sse/services/usage/xiaomi-mimo.js");
    const result = await getXiaomiTokenPlanUsage("tp-not-a-real-key", { region: "cn" }, null);
    expect(result.message).toBe(NO_QUOTA_MESSAGE);
    expect(result.plan).toBe("MiMo Token Plan");
  });

  it("reports a missing key instead of pretending it has data", async () => {
    mockAccount.getMimoAccountUsage.mockResolvedValue({});
    const { getXiaomiTokenPlanUsage } = await import("../../open-sse/services/usage/xiaomi-mimo.js");
    const result = await getXiaomiTokenPlanUsage("", {}, null);
    expect(result.message).toContain("API key not available");
  });

  it("prefers a real weekly quota when the connection also has a Desktop session", async () => {
    mockAccount.getMimoAccountUsage.mockResolvedValue({ percent: 73, resetAt: 1893456000 });
    const { getXiaomiTokenPlanUsage } = await import("../../open-sse/services/usage/xiaomi-mimo.js");
    const result = await getXiaomiTokenPlanUsage("tp-key", { region: "cn" }, null);
    expect(result.plan).toBe("MiMo Token Plan");
    expect(result.quotas.Weekly.remainingPercentage).toBe(73);
    expect(result.message).toBeUndefined();
  });
});
