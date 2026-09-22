/**
 * StepFun usage — GET {base}/v1/accounts
 * Auth: Bearer <apiKey>
 *
 * Two hosts, one shape (docs/zh · docs/en api-reference/accounts/get):
 *   - https://api.stepfun.ai  (international, USD)  ← provider `stepfun`
 *   - https://api.stepfun.com (China, CNY)          ← provider `stepfun-cn`
 *
 * Response format:
 * {
 *   "object": "account",
 *   "type": "prepaid",
 *   "balance": 14.97,
 *   "total_cash_balance": 0.0,
 *   "total_voucher_balance": 14.97
 * }
 *
 * The Step Plan channels (stepfun-plan / stepfun-plan-cn) have no public quota
 * endpoint (`/step_plan/v1/accounts` is 404), so they carry no usage handler.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

export const STEPFUN_ACCOUNTS_HOSTS = {
  stepfun: { baseUrl: "https://api.stepfun.ai", currency: "USD", brand: "StepFun" },
  "stepfun-cn": { baseUrl: "https://api.stepfun.com", currency: "CNY", brand: "StepFun CN" },
};

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 * @param {{ baseUrl?: string, currency?: string, brand?: string }} [opts]
 */
export async function getStepfunUsage(apiKey = null, proxyOptions = null, opts = {}) {
  const {
    baseUrl = "https://api.stepfun.com",
    currency = "CNY",
    brand = "StepFun",
  } = opts;

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: `${brand} API key not available. Add a key to view usage.` };
  }

  const accountsUrl = `${baseUrl.replace(/\/$/, "")}/v1/accounts`;

  try {
    const response = await proxyAwareFetch(
      accountsUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: brand,
        message: `${brand} authentication failed. Check the API key.`,
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: brand,
        message: `${brand} account API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { message: `${brand} account response was not JSON.` };
    }

    const balance = toFiniteNumber(data.balance, 0);
    const cash = toFiniteNumber(data.total_cash_balance, 0);
    const voucher = toFiniteNumber(data.total_voucher_balance, 0);

    const isAvailable = balance > 0;
    const quotas = {};

    const balanceRow = (total) => ({
      used: 0,
      total: Math.max(0, total),
      remainingPercentage: total > 0 ? 100 : 0,
      resetAt: null,
      displayRemaining: true,
      unlimited: false,
    });

    quotas[`Balance (${currency})`] = balanceRow(balance);

    if (voucher > 0 && cash > 0) {
      quotas[`Cash (${currency})`] = balanceRow(cash);
      quotas[`Voucher (${currency})`] = balanceRow(voucher);
    } else if (voucher > 0) {
      quotas[`Voucher (${currency})`] = balanceRow(voucher);
    }

    return {
      plan: isAvailable ? brand : `${brand} (Insufficient Balance)`,
      quotas,
    };
  } catch (error) {
    return { message: `${brand} error: ${error.message}` };
  }
}
