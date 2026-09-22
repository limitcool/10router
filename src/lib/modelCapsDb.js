// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  getModelCapsForProvider, getAllModelCaps, setModelCaps, clearModelCaps,
} from "@/lib/db/index.js";
