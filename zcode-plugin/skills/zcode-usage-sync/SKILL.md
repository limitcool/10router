---
name: zcode-usage-sync
description: Export ZCode, OpenCode, mirasim, Xiaomi MiMo's local model-usage ledger, or another 10Router/9Router instance's usage into 10Router via /api/settings/database/import-usage. Use when the user asks to 导出/同步/导入 ZCode/OpenCode/mirasim/小米MiMo 使用量到 10Router, sync usage from another 10Router/9Router instance (NAS/9r 备份/第二个实例汇总), sync zcode/mimo usage, export usage to 10router, or asks how much they used ZCode/mirasim/MiMo and wants it recorded in 10Router stats. OpenCode via --source opencode, mirasim via --source mirasim, Xiaomi MiMo via --source mimo, another router instance via --source 10r (--db for its data.sqlite).
---

# Usage Sync → 10Router

Export this machine's ZCode **or OpenCode** **or mirasim** **or Xiaomi MiMo** model-usage ledger — or another 10Router/9Router instance's own database — into 10Router's usage statistics.

## Preconditions (check before running)

1. **10Router endpoint** — default `http://127.0.0.1:20127`. If the user runs 10Router elsewhere (NAS, LAN), ask or infer from context. For a NAS/remote instance use its address, e.g. `http://192.168.31.101:20127`. *(Online modes only — `--export` needs neither endpoint nor credentials.)*
2. **Source** — `--source zcode` (default), `--source opencode` (opencode.ai desktop app), `--source mirasim` (mirasim desktop insights ledger), `--source mimo` (Xiaomi MiMo desktop / mimocode), or `--source 10r` (another 10Router/9Router instance's `data.sqlite`; aliases `10router` / `9r` / `9router`). None but zcode is auto-detected — pass the flag explicitly.
3. **Credential (one of)** —
   - Virtual key (recommended): created in 10Router dashboard → API Keys, format `sk-…`. Pass via `--key`.
   - Dashboard password: pass via `--password`.
   - The script also reads env vars `TENROUTER_ENDPOINT` / `TENROUTER_KEY` / `TENROUTER_PASSWORD`.
4. Never ask the user to paste credentials into chat if they already configured them; prefer env/config over interactive prompts.

## Run

**Choose the mode first**: if this machine can reach the 10Router endpoint (same
LAN / localhost / tunnel), sync online. If it **cannot** (different network, no
route to the instance), export offline instead — write a JSON file here, the
user carries it to any machine that can reach 10Router, and imports there.

### Online (direct)

Dry-run first (shows row counts per provider, imports nothing):

```bash
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --endpoint <URL> --key <sk-…> --dry-run
```

Then import:

```bash
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --endpoint <URL> --key <sk-…>
```

### OpenCode (opencode.ai desktop)

OpenCode stores usage in `~/.local/share/opencode/opencode.db` (Linux/macOS)
or `%LOCALAPPDATA%\opencode\opencode.db` (Windows). Use `--source opencode`:

```bash
# Offline export
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source opencode --export opencode-usage.json

# Online dry-run
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source opencode --endpoint <URL> --key <sk-…> --dry-run

# Online import
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source opencode --endpoint <URL> --key <sk-…>
```

### mirasim desktop

mirasim stores per-call usage in `~/.mirasim/insights/usage-YYYY-MM.ndjson` with full
token metering (input/output/cacheRead/cacheWrite/reasoning). Use `--source mirasim`:

```bash
# Offline export
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source mirasim --export mirasim-usage.json

# Online dry-run
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source mirasim --endpoint <URL> --key <sk-…> --dry-run

# Online import
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source mirasim --endpoint <URL> --key <sk-…>
```

Rows land under provider `mirasim-<protocol>` (mirasim-anthropic / mirasim-openai-responses /
mirasim-openai-chat), cost 0 (plan-based relay). Failed calls without token consumption are
skipped automatically; agent/leg/upstreamHost/effort/repo/workspace details ride in `meta`.

### Xiaomi MiMo desktop (mimocode)

Xiaomi MiMo desktop stores per-message usage in `~/.local/share/mimocode/mimocode.db`
(`message` table, JSON `data` column: assistant messages carry
input/output/reasoning/cache.read/cache.write plus modelID/providerID/agent/mode).
Use `--source mimo` (alias `--source mimocode`):

```bash
# Offline export
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source mimo --export mimo-usage.json

# Online dry-run
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source mimo --endpoint <URL> --key <sk-…> --dry-run

# Online import
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source mimo --endpoint <URL> --key <sk-…>
```

Rows land under provider `mimo-<providerID>` (mimo-xiaomi / mimo-mimo), cost 0 (plan-based);
0-token (empty/aborted) turns are skipped automatically; message/session/agent/mode details
ride in `meta`.

### Another 10Router / 9Router instance (--source 10r)

Aggregates a **second router instance's** own ledger (NAS box, sibling relay, a legacy
9Router install) into the dashboard you watch. The source instance's `data.sqlite`
`usageHistory` rows are already in the import shape — pass-through, cost/status/provider
preserved as-is, so same-named providers merge naturally in the target.

```bash
# Auto-discovery: %APPDATA%\10router|9router\db\data.sqlite or ~/.10router|~/.9router/db/data.sqlite
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source 10r --endpoint <URL> --key <sk-…> --dry-run

# Explicit db (NAS copy, mounted share, file copied over)
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source 10r --db /path/to/data.sqlite --endpoint <URL> --key <sk-…>

# Offline export / import elsewhere
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --source 10r --db /path/to/data.sqlite --export 10r-usage.json
```

