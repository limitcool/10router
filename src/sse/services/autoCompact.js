// ───────────────────────────────────────────────────────────────────────────
// Server-side auto-compaction of oversized conversations.
//
// Clients like Claude Code compact their own history, but anything that just
// POSTs the full transcript (ZCode, OpenClaw, custom agents, noAuth relays)
// hard-fails once the request crosses the model's context window. Rather than
// forwarding that failure, this service detects the overflow BEFORE dispatch,
// asks the same model (through the same pipeline) to summarize the older
// turns, and rewrites the body as [summary, ...recent tail].
//
// Only OpenAI-chat and Anthropic-messages shapes are rewritten. Estimation is
// a character heuristic (CJK-aware) — exact upstream counting is unknowable
// from here, so the threshold carries margin. Every failure mode is
// fail-open: a broken summary leaves the original request untouched.
// ───────────────────────────────────────────────────────────────────────────
import { getCustomModels } from "@/lib/localDb";
import { getAllModelCaps } from "@/lib/modelCapsDb";
import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { detectFormatByEndpoint, FORMATS } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";

export const INTERNAL_COMPACTION_HEADER = "x-9r-internal-compaction";

const DEFAULT_RATIO = 0.9;
const DEFAULT_KEEP_MESSAGES = 8;
const SUMMARY_OUTPUT_CAP = 1500;
// Tiny requests must never touch the caps/customs maps. The maps themselves
// are TTL-cached, so this floor only gates per-request overhead; keeping it
// low means small PINNED windows (edge models at 8k) can still trigger.
const ESTIMATE_FLOOR_TOKENS = 4000;
const SUMMARY_TIMEOUT_MS = 120_000;
// Base64 media blows up a char heuristic wildly out of proportion to the real
// vision token cost; count each media block flat instead.
const FLAT_MEDIA_TOKENS = 1000;

const SUMMARY_SYSTEM_PROMPT =
  "你是对话压缩助手。请把下面的历史对话压缩成一段可供后续模型无缝接续的摘要。" +
  "必须保留：用户的核心目标与约束、关键决定及理由、涉及的文件路径/函数名/代码标识符、" +
  "重要的工具调用结果、未完成的任务与下一步。只输出摘要正文，不要寒暄或标题。";
const SUMMARY_PREFIX = "[Conversation summary of earlier context]";

// ── pure: token estimation ─────────────────────────────────────────────────

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export function estimateTextTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(CJK_RE) || []).length;
  // CJK ≈ 1+ token per char on modern BPEs; latin/code ≈ ~4 chars per token.
  return Math.ceil(cjk * 1.2 + (s.length - cjk) / 4);
}

const safeJson = (v) => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

// Accumulator: { parts: string[], flat: number } — `flat` carries per-block
// token costs (media) that must not go through the char heuristic.
function textFromContent(content, acc) {
  if (content == null) return;
  if (typeof content === "string") { acc.parts.push(content); return; }
  if (Array.isArray(content)) {
    for (const part of content) textFromContent(part, acc);
    return;
  }
  if (typeof content !== "object") { acc.parts.push(String(content)); return; }
  const t = content.type;
  if (t === "image" || t === "image_url" || t === "input_image" || t === "document" || t === "file") {
    acc.flat += FLAT_MEDIA_TOKENS;
  } else if (t === "tool_use") {
    acc.parts.push(String(content.name || ""), safeJson(content.input));
  } else if (t === "tool_result") {
    textFromContent(content.content, acc);
  } else if (typeof content.text === "string") {
    acc.parts.push(content.text);
  } else {
    acc.parts.push(safeJson(content));
  }
}

export function estimateMessageTokens(msg) {
  const acc = { parts: [], flat: 8 }; // small per-message overhead
  if (!msg || typeof msg !== "object") return acc;
  textFromContent(msg.content, acc);
  if (typeof msg.name === "string") acc.parts.push(msg.name);
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const args = tc?.function?.arguments;
      acc.parts.push(String(tc?.function?.name || ""), typeof args === "string" ? args : safeJson(args));
    }
  }
  if (typeof msg.tool_call_id === "string") acc.parts.push(msg.tool_call_id);
  // Responses-API style items (function_call etc.)
  if (typeof msg.action === "object" && msg.action) acc.parts.push(safeJson(msg.action));
  return acc;
}

