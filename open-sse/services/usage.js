/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { getGitHubUsage } from "./usage/github.js";
import { getGeminiUsage, getAntigravityUsage } from "./usage/google.js";
import { getClaudeUsage } from "./usage/claude.js";
import { getCodexUsage, consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits } from "./usage/codex.js";

export { consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits };
import { getKiroUsage } from "./usage/kiro.js";
import { getMiniMaxUsage } from "./usage/minimax.js";
import { getCodeBuddyCnUsage, getCodeBuddyIntlUsage } from "./usage/codebuddy-cn.js";
import { getGrokCliUsage } from "./usage/grok-cli.js";
import { getKimiUsage } from "./usage/kimi.js";
import { getDeepseekUsage } from "./usage/deepseek.js";
import { getOpencodeGoUsage } from "./usage/opencode-go.js";
import { getXiaomiMimoUsage, getXiaomiTokenPlanUsage } from "./usage/xiaomi-mimo.js";
import { getStepfunUsage, STEPFUN_ACCOUNTS_HOSTS } from "./usage/stepfun.js";
import { resolveQoderCredentials } from "./qoderModels.js";
import {
  getIflowUsage,
  getOllamaUsage,
  getGlmUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
} from "./usage/misc.js";
import { getCommandCodeUsage } from "./usage/commandcode.js";
import { extractEarliestPackageExpiry } from "./usage/expiryExtractor.js";

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
const USAGE_HANDLERS = {
  github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
  antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions, { force: c.force }),
  claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions, { force: c.force }),
  codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
  kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  qoder: async (c) => {
    // PAT (pt-...) connections must be exchanged to a job token before the
    // quota endpoint accepts them.
    const resolved = await resolveQoderCredentials(c, c.proxyOptions).catch(() => null);
    return getQoderUsage(resolved?.accessToken || c.accessToken, c.proxyOptions);
  },
  "qoder-cn": async (c) => {
    const resolved = await resolveQoderCredentials(c, c.proxyOptions).catch(() => null);
    return getQoderUsage(resolved?.accessToken || c.accessToken, c.proxyOptions, "qoder-cn");
  },
  iflow: (c) => getIflowUsage(c.accessToken),
  ollama: (c) => getOllamaUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
  glm: (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  "glm-cn": (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
  "codebuddy-cn": (c) => getCodeBuddyCnUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  "codebuddy-intl": (c) => getCodeBuddyIntlUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  "grok-cli": (c) => getGrokCliUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  kimi: (c) => getKimiUsage(c.accessToken, c.apiKey, c.proxyOptions, c.providerSpecificData),
  deepseek: (c) => getDeepseekUsage(c.apiKey, c.proxyOptions),
  "opencode-go": (c) => getOpencodeGoUsage(c.apiKey, c.proxyOptions),
  "xiaomi-mimo": (c) => getXiaomiMimoUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  // Token Plan keys (tp-) live on a cluster with no quota endpoint at all — the
  // handler exists so the row can explain that instead of falling through to
  // "Usage API not implemented for xiaomi-tokenplan".
  "xiaomi-tokenplan": (c) => getXiaomiTokenPlanUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
  stepfun: (c) => getStepfunUsage(c.apiKey, c.proxyOptions, STEPFUN_ACCOUNTS_HOSTS.stepfun),
  "stepfun-cn": (c) => getStepfunUsage(c.apiKey, c.proxyOptions, STEPFUN_ACCOUNTS_HOSTS["stepfun-cn"]),
  commandcode: (c) => getCommandCodeUsage(c.apiKey, c.proxyOptions),
};

export async function getUsageForProvider(connection, proxyOptions = null, options = {}) {
  const { provider, accessToken, apiKey, providerSpecificData, projectId } = connection;
  const providerDataWithProjectId = {
    ...(providerSpecificData || {}),
    ...(projectId ? { projectId } : {}),
  };

  const handler = USAGE_HANDLERS[provider];
  if (!handler) return { message: `Usage API not implemented for ${provider}` };
  return await handler({
    provider,
    accessToken,
    apiKey,
    providerSpecificData,
    providerDataWithProjectId,
    proxyOptions,
    force: options.force === true,
  });
}

export { extractEarliestPackageExpiry };
