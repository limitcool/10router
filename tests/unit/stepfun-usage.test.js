import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const INTL_ACCOUNTS_URL = "https://api.stepfun.ai/v1/accounts";
const CN_ACCOUNTS_URL = "https://api.stepfun.com/v1/accounts";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ACCOUNT_BODY = {
  object: "account",
  type: "prepaid",
  balance: 25.5,
  total_cash_balance: 10.5,
  total_voucher_balance: 15.0,
};

describe("stepfun registry usage flags", () => {
  it("lists both standard channels (intl + cn) for the apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("stepfun");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("stepfun-cn");
    expect(USAGE_APIKEY_PROVIDERS).toContain("stepfun");
    expect(USAGE_APIKEY_PROVIDERS).toContain("stepfun-cn");
  });

  it("does not list the Step Plan channels (no public quota API)", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).not.toContain("stepfun-plan");
    expect(USAGE_SUPPORTED_PROVIDERS).not.toContain("stepfun-plan-cn");
  });
});

describe("getUsageForProvider(stepfun) — international host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns message when apiKey is missing", async () => {
    const res = await getUsageForProvider({ provider: "stepfun" });
    expect(res.message).toMatch(/API key not available/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("handles 401/403 authentication failure", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("", { status: 401 }));

    const res = await getUsageForProvider({
      provider: "stepfun",
      apiKey: "sk-invalid",
    });
    expect(res.plan).toBe("StepFun");
    expect(res.message).toMatch(/authentication failed/i);
  });

  it("queries api.stepfun.ai and labels balances in USD", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACCOUNT_BODY));

    const res = await getUsageForProvider({
      provider: "stepfun",
      apiKey: "sk-test",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(INTL_ACCOUNTS_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer sk-test");

    expect(res.plan).toBe("StepFun");
    expect(res.quotas["Balance (USD)"]).toEqual({
      used: 0,
      total: 25.5,
      remainingPercentage: 100,
      resetAt: null,
      displayRemaining: true,
      unlimited: false,
    });
    expect(res.quotas["Cash (USD)"].total).toBe(10.5);
    expect(res.quotas["Voucher (USD)"].total).toBe(15.0);
  });

  it("handles zero balance as insufficient balance", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ object: "account", type: "prepaid", balance: 0, total_cash_balance: 0, total_voucher_balance: 0 }),
    );

    const res = await getUsageForProvider({ provider: "stepfun", apiKey: "sk-test" });
    expect(res.plan).toBe("StepFun (Insufficient Balance)");
    expect(res.quotas["Balance (USD)"]?.total).toBe(0);
    expect(res.quotas["Balance (USD)"]?.remainingPercentage).toBe(0);
  });
});

describe("getUsageForProvider(stepfun-cn) — China host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries api.stepfun.com and labels balances in CNY", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACCOUNT_BODY));

    const res = await getUsageForProvider({
      provider: "stepfun-cn",
      apiKey: "sk-cn",
    });

    const [url] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(CN_ACCOUNTS_URL);
    expect(res.plan).toBe("StepFun CN");
    expect(res.quotas["Balance (CNY)"].total).toBe(25.5);
    expect(res.quotas["Voucher (CNY)"].total).toBe(15.0);
  });

  it("returns only the voucher row when cash is zero", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ object: "account", type: "prepaid", balance: 14.97, total_cash_balance: 0, total_voucher_balance: 14.97 }),
    );

    const res = await getUsageForProvider({ provider: "stepfun-cn", apiKey: "sk-cn" });
    expect(res.quotas["Balance (CNY)"].total).toBe(14.97);
    expect(res.quotas["Voucher (CNY)"].total).toBe(14.97);
    expect(res.quotas["Cash (CNY)"]).toBeUndefined();
  });
});

describe("getUsageForProvider(stepfun-plan*) — no quota API", () => {
  it("reports not-implemented instead of hitting a 404 endpoint", async () => {
    const res = await getUsageForProvider({ provider: "stepfun-plan-cn", apiKey: "sk" });
    expect(res.message).toMatch(/not implemented/i);
  });
});

describe("parseQuotaData(stepfun)", () => {
  it("forwards remainingPercentage and displayRemaining for balance rows", () => {
    const rows = parseQuotaData("stepfun", {
      plan: "StepFun",
      quotas: {
        "Balance (USD)": {
          used: 0,
          total: 25.5,
          remainingPercentage: 100,
          displayRemaining: true,
        },
      },
    });
    expect(rows[0]).toMatchObject({
      name: "Balance (USD)",
      total: 25.5,
      remainingPercentage: 100,
      displayRemaining: true,
    });
  });

  it("also parses the CN channel rows", () => {
    const rows = parseQuotaData("stepfun-cn", {
      plan: "StepFun CN",
      quotas: {
        "Balance (CNY)": { used: 0, total: 14.97, remainingPercentage: 100, displayRemaining: true },
      },
    });
    expect(rows[0]).toMatchObject({ name: "Balance (CNY)", total: 14.97, displayRemaining: true });
  });
});
