import path from "node:path";
import { ensureDirs, DATA_FILE, RUNTIME_DIR } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false, lastDriverError: null };
const state = global._dbAdapter;

/**
 * Resolve better-sqlite3, preferring the runtime copy the CLI installed into
 * <dataDir>/runtime/node_modules (cli/hooks/sqliteRuntime.js).
 *
 * Resolving it by ABSOLUTE path is the point: the app lives under
 * <prefix>/lib/node_modules/@techysy/10router/app, and Node walks that tree
 * UPWARD before it ever consults NODE_PATH — so a stale or half-built
 * better-sqlite3 anywhere above us silently shadows the good runtime copy and
 * we drop to node:sqlite. Falls back to the bare specifier so nothing breaks
 * when the runtime copy is absent.
 *
 * @returns {Promise<Function|null>} the Database constructor, or null if absent
 */
export async function loadBetterSqlite() {
  try {
    const { createRequire } = await import("node:module");
    // Base the resolver one level ABOVE node_modules (a fictitious file inside
    // <dataDir>/runtime) so the first lookup is exactly
    // <dataDir>/runtime/node_modules/better-sqlite3.
    const runtimeRequire = createRequire(path.join(RUNTIME_DIR, "_noop.js"));
    const mod = runtimeRequire("better-sqlite3");
    return mod?.default ?? mod;
  } catch {
    /* fall through to the bare specifier */
  }
  try {
    const mod = await import("better-sqlite3");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

async function tryBunSqlite() {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    state.lastDriverError = `bun:sqlite: ${e.message}`;
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite() {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  // Skip on Node >= 24: the native addon SIGSEGVs on load there, which is a
  // process-level crash the try/catch below cannot recover from. node:sqlite covers it.
  const [nodeMajor] = process.versions.node.split(".").map(Number);
  if (nodeMajor >= 24) return null;
  try {
    const Database = await loadBetterSqlite();
    if (!Database) throw new Error("not installed (runtime copy and bare specifier both missing)");
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE, Database);
  } catch (e) {
    state.lastDriverError = `better-sqlite3: ${e.message}`;
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    state.lastDriverError = `node:sqlite: ${e.message}`;
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    state.lastDriverError = `sql.js: ${e.message}`;
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
