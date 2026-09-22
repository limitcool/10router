// The usage log must not store usable API keys (issue #9, item 5).
//
// `usageHistory` is the largest, fastest-growing and most-shared table in the
// database — the one people screenshot, export and paste into issues — and it
// kept the complete `sk-…` value in every row, plus a second copy inside each
// per-day aggregate (`usageDaily.data`, both as a map key and in the entry).
//
// Nothing needs the key back: the log *groups* by key and *labels* it with the
// name from the apiKeys table, and both work off a digest. These tests pin the
// three halves that matter — nothing readable is stored, grouping/name lookup
// still work, and the migration converts what is already on disk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

const RAW_KEY = "sk-496f00bc7e460c8d-7if42g-960faa00";

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-key-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* OS temp reaper will collect it */ }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("key identity helpers", () => {
  it("masks while keeping the recognisable prefix", async () => {
    const { maskApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js");
    expect(maskApiKey(RAW_KEY)).toBe("sk-496f0***");
    expect(maskApiKey("short")).toBe("s***");
    expect(maskApiKey(null)).toBe(null);
    // Idempotent — a stored mask survives another round.
    expect(maskApiKey(maskApiKey(RAW_KEY))).toBe("sk-496f0***");
  });

  it("hashes deterministically and never reversibly", async () => {
    const { hashApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js");
    expect(hashApiKey(RAW_KEY)).toBe(hashApiKey(RAW_KEY));
    expect(hashApiKey(RAW_KEY)).toHaveLength(64);
    expect(hashApiKey(RAW_KEY)).not.toContain("496f00");
    expect(hashApiKey("other")).not.toBe(hashApiKey(RAW_KEY));
    expect(hashApiKey(null)).toBe(null);
  });

  it("recognises an already-masked value", async () => {
    const { isMaskedApiKey, maskApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js");
    expect(isMaskedApiKey(maskApiKey(RAW_KEY))).toBe(true);
    expect(isMaskedApiKey(RAW_KEY)).toBe(false);
  });
});

describe("what actually lands in the database", () => {
  it("stores a digest and a mask, never the key", async () => {
    await db.saveRequestUsage({
      provider: "stepfun-cn",
      model: "step-5-preview",
      connectionId: "c-1",
      apiKey: RAW_KEY,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat/completions",
      status: "ok",
      timestamp: "2026-09-21T10:00:00.000Z",
    });

    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();

    const row = adapter.get(`SELECT apiKey, apiKeyHash FROM usageHistory ORDER BY id DESC LIMIT 1`);
    expect(row.apiKey).toBe("sk-496f0***");
    expect(row.apiKeyHash).toHaveLength(64);

    // Nothing anywhere in the history table may contain the raw value.
    const all = adapter.all(`SELECT * FROM usageHistory`);
    expect(JSON.stringify(all)).not.toContain(RAW_KEY);

    // …nor in the per-day aggregate, neither as a value nor as a map key.
    const daily = adapter.all(`SELECT dateKey, data FROM usageDaily`);
    expect(daily.length).toBeGreaterThan(0);
    for (const d of daily) {
      expect(d.data).not.toContain(RAW_KEY);
      const parsed = JSON.parse(d.data);
      for (const key of Object.keys(parsed.byApiKey || {})) {
        expect(key).not.toContain(RAW_KEY);
      }
    }
  });

  it("still resolves the key's name from the apiKeys table", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { hashApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js");

    // createApiKey generates its own value; use it so the digest matches.
    const created = await createApiKey("Named Key", "machine-xyz");
    const realKey = created.key;
    await db.saveRequestUsage({
      provider: "stepfun-cn",
      model: "step-3.7-flash",
      connectionId: "c-2",
      apiKey: realKey,
      tokens: { prompt_tokens: 3, completion_tokens: 2 },
      endpoint: "/v1/chat/completions",
      status: "ok",
      timestamp: "2026-09-21T11:00:00.000Z",
    });

    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const row = adapter.get(`SELECT apiKeyHash FROM usageHistory WHERE model = 'step-3.7-flash'`);
    expect(row.apiKeyHash).toBe(hashApiKey(realKey));

    const stats = await db.getUsageStats("all");
    const entries = Object.values(stats.byApiKey);
    const named = entries.find((e) => e.keyName === "Named Key");
    expect(named, "the per-key aggregate should still know the key's name").toBeTruthy();
    expect(named.apiKeyMasked).toBe(realKey.slice(0, 8) + "***");
  });
});

describe("004-usage-apikey-digest migration", () => {
  beforeEach(async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`DELETE FROM usageHistory`);
    adapter.run(`DELETE FROM usageDaily`);
  });

  it("runs on a boot where the new column does not exist yet", async () => {
    // Migrations execute BEFORE the additive schema sync, so on the very boot
    // that introduces `apiKeyHash` the column is still missing. The first cut of
    // this migration relied on the column being there, its UPDATE threw, the
    // fail-open catch swallowed it and the history rows stayed in plain text
    // (the day aggregates, which need no new column, were converted — so the
    // failure was invisible). The migration now owns the column.
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const { maskApiKey, hashApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js");

    adapter.run(`DELETE FROM usageHistory`);
    // Simulate the pre-upgrade shape: no apiKeyHash column at all.
    adapter.exec(`DROP INDEX IF EXISTS idx_uh_apikey_hash`);
    // SQLite cannot drop a column in older versions, so rebuild the table.
    adapter.exec(`CREATE TABLE usageHistory_old AS SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory`);
    adapter.exec(`DROP TABLE usageHistory`);
    adapter.exec(`CREATE TABLE usageHistory(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER DEFAULT 0, completionTokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, status TEXT, tokens TEXT, meta TEXT)`);
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["2026-09-18T08:00:00.000Z", "stepfun-cn", "step-5-preview", "c-nocol", RAW_KEY, "/v1/chat/completions", 1, 1, 0, "ok", "{}", "{}"],
    );

    const cols = adapter.all(`PRAGMA table_info(usageHistory)`).map((c) => c.name);
    expect(cols).not.toContain("apiKeyHash");

    const { default: migration } = await import("@/lib/db/migrations/004-usage-apikey-digest.js");
    migration.up(adapter);

    const row = adapter.get(`SELECT apiKey, apiKeyHash FROM usageHistory WHERE connectionId = 'c-nocol'`);
    expect(row.apiKey).toBe(maskApiKey(RAW_KEY));
    expect(row.apiKeyHash).toBe(hashApiKey(RAW_KEY));
  });

  it("rewrites legacy rows and day aggregates, and is idempotent", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const { hashApiKey, maskApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js");

    // Legacy shapes: a raw key in the row, and a day aggregate keyed by it.
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["2026-09-20T09:00:00.000Z", "stepfun-cn", "step-5-preview", "c-old", RAW_KEY, "/v1/chat/completions", 7, 3, 0, "ok", "{}", "{}"],
    );
    adapter.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
      "2026-09-20",
      JSON.stringify({
        requests: 1,
        promptTokens: 7,
        completionTokens: 3,
        byApiKey: {
          [`${RAW_KEY}|step-5-preview|stepfun-cn`]: {
            requests: 1,
            promptTokens: 7,
            completionTokens: 3,
            cachedTokens: 0,
            cost: 0,
            rawModel: "step-5-preview",
            provider: "stepfun-cn",
            apiKey: RAW_KEY,
          },
        },
      }),
    ]);

    const { default: migration } = await import("@/lib/db/migrations/004-usage-apikey-digest.js");
    migration.up(adapter);

    const row = adapter.get(`SELECT apiKey, apiKeyHash FROM usageHistory WHERE connectionId = 'c-old'`);
    expect(row.apiKey).toBe(maskApiKey(RAW_KEY));
    expect(row.apiKeyHash).toBe(hashApiKey(RAW_KEY));

    const day = adapter.get(`SELECT data FROM usageDaily WHERE dateKey = '2026-09-20'`);
    expect(day.data).not.toContain(RAW_KEY);
    const parsed = JSON.parse(day.data);
    const keys = Object.keys(parsed.byApiKey);
    expect(keys).toEqual([`${hashApiKey(RAW_KEY)}|step-5-preview|stepfun-cn`]);
    const entry = parsed.byApiKey[keys[0]];
    expect(entry.apiKey).toBeUndefined();
    expect(entry.apiKeyHash).toBe(hashApiKey(RAW_KEY));
    expect(entry.apiKeyMasked).toBe(maskApiKey(RAW_KEY));
    // The aggregate itself is preserved.
    expect(entry.requests).toBe(1);
    expect(entry.promptTokens).toBe(7);

    // Running it again changes nothing (the framework also stamps the version).
    const before = day.data;
    migration.up(adapter);
    expect(adapter.get(`SELECT data FROM usageDaily WHERE dateKey = '2026-09-20'`).data).toBe(before);
  });

  it("keeps a legacy day aggregate usable for the key name", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const created = await createApiKey("Legacy Named", "machine-legacy");

    adapter.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
      "2026-09-19",
      JSON.stringify({
        requests: 2,
        promptTokens: 20,
        completionTokens: 4,
        byApiKey: {
          [`${created.key}|step-5-preview|stepfun-cn`]: {
            requests: 2,
            promptTokens: 20,
            completionTokens: 4,
            cachedTokens: 0,
            cost: 0,
            rawModel: "step-5-preview",
            provider: "stepfun-cn",
            apiKey: created.key,
          },
        },
      }),
    ]);

    const { default: migration } = await import("@/lib/db/migrations/004-usage-apikey-digest.js");
    migration.up(adapter);

    const stats = await db.getUsageStats("all");
    const named = Object.values(stats.byApiKey).find((e) => e.keyName === "Legacy Named");
    expect(named, "name lookup must survive the rewrite").toBeTruthy();
    expect(named.apiKeyMasked).toBe(created.key.slice(0, 8) + "***");
    expect(adapter.get(`SELECT data FROM usageDaily WHERE dateKey = '2026-09-19'`).data).not.toContain(created.key);
  });
});
