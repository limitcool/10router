// Combo "retry on empty content-filtered stream" (issue #10).
//
// Some providers (Z.ai / GLM family, and others) signal a content-safety kill
// with a *successful* HTTP 200: the stream opens normally, then terminates with
// a filtered finish reason and ZERO output tokens. Because the status is 2xx,
// the combo loop's `result.ok` short-circuits and returns the empty answer —
// the client sees a blank response and its own retry hits the same filter.
//
// This module provides the decision + a head-of-line gate that lets the combo
// *see inside* a 2xx stream before committing bytes to the client:
//   - buffer the stream head,
//   - release on the FIRST non-empty content/reasoning/tool-call delta (commit),
//   - or, if the stream ends with no valuable content at all, report "retry" so
//     the combo can fall through to the next model.
//
// The finish reason is normalized away by the response translator
// (`toOpenAIFinish`/`fromOpenAIFinish` map `content_filter`/`sensitive` to a
// plain stop/end_turn in the client format), so the reliable, format-agnostic
// signal is *emptiness at terminal* — which is exactly the client-visible
// failure and a superset of the reporter's sensitive case. Raw filtered tokens
// are also recognised opportunistically when they survive (OpenAI passthrough).
//
// Default OFF: callers must opt in per combo (`comboStrategies[name].retryOnEmpty`)
// or globally (`settings.comboRetryOnEmpty`). When enabled and the gate fires,
// the abandoned upstream still billed its input tokens (a stream is consumed to
// its terminal to log usage), so a replay doubles input cost for that request —
// which is why it is opt-in and only engages when a fallback model remains.

// Upstream finish/stop reasons that indicate a content-safety / policy kill.
// Compared case-insensitively after trimming.
const FILTER_FINISH_TOKENS = new Set([
  "content_filter",
  "content-filter",
  "sensitive",
  "refusal",
  "safety",
  "security",
  "blocked",
  "filtered",
  "flagged",
  "blocklist",
  "prohibited_content",
  "recitation",
]);

export function isFilterFinishReason(reason) {
  if (typeof reason !== "string") return false;
  return FILTER_FINISH_TOKENS.has(reason.trim().toLowerCase());
}

// Inspect one already-parsed SSE data object (client format) and classify its
// contribution. Returns { valuable, terminal, filtered }:
//   - valuable: this chunk carries real content the client would see
//   - terminal: this chunk finishes the message (stop/length/filter/…)
//   - filtered: the terminal reason is a content-safety kill
function classifyParsedChunk(parsed) {
  if (!parsed || typeof parsed !== "object") return { valuable: false, terminal: false, filtered: false };

  // OpenAI chat completions chunk
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  if (choice) {
    const delta = choice.delta || {};
    const content = typeof delta.content === "string" && delta.content !== "";
    const reasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content !== "";
    const toolCalls =
      Array.isArray(delta.tool_calls) &&
      delta.tool_calls.some((t) => (t?.function?.arguments && t.function.arguments !== "") || t?.function?.name || t?.id);
    const valuable = content || reasoning || toolCalls;
    if (choice.finish_reason) {
      return { valuable, terminal: true, filtered: isFilterFinishReason(choice.finish_reason) };
    }
    return { valuable, terminal: false, filtered: false };
  }

  // OpenAI Responses API chunk
  if (parsed.type === "response.completed" || parsed.type === "response.incomplete") {
    const text =
      Array.isArray(parsed.response?.output_text) && parsed.response.output_text.join("") !== ""
        ? true
        : Array.isArray(parsed.response?.output) &&
          parsed.response.output.some((o) =>
            Array.isArray(o?.content) ? o.content.some((c) => c?.text) : typeof o?.text === "string" && o.text !== ""
          );
    return { valuable: text, terminal: true, filtered: false };
  }
  if (parsed.type === "response.output_text.delta" || parsed.type === "response.reason_summary_text.delta") {
    return { valuable: typeof parsed.delta === "string" && parsed.delta !== "", terminal: false, filtered: false };
  }

  // Claude Messages stream chunk
  if (parsed.type === "content_block_delta") {
    const d = parsed.delta || {};
    const valuable = (typeof d.text === "string" && d.text !== "") || (typeof d.thinking === "string" && d.thinking !== "") ||
      (typeof d.partial_json === "string" && d.partial_json !== "");
    return { valuable, terminal: false, filtered: false };
  }
  if (parsed.type === "message_delta") {
    const stop = parsed.delta?.stop_reason;
    return { valuable: false, terminal: true, filtered: isFilterFinishReason(stop) };
  }

  // Gemini / Antigravity chunk
  const cand = Array.isArray(parsed.candidates) ? parsed.candidates[0] : undefined;
  if (cand) {
    const parts = cand.content?.parts;
    const text = Array.isArray(parts) && parts.some((p) => typeof p?.text === "string" && p.text !== "");
    if (cand.finishReason) {
      return { valuable: text, terminal: true, filtered: isFilterFinishReason(cand.finishReason) };
    }
    return { valuable: text, terminal: false, filtered: false };
  }

  return { valuable: false, terminal: false, filtered: false };
}

