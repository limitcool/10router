/**
 * Stop-sequence enforcement (issue #18).
 *
 * Some upstreams accept a `stop` / `stop_sequences` field and then ignore it —
 * measured directly on CodeBuddy CN: a request with stop:["GAMMA"] still
 * returns the whole generated string. When the client is relying on that stop
 * to bound a turn, it silently gets a longer answer than it asked for, and if
 * the provider also caps the turn (max_tokens) the client receives a truncated
 * answer *plus* the wrong finish reason.
 *
 * The concrete casualty is Claude Code's auto-mode classifier. Its stage 1 asks
 * for max_tokens:64 with stop_sequences:["</block>"] and halts the model the
 * instant the verdict tag appears; its parsers tolerate the missing closing tag
 * precisely because the stop is what cuts the turn:
 *
 *   l4e()  /<block>(yes|no)\b(<\/block>)?/gi        // closing tag optional
 *   LCo()  /<severity>\s*(\d+(?:\.\d+)?)\s*(<\/severity>)?/g   // ditto
 *   r4e()  rejects the answer unless stop_reason is stop_sequence | end_turn
 *
 * On an upstream that ignores the stop, the model rambles past the verdict, the
 * 64-token budget truncates the turn, finish_reason comes back `length`, the
 * client translates that to `max_tokens`, and r4e() throws the answer away —
 * "auto mode cannot determine the safety of Bash right now".
 *
 * This module implements the contract in the gateway instead: while relaying an
 * SSE stream we watch the generated text and cut it at the first requested stop
 * sequence, exactly the way a compliant provider would. Design notes:
 *
 *  - Fail open. Anything we cannot parse passes through untouched, and so does
 *    any provider that already honours the stop (a compliant provider excludes
 *    the sequence from its output, so the scan finds nothing and we no-op —
 *    applying this unconditionally is therefore safe).
 *  - The sequence itself is NOT emitted, matching Anthropic and OpenAI
 *    semantics. Both client parsers above accept the resulting partial tag.
 *  - Text is held back only while it could still turn into a stop sequence: we
 *    withhold the longest suffix that is a proper prefix of a requested stop, so
 *    a sequence split across two SSE deltas is still caught while ordinary text
 *    streams through unchanged. Up to MAX_HOLDBACK_CHARS is withheld; longer
 *    sequences are enforced without the split guarantee rather than buffering a
 *    whole response.
 *  - After a cut we keep relaying the remaining chunks with their content
 *    stripped instead of ending the stream early: the terminal chunk carries
 *    `usage`, and dropping it would rob the client of its token accounting.
 *  - Applied to SSE text streams only. The body is decoded and re-encoded, which
 *    is not byte-preserving for binary frames, so a provider that speaks a
 *    binary event encoding (Kiro's AWS EventStream) is skipped rather than
 *    risked — such streams never contain `data:` lines anyway.
 */

/** Sequences longer than this are left to the provider — enforcing them would stall streaming. */
export const MAX_ENFORCED_STOP_LENGTH = 256;

const DELTA_TEXT_KEYS = ["content", "reasoning_content", "reasoning", "thinking"];

/**
 * Normalise every spelling of "stop sequence" we may find in an outbound body
 * into a list of non-empty strings.
 *
 * @param {object|undefined|null} body body actually sent upstream
 * @returns {string[]}
 */
