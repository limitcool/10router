import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #18 wiring guards.
 *
 * The stop-sequence guard, the client-format translation of the forced
 * SSE→JSON path, and the translator mappings are each unit-tested directly.
 * What cannot be unit-tested cheaply is that chatCore actually USES them: a
 * future refactor could drop one line and every other test would stay green
 * while the behaviour silently disappeared. These assertions are scoped to the
 * exact call sites, with comments stripped so a comment mentioning the symbol
 * cannot satisfy them.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

/** Source with `//` comment lines and /* … *​/ blocks removed. */
function codeOnly(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("issue #18: chatCore stop-sequence enforcement is wired", () => {
  const chatCore = codeOnly("open-sse/handlers/chatCore.js");

  it("imports the guard", () => {
    expect(chatCore).toMatch(/import\s*\{[^}]*applyStopSequenceGuard[^}]*\}\s*from\s*"\.\.\/utils\/stopSequenceGuard\.js"/);
    expect(chatCore).toMatch(/import\s*\{[^}]*StopSequenceGuard[^}]*\}\s*from\s*"\.\.\/utils\/stopSequenceGuard\.js"/);
  });

  it("collects the requested stops from the client body as well as the outbound one", () => {
    // The client's request is the real statement of intent: a stop that no
    // translator mapped into the upstream dialect must still be honoured.
    expect(chatCore).toMatch(/collectStopSequences\(body\)/);
    expect(chatCore).toMatch(/collectStopSequences\(finalBody \|\| translatedBody\)/);
  });

  it("wraps the upstream body only when the upstream speaks SSE", () => {
    expect(chatCore).toMatch(/applyStopSequenceGuard\(providerResponse\.body, new StopSequenceGuard\(requestedStops\)\)/);
    // Binary event encodings (Kiro's AWS EventStream) must not be decoded.
    expect(chatCore).toMatch(/text\/event-stream/);
  });

  it("replaces providerResponse with the guarded stream before dispatching", () => {
    const guardIndex = chatCore.indexOf("applyStopSequenceGuard(");
    const streamingIndex = chatCore.indexOf("handleStreamingResponse({");
    const forcedIndex = chatCore.indexOf("handleForcedSSEToJson({");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(streamingIndex);
    expect(guardIndex).toBeLessThan(forcedIndex);
  });

  it("injects the client-format translator into the forced-SSE path", () => {
    expect(chatCore).toMatch(/needsTranslation\(providerResponseFormat, sourceFormat\)/);
    expect(chatCore).toMatch(/translateNonStreamingResponse\(rawBody, providerResponseFormat, sourceFormat, customToolNames\)/);
    expect(chatCore).toMatch(/translateToClientFormat,\s*trackDone, appendLog/);
  });
});

describe("issue #18: the forced-SSE handler uses the injected translator", () => {
  const handler = codeOnly("open-sse/handlers/chatCore/sseToJsonHandler.js");

  it("declares translateToClientFormat as a parameter", () => {
    expect(handler).toMatch(/async function handleForcedSSEToJson\(\{[^}]*translateToClientFormat/);
  });

  it("translates the aggregated body for non-Responses clients", () => {
    expect(handler).toMatch(/typeof translateToClientFormat === "function" \? translateToClientFormat\(parsed\) : parsed/);
  });

  it("keeps the Responses-client branch on its own conversion", () => {
    expect(handler).toMatch(/sourceFormat === FORMATS\.OPENAI_RESPONSES\s*\n\s*\? chatCompletionToResponses\(parsed, customToolNames\)/);
  });
});
