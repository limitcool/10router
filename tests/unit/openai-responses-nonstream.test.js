import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      new Set(["exec"])
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat) => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = new Set(["shell"]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

// Issue #18 (third finding): a Claude client routed to a force-stream provider
// (CodeBuddy CN rejects non-stream requests outright) used to receive the raw
// aggregated chat.completion body — `content` undefined for an Anthropic client.
describe("forced-SSE JSON path for a Claude client behind a chat upstream", () => {
  const claudeCtx = ({ reasoning = null, stopTranslator = true } = {}) => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"<block>no"},"finish_reason":null}]}',
      ...(reasoning
        ? [`data: {"id":"chatcmpl-sse","choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}},"finish_reason":null}]}`]
        : []),
      'data: {"id":"chatcmpl-sse","choices":[{"delta":{"content":"</block>"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"chatcmpl-sse","choices":[],"usage":{"prompt_tokens":2026,"completion_tokens":6,"total_tokens":2032}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const ctx = {
      providerResponse: new Response(
        new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(chunks)); controller.close(); } }),
        { headers: { "content-type": "text/event-stream" } }
      ),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI,
      provider: "codebuddy-cn",
      model: "deepseek-v4.1-flash",
      body: { model: "cbcn/deepseek-v4.1-flash", messages: [], stream: false },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/messages" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    };
    if (stopTranslator) {
      // exactly what chatCore injects
      ctx.translateToClientFormat = (raw) => translateNonStreamingResponse(raw, FORMATS.OPENAI, FORMATS.CLAUDE);
    }
    return ctx;
  };

  it("returns an Anthropic message body instead of raw chat.completion", async () => {
    const result = await handleForcedSSEToJson(claudeCtx());
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json).not.toHaveProperty("choices");
    const text = json.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(text).toBe("<block>no</block>");
    // `usage` must be Anthropic-named: Claude Code reads usage.input_tokens.
    expect(json.usage.input_tokens).toBe(2026);
    expect(json.usage.output_tokens).toBe(6);
    expect(json.stop_reason).toBe("end_turn");
  });

  it("keeps reasoning as a thinking block, like the normal non-streaming path", async () => {
    const result = await handleForcedSSEToJson(claudeCtx({ reasoning: "weighing the request" }));
    const json = await result.response.json();
    expect(json.content.find((b) => b.type === "thinking")?.thinking).toBe("weighing the request");
  });

  it("falls back to the raw body when no translator is injected", async () => {
    const result = await handleForcedSSEToJson(claudeCtx({ stopTranslator: false }));
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
  });
});
