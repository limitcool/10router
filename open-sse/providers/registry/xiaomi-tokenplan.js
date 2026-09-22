import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "xiaomi-tokenplan",
  // Sits directly under the base Xiaomi MiMo card (priority 20): same vendor,
  // same protocol — only the cluster (and who pays) differ.
  priority: 21,
  alias: "xiaomi-tokenplan",
  aliases: [
    "xmtp",
  ],
  uiAlias: "xmtp",
  display: {
    name: "MiMo Token Plan",
    icon: "smart_toy",
    color: "#FF6700",
    textIcon: "XT",
    website: "https://platform.xiaomimimo.com",
    notice: {
      text: "Xiaomi MiMo Token Plan subscription (API key starts with tp-). Token Plan keys are cluster-specific — select the region matching your subscription.",
      apiKeyUrl: "https://platform.xiaomimimo.com/console/api-keys",
    },
  },
  category: "apikey",
  hasProviderSpecificData: true,
  serviceKinds: ["llm", "tts"],
  regions: [
    { id: "cn", label: "China (中国大陆)" },
    { id: "sgp", label: "Singapore (新加坡)" },
    { id: "ams", label: "Amsterdam (阿姆斯特丹)" },
  ],
  // MiMo Desktop's own Token Plan preset is token-plan-cn; egress auto-match
  // picks the right cluster for overseas keys at add time regardless.
  defaultRegion: "cn",
  transport: {
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    regions: {
      cn: "https://token-plan-cn.xiaomimimo.com/v1",
      sgp: "https://token-plan-sgp.xiaomimimo.com/v1",
      ams: "https://token-plan-ams.xiaomimimo.com/v1",
    },
    defaultRegion: "cn",
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  // baseUrl omitted — region-dynamic, resolved in the executor's buildUrl.
  transports: [
    {
      format: "openai",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  // Aligned 2026-09 with MiMo Desktop's bundled plan catalogs: all three regions
  // (token-plan-cn / -sgp / -ams) serve the IDENTICAL set below. mimo-v2-omni was
  // never in any plan catalog (billing-only, since deprecated) — calling it here
  // 404s, which is how this list earned the "too old" reputation.
  models: [
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "mimo-v2.5-pro-claude", name: "MiMo V2.5 Pro (Claude Native)", targetFormat: "claude", upstreamModelId: "mimo-v2.5-pro" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
    // Listed `status: "deprecated"` in every Desktop region catalog — still served,
    // kept callable, but renamed so nobody picks it as a new default.
    { id: "mimo-v2-pro", name: "MiMo V2 Pro (legacy)" },
    { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", kind: "tts" },
    { id: "mimo-v2.5-tts-voiceclone", name: "MiMo V2.5 TTS Voice Clone", kind: "tts" },
    { id: "mimo-v2.5-tts-voicedesign", name: "MiMo V2.5 TTS Voice Design", kind: "tts" },
    { id: "mimo-v2-tts", name: "MiMo V2 TTS", kind: "tts" },
  ],
  // Same speech protocol as the base provider (shared adapter); only the cluster
  // URL differs and the adapter resolves it per connection/region.
  ttsConfig: {
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    authType: "apikey",
    authHeader: "bearer",
    format: "xiaomi-mimo-tts",
  },
};