/**
 * Estimate prompt-side tokens for the whole request: system prompt (OpenAI
 * puts it in messages, Anthropic in body.system), every message, and the tool
 * definitions that ride along on every turn (Claude Code's tools alone are
 * commonly 15-30k tokens, so ignoring them would under-trigger badly).
 */
export function estimateRequestTokens(body, fmt) {
  let tokens = 0;
  const consume = (acc) => {
    tokens += acc.flat || 0;
    for (const p of acc.parts) tokens += estimateTextTokens(p);
  };
  if (fmt === FORMATS.CLAUDE && body?.system !== undefined) {
    const acc = { parts: [], flat: 0 };
    textFromContent(body.system, acc);
    consume(acc);
  }
  const msgs = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  for (const m of msgs) consume(estimateMessageTokens(m));
  if (body?.tools) consume({ parts: [safeJson(body.tools)], flat: 0 });
  if (body?.tool_definitions) consume({ parts: [safeJson(body.tool_definitions)], flat: 0 });
  if (body?.response_format) consume({ parts: [safeJson(body.response_format)], flat: 0 });
  return tokens;
}

// ── pure: split + transcript rendering ─────────────────────────────────────

function hasBlockType(content, type) {
  return Array.isArray(content) && content.some((b) => b && typeof b === "object" && b.type === type);
}

/**
 * First index ≥ messages.length - keepRecent that is a safe cut point: the
 * tail must start on a real user turn whose tool pairing lives entirely in
 * the prefix. An Anthropic user message carrying tool_result would orphan the
 * tool_use on the other side of the cut, so it is never a boundary.
 */
export function findSafeCutIndex(messages, fmt, keepRecent) {
  if (!Array.isArray(messages) || messages.length < 3) return -1;
  const start = Math.max(1, messages.length - keepRecent);
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (fmt === FORMATS.CLAUDE && hasBlockType(m.content, "tool_result")) continue;
    return i;
  }
  return -1;
}

function lineForMessage(m) {
  const acc = { parts: [], flat: 0 };
  textFromContent(m?.content, acc);
  let text = acc.parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (Array.isArray(m?.tool_calls)) {
    text += " " + m.tool_calls
      .map((tc) => `call:${tc?.function?.name}${tc?.function?.arguments ? `(${String(tc.function.arguments).slice(0, 200)})` : ""}`)
      .join(" ");
  }
  if (Array.isArray(m?.content)) {
    for (const b of m.content) {
      if (b?.type === "tool_use") text += ` call:${b.name}(${safeJson(b.input).slice(0, 200)})`;
      if (b?.type === "tool_result") text += " [tool-result]";
    }
  }
  const media = acc.flat ? ` [media ~${Math.round(acc.flat / FLAT_MEDIA_TOKENS)}]` : "";
  const role = m?.role || (m?.type === "function_call" ? "assistant" : "msg");
  return `<${role}> ${text}${media}`.trimEnd();
}

/**
 * Serialize the prefix newest-first until the budget runs out (oldest lines
 * are dropped with a visible marker) — the transcript itself must never blow
 * past the summarizer's own window.
 */
export function renderTranscript(messages, budgetTokens) {
  const lines = (messages || []).map(lineForMessage);
  const kept = [];
  let used = 0;
  let omitted = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = estimateTextTokens(lines[i]);
    if (used + t > budgetTokens && kept.length > 0) { omitted = i + 1; break; }
    kept.unshift(lines[i]);
    used += t;
  }
  if (omitted > 0) kept.unshift(`[…earlier ${omitted} messages omitted for length…]`);
  return kept.join("\n");
}

// ── pure: planning ─────────────────────────────────────────────────────────

const clampRatio = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.5 && n <= 0.98 ? n : DEFAULT_RATIO;
};

export function buildCompactPlan({ body, fmt, contextWindow, ratio, keepRecent, est }) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length < 3) return null;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const threshold = Math.floor(contextWindow * clampRatio(ratio));
  if (est < threshold) return null;
  const cut = findSafeCutIndex(messages, fmt, keepRecent);
  if (cut <= 0 || cut >= messages.length) return null;
  return { cut, threshold, est, prefix: messages.slice(0, cut), tail: messages.slice(cut) };
}

