import path from "node:path";
import fs from "node:fs";
import { DATA_DIR, LEGACY_JSON_FILES } from "@/lib/dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
// Where the CLI installs the runtime copy of better-sqlite3 as an npm project:
// cli/hooks/sqliteRuntime.js → <dataDir>/runtime (getDataDir matches this
// module's DATA_DIR). driver.js resolves it by absolute path so a broken copy
// earlier in the global tree / NODE_PATH cannot shadow it.
export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export function getRuntimeNodeModulesDir() {
  return path.join(RUNTIME_DIR, "node_modules");
}
export const LEGACY_FILES = Object.fromEntries(
  Object.entries(LEGACY_JSON_FILES).map(([key, name]) => [key, path.join(DATA_DIR, name)]),
);
export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
