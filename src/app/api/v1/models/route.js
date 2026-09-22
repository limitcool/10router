import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  ALIAS_TO_ID,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { buildProviderOrderComparator } from "@/shared/utils/modelListOrder";
import { getProviderConnections, getProviderNodes, getCombos, getCustomModels, getModelAliases, getSettings } from "@/lib/localDb";
import { getAllModelCaps } from "@/lib/modelCapsDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels } from "open-sse/services/clinepassModels.js";
import { resolveClineModels } from "open-sse/services/clineModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { capabilitiesFromServiceKind, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const STATIC_CL = PROVIDER_ID_TO_ALIAS["cline"] || "cline";

const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => {
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {}
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models.map((m) => ({ id: m.id, name: m.name })),
    };
  },
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    // Static paid list (registry) UNION live free shelf: the
    // recommended-models feed only carries the rotating free tier (plus
    // clinePass, which belongs to the clinepass provider), so overriding here
    // would hide the paid models. On fetch failure return null and let the
    // static list stand alone.
    const staticModels = (PROVIDER_MODELS[STATIC_CL] || [])
      .filter((m) => m?.id)
      .map((m) => ({ id: m.id, name: m.name || m.id }));
    const result = await resolveClineModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      email: conn.email,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    const seen = new Set(staticModels.map((m) => m.id));
    const merged = [...staticModels];
    for (const m of result.models) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push({ id: m.id, name: m.name || m.id });
    }
    return { models: merged };
  },
  "grok-cli": async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
      },
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          ...refreshed,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Header sent by fetchCompatibleModelIds to detect cross-instance /models fetches
// and break recursive loops between 10router instances connected to each other.
const INTERNAL_MODELS_FETCH_HEADER = "x-9r-internal-models-fetch";

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