// ── model window resolution (with the A-layer pins) ────────────────────────

// Priority mirrors /v1/models: pinned modelCaps > user-added custom row >
// capabilities catalog/pattern. Cached briefly; pins are edited rarely and
// 30s of staleness only shifts a compaction threshold, never breaks a request.
const WINDOW_CACHE_MS = 30_000;
let windowCache = null;

function buildCustomIndex(customs) {
  const idx = new Map();
  for (const m of customs || []) {
    if (!m?.id || !m?.providerAlias) continue;
    const id = String(m.id);
    const alias = String(m.providerAlias);
    idx.set(`${alias}::${id}`, m);
  }
  return idx;
}

async function loadResolutionMaps() {
  const now = Date.now();
  if (windowCache && now - windowCache.at < WINDOW_CACHE_MS) return windowCache;
  let caps = {};
  let customs = [];
  try { caps = await getAllModelCaps() || {}; } catch { /* fail-open */ }
  try { customs = await getCustomModels() || []; } catch { /* fail-open */ }
  windowCache = { at: now, caps, customs: buildCustomIndex(customs) };
  return windowCache;
}

/** Invalidate the TTL cache right after a pin is saved (test/manual hook). */
export function invalidateWindowCache() { windowCache = null; }

const positiveInt = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

export async function resolveModelWindow(modelStr) {
  const s = String(modelStr || "");
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  const alias = s.slice(0, slash);
  const modelId = s.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const baseId = modelId.split(":")[0]; // "kimi-k3:agentic" shares the base numbers
  const { caps, customs } = await loadResolutionMaps();

  const pinned = caps[alias]?.[modelId] || caps[providerId]?.[modelId]
    || caps[alias]?.[baseId] || caps[providerId]?.[baseId];
  if (pinned && (positiveInt(pinned.contextWindow) || positiveInt(pinned.maxOutput))) {
    return { contextWindow: positiveInt(pinned.contextWindow), maxOutput: positiveInt(pinned.maxOutput) };
  }
  const customRow = customs.get(`${alias}::${modelId}`) || customs.get(`${providerId}::${modelId}`)
    || customs.get(`${alias}::${baseId}`) || customs.get(`${providerId}::${baseId}`);
  const c = getCapabilitiesForModel(providerId, baseId !== modelId ? baseId : modelId) || {};
  const contextWindow = positiveInt(customRow?.contextWindow) ?? (positiveInt(c.contextWindow) || null);
  const maxOutput = positiveInt(customRow?.maxOutput) ?? (positiveInt(c.maxOutput) || null);
  return { contextWindow, maxOutput };
}

// ── format + extraction helpers ────────────────────────────────────────────

export function detectChatFormat(endpoint, body) {
  const byEndpoint = detectFormatByEndpoint(endpoint, body);
  if (byEndpoint === FORMATS.CLAUDE || byEndpoint === FORMATS.OPENAI || byEndpoint === FORMATS.OPENAI_RESPONSES) {
    return byEndpoint;
  }
  if (Array.isArray(body?.messages)) return body?.system !== undefined ? FORMATS.CLAUDE : FORMATS.OPENAI;
  if (Array.isArray(body?.input)) return FORMATS.OPENAI_RESPONSES;
  return null;
}

function extractSummaryText(data) {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((b) => (typeof b === "string" ? b : b?.text || "")).join("");
  }
  // Reasoning models (e.g. cbcn hy4-preview) can burn the whole output budget on
  // reasoning_content and return content="" — a degraded-but-real fallback beats
  // silently dispatching the oversized original. enable_thinking:false below
  // normally prevents this; this is the safety net.
  if (!text.trim() && typeof choice?.message?.reasoning_content === "string") {
    text = choice.message.reasoning_content;
  }
  return text;
}

/**
 * Fold the summary INTO the first kept message instead of emitting a separate
 * user turn: the tail always starts on a user message (safe-cut rule), and a
 * standalone summary would produce two consecutive user messages — which the
 * strict Anthropic shape rejects. Block arrays get a leading text block; plain
 * strings concatenate.
 */
