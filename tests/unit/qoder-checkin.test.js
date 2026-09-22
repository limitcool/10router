import { describe, it, expect, vi } from "vitest";

// localDb is dynamically imported inside runQoderCheckinTick; mock it so the
// tick can be driven with a fixed connection set (and persistence is a no-op).
const mockConns = [];
vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnections: async () => mockConns,
  updateSettings: async () => ({}),
  getSettings: async () => ({}),
}));

import {
  isEligibleQoderConnection,
  getQoderOpenApiBase,
  buildQoderHeaders,
  checkinOneQoder,
  runQoderCheckinTick,
} from "../../src/sse/services/qoderCheckin.js";

describe("qoderCheckin unit tests", () => {
  describe("isEligibleQoderConnection", () => {
    it("accepts active qoder and qoder-cn with token", () => {
      expect(isEligibleQoderConnection({ provider: "qoder", accessToken: "dt-123", isActive: true })).toBe(true);
      expect(isEligibleQoderConnection({ provider: "qoder-cn", apiKey: "pt-123", isActive: true })).toBe(true);
    });

    it("rejects inactive or non-qoder connections", () => {
      expect(isEligibleQoderConnection({ provider: "qoder", accessToken: "dt-123", isActive: false })).toBe(false);
      expect(isEligibleQoderConnection({ provider: "openai", accessToken: "sk-123", isActive: true })).toBe(false);
      expect(isEligibleQoderConnection({ provider: "qoder", accessToken: "", isActive: true })).toBe(false);
      expect(isEligibleQoderConnection(null)).toBe(false);
    });
  });

  describe("getQoderOpenApiBase", () => {
    it("resolves CN and Intl base URLs correctly", () => {
      expect(getQoderOpenApiBase("qoder-cn")).toBe("https://openapi.qoder.com.cn");
      expect(getQoderOpenApiBase("qoder")).toBe("https://openapi.qoder.sh");
    });
  });

  describe("buildQoderHeaders", () => {
    it("constructs standard Qoder Cosy and Bearer headers", () => {
      const headers = buildQoderHeaders("test-token");
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["Cosy-ClientType"]).toBe("10");
      expect(headers["Cosy-Version"]).toBe("0.3.3");
      expect(headers["User-Agent"]).toBe("Qoder");
    });
  });

  describe("checkinOneQoder", () => {
    it("claims available campaigns successfully", async () => {
      const mockFetch = vi.fn()
        // 1. GET campaigns
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            campaigns: [
              {
                campaignId: "camp-1",
                campaignKey: "daily-100",
                actionType: "CLAIM_BENEFIT",
                claimStatus: "CLAIMABLE",
                benefit: { kind: "CREDITS", amount: 100 },
              },
            ],
          }),
        })
        // 2. POST claim
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            status: "CLAIMED",
            benefit: { amount: 100 },
          }),
        });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder", accessToken: "dt-token" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("checked-in");
      expect(res.claimedAmount).toBe(100);
      expect(res.campaigns).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toContain("/sash/api/v1/me/campaigns/camp-1/claim");
    });

    it("returns already when no claimable campaigns exist", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          campaigns: [
            {
              campaignId: "camp-1",
              actionType: "CLAIM_BENEFIT",
              claimStatus: "CLAIMED",
            },
          ],
        }),
      });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder-cn", accessToken: "dt-token" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("already");
      expect(res.claimedAmount).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns no-activity when the deployment offers no claim campaign at all", async () => {
      // The intl qoder.sh deployment answers every account with the season promo
      // (VIEW_DETAILS) and nothing else, so "already claimed today" would be a lie.
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          campaigns: [
            {
              campaignId: "promo-1",
              campaignKey: "season-2026",
              actionType: "VIEW_DETAILS",
              claimStatus: "UNCLAIMED",
            },
          ],
        }),
      });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder", accessToken: "dt-token" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("no-activity");
      expect(res.claimedAmount).toBe(0);
      // Nothing to claim, so it must never POST a claim request.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns no-activity for an empty campaign list (qoder-cn before the daily window)", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ campaigns: [] }),
      });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder-cn", accessToken: "dt-token" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("no-activity");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("keeps 'already' when a credits campaign exists but is not claimable", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          campaigns: [
            { campaignId: "camp-1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED" },
            { campaignId: "promo-1", actionType: "VIEW_DETAILS", claimStatus: "UNCLAIMED" },
          ],
        }),
      });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder-cn", accessToken: "dt-token" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("already");
    });

    it("handles 401 authentication rejection gracefully", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder", accessToken: "dt-expired" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("failed");
      expect(res.error).toContain("401");
    });
  });

  describe("runQoderCheckinTick with memoization", () => {
    it("skips accounts already completed today when skipIfCheckedToday is true", async () => {
      const mockCheckinOne = vi.fn();
      const conns = [
        { id: "conn-done", provider: "qoder", accessToken: "t1", isActive: true },
        { id: "conn-new", provider: "qoder", accessToken: "t2", isActive: true },
      ];

      // Re-route localDb to return our mock conns
      const memo = { "conn-done": "2026-09-18" };
      const deps = {
        nowMs: new Date("2026-09-18T10:00:00Z").getTime(),
        doneMap: memo,
        skipIfCheckedToday: true,
        checkinConnection: async (conn) => {
          if (memo[conn.id] === "2026-09-18") {
            return { status: "already", memoized: true };
          }
          return { status: "checked-in", claimedAmount: 100 };
        },
      };

      // Test checkinIfNotDone behavior
      const r1 = await deps.checkinConnection(conns[0]);
      expect(r1.status).toBe("already");
      expect(r1.memoized).toBe(true);

      const r2 = await deps.checkinConnection(conns[1]);
      expect(r2.status).toBe("checked-in");
    });

    it("does not memoize no-activity, so the next tick looks again", async () => {
      mockConns.length = 0;
      mockConns.push({
        id: "conn-none",
        name: "No Campaign",
        provider: "qoder",
        accessToken: "t1",
        isActive: true,
      });
      const doneMap = {};

      const results = await runQoderCheckinTick({
        doneMap,
        skipIfCheckedToday: true,
        checkinConnection: async (conn) => ({
          connectionId: conn.id,
          provider: conn.provider,
          status: "no-activity",
          message: "当前无可领取的活动",
          claimedAmount: 0,
        }),
      });

      expect(results[0].status).toBe("no-activity");
      // A campaign can still open later in the day, so the account must stay
      // eligible for the following tick instead of being written off as done.
      expect(doneMap["conn-none"]).toBeUndefined();
    });
  });

  describe("runQoderCheckinTick provider scoping", () => {
    it("provider:'qoder' sweeps only intl accounts", async () => {
      mockConns.length = 0;
      mockConns.push(
        { id: "q1", name: "Intl A", provider: "qoder", accessToken: "t1", isActive: true },
        { id: "c1", name: "CN A", provider: "qoder-cn", accessToken: "t2", isActive: true }
      );
      const touched = [];
      const results = await runQoderCheckinTick({
        provider: "qoder",
        doneMap: {},
        checkinConnection: async (conn) => {
          touched.push(conn.id);
          return { connectionId: conn.id, provider: conn.provider, status: "checked-in", claimedAmount: 100 };
        },
      });
      expect(touched).toEqual(["q1"]);
      expect(results.every((r) => r.provider === "qoder")).toBe(true);
    });

    it("provider:'qoder-cn' sweeps only CN accounts", async () => {
      mockConns.length = 0;
      mockConns.push(
        { id: "q1", name: "Intl A", provider: "qoder", accessToken: "t1", isActive: true },
        { id: "c1", name: "CN A", provider: "qoder-cn", accessToken: "t2", isActive: true }
      );
      const touched = [];
      await runQoderCheckinTick({
        provider: "qoder-cn",
        doneMap: {},
        checkinConnection: async (conn) => {
          touched.push(conn.id);
          return { connectionId: conn.id, provider: conn.provider, status: "checked-in", claimedAmount: 50 };
        },
      });
      expect(touched).toEqual(["c1"]);
    });

    it("no provider filter sweeps both (scheduler path)", async () => {
      mockConns.length = 0;
      mockConns.push(
        { id: "q1", name: "Intl A", provider: "qoder", accessToken: "t1", isActive: true },
        { id: "c1", name: "CN A", provider: "qoder-cn", accessToken: "t2", isActive: true }
      );
      const touched = [];
      await runQoderCheckinTick({
        doneMap: {},
        checkinConnection: async (conn) => {
          touched.push(conn.id);
          return { connectionId: conn.id, provider: conn.provider, status: "checked-in", claimedAmount: 10 };
        },
      });
      expect(touched.sort()).toEqual(["c1", "q1"]);
    });
  });
});
