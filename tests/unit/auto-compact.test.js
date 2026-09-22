// Auto-compaction service: pure helpers (estimation, safe cut, planning,
// transcript, summary attach, window resolution) + the fail-open orchestrator
// that rewrites body.messages via an internal guarded summary call.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCustomModels: vi.fn(),
  getAllModelCaps: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ getCustomModels: mocks.getCustomModels }));
vi.mock("@/lib/modelCapsDb", () => ({ getAllModelCaps: mocks.getAllModelCaps }));
vi.mock("@/sse/utils/logger.js", () => ({
  info: mocks.logInfo,
  warn: mocks.logWarn,
  debug: vi.fn(),
  error: vi.fn(),
}));

const svc = await import("@/sse/services/autoCompact.js");
const {
  estimateTextTokens,
  estimateRequestTokens,
  findSafeCutIndex,
  buildCompactPlan,
  renderTranscript,
  attachSummaryToFirstTail,
  resolveModelWindow,
  invalidateWindowCache,
  detectChatFormat,
  maybeCompactChatBody,
  INTERNAL_COMPACTION_HEADER,
} = svc;
const { FORMATS } = await import("open-sse/translator/formats.js");

beforeEach(() => {
  vi.clearAllMocks();
  invalidateWindowCache();
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getAllModelCaps.mockResolvedValue({});
});

describe("estimateTextTokens", () => {
  it("counts ascii at ~4 chars/token", () => {
    expect(estimateTextTokens("a".repeat(40))).toBe(10);
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens(null)).toBe(0);
  });
  it("weights CJK heavier than ascii", () => {
    const cjk = estimateTextTokens("中".repeat(10));
    const ascii = estimateTextTokens("a".repeat(10));
    expect(cjk).toBe(12); // ceil(10*1.2)
    expect(cjk).toBeGreaterThan(ascii);
  });
});