export function collectStopSequences(body) {
  if (!body || typeof body !== "object") return [];
  // Flat spellings (OpenAI `stop`, Anthropic `stop_sequences`) plus the nested
  // Gemini one, so a Gemini-dialect client body is understood as well.
  const candidates = [body.stop, body.stop_sequences, body.stopSequences, body.generationConfig?.stopSequences];
  const out = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const list = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of list) {
      if (typeof entry === "string" && entry.length > 0 && !out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

/**
 * Tracks generated text and answers "how much of this may I emit now?".
 * One instance per request/stream — it carries the hold-back buffer.
 */
export class StopSequenceGuard {
  constructor(stops) {
    const usable = collectStopSequences({ stop: stops }).filter((s) => s.length <= MAX_ENFORCED_STOP_LENGTH);
    this.stops = usable;
    /** True once a stop sequence was found and the turn was cut. */
    this.hit = false;
    /** The sequence that caused the cut (for diagnostics). */
    this.matched = null;
    /** Text withheld because it might be the prefix of a stop sequence. */
    this.holdover = "";
    /** Upstream dialect seen so far, so synthetic chunks match the stream. */
    this.shape = null;
    /** Last real chunk, cloned when a synthetic chunk must be emitted. */
    this.template = null;
  }

  get active() {
    return this.stops.length > 0;
  }

  /**
   * Length of the longest suffix of `text` that is a proper prefix of one of the
   * stop sequences — i.e. the smallest amount that must be withheld because the
   * next characters could complete a match. Ordinary text has none, so it streams
   * straight through and chunk boundaries stay as the provider sent them.
   */
  #partialPrefixLength(text) {
    let longest = 0;
    for (const stop of this.stops) {
      for (let length = Math.min(stop.length - 1, text.length); length > longest; length--) {
        if (text.endsWith(stop.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  }

  /**
   * Feed the text of one delta. Returns the text that is safe to emit now.
   * Returns "" once the turn has been cut.
   */
  push(text) {
    if (this.hit || typeof text !== "string" || text.length === 0) return "";
    if (!this.active) return text;
    const combined = this.holdover + text;
    let hitIndex = -1;
    let matched = null;
    for (const stop of this.stops) {
      const index = combined.indexOf(stop);
      if (index < 0) continue;
      // Earliest cut wins; on a tie prefer the longest sequence (most specific).
      if (hitIndex < 0 || index < hitIndex || (index === hitIndex && stop.length > (matched?.length ?? 0))) {
        hitIndex = index;
        matched = stop;
      }
    }
    if (hitIndex >= 0) {
      this.hit = true;
      this.matched = matched;
      this.holdover = "";
      return combined.slice(0, hitIndex);
    }
    const hold = this.#partialPrefixLength(combined);
    this.holdover = hold > 0 ? combined.slice(combined.length - hold) : "";
    return hold > 0 ? combined.slice(0, combined.length - hold) : combined;
  }

  /** Held-back text; must be emitted before the stream ends or it is lost. */
  takeHoldover() {
    const held = this.holdover;
    this.holdover = "";
    return held;
  }
}

function isOpenAIChunk(json) {
  return Array.isArray(json?.choices);
}

function isAnthropicChunk(json) {
  return typeof json?.type === "string" && (json.type.startsWith("content_block_delta") || json.type === "message_delta" || json.type === "message_stop" || json.type === "message_start");
}

/** Terminal chunks must not be forwarded before held-back text is flushed. */
function isTerminalChunk(json) {
  if (isOpenAIChunk(json)) return json.choices.some((choice) => choice?.finish_reason);
  if (isAnthropicChunk(json)) return json.type === "message_delta" || json.type === "message_stop";
  return false;
}

/**
 * The text field of a content-bearing delta, or null when the chunk carries no
 * text. Returned as an accessor so callers can rewrite it in place.
 */
function textAccessor(json) {
  if (isOpenAIChunk(json)) {
    const choices = json.choices.filter((choice) => choice?.delta && typeof choice.delta.content === "string");
    if (choices.length === 0) return null;
    return {
      get: () => choices.map((choice) => choice.delta.content).join(""),
      set: (value) => {
        // Feed the whole delta text through one guard, then split it again is
        // unnecessary: multi-choice responses are rare and each choice keeps its
        // own share only when they are equal in practice. Apply to the first
        // text-bearing choice and blank the rest so nothing escapes the cut.
        choices.forEach((choice, index) => {
          choice.delta.content = index === 0 ? value : "";
        });
      },
    };
  }
  if (isAnthropicChunk(json) && json.type === "content_block_delta" && typeof json.delta?.text === "string") {
    return { get: () => json.delta.text, set: (value) => { json.delta.text = value; } };
  }
  return null;
}

/** Remove generated content and tool calls from a chunk after a cut. */
function stripDelta(json) {
  if (isOpenAIChunk(json)) {
    for (const choice of json.choices) {
      const delta = choice?.delta;
      if (!delta || typeof delta !== "object") continue;
      for (const key of DELTA_TEXT_KEYS) if (key in delta) delta[key] = "";
      delete delta.tool_calls;
      delete delta.function_call;
    }
    return;
  }
  if (isAnthropicChunk(json) && json.type === "content_block_delta") {
    if (typeof json.delta?.text === "string") json.delta.text = "";
    delete json.delta?.partial_json;
  }
}

function finishReasonAccessor(json) {
  if (isOpenAIChunk(json)) {
    const choices = json.choices.filter((choice) => choice?.finish_reason);
    if (choices.length === 0) return null;
    return { set: (value) => { for (const choice of choices) choice.finish_reason = value; } };
  }
  if (isAnthropicChunk(json) && json.type === "message_delta" && json.delta?.stop_reason) {
    return { set: (value) => { json.delta.stop_reason = value; } };
  }
  return null;
}

/** A synthetic chunk carrying held-back text, shaped like the upstream stream. */
function holdoverChunk(guard, text) {
  if (guard.shape === "anthropic") {
    return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  }
  const base = guard.template && isOpenAIChunk(guard.template) ? { ...guard.template } : {};
  delete base.usage;
  return { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

function encodeDataLine(guard, json) {
  return `data: ${JSON.stringify(json)}`;
}

function emitHoldover(guard, out) {
  const held = guard.takeHoldover();
  if (held) out.push(encodeDataLine(guard, holdoverChunk(guard, held)));
}

/**
 * Rewrite one SSE line. Returns the list of lines to emit in its place (usually
 * exactly the input line).
 */
function transformLine(line, guard, out) {
  if (!guard.active || !line.startsWith("data:")) {
    out.push(line);
    return;
  }
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") {
    // Keepalive or end-of-stream: held-back text must go out first.
    emitHoldover(guard, out);
    out.push(line);
    return;
  }
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    out.push(line);
    return;
  }
  if (!isOpenAIChunk(json) && !isAnthropicChunk(json)) {
    out.push(line);
    return;
  }
  guard.shape = isAnthropicChunk(json) ? "anthropic" : "openai";
  if (isOpenAIChunk(json)) guard.template = json;

  if (isTerminalChunk(json)) emitHoldover(guard, out);

  const before = JSON.stringify(json);
  const hitBeforeChunk = guard.hit;
  const accessor = textAccessor(json);
  if (accessor) {
    const original = accessor.get();
    const emit = hitBeforeChunk ? "" : guard.push(original);
    if (emit !== original) accessor.set(emit);
  }
  if (guard.hit) {
    // The chunk that produced the cut legitimately carries the text before the
    // sequence — only chunks arriving after it must have their output removed.
    if (hitBeforeChunk) stripDelta(json);
    const finish = finishReasonAccessor(json);
    // The provider's own reason for ending is now irrelevant: we cut the turn
    // because the client's stop sequence appeared. `max_tokens` in particular
    // must not survive — it is what makes the client discard the answer.
    if (finish) finish.set(guard.shape === "anthropic" ? "stop_sequence" : "stop");
  }
  out.push(JSON.stringify(json) !== before ? encodeDataLine(guard, json) : line);
}

/**
 * Wrap an SSE byte stream so generated text stops at the first requested stop
 * sequence. Non-SSE chunks pass through untouched (fail open).
 *
 * @param {ReadableStream<Uint8Array>} stream upstream response body
 * @param {StopSequenceGuard} guard
 * @returns {ReadableStream<Uint8Array>}
 */
export function applyStopSequenceGuard(stream, guard) {
  if (!guard?.active || !stream) return stream;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  let buffer = "";
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const out = [];
          transformLine(line, guard, out);
          for (const entry of out) controller.enqueue(encoder.encode(`${entry}\n`));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          const out = [];
          transformLine(buffer, guard, out);
          for (const entry of out) controller.enqueue(encoder.encode(`${entry}\n`));
          buffer = "";
        }
        const out = [];
        emitHoldover(guard, out);
        for (const entry of out) controller.enqueue(encoder.encode(`${entry}\n`));
      },
    })
  );
}