// Incrementally scan a stream of SSE text chunks and decide commit/retry.
// Feed raw string chunks via push(); returns the running decision.
export function createStreamScanner() {
  let buf = "";
  let sawValuable = false;
  let sawTerminal = false;
  let sawFiltered = false;
  let committed = false; // released early on first content
  const enc = new TextEncoder();
  // One decoder for the whole stream: a fresh TextDecoder per push() would
  // mis-decode multi-byte UTF-8 (CJK!) split across chunk boundaries, corrupt
  // the line, and make the scanner blind to real content.
  const dec = new TextDecoder();
  const head = []; // buffered Uint8Array chunks (raw, pre-decode) until a decision

  function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawTerminal = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // partial/non-json line — ignore, passthrough keeps bytes intact
    }
    const c = classifyParsedChunk(parsed);
    if (c.valuable) sawValuable = true;
    if (c.terminal) {
      sawTerminal = true;
      if (c.filtered) sawFiltered = true;
    }
  }

  return {
    // Push a raw byte chunk. Returns:
    //   { kind: "buffered" }  — need more (nothing to commit yet)
    //   { kind: "commit" }    — first content seen; release all buffered + continue passthrough
    //   { kind: "retry" }     — terminal with no content (empty) → fall through to next model
    //   { kind: "commit-empty"} — terminal, not filtered, still empty; commit (return empty) unless caller wants retry
    push(chunkBytes) {
      if (committed) return { kind: "passthrough" };
      const bytes = typeof chunkBytes === "string" ? enc.encode(chunkBytes) : chunkBytes;
      head.push(bytes);
      buf += dec.decode(bytes, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) processLine(line);

      if (sawValuable) {
        committed = true;
        return { kind: "commit" };
      }
      if (sawTerminal) {
        // End with zero valuable content. Treat empty output as retryable.
        committed = true;
        return { kind: "retry" };
      }
      return { kind: "buffered" };
    },
    // Called when the upstream reader is done without an explicit terminal.
    finish() {
      // flush the decoder tail + any trailing buffered line
      buf += dec.decode();
      if (buf) {
        processLine(buf);
        buf = "";
      }
      if (committed) return { kind: "passthrough" };
      committed = true;
      // Never saw content, never saw a terminal — the model produced nothing
      // usable (abrupt close or silent filter). Retryable.
      return sawValuable ? { kind: "commit" } : { kind: "retry" };
    },
    get bufferedBytes() {
      return head;
    },
  };
}

// Inspect a NON-streaming 2xx completion for "empty content-filtered answer".
// Returns { retryable, empty, filtered } from the response JSON across formats.
export function inspectNonStream(json) {
  if (!json || typeof json !== "object") return { retryable: false, empty: false, filtered: false };

  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  if (choice) {
    const msg = choice.message || {};
    const content = typeof msg.content === "string" ? msg.content : "";
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const empty = !content && !reasoning && !toolCalls;
    const filtered = isFilterFinishReason(choice.finish_reason);
    return { retryable: empty, empty, filtered };
  }
  if (Array.isArray(json.content)) {
    // Claude non-stream
    const text = json.content.some((b) => (b?.type === "text" && b.text) || (b?.type === "thinking" && b.thinking) || b?.type === "tool_use");
    const filtered = isFilterFinishReason(json.stop_reason);
    return { retryable: !text, empty: !text, filtered };
  }
  if (Array.isArray(json.candidates)) {
    const text = json.candidates.some((c) => c?.content?.parts?.some((p) => typeof p?.text === "string" && p.text !== ""));
    const filtered = isFilterFinishReason(json.candidates[0]?.finishReason);
    return { retryable: !text, empty: !text, filtered };
  }
  return { retryable: false, empty: false, filtered: false };
}

// Gate a 2xx Response. Returns { action: "retry" } when the (streaming) answer is
// empty at terminal, or { action: "commit", response } with a reconstructed
// Response whose body replays the buffered head then continues live.
export async function gateResponse(response) {
  const ct = (response.headers.get("content-type") || "").toLowerCase();

  // Non-streaming JSON: cheap, decide directly. Never consumes beyond what we
  // rebuild, so rebuild the Response from the read text.
  if (!ct.includes("text/event-stream") && !ct.includes("stream")) {
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* fall through to commit */
    }
    if (json) {
      const { retryable } = inspectNonStream(json);
      if (retryable) return { action: "retry", meta: inspectNonStream(json) };
    }
    return { action: "commit", response: rewrap(response, text) };
  }

  // Streaming: head-of-line scan.
  if (!response.body) return { action: "commit", response };
  const reader = response.body.getReader();
  const scanner = createStreamScanner();
  let decision = null;
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      const r = scanner.push(value);
      if (r.kind === "commit") { decision = { kind: "commit" }; break; }
      if (r.kind === "retry") { decision = { kind: "retry" }; break; }
      continue;
    }
    if (done) {
      const r = scanner.finish();
      decision = { kind: r.kind === "retry" ? "retry" : "commit" };
      break;
    }
  }

  if (decision.kind === "retry") {
    // Consume/cancel the rest so the upstream can be released; usage was
    // already logged by the underlying stream once its body drained to terminal.
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    return { action: "retry" };
  }

  // Commit: replay buffered head, then pipe the remainder of the same reader.
  const headChunks = scanner.bufferedBytes;
  const body = new ReadableStream({
    async start(controller) {
      for (const c of headChunks) controller.enqueue(c);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
  return { action: "commit", response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }) };
}

function rewrap(response, text) {
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}
