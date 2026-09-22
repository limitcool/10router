import { describe, it, expect } from "vitest";
import {
  collectStopSequences,
  StopSequenceGuard,
  applyStopSequenceGuard,
  MAX_ENFORCED_STOP_LENGTH,
} from "../../open-sse/utils/stopSequenceGuard.js";

// --- helpers ---------------------------------------------------------------

/** Build a ReadableStream that emits the given string chunks verbatim. */
function streamOf(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** Run SSE text through the guard and return the rewritten text. */
async function guardSSE(chunks, stops) {
  const guard = new StopSequenceGuard(stops);
  return collect(applyStopSequenceGuard(streamOf(chunks), guard));
}

/** All `data:` payloads of an SSE text as parsed JSON objects. */
function payloads(sseText) {
  return sseText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line));
}

/** Concatenated assistant text of an OpenAI-shaped SSE stream. */
function openAIContent(sseText) {
  return payloads(sseText)
    .map((json) => json.choices?.[0]?.delta?.content ?? "")
    .join("");
}

/** The finish_reason the client would see. */
function openAIFinish(sseText) {
  const reasons = payloads(sseText)
    .map((json) => json.choices?.[0]?.finish_reason)
    .filter(Boolean);
  return reasons[reasons.length - 1] ?? null;
}

const openAIChunk = (content, extra = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  model: "deepseek-v4.1-flash",
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
  ...extra,
});

// --- collectStopSequences --------------------------------------------------

describe("collectStopSequences", () => {
  it("reads the OpenAI spelling", () => {
    expect(collectStopSequences({ stop: ["</block>"] })).toEqual(["</block>"]);
  });

  it("reads the Anthropic spelling", () => {
    expect(collectStopSequences({ stop_sequences: ["</block>"] })).toEqual(["</block>"]);
  });

  it("reads the nested Gemini spelling", () => {
    expect(collectStopSequences({ generationConfig: { stopSequences: ["STOP"] } })).toEqual(["STOP"]);
  });

  it("tolerates a bare string", () => {
    expect(collectStopSequences({ stop: "STOP" })).toEqual(["STOP"]);
  });

  it("drops blanks and non-strings", () => {
    expect(collectStopSequences({ stop: ["", null, 7, "OK", "OK"] })).toEqual(["OK"]);
  });

  it("returns nothing for an unrelated body", () => {
    expect(collectStopSequences({ messages: [] })).toEqual([]);
    expect(collectStopSequences(null)).toEqual([]);
  });
});

// --- guard core ------------------------------------------------------------

describe("StopSequenceGuard", () => {
  it("cuts at the sequence and excludes it", () => {
    const guard = new StopSequenceGuard(["GAMMA"]);
    expect(guard.push("ALPHA BETA GAMMA DELTA")).toBe("ALPHA BETA ");
    expect(guard.hit).toBe(true);
    expect(guard.matched).toBe("GAMMA");
    expect(guard.push("more text")).toBe("");
  });

  it("holds back only text that could still become a stop sequence", () => {
    const guard = new StopSequenceGuard(["GAMMA"]);
    // ordinary text streams straight through, boundaries untouched
    expect(guard.push("HELLO")).toBe("HELLO");
    expect(guard.holdover).toBe("");
    // ...but a trailing partial match is withheld until it can be decided
    expect(guard.push(" WORLD GAM")).toBe(" WORLD ");
    expect(guard.holdover).toBe("GAM");
  });

  it("catches a sequence split across two deltas", () => {
    const guard = new StopSequenceGuard(["</block>"]);
    expect(guard.push("verdict: </blo")).toBe("verdict: ");
    expect(guard.push("ck><category>x</category>")).toBe("");
    expect(guard.hit).toBe(true);
    expect(guard.matched).toBe("</block>");
  });

  it("prefers the earliest cut, and the longest sequence on a tie", () => {
    const first = new StopSequenceGuard(["END", "STOP"]);
    expect(first.push("A STOP then END", )).toBe("A ");
    const tie = new StopSequenceGuard(["XX", "XXXX"]);
    expect(tie.push("abXXXXcd")).toBe("ab");
    expect(tie.matched).toBe("XXXX");
  });

  it("releases held-back text when no sequence arrives", () => {
    const guard = new StopSequenceGuard(["GAMMA"]);
    expect(guard.push("HELLO GAM")).toBe("HELLO ");
    expect(guard.takeHoldover()).toBe("GAM");
    expect(guard.takeHoldover()).toBe("");
  });

  it("is inert without stop sequences", () => {
    const guard = new StopSequenceGuard([]);
    expect(guard.active).toBe(false);
    expect(guard.push("everything")).toBe("everything");
    expect(guard.hit).toBe(false);
  });

  it("leaves over-long sequences to the provider instead of buffering forever", () => {
    const guard = new StopSequenceGuard(["x".repeat(MAX_ENFORCED_STOP_LENGTH + 1)]);
    expect(guard.active).toBe(false);
  });
});

