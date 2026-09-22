/**
 * Xiaomi MiMo usage — weekly quota from the Xiaomi account session.
 *
 * Primary path: GET {mimo-server}/api/user/usage authorized by the account-session
 * cookie (see shared/mimoAccount.js). Response: { code: 0, data: { percent (remaining
 * %), resetDate, resetAt } }.
 *
 * Fallback: the sk- API key cannot read the quota, so when no account session is
 * available we surface a graceful message instead of failing.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { getMimoAccountUsage } from "../../shared/mimoAccount.js";

const USAGE_URL = "https://aistudio.xiaomimimo.com/open-apis/v1/user/usage";

/**
 * @param {string|null|undefined} accessToken - sk- API key
 * @param {object|null} providerSpecificData - may contain mimoPassToken, uid, etc.
 * @param {object|null} proxyOptions
 */
export async function getXiaomiMimoUsage(accessToken = null, providerSpecificData = null, proxyOptions = null) {
  // Preferred path: the weekly quota comes from the account service session
  // (mimo-server /api/user/usage), which the sk- key cannot reach. The session is
  // derived from MiMo Desktop's persisted passToken via the SSO/sts handshake.
  const account = await getMimoAccountUsage(providerSpecificData, proxyOptions);
  if (typeof account.percent === "number" && Number.isFinite(account.percent)) {
    return { plan: "Xiaomi MiMo Desktop", quotas: { Weekly: toWeeklyQuota(account.percent, account.resetAt, account.resetDate) } };
  }

  // Fallback: no account session available (Desktop never logged in, or its cookie
  // store is locked). The sk- key cannot read the quota, so surface a clear message.
  const key = accessToken || providerSpecificData?.apiKey;
  if (!key || typeof key !== "string" || !key.trim()) {
    return { message: "Xiaomi MiMo Desktop not connected. Add credentials to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "X-Mimo-Source": "mimocode-cli",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      },
      proxyOptions,
    );

    if (response.status === 401) {
      return {
        plan: "Xiaomi MiMo Desktop",
        message: "Weekly quota requires Xiaomi account session. API key alone is insufficient.",
      };
    }

    if (!response.ok) {
      return { plan: "Xiaomi MiMo Desktop", message: `Usage API error (${response.status})` };
    }

    const data = await response.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) {
      return { plan: "Xiaomi MiMo Desktop", message: "Usage endpoint returned unexpected response." };
    }

    const { percent, resetDate, resetAt } = data.data;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      return { plan: "Xiaomi MiMo Desktop", message: "Usage data missing percent field." };
    }

    return { plan: "Xiaomi MiMo Desktop", quotas: { Weekly: toWeeklyQuota(percent, resetAt, resetDate) } };
  } catch (error) {
    return { message: `Xiaomi MiMo Desktop usage error: ${error.message}` };
  }
}

// Message shown for a Token Plan connection with nothing readable. Kept as ONE
// fixed English sentence on purpose: the dashboard renders quota messages
// verbatim, and the DOM-level i18n runtime translates a text node only on an
// exact match — so a sentence without interpolation is translatable as-is
// (zh-CN / zh-TW entries live in public/i18n/literals).
const TOKENPLAN_NO_QUOTA_MESSAGE =
  "Token Plan does not expose a quota API for standalone keys — check your plan usage in the MiMo console.";

/**
 * MiMo Token Plan (tp- keys, token-plan-<region>.xiaomimimo.com).
 *
 * There is no plan-quota endpoint on that cluster: every candidate path on the
 * token-plan hosts answers 404 (openresty), and the account-service endpoint
 * that carries the weekly allowance rejects a tp- key with 401 (it wants a MiMo
 * account session). So there are only two possible answers:
 *
 *   1. the connection also carries a Desktop account session (mimoPassToken) —
 *      the weekly allowance is then readable, and we show it exactly like the
 *      base provider does;
 *   2. otherwise there is genuinely nothing to fetch. A raw "Usage API not
 *      implemented for xiaomi-tokenplan" is what the row used to display; say
 *      something true instead.
 */
export async function getXiaomiTokenPlanUsage(apiKey = null, providerSpecificData = null, proxyOptions = null) {
  const account = await getMimoAccountUsage(providerSpecificData, proxyOptions);
  if (typeof account.percent === "number" && Number.isFinite(account.percent)) {
    return { plan: "MiMo Token Plan", quotas: { Weekly: toWeeklyQuota(account.percent, account.resetAt, account.resetDate) } };
  }

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "API key not available. Add a key to view usage." };
  }

  return { plan: "MiMo Token Plan", message: TOKENPLAN_NO_QUOTA_MESSAGE };
}

/**
 * Normalize the account-service payload into the dashboard's quota shape.
 * `percent` is the REMAINING percentage (94 means 94% left).
 * @param {number} percent
 * @param {number|string|undefined} resetAt — epoch seconds
 * @param {string|undefined} resetDate — "YYYY-MM-DD"
 */
function toWeeklyQuota(percent, resetAt, resetDate) {
  const remaining = Math.max(0, Math.min(100, Math.round(percent)));
  let resetIso = null;
  if (typeof resetAt === "number" && resetAt > 0) {
    resetIso = new Date(resetAt * 1000).toISOString();
  } else if (typeof resetDate === "string" && resetDate) {
    const parsed = new Date(`${resetDate}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) resetIso = parsed.toISOString();
  }
  return {
    used: 100 - remaining,
    total: 100,
    remainingPercentage: remaining,
    resetAt: resetIso,
    unlimited: false,
    // Weekly allowance: resetAt is the next refresh, not a final expiry —
    // the badge must survive a drained week (that's when users look for it).
    recurring: true,
  };
}
