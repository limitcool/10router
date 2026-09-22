import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { loadKeyGroups } from "./disabledModelsRepo.js";

const SCOPE = "modelCaps";

// ───────────────────────────────────────────────────────────────────────────
// Per-model capability overrides (user-set context window / max output).
//
// The built-in catalog ships a contextWindow for only some models and never
// updates when upstream quietly expands a window; user-added custom models had
// nowhere to put an explicit window at all (the /v1/models list ignored the
// stored value). This repo lets the dashboard pin exact numbers per model.
//
// Storage mirrors disabledModelsRepo: one row per model keyed
// `${canonicalProvider}|${modelId}`, value `{ contextWindow?, maxOutput? }`.
// Canonicalisation means id/alias/uiAlias all resolve to the same row, and
// reads publish under every sibling name so any call-site spelling hits.
// ───────────────────────────────────────────────────────────────────────────

const positiveInt = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

// Normalise a proposed caps object; null when nothing valid remains (→ delete).
function cleanCaps({ contextWindow, maxOutput } = {}) {
  const cw = positiveInt(contextWindow);
  const mo = positiveInt(maxOutput);
  if (!cw && !mo) return null;
  const out = {};
  if (cw) out.contextWindow = cw;
  if (mo) out.maxOutput = mo;
  return out;
}

const rowKey = (canonical, modelId) => `${canonical}|${modelId}`;

async function canonicalOf(providerKey) {
  const { toCanonical } = await loadKeyGroups();
  return toCanonical.get(providerKey) || providerKey;
}

/**
 * Overrides for one provider, keyed by model id: { [modelId]: caps }.
 * Rows stored under any sibling name (id/alias/uiAlias) are included.
 */
export async function getModelCapsForProvider(providerKey) {
  if (!providerKey) return {};
  const db = await getAdapter();
  const canonical = await canonicalOf(providerKey);
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) {
    // Provider names never contain "|"; model ids may — split on the FIRST one.
    const sep = r.key.indexOf("|");
    if (sep <= 0) continue;
    const storedProvider = r.key.slice(0, sep);
    const modelId = r.key.slice(sep + 1);
    if ((await canonicalOf(storedProvider)) !== canonical) continue;
    const v = parseJson(r.value, null);
    if (v && (Number.isFinite(v.contextWindow) || Number.isFinite(v.maxOutput))) {
      out[modelId] = v;
    }
  }
  return out;
}

/**
 * Every override, keyed by provider name — published under the canonical name
 * AND every sibling alias (same trick as getDisabledModels), so a reader
 * holding a connection id, a registry id or an alias looks up directly.
 */
export async function getAllModelCaps() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const { toCanonical, byCanonical } = await loadKeyGroups();
  const byCanonicalOut = new Map(); // canonical -> { modelId: caps }
  for (const r of rows) {
    // Split on the FIRST "|" (see getModelCapsForProvider): model ids may
    // contain pipes, provider names never do.
    const sep = r.key.indexOf("|");
    if (sep <= 0) continue;
    const storedProvider = r.key.slice(0, sep);
    const modelId = r.key.slice(sep + 1);
    const canonical = toCanonical.get(storedProvider) || storedProvider;
    const v = parseJson(r.value, null);
    if (!modelId || !v || !(Number.isFinite(v.contextWindow) || Number.isFinite(v.maxOutput))) continue;
    const group = byCanonicalOut.get(canonical) || {};
    group[modelId] = v;
    byCanonicalOut.set(canonical, group);
  }
  const out = {};
  for (const [canonical, models] of byCanonicalOut) {
    const names = new Set([canonical, ...(byCanonical.get(canonical) || [])]);
    for (const name of names) out[name] = { ...(out[name] || {}), ...models };
  }
  return out;
}

/**
 * Set (or clear) one model's override. Passing empty/invalid values deletes
 * the row, falling the model back to catalog defaults.
 */
export async function setModelCaps(providerKey, modelId, caps) {
  if (!providerKey || !modelId) throw new Error("provider and modelId are required");
  const db = await getAdapter();
  const canonical = await canonicalOf(providerKey);
  const key = rowKey(canonical, String(modelId).trim());
  const entry = cleanCaps(caps);
  if (!entry) {
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
    return {};
  }
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, key, stringifyJson(entry)]
  );
  return entry;
}

/**
 * Drop every override for a provider — call when a provider node is deleted so
 * rows for a dead provider can never resurrect on a future node that happens
 * to reuse an id.
 */
export async function clearModelCaps(providerKey) {
  if (!providerKey) return;
  const db = await getAdapter();
  const canonical = await canonicalOf(providerKey);
  const perProvider = await getModelCapsForProvider(canonical);
  for (const modelId of Object.keys(perProvider)) {
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, rowKey(canonical, modelId)]);
  }
}
