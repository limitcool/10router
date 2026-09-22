// Issue #18: Claude Code auto mode (xml_2stage classifier) fails through the
// gateway when traffic routes to a non-Claude model (reporter: HTTP 200 but
// deepseek-v4.1-flash via CodeBuddy CN answered without the expected XML).
//
// STATE OF THE INVESTIGATION (2026-09-21, reverse-engineered from the shipped
// Claude Code 2.1.278 binary — the classifier module is plain JS inside it):
//
//  * The classifier runs TWO stages. Stage 1 is a cheap pre-filter:
//      request  → max_tokens 64, stop_sequences:["</block>"] (severity mode:
//                 "</severity>"), system = the security-monitor prompt
//      expected → one <block>yes|no</block> verdict, nothing after it
//      parse    → l4e(): every <block>(yes|no) match must AGREE (closing tag
//                 optional); severity mode r4e() additionally REQUIRES
//                 stop_reason ∈ {stop_sequence, end_turn}
//    Stage 2 (max_tokens 8192) runs only when stage 1 says BLOCK.
//
//  * The client parsers tolerate the missing closing tag precisely BECAUSE the
//    stop sequence is supposed to cut the turn the instant the tag appears —
//    stop_sequences is load-bearing, not decorative.
//
//  * FOUND AND FIXED HERE: open-sse/translator/request/claude-to-openai.js never
//    mapped Anthropic `stop_sequences` to OpenAI `stop`, so every claude→openai
//    request silently lost its stop sequences. Verified live: stepfun honours
//    `stop` (the gateway forwards it), so before this fix a Claude client's stop
//    sequences were ignored on every OpenAI-shaped provider.
//
//  * NOT fixable in the translator (verified by calling CodeBuddy CN's upstream
//    directly, gateway bypassed): cbcn IGNORES `stop` outright — it answers the
//    full string with stop:["GAMMA"] present. So on cbcn stage 1 still runs to
//    its 64-token cap; that only breaks the parse in severity mode, where
//    r4e() rejects a `max_tokens` stop_reason. See the issue thread.
//
//  * RULED OUT (previous hypothesis in this file): the cbcn WAF workaround
//    (executors/codebuddy-cn.js) replaces system prompts matching AGENT_PATTERN.
//    The REAL classifier prompt (39,485 chars, "You are a security monitor for
//    autonomous AI coding agents.") does NOT match AGENT_PATTERN and is not
//    whitelisted either → it passes through untouched, XML contract intact. The
//    workaround is still exercised below because it is a real (if unmatched in
//    this traffic) path that must stay for the WAF.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import CodeBuddyExecutor from "../../open-sse/executors/codebuddy-cn.js";

const T = (src, tgt, body, provider = "codebuddy-cn") =>
  translateRequest(src, tgt, "deepseek-v4.1-flash", body, true, null, provider);

// Representative auto-mode classifier prompt: pure task instructions, no CLI
// identity. The XML contract is what xml_2stage parses on the client side.
const XML_INSTRUCTIONS = `You are a task complexity classifier.
Respond ONLY with valid XML — no prose, no markdown fences — in exactly this format:
<classification>
<complexity>low|medium|high</complexity>
<thinking_needed>true|false</thinking_needed>
</classification>`;

// The same instructions behind Claude Code's stock identity preamble — the
// shape that trips the cbcn WAF workaround.
const IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";

function classifierBody(systemText) {
  return {
    system: [{ type: "text", text: systemText }],
    messages: [
      { role: "user", content: "Classify this task: refactor the auth middleware <and> keep tests green." },
    ],
    max_tokens: 200,
    stream: true,
  };
}

function systemOf(messages) {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string"
    ? sys.content
    : Array.isArray(sys.content)
      ? sys.content.map((b) => b?.text || "").join("\n")
      : "";
}

// Run openai-shaped upstream SSE events through the response translator the
// way chatCore does for a claude-format client, collecting every text_delta.
function runResponseStream(events) {
  const state = initState(FORMATS.CLAUDE);
  const out = [];
  for (const ev of events) {
    const r = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, ev, state);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  }
  return out;
}

function collectClaudeText(events) {
  let text = "";
  for (const ev of events) {
    if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      text += ev.delta.text;
    }
  }
  return text;
}