Details: the source's `connectionId` is a foreign uuid — moved to
`meta.sourceConnectionId` and nulled so the target's byAccount view stays clean;
`meta.syncedFrom` records the source db path (or `--tag <label>`). Rows that were
**native** on the source instance additionally get `meta.gatewaySync = true` — the target's
health scoring excludes imported rows by default, but a gateway-synced row is a real
observation (real status codes) and does participate; rows the source instance had itself
imported from a client ledger never get the marker and stay excluded however far they
travel. `--limit N` keeps the newest N rows. Reading a live instance's db is snapshot-based
(may miss the final seconds of traffic) — no need to stop the source.

**Same-instance guard**: the script refuses (`exit 2`) to import a db that looks like it
belongs to the very instance behind a loopback `--endpoint` — every row would dedup-hit
and the server stamps `meta.imported=true` on dedup hits, relabeling all LIVE rows as
imports. The guard covers **both paths**: direct online import, and re-importing an
offline JSON that records the local instance's path in `meta.sourceDbPath` (every 10r
export stamps it, independent of `--tag`). If it really is a different instance, re-run
with `--force`. **Do not** sync an instance whose upstream traffic is fed *by* the target
instance — chained rows have different signatures, the server dedup cannot catch that,
and it double-counts.

### Offline (export JSON, import elsewhere)

On the ZCode machine (no network, no credentials needed):

```bash
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --export zcode-usage.json
```

The user carries `zcode-usage.json` to a machine that can reach 10Router, then:

```bash
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --import zcode-usage.json --endpoint <URL> --key <sk-…>
```

The file is also loadable directly from the 10Router dashboard (Settings →
database backup section → JSON usage import).

Notes:
- The script is **idempotent**: 10Router dedups by row signature, so re-running never duplicates rows.
- **zcode source exports OFFICIAL channels only** (`builtin:*` — bigmodel / zai / … — plus
  `account:*`, the subscription-plan channels a recent ZCode major release introduced; plan
  quota traffic like `builtin:bigmodel-start-plan` now lands as `account:bigmodel-start-plan`).
  Everything else is a user-added custom provider; in this setup they all point at local gateways
  whose traffic is already counted by 10Router itself or another sync source, so exporting them
  would double-count. The skip is structural (immune to provider delete+re-add changing the id)
  and prints per-provider counts. `--include-custom` restores the old behavior when needed.
- Each row becomes provider `zcode-<name>` in 10Router, cost 0 (subscription plans), with agent/session metadata under `meta`.
- `--limit N` exports only the newest N rows; `--quiet` suppresses progress output.

## After running

Report the result line (`imported X, skipped Y`) and remind the user the numbers appear on the 10Router dashboard (Usage section) under the `zcode-*` / `opencode-*` / `mirasim-*` / `mimo-*` providers — for `--source 10r` the source instance's own provider names, merged with any same-named providers already in the target.

## Troubleshooting

- `HTTP 401 Invalid password` → key revoked or wrong password; create a new virtual key in the dashboard.
- `HTTP 401 Unauthorized` (error text "Unauthorized") → request was blocked by the global guard before reaching the route — means neither key nor password header reached it — check the script's auth flags.
- `connection refused` → wrong endpoint or 10Router not running.
- `no ZCode db.sqlite found` → ZCode has never recorded usage on this machine.
- `no 10Router/9Router db found` (`--source 10r`) → no instance db at the default paths; point at the file with `--db <path/to/data.sqlite>`.
- `looks like the database of the very instance behind <endpoint>` → same-instance guard fired; pick the other instance's db with `--db`, or `--force` if it really is a different instance.

## Repairing a 10Router usage database (wrongly imported rows)

If previously-imported rows are wrong (e.g. gateway traffic that was double-counted),
remove them with the bundled tools — **never DELETE by hand**: `usageDaily` day buckets
are maintained incrementally and nothing rebuilds them from `usageHistory`, so a raw
delete leaves the dashboard reporting phantom numbers. A hand-written rebuild is worse:
buckets are keyed by the **server's LOCAL date** (not the UTC date part) and carry **five**
aggregation dimensions (byProvider/byModel/byAccount/byApiKey/byEndpoint) — missing either
detail silently corrupts the numbers.

```bash
# read-only health check (safe anytime): integrity + usageDaily↔usageHistory fidelity + counter
node "$ZCODE_PLUGIN_ROOT/scripts/verify-usage-db.mjs" /path/to/data.sqlite

# dry report, optionally backing up the rows about to be removed
node "$ZCODE_PLUGIN_ROOT/scripts/clean-usage-db.mjs" /path/to/data.sqlite --provider zcode-xxxx --export removed.json

# perform the surgery (self-verifies; exits 1 and tells you to roll back if it fails)
node "$ZCODE_PLUGIN_ROOT/scripts/clean-usage-db.mjs" /path/to/data.sqlite --provider zcode-xxxx --apply

# re-check
node "$ZCODE_PLUGIN_ROOT/scripts/verify-usage-db.mjs" /path/to/data.sqlite
```

**Stop the 10Router service first** (or operate on a copy) — the app holds the database open
and concurrent writers corrupt it. `--where "<sql predicate>"` is available for filters other
than a single provider. Node 22 needs `--experimental-sqlite`; Node 24+ does not.