export function attachSummaryToFirstTail(tailFirst, fmt, summaryText) {
  const note = `${SUMMARY_PREFIX}\n${summaryText}\n[End of summary — recent messages follow]`;
  const c = tailFirst?.content;
  if (fmt === FORMATS.CLAUDE) {
    const blocks = [];
    blocks.push({ type: "text", text: note });
    if (typeof c === "string" && c) blocks.push({ type: "text", text: c });
    else if (Array.isArray(c)) blocks.push(...c);
    return { ...tailFirst, content: blocks };
  }
  if (typeof c === "string") return { ...tailFirst, content: c ? `${note}\n\n${c}` : note };
  if (Array.isArray(c)) return { ...tailFirst, content: [{ type: "text", text: note }, ...c] };
  return { ...tailFirst, content: note };
}

// ── orchestrator ───────────────────────────────────────────────────────────

/**
 * Mutates `body.messages` in place when compaction succeeds (the same object
 * the combo/single-model dispatchers below receive, and the one
 * clientRawRequest.body points at, so logging stays truthful). Returns true
 * only when the body was rewritten. Every guard falls through untouched.
 */
export async function maybeCompactChatBody({ request, body, modelStr, endpoint, settings }) {
  if (request?.headers?.get?.(INTERNAL_COMPACTION_HEADER) === "1") return false; // summary call itself
  if (settings?.autoCompactEnabled === false) return false;
  // Naming/warmup bypass requests are already filtered out upstream; a system
  // prompt alone must never be summarized.
  if (!body || !Array.isArray(body.messages) || body.messages.length < 3) return false;

  const fmt = detectChatFormat(endpoint, body);
  if (fmt !== FORMATS.CLAUDE && fmt !== FORMATS.OPENAI) return false; // responses/gemini: v1 scope

  const est = estimateRequestTokens(body, fmt);
  if (est < ESTIMATE_FLOOR_TOKENS) return false;

  const win = await resolveModelWindow(modelStr);
  if (!win?.contextWindow) return false;

  const ratio = clampRatio(settings?.autoCompactRatio);
  const keep = positiveInt(settings?.autoCompactKeepMessages) || DEFAULT_KEEP_MESSAGES;
  const plan = buildCompactPlan({ body, fmt, contextWindow: win.contextWindow, ratio, keepRecent: keep, est });
  if (!plan) return false;

  const summaryMax = Math.max(256, Math.min(SUMMARY_OUTPUT_CAP, Math.floor(win.contextWindow * 0.1)));
  const transcriptBudget = Math.max(2000, plan.threshold - summaryMax - 1500);
  const transcript = renderTranscript(plan.prefix, transcriptBudget);

  let origin = null;
  try { origin = new URL(request.url).origin; } catch { /* keep null */ }
  if (!origin) return false;

  const auth = request.headers?.get?.("authorization");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT_MS);
  let summary = "";
  try {
    const res = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        [INTERNAL_COMPACTION_HEADER]: "1",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({
        model: modelStr,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
        stream: false,
        max_tokens: summaryMax,
        temperature: 0.3,
        // Force a direct (non-reasoning) answer: reasoning models otherwise
        // spend max_tokens on thinking and return content="". The unified
        // thinking translator consumes/strips this per provider capability.
        enable_thinking: false,
      }),
    });
    if (!res.ok) {
      log.warn("COMPACT", `summary call ${res.status} for ${modelStr} — sending original request`);
      return false;
    }
    summary = extractSummaryText(await res.json());
  } catch (e) {
    log.warn("COMPACT", `summary failed for ${modelStr}: ${e?.message || e} — sending original request`);
    return false;
  } finally {
    clearTimeout(timer);
  }
  if (!summary || !summary.trim()) {
    log.warn("COMPACT", `empty summary for ${modelStr} — sending original request`);
    return false;
  }

  body.messages = [
    attachSummaryToFirstTail(plan.tail[0], fmt, summary.trim()),
    ...plan.tail.slice(1),
  ];
  log.info("COMPACT", `${modelStr}: est ${est}tok ≥ ${Math.round(ratio * 100)}% of ${win.contextWindow} → summarized ${plan.prefix.length} msgs, kept ${plan.tail.length}`);
  return true;
}