describe("issue #18: classifier request fidelity (claude → openai → cbcn executor)", () => {
  const executor = new CodeBuddyExecutor();

  it("XML output instructions survive translateRequest byte-for-byte", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(XML_INSTRUCTIONS));
    const sys = systemOf(out.messages);
    expect(sys).toContain(XML_INSTRUCTIONS);
    expect(sys).toContain("<classification>");
    expect(sys).toContain("</classification>");
  });

  it("cbcn executor leaves the identity-free classifier prompt untouched", () => {
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(XML_INSTRUCTIONS));
    const before = systemOf(translated.messages);
    const transformed = executor.transformRequest("deepseek-v4.1-flash", translated, true, {});
    expect(systemOf(transformed.messages)).toBe(before); // byte-identical
    expect(transformed.stream).toBe(true); // forceStream quirk, orthogonal to content
  });

  it("user turn (with angle brackets) passes through both hops verbatim", () => {
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(XML_INSTRUCTIONS));
    const transformed = executor.transformRequest("deepseek-v4.1-flash", translated, true, {});
    const user = transformed.messages.find((m) => m.role === "user");
    const text = typeof user.content === "string" ? user.content : user.content.map((b) => b?.text || "").join("");
    expect(text).toContain("refactor the auth middleware <and> keep tests green.");
  });

  // DOCUMENTED INTERFERENCE PATH (intended WAF workaround, not a bug to fix
  // blindly): open-sse/executors/codebuddy-cn.js transformRequest — system
  // prompts matching AGENT_PATTERN are replaced wholesale with NEUTRAL_PROMPT.
  // A classifier prompt carrying the CC identity preamble loses its XML
  // contract here — and the model, never told to emit XML, answers prose:
  // exactly the reporter's symptom (HTTP 200, non-XML output). Settling whether
  // CC's auto-mode classifier carries the preamble needs the reporter's raw
  // request bytes; removing the workaround is NOT an option (Tencent's WAF
  // rejects identity-carrying prompts outright — the whole request dies).
  it("identity-prefixed classifier prompt is neutralized by the cbcn WAF workaround", () => {
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(`${IDENTITY_PREFIX}\n\n${XML_INSTRUCTIONS}`));
    const transformed = executor.transformRequest("deepseek-v4.1-flash", translated, true, {});
    const sys = systemOf(transformed.messages);
    expect(sys).toBe(NEUTRAL_PROMPT);
    expect(sys).not.toContain("<classification>");
  });

  // The real classifier prompt (extracted from the shipped CC binary) opens with
  // "You are a security monitor for autonomous AI coding agents." — it carries no
  // agent-identity preamble, so the workaround above does NOT fire on it. This
  // case pins that distinction: the marker that would trip the WAF is absent.
  it("a security-monitor classifier prompt is not identity-prefixed and survives untouched", () => {
    const REAL_OPENING =
      "You are a security monitor for autonomous AI coding agents.\n\n## Context\nThe agent you are monitoring is an autonomous coding agent with shell access.";
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(`${REAL_OPENING}\n\n${XML_INSTRUCTIONS}`));
    const transformed = executor.transformRequest("deepseek-v4.1-flash", translated, true, {});
    expect(systemOf(transformed.messages)).toContain("You are a security monitor for autonomous AI coding agents.");
  });
});

describe("issue #18: stop sequences survive the openai → claude hop", () => {
  const openaiBody = (extra = {}) => ({
    model: "some-gpt",
    messages: [{ role: "user", content: "go" }],
    max_tokens: 64,
    ...extra,
  });

  it("maps OpenAI stop to Anthropic stop_sequences", () => {
    const out = T(FORMATS.OPENAI, FORMATS.CLAUDE, openaiBody({ stop: ["</block>"] }));
    expect(out.stop_sequences).toEqual(["</block>"]);
  });

  it("omits the field entirely when the client sent none", () => {
    const out = T(FORMATS.OPENAI, FORMATS.CLAUDE, openaiBody());
    expect("stop_sequences" in out).toBe(false);
  });

  it("drops blanks and caps at Anthropic's limit of 4", () => {
    const out = T(FORMATS.OPENAI, FORMATS.CLAUDE, openaiBody({ stop: ["", null, "a", "b", "c", "d", "e"] }));
    expect(out.stop_sequences).toEqual(["a", "b", "c", "d"]);
  });

  it("tolerates a bare string", () => {
    const out = T(FORMATS.OPENAI, FORMATS.CLAUDE, openaiBody({ stop: "STOP" }));
    expect(out.stop_sequences).toEqual(["STOP"]);
  });
});

