import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");

// Exact upstream payload from a real Antigravity 429 (5h individual quota exhausted).
const REAL_429_ERROR = `[429]: { "error": { "code": 429, "message": "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h27m36s.", "status": "RESOURCE_EXHAUSTED", "details": [ { "@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "QUOTA_EXHAUSTED", "domain": "cloudcode-pa.googleapis.com", "metadata": { "uiMessage": "true", "model": "gemini-3.8-flash-high", "quotaResetDelay": "1h27m36.139434956s", "quotaResetTimeStamp": "2026-09-15T12:52:06Z" } }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "5256.139434956s" } ] } }`;

describe("Antigravity quota exhausted error i18n", () => {
  const zhCN = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-CN.json"), "utf8"));
  const zhTW = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-TW.json"), "utf8"));

  it("zh-CN dictionary contains the quota reset template and duration units", () => {
    expect(zhCN["Individual quota reached. Resets at {time} (in {duration})."]).toContain("该账号额度已用完");
    expect(zhCN["Subscription quota used up. Please wait for the quota reset."]).toBe("该账号额度已用完，请等待重置。");
    expect(zhCN["{n}d"]).toBe("{n}天");
    expect(zhCN["{n}h"]).toBe("{n}小时");
    expect(zhCN["{n}m"]).toBe("{n}分");
    expect(zhCN["{n}s"]).toBe("{n}秒");
  });

  it("zh-TW dictionary contains the quota reset template and duration units", () => {
    expect(zhTW["Individual quota reached. Resets at {time} (in {duration})."]).toContain("該帳號額度已用完");
    expect(zhTW["Subscription quota used up. Please wait for the quota reset."]).toBe("該帳號額度已用完，請等待重置。");
    expect(zhTW["{n}d"]).toBe("{n}天");
    expect(zhTW["{n}h"]).toBe("{n}小時");
    expect(zhTW["{n}m"]).toBe("{n}分");
    expect(zhTW["{n}s"]).toBe("{n}秒");
  });

  it("the plan-quota reminder is a bare 'wait for reset' with no upsell or clock", () => {
    // The payload carries no reset fields, and the row already renders the package
    // expiry as its own badge — repeating a countdown here would be a second,
    // contradictory clock. (The per-minute Google template keeps its {time} +
    // {duration} + upgrade hint untouched.)
    for (const [dict, wait] of [[zhCN, "请等待重置"], [zhTW, "請等待重置"]]) {
      const msg = dict["Subscription quota used up. Please wait for the quota reset."];
      expect(msg).toContain(wait);
      expect(msg).not.toMatch(/\{|\}/);            // no placeholders left over
      expect(msg).not.toMatch(/升级订阅|升級訂閱/); // nothing to upgrade on a weekly plan
      expect(msg.length).toBeLessThanOrEqual(16);
    }
  });

  it("parseQuotaDurationParts parses Google-style duration strings", async () => {
    const { parseQuotaDurationParts } = await import("@/shared/utils/quotaError.js");
    expect(parseQuotaDurationParts("1h27m36.139434956s")).toEqual({ h: 1, m: 27, s: 36 });
    expect(parseQuotaDurationParts("5256.139434956s")).toEqual({ h: 0, m: 0, s: 5256 });
    expect(parseQuotaDurationParts("2m")).toEqual({ h: 0, m: 2, s: 0 });
    expect(parseQuotaDurationParts("garbage")).toBeNull();
  });

  it("formatQuotaDuration renders localized segments with fallback units", async () => {
    const { formatQuotaDuration, parseQuotaDurationParts } = await import("@/shared/utils/quotaError.js");
    // Empty dictionary in test env -> "{n}h" style fallback ("1h 27m 36s").
    const out = formatQuotaDuration(parseQuotaDurationParts("1h27m36.139434956s"));
    expect(out).toContain("1h");
    expect(out).toContain("27m");
    expect(out).toContain("36s");
    // 5256s rolls up to 1h 27m.
    const rolled = formatQuotaDuration(parseQuotaDurationParts("5256.139434956s"));
    expect(rolled).toContain("1h");
    expect(rolled).toContain("27m");
  });

  it("formatQuotaDuration shows days+hours instead of a bare day count", async () => {
    const { formatQuotaDuration, parseQuotaDurationParts } = await import("@/shared/utils/quotaError.js");
    // "41h" is technically correct and useless: the user wants to see 1d 17h.
    expect(formatQuotaDuration(parseQuotaDurationParts("41h27m36s"))).toBe("1d 17h");
    expect(formatQuotaDuration(parseQuotaDurationParts("41h"))).toBe("1d 17h");
    // Exact multiples of a day stay bare — "2d 0h" is a bug, not precision.
    expect(formatQuotaDuration(parseQuotaDurationParts("48h"))).toBe("2d");
    expect(formatQuotaDuration(parseQuotaDurationParts("72h59m"))).toBe("3d");
    // Just under a day must NOT gain a day component.
    expect(formatQuotaDuration(parseQuotaDurationParts("23h59m59s"))).toBe("23h 59m 59s");
    // Sub-minute waits keep the old seconds rendering.
    expect(formatQuotaDuration(parseQuotaDurationParts("45s"))).toBe("45s");
  });

  it("extractQuotaResetInfo pulls delay and timestamp from the real 429 payload", async () => {
    const { extractQuotaResetInfo } = await import("@/shared/utils/quotaError.js");
    const info = extractQuotaResetInfo(REAL_429_ERROR);
    expect(info.delay).toBe("1h27m36.139434956s");
    expect(info.timestamp).toBe("2026-09-15T12:52:06Z");
  });

  it("translateQuotaError produces a friendly template message for the real 429 payload", async () => {
    const { translateQuotaError } = await import("@/shared/utils/quotaError.js");
    const out = translateQuotaError(REAL_429_ERROR);
    // Dictionary is empty in tests, so the English template is kept with values substituted.
    expect(out).toContain("Resets at");
    expect(out).toMatch(/Resets at .+ \(in 1h 27m 36s\)/);
    expect(out).not.toContain("{time}");
    expect(out).not.toContain("{duration}");
  });

  it("translateQuotaError leaves unrelated errors untouched", async () => {
    const { translateQuotaError } = await import("@/shared/utils/quotaError.js");
    const plain = "Some totally unrelated error";
    expect(translateQuotaError(plain)).toBe(plain);
  });

  it("provider detail page and ConnectionRow route errors through translateQuotaError", () => {
    const pageSrc = readFileSync(resolve(rootDir, "src/app/(dashboard)/dashboard/providers/[id]/page.js"), "utf8");
    expect(pageSrc).toContain("translateQuotaError(error)");
    const rowSrc = readFileSync(resolve(rootDir, "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js"), "utf8");
    expect(rowSrc).toContain("translateQuotaError(connection.lastError)");
  });
});

