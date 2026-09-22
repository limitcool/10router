import { NextResponse } from "next/server";
import { getModelCapsForProvider, getAllModelCaps, setModelCaps } from "@/lib/modelCapsDb";

export const dynamic = "force-dynamic";

// GET /api/models/caps[?provider=xxx]
// With a provider: that provider's per-model overrides keyed by model id.
// Without: EVERY provider's overrides (keyed by provider name) so the shared
// useModelCaps hook can apply the user's pinned context window / max output
// across all surfaces (combos page, grok card, provider page fallbacks).
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || searchParams.get("providerAlias");
    if (provider) {
      const caps = await getModelCapsForProvider(provider);
      return NextResponse.json({ caps });
    }
    const all = await getAllModelCaps();
    return NextResponse.json({ caps: all });
  } catch (error) {
    console.log("Error fetching model caps:", error);
    return NextResponse.json({ error: "Failed to fetch model caps" }, { status: 500 });
  }
}

// PUT /api/models/caps  body: { provider, modelId, contextWindow?, maxOutput? }
// Omitted / empty / non-positive values clear that field; clearing both
// removes the override row entirely (model falls back to catalog defaults).
export async function PUT(request) {
  try {
    const { provider, modelId, contextWindow, maxOutput } = await request.json();
    if (!provider || !modelId) {
      return NextResponse.json({ error: "provider and modelId required" }, { status: 400 });
    }
    const caps = await setModelCaps(provider, modelId, { contextWindow, maxOutput });
    return NextResponse.json({ success: true, modelId, caps });
  } catch (error) {
    console.log("Error saving model caps:", error);
    return NextResponse.json({ error: "Failed to save model caps" }, { status: 500 });
  }
}