async function fetchCompatibleModelIds(connection) {
  if (!connection?.apiKey) return [];

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "GET",
      headers: { ...headers, [INTERNAL_MODELS_FETCH_HEADER]: "1" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();
    const rawModels = parseOpenAIStyleModels(data);

    return Array.from(
      new Set(
        rawModels
          .map((model) => model?.id || model?.name || model?.model)
          .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
      )
    );
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// Positive-integer coercion for user-entered/stored token counts (may arrive
// as strings from custom model rows); null when absent or invalid.
const posNum = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 */
export async function buildModelsList(kindFilter, options = {}) {
  // When this header is present, the /v1/models request came from another
  // 10router instance's fetchCompatibleModelIds — skip dynamic fetch to break
  // cross-instance recursive loops.
  const skipDynamicFetch = options.skipDynamicFetch === true;
  let connections = [];
  // Distinguish "DB healthy but with no connections" from "DB unavailable".
  // `getProviderConnections()` returns [] for a healthy DB with no provider
  // connections and throws only when the DB itself is unreachable. The
  // static-catalog fallback below is meant for the latter; a healthy DB with
  // zero connections must NOT dump every built-in model onto the client
  // (hundreds of mostly-unusable entries) — only expose what the user has
  // explicitly added via custom models / combos.
  let dbAvailable = true;
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    dbAvailable = false;
    console.log("Could not fetch providers, returning all models");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  // Valid custom-provider node IDs (openai/anthropic-compatible nodes). Used to
  // filter orphan customModels whose providerAlias points at a node that no
  // longer exists (the node was deleted but its customModels were left behind,
  // e.g. after importing an older 9router DB). Those orphans would otherwise be
  // dumped into /v1/models for every client.
  let providerNodes = [];
  try {
    providerNodes = await getProviderNodes();
  } catch (e) {
    console.log("Could not fetch provider nodes");
  }
  const validNodeIds = new Set(providerNodes.map((n) => n.id));

  // Every valid provider identifier (id or alias) from the static registry, so a
  // customModel keyed by either form is treated as legitimate (e.g. noAuth free
  // provider `oc` = opencode alias).
  const validProviderIds = new Set();
  for (const p of Object.values(AI_PROVIDERS)) {
    if (!p) continue;
    if (p.id) validProviderIds.add(p.id);
    if (p.alias) validProviderIds.add(p.alias);
  }

  // A customModel's providerAlias is legitimate when it resolves to a real
  // provider (built-in id or alias) OR to a custom provider node that both
  // exists AND has an active connection. Anything else is an orphan (deleted
  // node) or a dead node (connection disabled) and must not surface in /v1/models.
  const isCompatibleNodeId = (alias) =>
    typeof alias === "string" &&
    (alias.startsWith("openai-compatible-") || alias.startsWith("anthropic-compatible-"));
  const isValidCustomAlias = (alias) => {
    if (typeof alias !== "string" || alias.trim() === "") return false;
    const a = alias.trim();
    if (validProviderIds.has(a)) return true;
    if (isCompatibleNodeId(a)) {
      // Custom node: must exist AND have an active connection to expose models.
      return validNodeIds.has(a) && activeConnectionByProvider.has(a);
    }
    return false;
  };

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  // The user's latest provider order: settings.providerCardOrder is written by
  // the dashboard's drag-and-drop card reordering (array of provider ids). The
  // model list must expose providers in that same order — otherwise clients
  // keep seeing raw DB insertion order while the UI says something else.
  // One final rank sort (see emit/ordered at the bottom) is the single source
  // of ordering, so connected providers and noAuth orphan custom models
  // interleave exactly like the dashboard (where visible noAuth share the top
  // rank with connected). Tie-breaks mirror the dashboard comparator via the
  // shared helper: manual order → registry priority → name.
  let providerCardOrder = [];
  try {
    const settings = await getSettings();
    if (Array.isArray(settings?.providerCardOrder)) providerCardOrder = settings.providerCardOrder;
  } catch (e) {
    console.log("Could not fetch provider card order:", e?.message);
  }
  // User-pinned per-model context window / max output (dashboard overrides).
  // Published under every provider name spelling, like getDisabledModels().
  // Fail-open: clients may not override anything, but must still get a list.
  let capsOverrides = {};
  try {
    const ov = await getAllModelCaps();
    if (ov && typeof ov === "object") capsOverrides = ov;
  } catch (e) {
    console.log("Could not fetch model caps overrides:", e?.message);
  }
  const compareProviders = buildProviderOrderComparator({
    cardOrder: providerCardOrder,
    aliasToId: ALIAS_TO_ID,
    priorityOf: (id) => AI_PROVIDERS[id]?.priority,
  });
  // Resolve every provider that can appear in this response to one ordinal up
  // front, ranked together by the comparator — so connected providers and
  // noAuth orphan custom models interleave under exactly the dashboard's rule
  // (visible noAuth shares the top card rank with connected).
  const canonicalProvider = (idOrAlias) => ALIAS_TO_ID[idOrAlias] || idOrAlias;
  const groupRank = new Map();
  {
    const present = new Set(activeConnectionByProvider.keys());
    for (const cm of customModels) {
      if (cm?.id && cm?.providerAlias) present.add(String(cm.providerAlias));
    }
    if (connections.length === 0 && !dbAvailable) {
      for (const alias of Object.keys(PROVIDER_MODELS)) present.add(alias);
    }
    [...present].sort(compareProviders).forEach((key, i) => {
      const cid = canonicalProvider(key);
      if (!groupRank.has(cid)) groupRank.set(cid, i);
    });
  }
  const COMBO_RANK = -1; // combos lead the list, ahead of every provider group
  const rankOf = (idOrAlias) => {
    const r = groupRank.get(canonicalProvider(idOrAlias || ""));
    return r === undefined ? Number.MAX_SAFE_INTEGER : r;
  };

  // Tagged accumulator: final list = stable sort by (rank, seq), so a
  // provider's own models keep insertion order while the provider groups
  // themselves land in the user's card order. This replaces pushing into one
  // array in loop order, which could not interleave orphan providers.
  const tagged = [];
  let seq = 0;
  const emit = (model, rank) => { tagged.push({ model, rank, seq: seq++ }); };
  const orderedModels = () => {
    tagged.sort((a, b) => (a.rank - b.rank) || (a.seq - b.seq));
    return tagged.map((t) => t.model);
  };

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    }
    emit(entry, COMBO_RANK);
  }

  if (connections.length === 0) {
    // Only when the DB itself is unavailable do we fall back to the full
    // static catalog (filtered by per-model kind). A healthy DB with zero
    // connections means the user hasn't set up any provider yet — exposing all
    // built-in models there would flood the client with hundreds of entries
    // that mostly can't be used (e.g. OpenCode seeing 600+ models when only a
    // few free ones were configured). Custom models/combos the user explicitly
    // added are still exposed below.
    if (!dbAvailable) {
      const aliasToProviderId = Object.fromEntries(
        Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
      );
      for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
        const providerId = aliasToProviderId[alias] || alias;
        if (!providerMatchesKinds(providerId, kindFilter)) continue;
        for (const model of providerModels) {
          if (!kindFilter.includes(modelKind(model))) continue;
          if (isDisabled(alias, model.id)) continue;
          emit({
            id: `${alias}/${model.id}`,
            object: "model",
            owned_by: alias,
          }, rankOf(providerId));
        }
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Disabled custom models (e.g. newly fetched from a JSON catalog) are not
      // exposed to clients until the user enables them.
      if (customModel.enabled === false) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!isValidCustomAlias(providerAlias)) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      const entry = {
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      };
      // Fix: honor the stored contextWindow/maxOutput of user-added custom
      // models (previously dropped here), with the dashboard override on top.
      const pinned = capsOverrides[providerAlias]?.[modelId];
      const cw = pinned?.contextWindow ?? posNum(customModel.contextWindow);
      const mo = pinned?.maxOutput ?? posNum(customModel.maxOutput);
      if (cw) entry.context_length = cw;
      if (mo) entry.max_completion_tokens = mo;
      emit(entry, rankOf(providerAlias));
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();

      let rawModelIds;
      rawModelIds = hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) => typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      // Dynamic upstream fetch for compatible nodes. This is a credential-backed
      // discovery operation, not a user-imported model catalog.
      if (isCompatibleProvider && rawModelIds.length === 0 && !skipDynamicFetch) {
        rawModelIds = await fetchCompatibleModelIds(conn);
      }

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
      if (liveResolver && !hasExplicitEnabledModels) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length) {
            rawModelIds = live.models.map((m) => m.id);
            liveModelKindById = new Map(
              live.models
                .filter((m) => m?.id)
                .map((m) => [m.id, modelKind(m)])
            );
            liveCapabilitiesById = new Map(
              live.models
                .filter((m) => m?.id && m.capabilities)
                .map((m) => [m.id, m.capabilities])
            );
          }
        } catch (err) {
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelCapsById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          // Fetched/imported custom models default to disabled; honor that flag
          // here too (the zero-connection branch below already does).
          if (m.enabled === false) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) {
            customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
            customModelCapsById.set(modelId, m);
          }
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));
      // Dashboard-pinned caps for this provider, under any name spelling.
      const providerCaps =
        capsOverrides[providerId] || capsOverrides[staticAlias] || capsOverrides[outputAlias] || null;

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const kind = customKind || liveKind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Fall back to the same
        // pattern-matched capabilities the dashboard uses (useModelCaps.js) so
        // dynamically-discovered LLM models still surface vision/reasoning/search/tools.
        const globalCaps = kind === LLM_KIND ? getCapabilitiesForModel(providerId, modelId) : null;
        const serviceCaps = capabilitiesFromServiceKind(customKind || liveKind);
        const discoveredCaps = liveCapabilitiesById.get(modelId);
        const caps = globalCaps
          ? { ...globalCaps, ...(serviceCaps || {}), ...(discoveredCaps || {}) }
          : (serviceCaps || discoveredCaps || null);
        if (caps) model.capabilities = caps;
        // Token limits under the snake_case names the OpenAI/OpenRouter
        // convention uses. `capabilities.contextWindow` is camelCase and nested,
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          // A user-added custom model's stored window belongs to THIS model, so
          // it beats the generic catalog default; an explicit dashboard
          // override (modelCaps) beats everything.
          const customRow = customModelCapsById.get(modelId);
          if (customRow) {
            const c = posNum(customRow.contextWindow);
            const o = posNum(customRow.maxOutput);
            if (c) contextWindow = c;
            if (o) maxOutput = o;
          }
          const pinned = providerCaps?.[modelId];
          if (pinned?.contextWindow) contextWindow = pinned.contextWindow;
          if (pinned?.maxOutput) maxOutput = pinned.maxOutput;
          // Keep the nested block in sync with the snake_case values above.
          if (caps) {
            if (Number.isFinite(contextWindow)) caps.contextWindow = contextWindow;
            if (Number.isFinite(maxOutput)) caps.maxOutput = maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
        }
        emit(model, rankOf(providerId));
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        emit({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        }, rankOf(providerId));
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        emit({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        }, rankOf(providerId));
      }
    }
  }

  // Orphan custom models: custom models whose providerAlias has no active
  // connection (e.g. noAuth free providers like opencode — they never create
  // connection records, so the per-connection loop above never sees them).
  // Without this branch, adding oc/mimo-v2.5-free works in the dashboard but
  // the model never shows up in /v1/models for clients.
  if (connections.length > 0) {
    const connectedAliases = new Set();
    for (const [providerId] of activeConnectionByProvider.entries()) {
      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      connectedAliases.add(staticAlias);
      const alias = getProviderAlias(providerId);
      if (alias) connectedAliases.add(alias);
      connectedAliases.add(providerId);
      const conn = activeConnectionByProvider.get(providerId);
      const prefix = conn?.providerSpecificData?.prefix;
      if (prefix) connectedAliases.add(String(prefix).trim());
    }
    for (const customModel of customModels) {
      if (!customModel?.id) continue;
      // Fetched/imported custom models default to disabled; honor the flag here too.
      if (customModel.enabled === false) continue;
      const kind = getModelKind(customModel) || LLM_KIND;
      if (!kindFilter.includes(kind)) continue;
      const alias = String(customModel.providerAlias || "").trim();
      if (!alias || connectedAliases.has(alias)) continue;
      // Drop customModels whose alias points at a deleted provider node (orphan
      // left behind by a failed import or node deletion). Keep only those tied
      // to a real provider or an existing node.
      if (!isValidCustomAlias(alias)) continue;
      const modelId = String(customModel.id).trim();
      if (!modelId) continue;
      if (isDisabled(alias, modelId)) continue;
      const entry = {
        id: `${alias}/${modelId}`,
        object: "model",
        owned_by: alias,
      };
      const pinned = capsOverrides[alias]?.[modelId];
      const cw = pinned?.contextWindow ?? posNum(customModel.contextWindow);
      const mo = pinned?.maxOutput ?? posNum(customModel.maxOutput);
      if (cw) entry.context_length = cw;
      if (mo) entry.max_completion_tokens = mo;
      emit(entry, rankOf(alias));
    }
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of orderedModels()) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    // Detect cross-instance recursive /models fetch (another 10router fetching our /models)
    const skipDynamicFetch = request?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1";
    const data = await buildModelsList([LLM_KIND], { skipDynamicFetch });
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
