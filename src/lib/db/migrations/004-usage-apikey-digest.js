// Stop storing full API keys in the usage log (issue #9, item 5).
//
// The log kept the complete `sk-…` value in every row of the largest table in the
// database, and again inside each per-day aggregate (usageDaily.data, both as a
// map key and in the entry). Nothing reads it back — the log groups by key and
// labels it with the name from the apiKeys table, both of which work off a
// digest. New writes already store the digest plus a masked value; this rewrites
// what is already on disk.
//
// Idempotent: rows whose value is already masked (ends in `***`) and aggregate
// entries that already carry `apiKeyHash` are skipped, so a re-run is a no-op.

import { hashApiKey, maskApiKey, isMaskedApiKey } from "../crypto/apiKeyIdentity.js";

// Add `apiKeyHash` when this migration is the first thing to touch it. Uses the
// same SQLite-safe form as the schema sync (ADD COLUMN must not carry UNIQUE /
// PRIMARY KEY) and tolerates the column already being there.
function ensureApiKeyHashColumn(db) {
  try {
    const cols = db.all(`PRAGMA table_info(usageHistory)`).map((c) => c.name);
    if (!cols.includes("apiKeyHash")) {
      db.exec(`ALTER TABLE usageHistory ADD COLUMN apiKeyHash TEXT`);
      console.log("[migration] usage-apikey-digest: added usageHistory.apiKeyHash");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_uh_apikey_hash ON usageHistory(apiKeyHash)`);
  } catch (err) {
    console.warn("[migration] usage-apikey-digest: could not ensure apiKeyHash column:", err?.message || err);
  }
}

export default {
  version: 4,
  name: "usage-apikey-digest",
  up(db) {
    // Migrations run BEFORE the additive schema sync (see runMigrationOnce), so
    // a column this migration writes to may not exist yet on the boot that
    // introduces it. Own it here instead of relying on the ordering.
    ensureApiKeyHashColumn(db);

    let rows = 0;
    try {
      const history = db.all(`SELECT id, apiKey FROM usageHistory WHERE apiKey IS NOT NULL AND apiKey != ''`);
      for (const row of history) {
        if (isMaskedApiKey(row.apiKey)) continue; // already converted
        db.run(`UPDATE usageHistory SET apiKey = ?, apiKeyHash = ? WHERE id = ?`, [
          maskApiKey(row.apiKey),
          hashApiKey(row.apiKey),
          row.id,
        ]);
        rows += 1;
      }
    } catch (err) {
      console.warn("[migration] usage-apikey-digest: history rows skipped:", err?.message || err);
    }

    let days = 0;
    try {
      const daily = db.all(`SELECT dateKey, data FROM usageDaily`);
      for (const day of daily) {
        let parsed;
        try {
          parsed = JSON.parse(day.data || "{}");
        } catch {
          continue;
        }
        const byApiKey = parsed?.byApiKey;
        if (!byApiKey || typeof byApiKey !== "object") continue;

        const rebuilt = {};
        let changed = false;
        for (const [key, entry] of Object.entries(byApiKey)) {
          if (!entry || typeof entry !== "object") {
            rebuilt[key] = entry;
            continue;
          }
          const raw = typeof entry.apiKey === "string" ? entry.apiKey : null;
          if (!raw && entry.apiKeyHash) {
            rebuilt[key] = entry; // already converted
            continue;
          }
          if (!raw) {
            rebuilt[key] = entry; // "local-no-key" bucket
            continue;
          }
          const { apiKey: _drop, ...rest } = entry;
          const apiKeyHash = hashApiKey(raw);
          // The map key used to embed the raw key.
          const rest0 = key.split("|");
          const suffix = rest0.length > 1 ? "|" + rest0.slice(1).join("|") : "";
          rebuilt[`${apiKeyHash || "local-no-key"}${suffix}`] = {
            ...rest,
            apiKeyHash,
            apiKeyMasked: maskApiKey(raw),
          };
          changed = true;
        }
        if (!changed) continue;
        db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify({ ...parsed, byApiKey: rebuilt }), day.dateKey]);
        days += 1;
      }
    } catch (err) {
      console.warn("[migration] usage-apikey-digest: daily aggregates skipped:", err?.message || err);
    }

    if (rows || days) {
      console.log(`[migration] usage-apikey-digest: rewrote ${rows} history row(s), ${days} day aggregate(s)`);
    }
  },
};
