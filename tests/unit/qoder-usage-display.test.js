import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatResetTime, parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { extractEarliestPackageExpiry } from "../../open-sse/services/usage/expiryExtractor.js";
import { buildQoderAddOnPacks } from "../../open-sse/services/usage/misc.js";

describe("Qoder usage & sentinel timestamp display", () => {
  it("formatResetTime should return '-' for sentinel dates beyond 2099", () => {
    // Year 9999 sentinel
    const farFuture = "9999-12-31T00:00:00.000Z";
    expect(formatResetTime(farFuture)).toBe("-");

    const year3000 = new Date("3000-01-01T00:00:00.000Z");
    expect(formatResetTime(year3000)).toBe("-");
  });

  it("parseQuotaData should normalize Qoder 0 credits without sentinel expiry", () => {
    const rawQoderUsage = {
      userId: "test-user",
      userType: "personal_standard",
      usageType: "credits",
      totalUsagePercentage: 0.0,
      isQuotaExceeded: true,
      expiresAt: 253402214400000,
      quotas: {
        user: {
          total: 0,
          used: 0,
          remaining: 0,
          unit: "credits",
          resetAt: "9999-12-31T00:00:00.000Z",
          unlimited: false,
        },
      },
    };

    const parsed = parseQuotaData("qoder", rawQoderUsage);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Plan Credits");
    expect(parsed[0].total).toBe(0);
    expect(parsed[0].used).toBe(0);
    expect(parsed[0].resetAt).toBeNull();
    expect(parsed[0].unlimited).toBe(false);
  });

  it("extractEarliestPackageExpiry should ignore sentinel dates beyond 2099", () => {
    const usage = {
      quotas: {
        Personal: {
          total: 100,
          used: 10,
          remaining: 90,
          resetAt: "9999-12-31T00:00:00.000Z",
        },
      },
    };

    const result = extractEarliestPackageExpiry(usage);
    expect(result).toBeNull();
  });
});