describe("estimateRequestTokens", () => {
  it("includes system, messages, and tool definitions", () => {
    const base = estimateRequestTokens({ messages: [{ role: "user", content: "x".repeat(400) }] }, FORMATS.OPENAI);
    const withTools = estimateRequestTokens({
      messages: [{ role: "user", content: "x".repeat(400) }],
      tools: [{ type: "function", function: { name: "f", description: "d".repeat(800), parameters: {} } }],
    }, FORMATS.OPENAI);
    expect(withTools).toBeGreaterThan(base);
    const claude = estimateRequestTokens({
      system: "s".repeat(800),
      messages: [{ role: "user", content: "x".repeat(400) }],
    }, FORMATS.CLAUDE);
    expect(claude).toBeGreaterThan(base);
  });
  it("counts media flat instead of base64 length", () => {
    const withImage = estimateRequestTokens({
      messages: [{ role: "user", content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(400000)}` } },
      ] }],
    }, FORMATS.OPENAI);
    const textOnly = estimateRequestTokens({ messages: [{ role: "user", content: "hi" }] }, FORMATS.OPENAI);
    // 400k chars of base64 would be ~100k tokens if (wrongly) counted by length.
    expect(withImage - textOnly).toBeLessThan(1200);
  });
});

describe("findSafeCutIndex", () => {
  const alt = (n, last = "user") => {
    const msgs = [];
    for (let i = 0; i < n; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x" });
    if (last && msgs[msgs.length - 1].role !== last) msgs[msgs.length - 1] = { role: last, content: "x" };
    return msgs;
  };
  it("cuts at the first user boundary inside the kept window", () => {
    // 11 alternating msgs (user at even idx), keep 4 → start=7 → boundary idx 8
    expect(findSafeCutIndex(alt(11), FORMATS.OPENAI, 4)).toBe(8);
  });
  it("never returns a cut that leaves no prefix or no tail", () => {
    expect(findSafeCutIndex(alt(2), FORMATS.OPENAI, 8)).toBe(-1);
  });
  it("skips Anthropic user messages that carry tool_result (orphan tool_use)", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", name: "t", id: "1", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "and now?" },
    ];
    // keep=4 → start=1 → idx 2 rejected (tool_result), idx 4 is plain user → cut there
    expect(findSafeCutIndex(msgs, FORMATS.CLAUDE, 4)).toBe(4);
    // keep=5 → start=0.. boundary idx 2 rejected, idx 4 accepted: prefix nonempty
    expect(findSafeCutIndex(msgs, FORMATS.CLAUDE, 5)).toBe(4);
    // keep=1 → start=4 → boundary idx4 → tail len 1
    expect(findSafeCutIndex(msgs, FORMATS.CLAUDE, 1)).toBe(4);
  });
});

describe("buildCompactPlan", () => {
  const bigBody = () => ({
    messages: Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(12000),
    })),
  });
  it("returns null below the threshold", () => {
    const plan = buildCompactPlan({ body: bigBody(), fmt: FORMATS.OPENAI, contextWindow: 500000, ratio: 0.9, keepRecent: 4, est: 30000 });
    expect(plan).toBeNull();
  });
  it("splits prefix/tail above the threshold", () => {
    const body = bigBody();
    const est = estimateRequestTokens(body, FORMATS.OPENAI);
    const plan = buildCompactPlan({ body, fmt: FORMATS.OPENAI, contextWindow: 20000, ratio: 0.9, keepRecent: 4, est });
    expect(plan).toBeTruthy();
    expect(plan.prefix.length + plan.tail.length).toBe(body.messages.length);
    expect(plan.tail[plan.tail.length - 1].role).toBe("assistant");
    // keep=4 → start=6; idx6 is a plain user message (even= user) → cut there
    expect(plan.cut).toBe(6);
  });
  it("returns null without a usable window", () => {
    expect(buildCompactPlan({ body: bigBody(), fmt: FORMATS.OPENAI, contextWindow: null, ratio: 0.9, keepRecent: 4, est: 999999 })).toBeNull();
  });
});

describe("renderTranscript", () => {
  const msgs = [
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "tool_use", name: "bash", input: { cmd: "ls" } }] },
    { role: "user", content: "second question" },
  ];
  it("renders roles and tool calls when budget allows", () => {
    const t = renderTranscript(msgs, 100000);
    expect(t).toContain("<user> first question");
    expect(t).toContain("call:bash");
    expect(t).not.toContain("omitted");
  });
  it("drops the oldest lines with a marker when over budget", () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `msg ${i} ${"y".repeat(800)}` }));
    const t = renderTranscript(long, 500);
    expect(t).toContain("omitted for length");
    expect(t).toContain("msg 29"); // newest kept
    expect(t).not.toContain("msg 0 ");
  });
});

describe("attachSummaryToFirstTail", () => {
  it("claude string content becomes [note, original] blocks", () => {
    const out = attachSummaryToFirstTail({ role: "user", content: "hello" }, FORMATS.CLAUDE, "SUMMARY");
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content[0].text).toContain("SUMMARY");
    expect(out.content[1].text).toBe("hello");
    expect(out.role).toBe("user");
  });
  it("claude array content is prepended without touching media blocks", () => {
    const out = attachSummaryToFirstTail(
      { role: "user", content: [{ type: "image", source: {} }] }, FORMATS.CLAUDE, "S");
    expect(out.content[0].type).toBe("text");
    expect(out.content[1].type).toBe("image");
  });
  it("openai string content concatenates", () => {
    const out = attachSummaryToFirstTail({ role: "user", content: "hi" }, FORMATS.OPENAI, "S");
    expect(out.content).toContain("S");
    expect(out.content.endsWith("hi")).toBe(true);
  });
});

describe("resolveModelWindow", () => {
  it("pinned modelCaps win, under alias or canonical id, and cache invalidation works", async () => {
    mocks.getAllModelCaps.mockResolvedValue({ "codebuddy-cn": { "hy3": { contextWindow: 123456 } } });
    // alias "cbcn" must resolve to canonical "codebuddy-cn" pins
    expect((await resolveModelWindow("cbcn/hy3")).contextWindow).toBe(123456);
    mocks.getAllModelCaps.mockResolvedValue({ "codebuddy-cn": { "hy3": { contextWindow: 999 } } });
    // cached → still old value
    expect((await resolveModelWindow("cbcn/hy3")).contextWindow).toBe(123456);
    invalidateWindowCache();
    expect((await resolveModelWindow("cbcn/hy3")).contextWindow).toBe(999);
  });
  it("variant suffix falls back to the base model's numbers", async () => {
    mocks.getAllModelCaps.mockResolvedValue({ "glm": { "base-m": { contextWindow: 4321 } } });
    expect((await resolveModelWindow("glm/base-m:agentic")).contextWindow).toBe(4321);
  });
  it("custom row beats the capabilities default", async () => {
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "mynode", id: "custom-gpt", type: "llm", contextWindow: 777000, maxOutput: 9000 },
    ]);
    const win = await resolveModelWindow("mynode/custom-gpt");
    expect(win.contextWindow).toBe(777000);
    expect(win.maxOutput).toBe(9000);
  });
  it("unknown model without a window returns null window (caller fails open)", async () => {
    // capabilities always has a default; but a non-"alias/model" string yields null
    expect(await resolveModelWindow("no-slash")).toBeNull();
  });
});

// ── orchestrator ───────────────────────────────────────────────────────────

const makeRequest = (url = "http://127.0.0.1:20128/v1/chat/completions", headers = {}) => ({
  url,
  headers: new Headers({ "content-type": "application/json", authorization: "Bearer sk-1", ...headers }),
});

const bigOpenaiBody = () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ` + "x".repeat(13000) });
  }
  messages.push({ role: "user", content: "final question" });
  return { model: "testprov/test-model", messages };
};

describe("maybeCompactChatBody", () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("skips the internal summary request (recursion guard)", async () => {
    const request = makeRequest(undefined, { [INTERNAL_COMPACTION_HEADER]: "1" });
    const body = bigOpenaiBody();
    const done = await maybeCompactChatBody({ request, body, modelStr: "p/m", endpoint: "/v1/chat/completions", settings: {} });
    expect(done).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when disabled", async () => {
    const body = bigOpenaiBody();
    const done = await maybeCompactChatBody({
      request: makeRequest(), body, modelStr: "testprov/test-model", endpoint: "/v1/chat/completions",
      settings: { autoCompactEnabled: false },
    });
    expect(done).toBe(false);
  });

  it("skips small requests WITHOUT any fetch or caps DB read (hot path)", async () => {
    const body = { model: "p/m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "?" }] };
    const done = await maybeCompactChatBody({
      request: makeRequest(), body, modelStr: "p/m", endpoint: "/v1/chat/completions", settings: {},
    });
    expect(done).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.getAllModelCaps).not.toHaveBeenCalled();
  });

  it("skips responses-api format", async () => {
    const body = { model: "p/m", input: [{ role: "user", content: "x".repeat(50000) }] };
    const done = await maybeCompactChatBody({
      request: makeRequest("http://x/v1/responses"), body, modelStr: "p/m", endpoint: "/v1/responses", settings: {},
    });
    expect(done).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("compacts: internal guarded call, summary folded into first kept msg", async () => {
    mocks.getAllModelCaps.mockResolvedValue({ "testprov": { "test-model": { contextWindow: 30000 } } });
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "THE SUMMARY" } }],
    }), { status: 200 }));
    const body = bigOpenaiBody();
    const request = makeRequest();
    const done = await maybeCompactChatBody({
      request, body, modelStr: "testprov/test-model", endpoint: "/v1/chat/completions", settings: {},
    });
    expect(done).toBe(true);
    // one internal call to the LOCAL gateway, with the guard header + auth copied
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:20128/v1/chat/completions");
    expect(init.headers[INTERNAL_COMPACTION_HEADER]).toBe("1");
    expect(init.headers.authorization).toBe("Bearer sk-1");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("testprov/test-model");
    expect(sent.stream).toBe(false);
    expect(sent.enable_thinking).toBe(false); // keep reasoning models from burning max_tokens on thinking
    // rewritten: fewer messages, first message starts with the summary note,
    // last kept messages untouched
    const orig = bigOpenaiBody();
    expect(body.messages.length).toBeLessThan(orig.messages.length);
    expect(body.messages[0].content).toContain("THE SUMMARY");
    expect(body.messages[body.messages.length - 1].content).toBe("final question");
    expect(mocks.logInfo).toHaveBeenCalled();
  });

  it("uses reasoning_content as fallback when content is empty", async () => {
    mocks.getAllModelCaps.mockResolvedValue({ "testprov": { "test-model": { contextWindow: 30000 } } });
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "REASONED SUMMARY" } }],
    }), { status: 200 }));
    const body = bigOpenaiBody();
    const done = await maybeCompactChatBody({
      request: makeRequest(), body, modelStr: "testprov/test-model", endpoint: "/v1/chat/completions", settings: {},
    });
    expect(done).toBe(true);
    expect(body.messages[0].content).toContain("REASONED SUMMARY");
  });

  it("empty summary on both fields → warns and keeps original body", async () => {
    mocks.getAllModelCaps.mockResolvedValue({ "testprov": { "test-model": { contextWindow: 30000 } } });
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "" } }],
    }), { status: 200 }));
    const body = bigOpenaiBody();
    const snapshot = JSON.stringify(body);
    const done = await maybeCompactChatBody({
      request: makeRequest(), body, modelStr: "testprov/test-model", endpoint: "/v1/chat/completions", settings: {},
    });
    expect(done).toBe(false);
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(mocks.logWarn).toHaveBeenCalledWith("COMPACT", expect.stringContaining("empty summary"));
  });

  it("falls open when the summary call fails (body untouched)", async () => {
    mocks.getAllModelCaps.mockResolvedValue({ "testprov": { "test-model": { contextWindow: 30000 } } });
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    const body = bigOpenaiBody();
    const snapshot = JSON.stringify(body);
    const done = await maybeCompactChatBody({
      request: makeRequest(), body, modelStr: "testprov/test-model", endpoint: "/v1/chat/completions", settings: {},
    });
    expect(done).toBe(false);
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(mocks.logWarn).toHaveBeenCalled();
  });

  it("claude shape: cut avoids tool_result heads and system stays put", async () => {
    mocks.getAllModelCaps.mockResolvedValue({ "testprov": { "test-model": { contextWindow: 20000 } } });
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "SUM" } }],
    }), { status: 200 }));
    const messages = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: "user", content: `q${i} ` + "x".repeat(18000) });
      messages.push({ role: "assistant", content: [{ type: "tool_use", name: "t", id: `id${i}`, input: { a: 1 } }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `id${i}`, content: "out" }] });
      messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    }
    messages.push({ role: "user", content: "final?" });
    const body = { model: "testprov/test-model", system: "SYS PROMPT", messages };
    const done = await maybeCompactChatBody({
      request: makeRequest("http://127.0.0.1:20128/v1/messages"), body, modelStr: "testprov/test-model", endpoint: "/v1/messages",
      settings: { autoCompactKeepMessages: 6 },
    });
    expect(done).toBe(true);
    expect(body.system).toBe("SYS PROMPT"); // untouched
    const first = body.messages[0];
    expect(first.role).toBe("user");
    expect(Array.isArray(first.content)).toBe(true);
    expect(first.content[0].type).toBe("text");
    expect(first.content[0].text).toContain("SUM");
    // no message at the head carries an orphan tool_result whose tool_use moved away:
    // the FIRST kept boundary was a plain user message; everything tool-paired stayed grouped
    for (const m of body.messages) {
      if (m.role === "user" && Array.isArray(m.content)) {
        const hasTr = m.content.some((b) => b.type === "tool_result");
        if (hasTr) {
          // its tool_use must be the immediately-preceding assistant
          const idx = body.messages.indexOf(m);
          const prev = body.messages[idx - 1];
          expect(prev?.role).toBe("assistant");
        }
      }
    }
  });
});

describe("detectChatFormat", () => {
  it("maps endpoints", () => {
    expect(detectChatFormat("/v1/messages", {})).toBe(FORMATS.CLAUDE);
    expect(detectChatFormat("/v1/chat/completions", { messages: [] })).toBe(FORMATS.OPENAI);
    expect(detectChatFormat("/v1/responses", {})).toBe(FORMATS.OPENAI_RESPONSES);
  });
  it("body-shape fallback", () => {
    expect(detectChatFormat("/weird", { system: "s", messages: [] })).toBe(FORMATS.CLAUDE);
    expect(detectChatFormat("/weird", { messages: [{ role: "user", content: "x" }] })).toBe(FORMATS.OPENAI);
    expect(detectChatFormat("/weird", { input: [] })).toBe(FORMATS.OPENAI_RESPONSES);
    expect(detectChatFormat("/weird", { contents: [] })).toBe(null);
  });
});
