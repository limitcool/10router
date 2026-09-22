import { describe, it, expect } from "vitest";
import { buildProviderOrderComparator } from "../../src/shared/utils/modelListOrder.js";

const PRIORITIES = { "codebuddy-cn": 100, opencode: 110, mimo: 120, qoder: 130 };
const ALIAS_TO_ID = { cbcn: "codebuddy-cn", oc: "opencode", qd: "qoder" };

function sortKeys(keys, cmp) {
  return [...keys].sort(cmp);
}

describe("buildProviderOrderComparator", () => {
  it("orders by manual card order when present", () => {
    const cmp = buildProviderOrderComparator({
      cardOrder: ["qoder", "codebuddy-cn", "opencode"],
      aliasToId: ALIAS_TO_ID,
      priorityOf: (id) => PRIORITIES[id],
    });
    expect(sortKeys(["opencode", "qoder", "codebuddy-cn"], cmp)).toEqual([
      "qoder", "codebuddy-cn", "opencode",
    ]);
  });

  it("canonicalizes aliases to ids for ordering lookup", () => {
    // Card order stores the canonical id; consumers may pass the alias.
    const cmp = buildProviderOrderComparator({
      cardOrder: ["qoder", "codebuddy-cn", "opencode"],
      aliasToId: ALIAS_TO_ID,
      priorityOf: (id) => PRIORITIES[id],
    });
    expect(sortKeys(["opencode", "qd", "cbcn"], cmp)).toEqual(["qd", "cbcn", "opencode"]);
  });

  it("sinks ids absent from card order below ordered ones, then by priority", () => {
    const cmp = buildProviderOrderComparator({
      cardOrder: ["opencode"],
      aliasToId: ALIAS_TO_ID,
      priorityOf: (id) => PRIORITIES[id],
    });
    // qoder (130), mimo (120), cbcn→codebuddy-cn (100) absent from order.
    expect(sortKeys(["qoder", "opencode", "mimo", "cbcn"], cmp)).toEqual([
      "opencode", "cbcn", "mimo", "qoder",
    ]);
  });

  it("falls back to name comparison when priorities tie", () => {
    const cmp = buildProviderOrderComparator({
      cardOrder: [],
      aliasToId: {},
      priorityOf: () => undefined,
    });
    expect(sortKeys(["zebra", "apple", "mango"], cmp)).toEqual(["apple", "mango", "zebra"]);
  });

  it("first occurrence wins for duplicated card entries (indexOf parity)", () => {
    const cmp = buildProviderOrderComparator({
      cardOrder: ["a", "b", "a"],
      aliasToId: {},
      priorityOf: () => undefined,
    });
    expect(sortKeys(["b", "a"], cmp)).toEqual(["a", "b"]);
  });

  it("handles empty / missing inputs without throwing", () => {
    const cmp = buildProviderOrderComparator({});
    expect(() => cmp("x", "y")).not.toThrow();
    expect(sortKeys(["x", "y"], cmp)).toEqual(["x", "y"]);
  });
});
