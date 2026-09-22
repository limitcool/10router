// Shared provider-card ordering used by the dashboard providers page and the
// media-providers listing pages (issue: media provider cards had no drag
// reorder and never floated connected providers to the front). These cases pin
// the pure rank/comparator/splice math so both surfaces cannot drift.
import { describe, it, expect } from "vitest";
import {
  effectiveConnectionStatus,
  computeConnectionStats,
  connectionRank,
  buildCardOrderIndexer,
  buildProviderCardComparator,
  mergeCardOrder,
  moveCardInOrder,
  DEFAULT_CARD_PRIORITY,
} from "@/shared/utils/providerCardOrder";

const future = () => new Date(Date.now() + 60_000).toISOString();

describe("effectiveConnectionStatus", () => {
  it("passes a normal status through", () => {
    expect(effectiveConnectionStatus({ testStatus: "active" })).toBe("active");
    expect(effectiveConnectionStatus({ testStatus: "error" })).toBe("error");
  });

  // The account-level "unavailable" testStatus is a lazily-cleared flag: a
  // model lock (modelLock_*) is the real signal. "unavailable" with NO active
  // lock means the locks expired → the account recovered → active.
  it("treats 'unavailable' without an active lock as recovered (active)", () => {
    expect(effectiveConnectionStatus({ testStatus: "unavailable" })).toBe("active");
  });

  it("keeps 'unavailable' while a model lock is still in flight (cooldown)", () => {
    const conn = { testStatus: "unavailable", modelLock_gpt: future() };
    expect(effectiveConnectionStatus(conn)).toBe("unavailable");
  });

  it("treats an expired model lock as recovered (active)", () => {
    const conn = { testStatus: "unavailable", modelLock_gpt: "2000-01-01T00:00:00Z" };
    expect(effectiveConnectionStatus(conn)).toBe("active");
  });
});

describe("computeConnectionStats", () => {
  const conns = [
    { id: "a", provider: "openai", authType: "apikey", testStatus: "active" },
    { id: "b", provider: "openai", authType: "apikey", testStatus: "error" },
    { id: "c", provider: "openai", authType: "apikey", testStatus: "active", isActive: false },
    { id: "d", provider: "gemini", authType: "oauth", testStatus: "active" },
  ];

  it("counts total/connected/error and excludes disabled connections", () => {
    const stats = computeConnectionStats(conns, "openai");
    expect(stats).toEqual({ connected: 1, error: 1, total: 3, allDisabled: false });
  });

  it("flags allDisabled only when every connection is off", () => {
    const off = [
      { provider: "x", authType: "apikey", testStatus: "active", isActive: false },
      { provider: "x", authType: "apikey", testStatus: "error", isActive: false },
    ];
    expect(computeConnectionStats(off, "x").allDisabled).toBe(true);
  });

  it("restricts to the requested authTypes", () => {
    const oauthOnly = computeConnectionStats(conns, "openai", ["oauth"]);
    expect(oauthOnly.total).toBe(0);
    expect(oauthOnly.allDisabled).toBe(false);
  });

  it("returns zeros for an unknown provider", () => {
    expect(computeConnectionStats(conns, "nope")).toEqual({
      connected: 0,
      error: 0,
      total: 0,
      allDisabled: false,
    });
  });
});

describe("connectionRank", () => {
  it("ranks connected first, then disabled-configured, then never-configured", () => {
    expect(connectionRank({ connected: 1, total: 2 })).toBe(0);
    expect(connectionRank({ connected: 0, total: 2 })).toBe(2);
    expect(connectionRank({ connected: 0, total: 0 })).toBe(3);
  });

  it("ranks no-auth providers by their enabled flag", () => {
    expect(connectionRank({ connected: 0, total: 0 }, { noAuth: true })).toBe(0);
    expect(
      connectionRank({ connected: 0, total: 0 }, { noAuth: true, noAuthEnabled: false }),
    ).toBe(1);
  });

  it("prefers connection state over noAuth", () => {
    expect(connectionRank({ connected: 2, total: 2 }, { noAuth: true, noAuthEnabled: false })).toBe(0);
  });
});