// --- SSE relay: OpenAI upstream -------------------------------------------

describe("applyStopSequenceGuard (OpenAI-shaped upstream)", () => {
  it("stops the visible text at the client's stop sequence", async () => {
    const out = await guardSSE(
      [
        `data: ${JSON.stringify(openAIChunk("ALPHA BETA "))}\n\n`,
        `data: ${JSON.stringify(openAIChunk("GAMMA DELTA EPSILON"))}\n\n`,
        `data: ${JSON.stringify({ ...openAIChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
      ["GAMMA"]
    );
    expect(openAIContent(out)).toBe("ALPHA BETA ");
    expect(openAIFinish(out)).toBe("stop");
    expect(out).toContain("[DONE]");
  });

  it("keeps the terminal usage chunk so the client can still account for tokens", async () => {
    const usageChunk = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      model: "deepseek-v4.1-flash",
      choices: [],
      usage: { prompt_tokens: 2026, completion_tokens: 9, total_tokens: 2035 },
    };
    const out = await guardSSE(
      [
        `data: ${JSON.stringify(openAIChunk("ALPHA BETA GAMMA rest"))}\n\n`,
        `data: ${JSON.stringify(usageChunk)}\n\n`,
        "data: [DONE]\n\n",
      ],
      ["GAMMA"]
    );
    const usage = payloads(out).map((json) => json.usage).filter(Boolean)[0];
    expect(usage).toEqual(usageChunk.usage);
    expect(openAIContent(out)).toBe("ALPHA BETA ");
  });

  it("rewrites the truncation finish reason the provider reports instead", async () => {
    // The real #18 shape: the stop was ignored, so the turn ends at the token
    // cap. `length` translates to Claude's `max_tokens`, which the classifier's
    // severity parser rejects — so the cut must be reported as a clean stop.
    const out = await guardSSE(
      [
        `data: ${JSON.stringify(openAIChunk("ALPHA BETA GAMMA and then a lot more"))}\n\n`,
        `data: ${JSON.stringify({ ...openAIChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
      ["GAMMA"]
    );
    expect(openAIFinish(out)).toBe("stop");
  });

  it("reproduces the classifier case: <block> verdict survives, the tail does not", async () => {
    const out = await guardSSE(
      [
        `data: ${JSON.stringify(openAIChunk("<block>yes</block><category>Irreversible Local Destruction</category><reason>rm -rf</reason>"))}\n\n`,
        `data: ${JSON.stringify({ ...openAIChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
      ["</block>"]
    );
    // l4e() accepts <block>yes without the closing tag — that is exactly why the
    // closing tag is optional in Claude Code's parser.
    expect(openAIContent(out)).toBe("<block>yes");
    expect(openAIFinish(out)).toBe("stop");
  });

  it("drops tool calls that arrive after the cut", async () => {
    const out = await guardSSE(
      [
        `data: ${JSON.stringify(openAIChunk("ALPHA BETA GAMMA"))}\n\n`,
        `data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ ...openAIChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
      ["GAMMA"]
    );
    expect(payloads(out).some((json) => json.choices?.[0]?.delta?.tool_calls)).toBe(false);
    expect(openAIFinish(out)).toBe("stop");
  });

  it("flushes the held-back tail before the terminal chunk", async () => {
    // No sequence ever completes, so the withheld tail must still reach the
    // client — and it has to arrive before finish_reason, or the translator has
    // already closed the content block.
    const out = await guardSSE(
      [
        `data: ${JSON.stringify(openAIChunk("HELLO NE"))}\n\n`,
        `data: ${JSON.stringify({ ...openAIChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
      ["NEVER"]
    );
    expect(openAIContent(out)).toBe("HELLO NE");
    const lines = payloads(out);
    const tailIndex = lines.findIndex((json) => json.choices?.[0]?.delta?.content === "NE");
    const finishIndex = lines.findIndex((json) => json.choices?.[0]?.finish_reason);
    expect(tailIndex).toBeGreaterThanOrEqual(0);
    expect(tailIndex).toBeLessThan(finishIndex);
  });

  it("carries a sequence split across TCP-sized chunks", async () => {
    const body = `data: ${JSON.stringify(openAIChunk("verdict </blo"))}` + "\n\n" + `data: ${JSON.stringify(openAIChunk("ck>tail"))}` + "\n\n" + "data: [DONE]\n\n";
    // split mid-JSON, so the line assembler is exercised too
    const chunks = [body.slice(0, 60), body.slice(60, 61), body.slice(61)];
    const out = await guardSSE(chunks, ["</block>"]);
    expect(openAIContent(out)).toBe("verdict ");
  });

  it("is byte-identical when nothing matches", async () => {
    const sse = `data: ${JSON.stringify(openAIChunk("hello "))}\n\ndata: ${JSON.stringify(openAIChunk("world"))}\n\ndata: [DONE]\n\n`;
    expect(await guardSSE([sse], ["ZZZ"])).toBe(sse);
  });

  it("is byte-identical when there is no stop sequence at all", async () => {
    const sse = `data: ${JSON.stringify(openAIChunk("hello"))}\n\ndata: [DONE]\n\n`;
    expect(await collect(applyStopSequenceGuard(streamOf([sse]), new StopSequenceGuard([])))).toBe(sse);
  });

  it("leaves non-data lines (keepalives, event names) untouched", async () => {
    const sse = `: keepalive\n\ndata: ${JSON.stringify(openAIChunk("A GAMMA B"))}\n\ndata: [DONE]\n\n`;
    const out = await guardSSE([sse], ["GAMMA"]);
    expect(out.startsWith(": keepalive\n\n")).toBe(true);
  });
});

// --- SSE relay: Anthropic-shaped upstream ---------------------------------

describe("applyStopSequenceGuard (Anthropic-shaped upstream)", () => {
  const anthropicChunk = (text) => ({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });

  it("cuts text_delta content and reports stop_sequence", async () => {
    const out = await guardSSE(
      [
        `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1" } })}\n\n`,
        `data: ${JSON.stringify(anthropicChunk("verdict </severity>4</severity>"))}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 64 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ],
      ["</severity>"]
    );
    const text = payloads(out)
      .map((json) => json.delta?.text ?? "")
      .join("");
    expect(text).toBe("verdict ");
    const stopReason = payloads(out).find((json) => json.type === "message_delta")?.delta?.stop_reason;
    // Anthropic semantics, and r4e() accepts it directly.
    expect(stopReason).toBe("stop_sequence");
    // usage must survive the cut
    expect(payloads(out).find((json) => json.type === "message_delta")?.usage).toEqual({ output_tokens: 64 });
  });
});