describe("issue #18: stop_sequences survive the claude → openai hop", () => {
  it("maps Anthropic stop_sequences to OpenAI stop (stage 1's halt on </block>)", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      ...classifierBody(XML_INSTRUCTIONS),
      stop_sequences: ["</block>"],
      max_tokens: 64,
    });
    expect(out.stop).toEqual(["</block>"]);
    expect(out.max_tokens).toBe(64);
  });

  it("preserves order and every sequence in a multi-stop request", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      ...classifierBody(XML_INSTRUCTIONS),
      stop_sequences: ["</block>", "\n\nHuman:", "</severity>"],
    });
    expect(out.stop).toEqual(["</block>", "\n\nHuman:", "</severity>"]);
  });

  it("omits the field entirely when the client sent none (no behaviour change)", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(XML_INSTRUCTIONS));
    expect("stop" in out).toBe(false);
  });

  it("ignores an empty list rather than sending a request the provider 400s", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, { ...classifierBody(XML_INSTRUCTIONS), stop_sequences: [] });
    expect("stop" in out).toBe(false);
  });

  it("drops blank / non-string entries (Anthropic rejects whitespace-only stops)", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      ...classifierBody(XML_INSTRUCTIONS),
      stop_sequences: ["", null, 42, "</block>"],
    });
    expect(out.stop).toEqual(["</block>"]);
  });

  it("caps at Anthropic's 4-sequence limit instead of forwarding an invalid request", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      ...classifierBody(XML_INSTRUCTIONS),
      stop_sequences: ["a", "b", "c", "d", "e", "f"],
    });
    expect(out.stop).toEqual(["a", "b", "c", "d"]);
  });

  it("a bare string is tolerated, not silently discarded", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, { ...classifierBody(XML_INSTRUCTIONS), stop_sequences: "</block>" });
    expect(out.stop).toEqual(["</block>"]);
  });

  it("stop survives the cbcn executor transform (stage 1's end-to-end shape)", () => {
    const executor2 = new CodeBuddyExecutor();
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      ...classifierBody(XML_INSTRUCTIONS),
      stop_sequences: ["</block>"],
      max_tokens: 64,
    });
    const transformed = executor2.transformRequest("deepseek-v4.1-flash", translated, true, {});
    expect(transformed.stop).toEqual(["</block>"]);
    expect(transformed.stream).toBe(true);
  });
});

describe("issue #18: classifier response fidelity (openai SSE → claude)", () => {
  it("conforming XML output reaches the client byte-for-byte", () => {
    const xml = "<classification>\n<complexity>high</complexity>\n<thinking_needed>true</thinking_needed>\n</classification>";
    // split mid-tag to prove no chunk-boundary mangling
    const events = [
      { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: xml.slice(0, 30) } }] },
      { id: "c1", choices: [{ index: 0, delta: { content: xml.slice(30) } }] },
      { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    expect(collectClaudeText(runResponseStream(events))).toBe(xml);
  });

  it("non-XML prose passes through verbatim — the gateway never repairs output", () => {
    const prose = "Sure! This task is HIGH complexity because it touches middleware and tests. You should enable thinking.";
    const events = [
      { id: "c2", choices: [{ index: 0, delta: { role: "assistant", content: prose.slice(0, 40) } }] },
      { id: "c2", choices: [{ index: 0, delta: { content: prose.slice(40) } }] },
      { id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    expect(collectClaudeText(runResponseStream(events))).toBe(prose);
  });

  it("terminal stop_reason survives for the classifier turn", () => {
    const events = [
      { id: "c3", choices: [{ index: 0, delta: { content: "<classification/>" } }] },
      { id: "c3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const out = runResponseStream(events);
    const md = out.find((e) => e?.type === "message_delta");
    expect(md?.delta?.stop_reason).toBeTruthy();
  });
});