describe("buildCardOrderIndexer", () => {
  it("indexes first occurrence and parks unknown ids last", () => {
    const idx = buildCardOrderIndexer(["a", "b", "a"]);
    expect(idx("a")).toBe(0);
    expect(idx("b")).toBe(1);
    expect(idx("z")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("buildProviderCardComparator", () => {
  const info = {
    connected: { name: "Connected", priority: 50 },
    unconnectedLow: { name: "Zeta", priority: 5 },
    unconnectedHigh: { name: "Alpha", priority: 900 },
    noAuth: { name: "Free", noAuth: true, priority: 999 },
  };
  const stats = {
    connected: { connected: 1, total: 1 },
    unconnectedLow: { connected: 0, total: 0 },
    unconnectedHigh: { connected: 0, total: 0 },
    noAuth: { connected: 0, total: 0 },
  };
  const cmp = (cardOrder = []) =>
    buildProviderCardComparator({
      cardOrder,
      statsOf: (id) => stats[id] || { connected: 0, total: 0 },
      infoOf: (id) => info[id],
    });

  it("floats connected (and enabled no-auth) providers above unconnected ones", () => {
    const order = ["connected", "unconnectedLow", "unconnectedHigh", "noAuth"].sort(cmp());
    expect(order.slice(0, 2).sort()).toEqual(["connected", "noAuth"]);
    expect(order.slice(2)).toEqual(
      expect.arrayContaining(["unconnectedLow", "unconnectedHigh"]),
    );
  });

  it("uses manual card order inside the same rank", () => {
    const order = ["unconnectedLow", "unconnectedHigh"].sort(
      cmp(["unconnectedHigh", "unconnectedLow"]),
    );
    expect(order).toEqual(["unconnectedHigh", "unconnectedLow"]);
  });

  it("falls back to registry priority, then name", () => {
    // No manual order: priority decides (unconnectedHigh=900 → after low=5).
    const byPriority = ["unconnectedHigh", "unconnectedLow"].sort(cmp());
    expect(byPriority).toEqual(["unconnectedLow", "unconnectedHigh"]);

    // Same priority → name.
    const tie = buildProviderCardComparator({
      cardOrder: [],
      statsOf: () => ({ connected: 0, total: 0 }),
      infoOf: (id) => ({ name: id }),
    });
    expect(["bbb", "aaa"].sort(tie)).toEqual(["aaa", "bbb"]);
  });

  it("uses the default priority when a provider omits one", () => {
    expect(DEFAULT_CARD_PRIORITY).toBe(999);
    const cmpNoPriority = buildProviderCardComparator({
      cardOrder: [],
      statsOf: () => ({ connected: 0, total: 0 }),
      infoOf: (id) => ({}),
    });
    expect(["a", "b"].sort(cmpNoPriority)).toEqual(["a", "b"]);
  });
});

describe("mergeCardOrder / moveCardInOrder", () => {
  it("appends unknown keys without duplicating known ones", () => {
    expect(mergeCardOrder(["a"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeCardOrder([], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("moves a card to the target slot and merges known keys", () => {
    const next = moveCardInOrder(["a", "b"], ["a", "b", "c"], "c", "a");
    expect(next).toEqual(["c", "a", "b"]);
  });

  it("moves downward too", () => {
    expect(moveCardInOrder(["a", "b", "c"], ["a", "b", "c"], "a", "c")).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("returns the same reference for a no-op (caller can skip the persist)", () => {
    const prev = ["a", "b"];
    expect(moveCardInOrder(prev, ["a", "b"], "a", "a")).toBe(prev);
    expect(moveCardInOrder(prev, ["a", "b"], "zz", "a")).toBe(prev);
    expect(moveCardInOrder(prev, ["a", "b"], null, "a")).toBe(prev);
  });
});
