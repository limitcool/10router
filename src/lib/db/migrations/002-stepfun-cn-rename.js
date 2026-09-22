// Rename the first-party StepFun provider id `stepfun` → `stepfun-cn`.
//
// StepFun ships two independent channels per host: the standard API (`/v1`,
// billed against cash/voucher balance) and Step Plan (`/step_plan/v1`, billed
// against subscription Credits). They also run separate China (`api.stepfun.com`)
// and international (`api.stepfun.ai`) deployments. The registry now models all
// four, with the bare names reserved for the international site — so the
// original `stepfun` entry (which pointed at api.stepfun.com) becomes
// `stepfun-cn`.
//
// Every provider id that survived a release used to mean the China host, so
// renaming persisted rows forward is the only correct mapping. Without this,
// an existing connection would be re-interpreted as the international provider
// (different host, different key partition → 401), and disabled-model / caps
// rows would silently attach to the wrong channel.
//
// Idempotent by construction: after the first run the old keys no longer exist,
// and the migration framework stamps schemaVersion so it never runs twice.

const OLD_ID = "stepfun";
const NEW_ID = "stepfun-cn";

export default {
  version: 2,
  name: "stepfun-cn-rename",
  up(db) {
    // 1. Connections
    db.run(`UPDATE providerConnections SET provider = ? WHERE provider = ?`, [NEW_ID, OLD_ID]);

    // 2. kv rows keyed by provider id: disabledModels (key = id),
    //    modelCaps (key = `${id}|${modelId}`), customModels (key = `${id}|${model}|${kind}`).
    db.run(`UPDATE kv SET key = ? WHERE scope = 'disabledModels' AND key = ?`, [NEW_ID, OLD_ID]);
    for (const scope of ["modelCaps", "customModels"]) {
      db.run(
        `UPDATE kv SET key = ? || substr(key, ?) WHERE scope = ? AND key LIKE ?`,
        [NEW_ID, OLD_ID.length + 1, scope, `${OLD_ID}|%`],
      );
    }

    // 3. settings JSON: provider-keyed maps/arrays that persisted the old id.
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    if (!row?.data) return;
    let settings;
    try {
      settings = JSON.parse(row.data);
    } catch {
      return;
    }
    if (!settings || typeof settings !== "object") return;

    let changed = false;
    if (Array.isArray(settings.providerCardOrder)) {
      const next = settings.providerCardOrder.map((p) => (p === OLD_ID ? NEW_ID : p));
      if (next.some((p, i) => p !== settings.providerCardOrder[i])) {
        settings.providerCardOrder = next;
        changed = true;
      }
    }
    for (const mapKey of ["topologyVisibility", "providerStrategies"]) {
      const map = settings[mapKey];
      if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, OLD_ID)) {
        if (!(NEW_ID in map)) map[NEW_ID] = map[OLD_ID];
        delete map[OLD_ID];
        changed = true;
      }
    }
    if (changed) {
      db.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify(settings)]);
    }
  },
};