describe("quota error - truncated legacy payload fallback", () => {
  // NOTE: in the vitest environment translate() has no dictionary loaded, so the
  // template comes back in English. Assert on STRUCTURE (placeholders filled /
  // not left empty), which holds in every locale.
  it("never renders empty placeholders when reset fields were cut off", async () => {
    const { translateQuotaError } = await import("@/shared/utils/quotaError.js");
    const truncated =
      '{"error":{"code":429,"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h27m';
    const msg = translateQuotaError(truncated);
    // No "Resets at  (in  )" shell: both slots must carry a value.
    expect(msg).not.toMatch(/Resets at\s+\(in/);
    expect(msg).not.toMatch(/\(in\s*\)/);
    // The neutral fallbacks fill the slots.
    expect(msg).toMatch(/shortly/);
    // Partial duration still parses from the truncated tail ("Resets in 1h27m").
    expect(msg).toMatch(/1h 27m/);
  });

  it("still extracts real values when the payload is complete", async () => {
    const { translateQuotaError } = await import("@/shared/utils/quotaError.js");
    const full =
      '{"error":{"code":429,"message":"Individual quota reached.","details":[{"quotaResetDelay":"1h27m36.139434956s","quotaResetTimeStamp":"2026-09-15T12:52:06Z"}]}}';
    const msg = translateQuotaError(full);
    expect(msg).toMatch(/1h 27m 36s/);
    expect(msg).not.toMatch(/shortly/);
  });
});

describe("plan-quota errors (MiMo weekly package)", () => {
  // Verbatim from a live 10router connection row: this arrived as raw JSON in the
  // red row text because translateQuotaError only knew the Google shape.
  const MIMO_403 =
    '[403]: {"error":{"message":"本周用量已满，请等待额度重置或升级套餐","type":"permission_error","code":"subscription_quota_exhausted","biz_code":30011}}';

  it("replaces the raw MiMo 403 blob with the wait-for-reset reminder", async () => {
    const { translateQuotaError } = await import("@/shared/utils/quotaError.js");
    const msg = translateQuotaError(MIMO_403);
    expect(msg).toBe("Subscription quota used up. Please wait for the quota reset.");
    // None of the wire noise may survive: that is what overflowed the row.
    expect(msg).not.toMatch(/\[403\]|permission_error|biz_code|subscription_quota_exhausted|\{/);
  });

  it("keeps the Google per-minute countdown on its own branch (no pattern overlap)", async () => {
    const { translateQuotaError } = await import("@/shared/utils/quotaError.js");
    // Google's payload literally carries `"reason":"QUOTA_EXHAUSTED"`; if the plan
    // pattern were loosened to bare `quota_exhausted` it would be captured here
    // instead and lose its reset clock. This asserts the two stay disjoint.
    const google =
      'Quota exceeded for quota metric "Individual requests" with quota id "cloudcode-pa:gemini-pro". (or with a similar model or region) and limit name "generativelanguage.googleapis.com/individual_request_limit_per_day_family_customer" for consumer project "local". Individual quota reached. Please upgrade your subscription to increase your limits. Resets at 2026-09-15T12:52:06Z. [reason: "QUOTA_EXHAUSTED"]';
    const msg = translateQuotaError(google);
    expect(msg).toMatch(/^Individual quota reached\. Resets at /);
    expect(msg).not.toBe("Subscription quota used up. Please wait for the quota reset.");
  });

  it("recognizes the Chinese-only variant that carries no machine code", async () => {
    const { translateQuotaError } = await import("@/shared/utils/quotaError.js");
    expect(translateQuotaError("[403]: 本周用量已满")).toBe("Subscription quota used up. Please wait for the quota reset.");
    // ...and still refuses to swallow an unrelated 403.
    expect(translateQuotaError("[403]: API key not valid")).toBe("[403]: API key not valid");
  });
});
