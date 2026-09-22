/**
 * Extract earliest-expiring available quota package from usage payload.
 *
 * Scans `usage.quotas` across all packages, skips exhausted one-shot packages
 * (used >= total or remaining <= 0) and summary aggregates ("Total Points"),
 * and returns the soonest future expiry timestamp/ISO string. Exhausted
 * RECURRING windows (recurring:true) are kept — their next reset time is the
 * point of the badge even (especially) when the window is drained.
 *
 * @param {Object} usage
 * @returns {{ expiry: string, name: string, timestamp: number } | null}
 */
export function extractEarliestPackageExpiry(usage) {
  if (!usage || typeof usage !== "object" || !usage.quotas) return null;

  let earliestTime = Infinity;
  let earliestName = null;
  let earliestIso = null;

  const now = Date.now();

  for (const [name, quota] of Object.entries(usage.quotas)) {
    if (!quota || typeof quota !== "object") continue;

    // Skip aggregate / summary rows that don't represent a real package
    const lowerName = name.toLowerCase();
    if (
      lowerName.includes("total") ||
      lowerName.includes("aggregate") ||
      lowerName.includes("summary")
    ) {
      continue;
    }

    // Check if quota is exhausted — but a RECURRING window (recurring:true,
    // e.g. CodeBuddy refills / MiMo weekly) resets instead of dying: when
    // it's drained, the upcoming reset time is exactly the information the
    // badge exists to show. One-shot bonus packs keep being skipped.
    const isRecurring = quota.recurring === true;
    if (!isRecurring) {
      const used = Number(quota.used ?? 0);
      const total = Number(quota.total ?? 0);
      if (total > 0 && used >= total) {
        continue;
      }
      if (quota.remaining !== undefined && quota.remaining <= 0) {
        continue;
      }
      if (quota.remainingPercentage !== undefined && quota.remainingPercentage <= 0) {
        continue;
      }
    }

    // Must have a valid future reset / expiry time
    if (!quota.resetAt) continue;
    const resetTime = new Date(quota.resetAt).getTime();
    if (isNaN(resetTime)) continue;

    // We only care about future expirations (ignoring sentinel dates like year 9999)
    if (resetTime > now && resetTime < earliestTime && new Date(resetTime).getFullYear() <= 2099) {
      earliestTime = resetTime;
      earliestName = name;
      earliestIso = quota.resetAt instanceof Date ? quota.resetAt.toISOString() : String(quota.resetAt);
    }
  }

  if (earliestTime < Infinity) {
    return {
      expiry: earliestIso,
      name: earliestName,
      timestamp: earliestTime,
    };
  }

  return null;
}
