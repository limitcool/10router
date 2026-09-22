// Issue #10: combo must fall through when a model answers 2xx with an empty
// content-filtered stream (finish_reason "sensitive"/"content_filter" + zero
// output tokens) instead of handing the client a blank answer.
//
// Offline by construction: fake Responses built in-process, fake
// handleSingleModel, silent logger — no DB, no network, no real keys.
import { describe, it, expect } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";
import {
  isFilterFinishReason,
  inspectNonStream,
  gateResponse,
  createStreamScanner,
} from "open-sse/services/sensitiveRetry.js";

const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const enc = new TextEncoder();

// Build an SSE Response from parsed-chunk objects (or raw strings).
function sseResponse(events, contentType = "text/event-stream") {
  const body =
    events
      .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

// The reporter's exact shape: stream opens, role delta, then a filtered
// terminal with zero output tokens.
const openaiEmptyFiltered = [
  { id: "1", choices: [{ index: 0, delta: { role: "assistant" } }] },
  { id: "1", choices: [{ index: 0, delta: {}, finish_reason: "sensitive" }] },
];

const openaiContent = [
  { id: "2", choices: [{ index: 0, delta: { role: "assistant" } }] },
  { id: "2", choices: [{ index: 0, delta: { content: "Hello " } }] },
  { id: "2", choices: [{ index: 0, delta: { content: "world" } }] },
  { id: "2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

const claudeEmptyFiltered = [
  { type: "message_start", message: { id: "m1", role: "assistant" } },
  { type: "message_delta", delta: { stop_reason: "sensitive" } },
];

describe("isFilterFinishReason", () => {
  it("recognises content-safety terminals case/space-insensitively", () => {
    expect(isFilterFinishReason("sensitive")).toBe(true);
    expect(isFilterFinishReason(" SENSITIVE ")).toBe(true);
    expect(isFilterFinishReason("content_filter")).toBe(true);
    expect(isFilterFinishReason("Content-Filter")).toBe(true);
  });

  it("does not steal normal terminals", () => {
    expect(isFilterFinishReason("stop")).toBe(false);
    expect(isFilterFinishReason("length")).toBe(false);
    expect(isFilterFinishReason("end_turn")).toBe(false);
    expect(isFilterFinishReason("tool_calls")).toBe(false);
    expect(isFilterFinishReason(null)).toBe(false);
    expect(isFilterFinishReason(42)).toBe(false);
  });
});

describe("inspectNonStream", () => {
  it("flags an empty content-filtered OpenAI completion as retryable", () => {
    const r = inspectNonStream({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
    });
    expect(r).toMatchObject({ retryable: true, empty: true, filtered: true });
  });

  it("keeps a real answer (even with a filtered reason) non-retryable", () => {
    // Some providers emit partial content THEN filter — the content is real
    // and must reach the client.
    const r = inspectNonStream({
      choices: [{ message: { content: "partial answer" }, finish_reason: "content_filter" }],
    });
    expect(r.retryable).toBe(false);
  });

  it("treats tool_calls as valuable content", () => {
    const r = inspectNonStream({
      choices: [{ message: { content: "", tool_calls: [{ id: "t1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    });
    expect(r.retryable).toBe(false);
  });

  it("flags empty Claude and Gemini completions", () => {
    expect(inspectNonStream({ content: [], stop_reason: "sensitive" }).retryable).toBe(true);
    expect(inspectNonStream({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }).retryable).toBe(true);
  });

  it("never flags unknown shapes (binary-ish payloads must pass through)", () => {
    expect(inspectNonStream({ audio: "AAAA" }).retryable).toBe(false);
    expect(inspectNonStream(null).retryable).toBe(false);
  });
});

describe("createStreamScanner", () => {
  it("commits on the first valuable delta", () => {
    const s = createStreamScanner();
    const r = s.push(enc.encode(`data: ${JSON.stringify(openaiContent[1])}\n\n`));
    expect(r.kind).toBe("commit");
    // after commit, everything is passthrough
    expect(s.push(enc.encode("data: whatever\n\n")).kind).toBe("passthrough");
  });

  it("retries on a filtered terminal with zero content", () => {
    const s = createStreamScanner();
    expect(s.push(enc.encode(`data: ${JSON.stringify(openaiEmptyFiltered[0])}\n\n`)).kind).toBe("buffered");
    const r = s.push(enc.encode(`data: ${JSON.stringify(openaiEmptyFiltered[1])}\n\ndata: [DONE]\n\n`));
    expect(r.kind).toBe("retry");
  });

  it("retries on [DONE] with no content at all (silent filter)", () => {
    const s = createStreamScanner();
    expect(s.push(enc.encode(`data: ${JSON.stringify(openaiEmptyFiltered[0])}\n\ndata: [DONE]\n\n`)).kind).toBe("retry");
  });

  it("retries when the stream closes abruptly with nothing valuable", () => {
    const s = createStreamScanner();
    s.push(enc.encode(`data: ${JSON.stringify(claudeEmptyFiltered[0])}\n\n`));
    expect(s.finish().kind).toBe("retry");
  });

  it("handles CJK split across chunk boundaries (single decoder)", () => {
    // 你 = E4 BD A0 — split mid-character between pushes. A per-push decoder
    // would corrupt the line and miss the content. Compute the split point
    // dynamically: the first 0xE4 byte is the start of 你 (everything before
    // is ASCII).
    const full = enc.encode(`data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n`);
    const split = full.indexOf(0xe4) + 1; // one byte INTO the character
    const s = createStreamScanner();
    expect(s.push(full.slice(0, split)).kind).toBe("buffered");
    expect(s.push(full.slice(split)).kind).toBe("commit");
  });

  it("counts reasoning_content and tool-call deltas as valuable", () => {
    const s1 = createStreamScanner();
    expect(s1.push(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n')).kind).toBe("commit");

    const s2 = createStreamScanner();
    expect(
      s2.push(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"id":"t1","function":{"name":"f","arguments":""}}]}}]}\n\n'))
        .kind
    ).toBe("commit");
  });

  it("ignores empty-string deltas (role-only chunks are not content)", () => {
    const s = createStreamScanner();
    expect(s.push(enc.encode('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n')).kind).toBe("buffered");
  });
});

describe("gateResponse", () => {
  it("retries an empty filtered SSE stream", async () => {
    const gate = await gateResponse(sseResponse(openaiEmptyFiltered));
    expect(gate.action).toBe("retry");
  });

  it("commits a real stream and replays every buffered byte losslessly", async () => {
    const original = sseResponse(openaiContent);
    const expected = await original.clone().text();
    const gate = await gateResponse(original);
    expect(gate.action).toBe("commit");
    expect(gate.response.status).toBe(200);
    expect(gate.response.headers.get("content-type")).toBe("text/event-stream");
    expect(await gate.response.text()).toBe(expected);
  });

  it("retries an empty filtered non-stream JSON completion", async () => {
    const res = new Response(
      JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "sensitive" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const gate = await gateResponse(res);
    expect(gate.action).toBe("retry");
  });

  it("commits (rewraps) a non-stream JSON answer with content", async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    const res = new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    const gate = await gateResponse(res);
    expect(gate.action).toBe("commit");
    expect(await gate.response.text()).toBe(payload);
  });

  it("commits unparseable non-JSON bodies untouched", async () => {
    const res = new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } });
    const gate = await gateResponse(res);
    expect(gate.action).toBe("commit");
    expect(await gate.response.text()).toBe("not json at all");
  });
});

describe("handleComboChat retryOnEmpty (issue #10)", () => {
  const body = { messages: [{ role: "user", content: "hi" }], stream: true };

  function fakeProvider(script) {
    const attempts = [];
    const handleSingleModel = async (_b, model) => {
      attempts.push(model);
      const step = script[model] ?? "content";
      if (step === "empty-filtered") return sseResponse(openaiEmptyFiltered);
      if (step === "empty-filtered-claude") return sseResponse(claudeEmptyFiltered);
      if (step === "content") return sseResponse(openaiContent);
      if (step === "audio") {
        return new Response(enc.encode("fake-audio-bytes"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      if (step === "fail") {
        return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unknown step ${step}`);
    };
    return { attempts, handleSingleModel };
  }

  async function run(models, script, opts = {}) {
    const { attempts, handleSingleModel } = fakeProvider(script);
    const res = await handleComboChat({
      body,
      models,
      handleSingleModel,
      log: silentLog,
      comboName: "combo-under-test",
      comboStrategy: "fallback",
      ...opts,
    });
    return { attempts, res, text: await res.text() };
  }

  it("default OFF: an empty filtered 200 is returned as-is (no behaviour change)", async () => {
    const { attempts, text } = await run(["m1", "m2"], { m1: "empty-filtered" });
    expect(attempts).toEqual(["m1"]);
    expect(text).not.toContain("Hello");
  });

  it("opted in: falls through to the next model and returns its real answer", async () => {
    const { attempts, res, text } = await run(["m1", "m2"], { m1: "empty-filtered" }, { retryOnEmpty: true });
    expect(attempts).toEqual(["m1", "m2"]);
    expect(res.ok).toBe(true);
    expect(text).toContain('"content":"Hello "');
    expect(text).toContain('"content":"world"');
  });

  it("opted in: works for Claude-format filtered terminals too", async () => {
    const { attempts, text } = await run(
      ["m1", "m2"],
      { m1: "empty-filtered-claude" },
      { retryOnEmpty: true }
    );
    expect(attempts).toEqual(["m1", "m2"]);
    expect(text).toContain('"content":"Hello "');
  });

  it("opted in: a real answer on the first model passes through untouched", async () => {
    const { attempts, text } = await run(["m1", "m2"], {}, { retryOnEmpty: true });
    expect(attempts).toEqual(["m1"]);
    expect(text).toContain('"content":"Hello "');
  });

  it("opted in: the LAST model is never gated — empty 200 beats synthetic 5xx", async () => {
    const { attempts, res } = await run(["m1"], { m1: "empty-filtered" }, { retryOnEmpty: true });
    expect(attempts).toEqual(["m1"]);
    expect(res.status).toBe(200);
  });

  it("opted in: non-gateable content types (audio) bypass the gate entirely", async () => {
    const { attempts } = await run(["m1", "m2"], { m1: "audio" }, { retryOnEmpty: true });
    expect(attempts).toEqual(["m1"]);
  });

  it("opted in: every model empty → the last empty response is returned, not an error", async () => {
    const { attempts, res } = await run(
      ["m1", "m2"],
      { m1: "empty-filtered", m2: "empty-filtered" },
      { retryOnEmpty: true }
    );
    expect(attempts).toEqual(["m1", "m2"]);
    expect(res.status).toBe(200);
  });

  it("opted in: hard failures still fall back as before (gate does not interfere)", async () => {
    const { attempts, text } = await run(
      ["m1", "m2"],
      { m1: "fail" },
      { retryOnEmpty: true }
    );
    expect(attempts).toEqual(["m1", "m2"]);
    expect(text).toContain('"content":"Hello "');
  });

  it("opted in: hard failure on first + empty-filtered on second → last empty 200 returned", async () => {
    const { attempts, res } = await run(
      ["m1", "m2"],
      { m1: "fail", m2: "empty-filtered" },
      { retryOnEmpty: true }
    );
    expect(attempts).toEqual(["m1", "m2"]);
    expect(res.status).toBe(200);
  });

  it("caps the burn budget: retryOnEmptyLimit=1 stops gating after one empty retry", async () => {
    // m1 burns (empty-retry 1/1); at m2 the budget is exhausted → its 2xx passes
    // through ungated even though it is also empty. m3/m4 are never called.
    const { attempts, res } = await run(
      ["m1", "m2", "m3", "m4"],
      { m1: "empty-filtered", m2: "empty-filtered", m3: "empty-filtered", m4: "content" },
      { retryOnEmpty: true, retryOnEmptyLimit: 1 }
    );
    expect(attempts).toEqual(["m1", "m2"]);
    expect(res.status).toBe(200);
  });

  it("default burn budget is 2", async () => {
    const { attempts } = await run(
      ["m1", "m2", "m3", "m4"],
      { m1: "empty-filtered", m2: "empty-filtered", m3: "empty-filtered", m4: "content" },
      { retryOnEmpty: true }
    );
    expect(attempts).toEqual(["m1", "m2", "m3"]);
  });

  it("warns when the fallback target is the same provider (likely the same filter)", async () => {
    const warnings = [];
    const spyLog = { ...silentLog, warn: (_tag, msg) => warnings.push(String(msg)) };
    const { attempts, handleSingleModel } = fakeProvider({ "z-ai/glm-a": "empty-filtered" });
    await handleComboChat({
      body,
      models: ["z-ai/glm-a", "z-ai/glm-b"],
      handleSingleModel,
      log: spyLog,
      comboName: "combo-under-test",
      comboStrategy: "fallback",
      retryOnEmpty: true,
    });
    expect(attempts).toEqual(["z-ai/glm-a", "z-ai/glm-b"]);
    expect(warnings.some((w) => w.includes("same provider"))).toBe(true);
  });

  it("no same-provider warning across different vendors", async () => {
    const warnings = [];
    const spyLog = { ...silentLog, warn: (_tag, msg) => warnings.push(String(msg)) };
    const { handleSingleModel } = fakeProvider({ "z-ai/glm-a": "empty-filtered" });
    await handleComboChat({
      body,
      models: ["z-ai/glm-a", "openai/gpt-x"],
      handleSingleModel,
      log: spyLog,
      comboName: "combo-under-test",
      comboStrategy: "fallback",
      retryOnEmpty: true,
    });
    expect(warnings.some((w) => w.includes("same provider"))).toBe(false);
  });
});