describe("Qoder addOn pack breakdown (buildQoderAddOnPacks)", () => {
  const NOW = new Date("2026-09-21T00:00:00.000Z").getTime();
  const fixed = (amount, iso) => ({
    claimStatus: "CLAIMED",
    benefit: { kind: "CREDITS", amount, validity: { mode: "FIXED_END", fixedEnd: iso } },
  });
  // startAt is in SECONDS (as the API returns it)
  const relative = (amount, days, startAt) => ({
    claimStatus: "CLAIMED",
    startAt,
    benefit: { kind: "CREDITS", amount, validity: { mode: "RELATIVE_DAYS", days } },
  });

  it("itemises every listed pack, soonest-expiring first", () => {
    const { packs, resetAt } = buildQoderAddOnPacks({
      campaigns: [relative(100, 30, 1789869600), fixed(500, "2026-09-30T15:59:00Z")],
      used: 1,
      total: 600,
      now: NOW,
    });
    expect(packs.map((p) => p.total)).toEqual([500, 100]);
    expect(packs[0].used).toBe(1); // soonest-expiring pack absorbs the spend
    expect(packs[0].remaining).toBe(499);
    expect(packs[1].used).toBe(0);
    expect(resetAt).toBe("2026-09-30T15:59:00.000Z");
    expect(packs.some((p) => p.unitemized)).toBe(false);
  });

  it("adds an expiry-less remainder pack when the list covers less than the aggregate", () => {
    // The live case this fixes: aggregate total 700, but the campaigns API only
    // lists 500 + 100 — the third gifted pack is not exposed by any device-token
    // endpoint, so the rows used to add up to 600 under a 700 total.
    const { packs } = buildQoderAddOnPacks({
      campaigns: [relative(100, 30, 1789869600), fixed(500, "2026-09-30T15:59:00Z")],
      used: 1,
      total: 700,
      now: NOW,
    });
    expect(packs).toHaveLength(3);
    const last = packs[2];
    expect(last.unitemized).toBe(true);
    expect(last.total).toBe(100);
    expect(last.expiresAt).toBeNull();
    expect(last.used).toBe(0);
    expect(last.remaining).toBe(100);
    // the rows now reconcile with the aggregate row above them
    expect(packs.reduce((sum, p) => sum + p.total, 0)).toBe(700);
    // and the unknown-expiry row must NOT become the "soonest" pack
    expect(packs[0].expiresAt).toBe("2026-09-30T15:59:00.000Z");
  });

  it("does not fabricate a remainder when the packs already cover the aggregate", () => {
    const { packs } = buildQoderAddOnPacks({
      campaigns: [fixed(700, "2026-10-01T00:00:00Z")],
      used: 0,
      total: 700,
      now: NOW,
    });
    expect(packs).toHaveLength(1);
    expect(packs[0].unitemized).toBeUndefined();
  });

  it("stays aggregate-only (no rows) when the campaign list is empty or unusable", () => {
    const { packs, resetAt } = buildQoderAddOnPacks({ campaigns: [], used: 3, total: 700, now: NOW });
    // Nothing is itemised ⇒ do not invent a row that claims the whole aggregate.
    expect(packs).toEqual([]);
    expect(resetAt).toBeNull();
  });

  it("skips non-credit, unclaimed, expired and zero-amount campaigns", () => {
    const { packs } = buildQoderAddOnPacks({
      campaigns: [
        { claimStatus: "CLAIMED", actionType: "VIEW_DETAILS" }, // marketing campaign: no benefit
        { claimStatus: "CLAIMED", benefit: { kind: "TOKENS", amount: 100 } },
        { claimStatus: "AVAILABLE", benefit: { kind: "CREDITS", amount: 100 } },
        fixed(100, "2026-09-01T00:00:00Z"), // already expired vs NOW
        fixed(0, "2026-10-01T00:00:00Z"),
      ],
      used: 0,
      total: 0,
      now: NOW,
    });
    expect(packs).toEqual([]);
  });

  it("lets the remainder absorb spend the listed packs cannot cover", () => {
    const { packs } = buildQoderAddOnPacks({
      campaigns: [fixed(100, "2026-09-30T15:59:00Z")],
      used: 250,
      total: 300,
      now: NOW,
    });
    expect(packs).toHaveLength(2);
    expect(packs[0].used).toBe(100);
    expect(packs[1].unitemized).toBe(true);
    expect(packs[1].total).toBe(200);
    expect(packs[1].used).toBe(150);
    expect(packs[1].remaining).toBe(50);
  });
});

describe("Qoder unpacked-remainder row rendering", () => {
  const rawWithRemainder = {
    quotas: {
      user: { total: 0, used: 0, remaining: 0, unit: "credits", resetAt: null, unlimited: false },
      addOn: {
        total: 700,
        used: 1,
        remaining: 699,
        unit: "credits",
        unlimited: false,
        packs: [
          { total: 500, expiresAt: "2026-09-30T15:59:00.000Z", used: 1, remaining: 499 },
          { total: 100, expiresAt: "2026-10-20T02:00:00.000Z", used: 0, remaining: 100 },
          { total: 100, expiresAt: null, used: 0, remaining: 100, unitemized: true },
        ],
      },
    },
  };

  it("labels the unitemized pack instead of numbering it", () => {
    const parsed = parseQuotaData("qoder", rawWithRemainder);
    expect(parsed.map((q) => q.name)).toEqual([
      "Plan Credits",
      "Resource Package",
      "Bonus Pack 1",
      "Bonus Pack 2",
      "Bonus Pack (unitemized)",
    ]);
    const row = parsed[parsed.length - 1];
    expect(row.total).toBe(100);
    expect(row.resetAt).toBeNull(); // nothing to count down to
    const packRows = parsed.filter((q) => q.name.startsWith("Bonus Pack"));
    expect(packRows.reduce((sum, q) => sum + q.total, 0)).toBe(700);
  });

  it("has a translation for the new row label in every dashboard locale", () => {
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(
        readFileSync(new URL(`../../public/i18n/literals/${lang}.json`, import.meta.url), "utf8"),
      );
      expect(typeof dict["Bonus Pack (unitemized)"]).toBe("string");
      expect(dict["Bonus Pack (unitemized)"].length).toBeGreaterThan(0);
    }
  });
});
