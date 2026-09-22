// Shared provider-card ordering + drag-reorder model.
//
// ONE source of truth for how provider cards are ordered and how a manual
// drag is persisted, shared by the dashboard providers page and the
// media-providers listing pages (generic kinds + the merged Web Search/Fetch
// page). Order chain:
//
//   connection-state rank → manual drag order → registry priority → name
//
// The manual order lives in settings.providerCardOrder — a flat array of
// provider ids that /v1/models reads too (see shared/utils/modelListOrder.js),
// so a drag on any surface reorders every surface. Keeping the rank,
// comparator and splice math here means the surfaces cannot drift and the pure
// parts are unit-testable.
//
// Connection-state rank (lower floats first), mirroring the providers page:
//   0  connected (or an enabled no-auth provider, e.g. a keyless search host)
//   1  a no-auth provider that is switched off (the providers page maps this
//      to its topology toggle; media pages have no toggle, so they use 0)
//   2  configured but every connection is disabled → sinks below connected
//   3  never configured → sinks last

export const DEFAULT_CARD_PRIORITY = 999;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Effective test status of one connection. A connection under an in-flight
 * model lock is treated as "active" (the lock is a cooldown, not a failure).
 */
export function effectiveConnectionStatus(conn) {
  const isCooldown = Object.entries(conn || {}).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now(),
  );
  return conn?.testStatus === "unavailable" && !isCooldown ? "active" : conn?.testStatus;
}

/**
 * Connection stats for one provider, optionally restricted to specific
 * authTypes (the providers page folds oauth + api_key together for kiro).
 * A disabled connection (`isActive === false`) never counts as connected.
 *
 * @returns {{connected:number, error:number, total:number, allDisabled:boolean}}
 */
export function computeConnectionStats(connections, providerId, authTypes = null) {
  const list = (connections || []).filter(
    (c) => c.provider === providerId && (!authTypes || authTypes.includes(c.authType)),
  );
  const connected = list.filter((c) => {
    if (c.isActive === false) return false;
    const status = effectiveConnectionStatus(c);
    return status === "active" || status === "success";
  }).length;
  const error = list.filter((c) => {
    const status = effectiveConnectionStatus(c);
    return status === "error" || status === "expired" || status === "unavailable";
  }).length;
  const total = list.length;
  const allDisabled = total > 0 && list.every((c) => c.isActive === false);
  return { connected, error, total, allDisabled };
}

/** Connection-state rank for one provider — see the file header. */
export function connectionRank(stats, { noAuth = false, noAuthEnabled = true } = {}) {
  if ((stats?.connected ?? 0) > 0) return 0;
  if (noAuth) return noAuthEnabled ? 0 : 1;
  if ((stats?.total ?? 0) === 0) return 3;
  return 2;
}

/** Index lookup for the manual order; ids absent from it sort after every known one. */
export function buildCardOrderIndexer(cardOrder = []) {
  const pos = new Map();
  (cardOrder || []).forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i); // first occurrence wins, like indexOf
  });
  return (key) => (pos.has(key) ? pos.get(key) : MAX_SAFE);
}

/**
 * Build a comparator over provider ids.
 *
 * @param {object}   opts
 * @param {string[]} [opts.cardOrder]          manual order (settings.providerCardOrder)
 * @param {Function} opts.statsOf              (id) → computeConnectionStats(...)
 * @param {Function} opts.infoOf               (id) → registry entry ({priority,name,noAuth})
 * @param {Function} [opts.noAuthEnabledOf]    (id) → boolean; false demotes a no-auth
 *                                             provider to rank 1 (topology toggle)
 * @returns {(a:string, b:string) => number}
 */
export function buildProviderCardComparator({ cardOrder = [], statsOf, infoOf, noAuthEnabledOf }) {
  const orderIndex = buildCardOrderIndexer(cardOrder);
  const noAuthEnabled = (key) => (noAuthEnabledOf ? noAuthEnabledOf(key) !== false : true);
  return (a, b) => {
    const ia = infoOf(a) || {};
    const ib = infoOf(b) || {};
    const ra = connectionRank(statsOf(a), { noAuth: !!ia.noAuth, noAuthEnabled: noAuthEnabled(a) });
    const rb = connectionRank(statsOf(b), { noAuth: !!ib.noAuth, noAuthEnabled: noAuthEnabled(b) });
    if (ra !== rb) return ra - rb;
    const oa = orderIndex(a);
    const ob = orderIndex(b);
    if (oa !== ob) return oa - ob;
    const pa = ia.priority ?? DEFAULT_CARD_PRIORITY;
    const pb = ib.priority ?? DEFAULT_CARD_PRIORITY;
    if (pa !== pb) return pa - pb;
    return String(ia.name || a).localeCompare(String(ib.name || b));
  };
}

/** Grow the manual order with every known key, preserving first-seen order. */
export function mergeCardOrder(cardOrder, allKeys) {
  const base = [...(cardOrder || [])];
  for (const key of allKeys || []) {
    if (!base.includes(key)) base.push(key);
  }
  return base;
}

/**
 * Pure reorder: move `sourceId` to `targetId`'s slot. Returns the SAME array
 * reference for a no-op (missing/same id) so callers can skip the persist.
 */
export function moveCardInOrder(cardOrder, allKeys, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return cardOrder;
  const base = mergeCardOrder(cardOrder, allKeys);
  const fromIdx = base.indexOf(sourceId);
  const toIdx = base.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return cardOrder;
  base.splice(fromIdx, 1);
  base.splice(toIdx, 0, sourceId);
  return base;
}

/** Persist the manual order (fire-and-forget: the caller already updated state). */
export function saveProviderCardOrder(base) {
  return fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerCardOrder: base }),
  });
}
