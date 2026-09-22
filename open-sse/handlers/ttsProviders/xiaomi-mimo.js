// Xiaomi MiMo TTS — via OpenAI-compatible chat completions (non-streaming).
// Docs: https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
// Message contract: target text in `role: assistant` content, style/voice
// instructions in `role: user` content. Voice is selected via the top-level
// `audio.voice` field (NOT embedded in the model name).
import { parseModelVoice } from "./_base.js";
import { normalizeMimoApiBase, resolveXiaomiTokenplanBaseUrl } from "../../config/providers.js";

const DEFAULT_MODEL = "mimo-v2.5-tts";
const DEFAULT_VOICE = "mimo_default";
const BILLING_BASE = "https://api.xiaomimimo.com/v1";
// All MiMo speech models the gateway hosts (plan + billing catalogs). Must be
// enumerated: parseModelVoice() rewrites an unknown BARE model to the default
// one, so "mimo-v2-tts" would silently synthesize as v2.5-tts without this list.
const KNOWN_TTS_MODELS = [DEFAULT_MODEL, "mimo-v2.5-tts-voiceclone", "mimo-v2.5-tts-voicedesign", "mimo-v2-tts"];

/**
 * Which cluster a MiMo TTS call belongs to — mirroring MiMo Desktop, where
 * auth.json metadata.base_url decides plan vs billing for every route.
 *   • stored endpoint from the OAuth payload wins (it is what the key was minted for);
 *   • the region-based manual-key provider falls back to its region map;
 *   • otherwise the public billing host.
 */
export function resolveMiMoTtsBaseUrl(provider, credentials) {
  const stored = normalizeMimoApiBase(credentials?.providerSpecificData?.baseUrl);
  if (stored) return stored;
  if (provider === "xiaomi-tokenplan") return resolveXiaomiTokenplanBaseUrl(credentials);
  return BILLING_BASE;
}

export default {
  synthesize(text, model, credentials, responseFormat, { style, language, provider } = {}) {
    if (!credentials?.apiKey) throw new Error(`${provider || "xiaomi-mimo"} API key required`);
    return synthesizeMiMo(text, model, credentials.apiKey, style, language, resolveMiMoTtsBaseUrl(provider, credentials));
  },
};

export async function synthesizeMiMo(text, model, apiKey, style, language, baseUrl = BILLING_BASE) {
  const { modelId, voiceId } = parseModelVoice(model, DEFAULT_MODEL, DEFAULT_VOICE, KNOWN_TTS_MODELS);

  // Language and style are soft instructions → prepend as a role:user message.
  // MiMo auto-detects the spoken language of the text; the hint only nudges it
  // (e.g. "Speak in English.") and is independent of the chosen voice.
  const instructions = [];
  if (language) instructions.push(`Speak in ${language}.`);
  if (style) instructions.push(style);

  const messages = [{ role: "assistant", content: text }];
  if (instructions.length) messages.unshift({ role: "user", content: instructions.join(" ") });

  const res = await fetch(`${normalizeMimoApiBase(baseUrl) || BILLING_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      stream: false,
      messages,
      audio: {
        format: "wav",
        voice: voiceId || DEFAULT_VOICE,
      },
    }),
  });

  const rawText = await res.text();
  let data = {};
  if (rawText) {
    try { data = JSON.parse(rawText); } catch { data = {}; }
  }

  if (!res.ok) {
    throw new Error(data?.error?.message || rawText || `MiMo TTS error (${res.status})`);
  }

  const audio = data?.choices?.[0]?.message?.audio?.data;
  if (!audio) throw new Error(data?.error?.message || "MiMo TTS returned no audio");

  return {
    base64: audio,
    format: data?.choices?.[0]?.message?.audio?.format || "wav",
  };
}
