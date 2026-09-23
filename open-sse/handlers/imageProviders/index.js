// Image provider adapter registry
import createOpenAIAdapter from "./openai.js";
import gemini from "./gemini.js";
import codex from "./codex.js";
import sdwebui from "./sdwebui.js";
import comfyui from "./comfyui.js";
import huggingface from "./huggingface.js";
import nanobanana from "./nanobanana.js";
import falAi from "./falAi.js";
import stabilityAi from "./stabilityAi.js";
import blackForestLabs from "./blackForestLabs.js";
import runwayml from "./runwayml.js";
import cloudflareAi from "./cloudflareAi.js";
import antigravity from "./antigravity.js";
import openaiCompatNode from "./openaiCompatNode.js";

const ADAPTERS = {
  openai: createOpenAIAdapter("openai"),
  minimax: createOpenAIAdapter("minimax"),
  openrouter: createOpenAIAdapter("openrouter"),
  recraft: createOpenAIAdapter("recraft"),
  "vercel-ai-gateway": createOpenAIAdapter("vercel-ai-gateway"),
  xai: createOpenAIAdapter("xai"),
  "agnes-ai": createOpenAIAdapter("agnes-ai"),
  "agnes-ai-cn": createOpenAIAdapter("agnes-ai-cn"),
  gemini,
  codex,
  sdwebui,
  comfyui,
  huggingface,
  nanobanana,
  antigravity,
  "fal-ai": falAi,
  "stability-ai": stabilityAi,
  "black-forest-labs": blackForestLabs,
  runwayml,
  "cloudflare-ai": cloudflareAi,
};

export function getImageAdapter(provider) {
  if (ADAPTERS[provider]) return ADAPTERS[provider];
  // User-defined openai-compatible nodes (chat/responses) carry their own
  // baseUrl in credentials and speak the OpenAI images API. Without this branch
  // image models registered on such nodes are unresolvable.
  if (provider?.startsWith?.("openai-compatible-")) return openaiCompatNode;
  return null;
}

export function isImageProvider(provider) {
  if (provider in ADAPTERS) return true;
  return !!provider?.startsWith?.("openai-compatible-");
}
