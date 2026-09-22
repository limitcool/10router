/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";
import {
  QODER_OPENAPI_BASE,
  QODER_CN_OPENAPI_BASE,
} from "../../shared/qoder/constants.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — session (5h) + weekly (7d) `usage` is a 0..1
 *   ratio (1.0 = limit reached, e.g. weekly 100% used). No reset timestamp exposed.
 * POST https://ollama.com/api/me — plan label (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 */
export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    const sessionRaw = limits.session?.usage;
    const weeklyRaw = limits.weekly?.usage;
    const sessionNum = Number(sessionRaw);
    const weeklyNum = Number(weeklyRaw);
    const hasSession = sessionRaw !== undefined && sessionRaw !== null && !Number.isNaN(sessionNum);
    const hasWeekly = weeklyRaw !== undefined && weeklyRaw !== null && !Number.isNaN(weeklyNum);

    if (!hasSession && !hasWeekly) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    const quotas = {};
    if (hasSession) quotas["Session (5h)"] = ratioQuota(sessionNum);
    if (hasWeekly) quotas["Weekly (7d)"] = ratioQuota(weeklyNum);

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      if (!limit || limit.type !== "TOKENS_LIMIT") continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      quotas["session"] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

/**
 * Build Qoder's per-pack breakdown from the campaigns list, reconciled against
 * the authoritative `addOnQuota` aggregate.
 *
 * The device-token campaigns list is the ONLY source of per-pack data, and it is
 * incomplete: a pack granted outside a campaign, or a campaign the listing has
 * since dropped, is simply absent. Observed live on a real account — aggregate
 * `total: 700` but only 500 + 100 across the listed packs, with the third gifted
 * pack (100 credits) present on the official account page and in no device-token
 * response. The aggregate is the source of truth, so when the listed packs cover
 * less than `total` we account for the remainder with one expiry-less pack;
 * otherwise the per-pack rows silently add up to less than the "Resource
 * Package" row directly above them, which reads as missing credits.
 *
 * @param {{campaigns?: Array, used?: number, total?: number, now?: number}} args
 * @returns {{packs: Array, resetAt: string|null}}
 */
export function buildQoderAddOnPacks({ campaigns = [], used = 0, total = 0, now = Date.now() } = {}) {
  const claimed = campaigns.filter(
    (c) => c?.claimStatus === "CLAIMED" && c?.benefit?.kind === "CREDITS",
  );
  const packs = [];
  for (const c of claimed) {
    const v = c.benefit?.validity;
    let expiresAtMs = null;
    if (v?.mode === "FIXED_END" && v.fixedEnd) {
      expiresAtMs = new Date(v.fixedEnd).getTime();
    } else if (v?.mode === "RELATIVE_DAYS" && v.days && c.startAt) {
      expiresAtMs = c.startAt * 1000 + v.days * 86400000;
    }
    const packTotal = Number(c.benefit?.amount) || 0;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || packTotal <= 0) {
      continue;
    }
    packs.push({ total: packTotal, expiresAt: new Date(expiresAtMs).toISOString() });
  }
  packs.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));

  // Qoder spends soonest-expiring credits first; the API only reports aggregate
  // used, so derive per-pack used with that assumption.
  let usedLeft = Math.max(0, Number(used) || 0);
  for (const p of packs) {
    const packUsed = Math.min(usedLeft, p.total);
    p.used = packUsed;
    p.remaining = p.total - packUsed;
    usedLeft -= packUsed;
  }

  // Reconcile with the aggregate. Appended LAST on purpose: an unknown expiry can
  // only be "not sooner" than every known one, so it must not pre-empt the known
  // packs in the soonest-first spend order above.
  const itemized = packs.reduce((sum, p) => sum + p.total, 0);
  const unattributed = (Number(total) || 0) - itemized;
  if (packs.length > 0 && unattributed > 0) {
    const packUsed = Math.min(usedLeft, unattributed);
    packs.push({
      total: unattributed,
      expiresAt: null,
      used: packUsed,
      remaining: unattributed - packUsed,
      unitemized: true,
    });
  }

  return { packs, resetAt: packs.length > 0 ? packs[0].expiresAt || null : null };
}

export async function getQoderUsage(accessToken, proxyOptions = null, providerId = "qoder") {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const usageUrl = U(providerId).url || U("qoder").url;
    const response = await proxyAwareFetch(
      usageUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const addOnQuota = body.addOnQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total. Sentinel values (e.g. year 9999 /
    // 253402214400000) mean "no expiration / permanent" — ignore them so
    // we don't render a 2.9-million-day countdown.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const isSentinelExpiry = expiresAtMs && (expiresAtMs >= 253400000000000 || new Date(expiresAtMs).getFullYear() > 2099);
    const resetAt = expiresAtMs && !isSentinelExpiry ? new Date(expiresAtMs).toISOString() : null;
    // Fetch active campaigns to resolve the resource-package breakdown.
    // Qoder's device-token API only exposes the aggregated `addOnQuota`;
    // the web UI's per-pack list (`/api/v2/me/usages/big_model_credits`)
    // is cookie-auth only. Each CLAIMED campaign with a CREDITS benefit is
    // one gifted pack: `benefit.amount` credits, expiring at `FIXED_END`
    // or `startAt + RELATIVE_DAYS` (claim day is not exposed, so campaign
    // start is the best available proxy). Best-effort: on any failure we
    // fall back to the aggregate-only view.
    let addOnResetAt = null;
    let addOnPacks = [];
    try {
      const campBase = providerId === "qoder-cn" ? QODER_CN_OPENAPI_BASE : QODER_OPENAPI_BASE;
      const campUrl = `${campBase}/sash/api/v1/me/campaigns?clientType=10`;
      const campRes = await proxyAwareFetch(
        campUrl,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Cosy-ClientType": "10",
            "Cosy-Version": "0.3.3",
            "User-Agent": "Qoder",
            Accept: "application/json",
          },
        },
        proxyOptions,
      );
      if (campRes.ok) {
        const campBody = await campRes.json().catch(() => null);
        const resolved = buildQoderAddOnPacks({
          campaigns: campBody?.campaigns || [],
          used: Number(addOnQuota.used) || 0,
          total: Number(addOnQuota.total) || 0,
        });
        addOnPacks = resolved.packs;
        addOnResetAt = resolved.resetAt;
      }
    } catch {
      // Best-effort breakdown fetch
    }

    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
        unlimited: false,
      },
      addOn: {
        total: Number(addOnQuota.total) || 0,
        used: Number(addOnQuota.used) || 0,
        remaining: Number(addOnQuota.remaining) || 0,
        unit: addOnQuota.unit || "credits",
        resetAt: addOnResetAt,
        unlimited: false,
        packs: addOnPacks,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
        unlimited: false,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
