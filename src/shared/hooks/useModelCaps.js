"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null; // { byFull, byId } | null
let inflight = null;

// User-pinned per-model overrides (context window / max output), published
// under every provider name spelling by /api/models/caps. Applied AFTER the
// base caps resolve, so a pin wins over both /api/models and the pattern
// fallback. A built-in model's caps from /api/models already carry the pin
// server-side; this map is what makes discovered/live models (never in
// /api/models) reflect it too.
let overrideCache = null; // { [providerName]: { [modelId]: caps } } | null
let overrideInflight = null;

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  return { byFull, byId };
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      cache = buildMaps(data.models);
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {} };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

function loadModelCapsOverrides() {
  if (overrideCache) return Promise.resolve(overrideCache);
  if (overrideInflight) return overrideInflight;
  overrideInflight = fetch("/api/models/caps")
    .then(async (res) => {
      if (!res.ok) throw new Error(`caps ${res.status}`);
      const data = await res.json();
      overrideCache = data.caps && typeof data.caps === "object" ? data.caps : {};
      return overrideCache;
    })
    .catch(() => ({}))
    .finally(() => { overrideInflight = null; });
  return overrideInflight;
}

// Drop the module caches after an override is saved, so the next mount (or a
// manual refresh()) refetches instead of serving stale caps.
export function invalidateModelCapsCache() {
  cache = null;
  inflight = null;
  overrideCache = null;
  overrideInflight = null;
}

// Resolve caps from a "provider/model" string or a bare model id.
function resolveCaps(byFull, byId, overrides, key) {
  if (!key) return null;
  const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  const applyOverride = (base) => {
    const ov = provider ? overrides[provider]?.[bare] : null;
    if (!ov) return base;
    return {
      ...(base || {}),
      ...(ov.contextWindow ? { contextWindow: ov.contextWindow } : {}),
      ...(ov.maxOutput ? { maxOutput: ov.maxOutput } : {}),
    };
  };
  if (byFull[key]) return applyOverride(byFull[key]);
  if (byId[bare]) return applyOverride(byId[bare]);
  const c = getCapabilitiesForModel(provider, bare);
  return applyOverride({
    vision: c.vision,
    search: c.search,
    reasoning: c.reasoning,
    contextWindow: c.contextWindow,
    maxOutput: c.maxOutput,
  });
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});
  const [overrides, setOverrides] = useState(() => overrideCache || {});

  const refresh = useCallback(() => {
    invalidateModelCapsCache();
    Promise.all([loadModelCaps(), loadModelCapsOverrides()]).then(([maps, ov]) => {
      setByFull(maps.byFull);
      setById(maps.byId);
      setOverrides(ov || {});
    });
  }, []);

  useEffect(() => {
    loadModelCapsOverrides().then(setOverrides);
    if (cache) {
      setByFull(cache.byFull);
      setById(cache.byId);
      return;
    }
    let alive = true;
    loadModelCaps().then((maps) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    });
    return () => { alive = false; };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, overrides, key),
    [byFull, byId, overrides],
  );

  // The same resolution WITHOUT the user overrides, so the caps editor can show
  // what a pin is replacing ("built-in 256000") instead of guessing.
  const getBaseCaps = useCallback(
    (key) => resolveCaps(byFull, byId, {}, key),
    [byFull, byId],
  );

  return { getCaps, getBaseCaps, overrides, refresh };
}

// Exported for tests: the override-vs-base resolution is the only piece of this
// hook with logic in it, and `getBaseCaps` is literally `resolveCaps(…, {}, key)`.
export { resolveCaps };
