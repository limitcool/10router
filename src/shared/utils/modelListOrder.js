// Shared provider ordering — single source of truth for "the user's latest
// order". The dashboard providers page WRITES settings.providerCardOrder (an
// array of provider ids, in manual drag order); /v1/models READS it so clients
// list providers in the same order the user sees. Keeping the comparator here
// means the two surfaces cannot drift.
//
// Tie-breaks mirror src/app/(dashboard)/dashboard/providers/page.js:
//   manual card order → registry priority → name.
// Ids absent from the card order sort after all ordered ones with
// Number.MAX_SAFE_INTEGER, exactly like the dashboard's getCardOrderIndex.

export function buildProviderOrderComparator({
  cardOrder = [],
  aliasToId = {},
  priorityOf = () => undefined,
} = {}) {
  const pos = new Map();
  cardOrder.forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i); // first occurrence wins, like indexOf
  });
  const canonical = (key) => aliasToId[key] || key;
  const orderIndex = (key) => {
    const i = pos.get(canonical(key));
    return i === undefined ? Number.MAX_SAFE_INTEGER : i;
  };
  return (a, b) => {
    const oa = orderIndex(a);
    const ob = orderIndex(b);
    if (oa !== ob) return oa - ob;
    const pa = priorityOf(canonical(a)) ?? 999;
    const pb = priorityOf(canonical(b)) ?? 999;
    if (pa !== pb) return pa - pb;
    return String(canonical(a)).localeCompare(String(canonical(b)));
  };
}
