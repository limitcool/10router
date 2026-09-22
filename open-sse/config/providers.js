// Barrel: PROVIDERS now built from providers/registry (transport co-located with models)
import { PROVIDERS } from "../providers/index.js";
export { PROVIDERS, PROVIDER_OAUTH } from "../providers/index.js";

export const OLLAMA_LOCAL_DEFAULT_HOST = "http://localhost:11434";

export function resolveOllamaLocalHost(credentials) {
  const raw = credentials?.providerSpecificData?.baseUrl?.trim();
  return (raw || OLLAMA_LOCAL_DEFAULT_HOST).replace(/\/$/, "");
}

// Region URLs single-source from registry xiaomi-tokenplan.transport
export const XIAOMI_TOKENPLAN_REGIONS = PROVIDERS["xiaomi-tokenplan"]?.regions || {};
export const XIAOMI_TOKENPLAN_DEFAULT_REGION = PROVIDERS["xiaomi-tokenplan"]?.defaultRegion;

/**
 * Normalize any MiMo endpoint a connection may carry — the OAuth payload's `url`
 * (what MiMo Desktop stores in auth.json metadata.base_url), a region URL, or a
 * value from a credential transfer — to its `https://host/v1` API base.
 * Returns "" for anything unparseable so callers can fall back cleanly.
 */
export function normalizeMimoApiBase(raw) {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) return "";
  s = s.replace(/\/chat\/completions$/i, "");
  s = s.replace(/\/anthropic\/v1\/messages$/i, "");
  s = s.replace(/\/models$/i, "");
  s = s.replace(/\/v1\/.*$/i, "/v1");
  if (!s) return "";
  if (/\/anthropic$/i.test(s)) s = s.replace(/\/anthropic$/i, "");
  return /\/v1$/i.test(s) ? s : `${s}/v1`;
}

export function resolveXiaomiTokenplanBaseUrl(credentials) {
  // xiaomi-tokenplan is a region-based manual-key provider: the cluster is chosen
  // by the user's `region`, NOT by a stored baseUrl (which would be the billing
  // host by default and misroute plan keys). Base-provider plan routing lives in
  // the xiaomi-mimo executor, which reads psd.baseUrl directly.
  const region = credentials?.providerSpecificData?.region;
  return XIAOMI_TOKENPLAN_REGIONS[region] || XIAOMI_TOKENPLAN_REGIONS[XIAOMI_TOKENPLAN_DEFAULT_REGION];
}
