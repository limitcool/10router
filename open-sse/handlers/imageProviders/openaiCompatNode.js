// Custom node providers (openai-compatible-*) — baseUrl comes from the node's
// connection credentials, not from a static PROVIDER_MEDIA entry.
//
// Rationale: image models such as `gpt-image-1.5` / `gpt-image-2` are only
// exposed on /v1/images/generations by Responses-style upstreams that 10router
// reaches through a user-defined openai-compatible node. Those nodes have no
// entry in PROVIDER_MEDIA, so before this adapter existed every image request
// died at `getImageAdapter() === null` with
// "Provider '<node id>' does not support image generation".
//
// Unlike the embedding counterpart this adapter does NOT fall back to
// api.openai.com when the node has no baseUrl: silently shipping the prompt and
// the node's API key to OpenAI would be a credential leak. It refuses instead.
import createOpenAIAdapter from "./openai.js";

const baseAdapter = createOpenAIAdapter("openai");

/**
 * Strip a trailing slash and a trailing endpoint segment so a user who pasted a
 * full endpoint into the node config doesn't end up with e.g.
 * ".../v1/images/generations/images/generations".
 */
function sanitizeBaseUrl(raw) {
  return String(raw)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/images\/(generations|edits)$/, "");
}

export default {
  ...baseAdapter,
  buildUrl: (_model, creds) => {
    const rawBaseUrl = creds?.providerSpecificData?.baseUrl || "";
    if (!rawBaseUrl.trim()) {
      throw new Error(
        "Image generation requires a Base URL on this provider node; refusing to fall back to api.openai.com"
      );
    }
    return `${sanitizeBaseUrl(rawBaseUrl)}/images/generations`;
  },
  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    return headers;
  },
};
