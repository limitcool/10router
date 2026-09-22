// Tool call helper functions for translator

import { FORMATS } from "../formats.js";

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Fallback streaming tool_call id when provider omits one (index optional)
export function fallbackToolCallId(index) {
  return index === undefined ? `call_${Date.now()}` : `call_${index}_${Date.now()}`;
}

// Generate deterministic tool call ID from position + tool name (cache-friendly)
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName = "") {
  const name = toolName ? `_${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

// Sanitize ID to match Anthropic pattern: keep only alphanumeric, underscore, hyphen
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

// Ensure all tool_calls have valid id field and arguments is string (some providers require it)
export function ensureToolCallIds(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        // Validate or regenerate ID for Anthropic compatibility
        if (!tc.id || !TOOL_ID_PATTERN.test(tc.id)) {
          const sanitized = sanitizeToolId(tc.id);
          tc.id = sanitized || generateToolCallId(i, j, tc.function?.name);
        }
        if (!tc.type) {
          tc.type = "function";
        }
        // Ensure arguments is JSON string, not object
        if (tc.function?.arguments && typeof tc.function.arguments !== "string") {
          tc.function.arguments = JSON.stringify(tc.function.arguments);
        }
      }
    }

    // Validate tool_call_id in tool messages (role: "tool")
    if (msg.role === "tool" && msg.tool_call_id && !TOOL_ID_PATTERN.test(msg.tool_call_id)) {
      const sanitized = sanitizeToolId(msg.tool_call_id);
      msg.tool_call_id = sanitized || generateToolCallId(i, 0);
    }

    // Also validate tool_use blocks in content (Claude format)
    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_use" && block.id && !TOOL_ID_PATTERN.test(block.id)) {
          const sanitized = sanitizeToolId(block.id);
          block.id = sanitized || generateToolCallId(i, k, block.name);
        }
        // Validate tool_use_id in tool_result blocks
        if (block.type === "tool_result" && block.tool_use_id && !TOOL_ID_PATTERN.test(block.tool_use_id)) {
          const sanitized = sanitizeToolId(block.tool_use_id);
          block.tool_use_id = sanitized || generateToolCallId(i, k);
        }
      }
    }
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

// Check if user message has tool_result for given ids (OpenAI format: role=tool, Claude format: tool_result in content)
export function hasToolResults(msg, toolCallIds) {
  if (!msg || !toolCallIds.length) return false;

  // OpenAI format: role = "tool" with tool_call_id
  if (msg.role === "tool" && msg.tool_call_id) {
    return toolCallIds.includes(msg.tool_call_id);
  }

  // Claude format: tool_result blocks in user message content
  if (msg.role === "user" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && toolCallIds.includes(block.tool_use_id)) {
        return true;
      }
    }
  }

  return false;
}

// Fix missing tool responses - insert empty tool_result if assistant has tool_use but next message has no tool_result
export function fixMissingToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const newMessages = [];

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    const nextMsg = body.messages[i + 1];

    newMessages.push(msg);

    // Check if this is assistant with tool_calls/tool_use
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    // Check if next message has tool_result
    if (nextMsg && !hasToolResults(nextMsg, toolCallIds)) {
      // Insert tool responses for each tool_call
      for (const id of toolCallIds) {
        // OpenAI format: role = "tool"
        newMessages.push({
          role: "tool",
          tool_call_id: id,
          content: ""
        });
      }
    }
  }

  body.messages = newMessages;
  return body;
}

// Stamp `type: "custom"` onto Claude-format tools that arrive without one.
// Anthropic's tool schema allows omitting `type`, but a few strict Anthropic-compatible
// gateways only accept the explicit modern shape (MiniMax rejects the legacy typeless
// payload with its 2013 error). Tools already carrying a truthy `type` — `computer_use`,
// `bash`, `web_search_20250305`, `custom` — are passed through untouched.
//
// Spread order matters: `{ ...tool, type: "custom" }` puts the default last so a truthy
// value from the tool itself wins, while falsy ones (null/undefined/"") still get stamped.
// `{ type: "custom", ...tool }` would let `type: null` survive.
export function defaultClaudeToolType(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => tool?.type ? tool : { ...tool, type: "custom" });
}

// Whether Claude-format tools need explicit `type` defaulting before dispatch.
//
// Only gateways that declare the `requireClaudeToolType` quirk get it. Stamping the type
// onto *every* Claude-format request breaks the opposite kind of endpoint — the ones whose
// Anthropic-compatible surface accepts only the legacy typeless shape. DeepSeek's
// /anthropic/v1/messages whitelists tool `type` to its web_search_* variants and answers
// HTTP 400 "unknown variant `custom`", which surfaced to clients as a persistent 503 (#3905).
//
// Keeping the decision here (instead of inline in the handler) makes the provider gate
// unit-testable, and making another strict gateway work is now a one-line registry quirk.
export function shouldDefaultClaudeToolType(provider, finalFormat, tools, PROVIDERS) {
  return (
    finalFormat === FORMATS.CLAUDE
    && Array.isArray(tools)
    && PROVIDERS?.[provider]?.quirks?.requireClaudeToolType === true
  );
}

// ─── strict-gateway tool-schema downgrade ────────────────────────────────────
//
// Some upstreams validate a tool's `parameters` JSON-Schema far more strictly
// than the OpenAI spec requires. CodeBuddy CN (`cbcn`) answers HTTP 400
// {code:11129 "invalid function call parameters"} whenever the ROOT of a
// tool's `parameters` is not a concrete `type:"object"`. Verified live
// (2026-09-19) against cbcn/deepseek-v4.1-flash:
//   rejected (11129): root anyOf / oneOf / allOf / $ref / type:["object"] /
//                     type:[...] array / missing `type` / type:"null" / type:"string"
//   accepted (200):   root type:"object" (even with sibling anyOf/oneOf for
//                     conditional required), and ALL nested property-level
//                     constructs (property anyOf/$ref/tuple/const/prefixItems/
//                     additionalProperties-schema)
// Only cbcn is this strict — cbai (intl), mimo, qoder all accept the bad roots
// — so the downgrade is gated by the `sanitizeToolSchema` transport quirk and
// never touches lenient providers. It also fixes clients like ZCode / OpenClaw
// whose auto-generated toolsets (Pydantic / JSON-Schema) emit these shapes.
//
// The fix is deliberately ROOT-ONLY: nested schemas are left untouched because
// cbcn accepts them, so a valid tool passes through byte-for-byte (idempotent).

const ROOT_COMBINATORS = ["allOf", "anyOf", "oneOf"];

function isSchemaObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// Resolve a local JSON-pointer ref ("#/$defs/Foo", "#/definitions/Foo") against
// the schema root. External (http…) or unresolvable refs return null.
function resolveLocalRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#") || ref === "#") return null;
  const path = ref.slice(1).replace(/^\//, "");
  if (!path) return null;
  let node = root;
  for (const raw of path.split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (isSchemaObject(node) && key in node) node = node[key];
    else return null;
  }
  return isSchemaObject(node) ? node : null;
}

// Merge a root-level combinator's branches into one object schema: union of
// properties; required = union for allOf, intersection for anyOf/oneOf.
function mergeRootCombinator(schema, key) {
  const { [key]: branches, ...rest } = schema;
  if (!Array.isArray(branches)) return rest;
  const properties = {};
  let requiredSets = [];
  for (const raw of branches) {
    let b = raw;
    if (isSchemaObject(b) && typeof b.$ref === "string") {
      const target = resolveLocalRef(schema, b.$ref);
      if (target) b = { ...target, ...b, $ref: undefined };
    }
    if (!isSchemaObject(b)) continue;
    if (isSchemaObject(b.properties)) Object.assign(properties, b.properties);
    if (Array.isArray(b.required)) requiredSets.push(b.required);
  }
  const merged = { ...rest, type: "object", properties };
  if (requiredSets.length) {
    const union = new Set(requiredSets.flat());
    const keep = key === "allOf"
      ? [...union]
      : [...requiredSets[0]].filter((r) => requiredSets.every((s) => s.includes(r)));
    const required = keep.filter((r) => r in properties);
    if (required.length) merged.required = required;
  }
  return merged;
}

export function normalizeToolParametersSchema(params) {
  if (!isSchemaObject(params)) return { type: "object", properties: {} };
  let p = { ...params };

  // 1) inline a root $ref (its $defs/definitions siblings travel with it)
  if (typeof p.$ref === "string") {
    const target = resolveLocalRef(p, p.$ref);
    const { $ref, ...siblings } = p;
    p = target ? { ...target, ...siblings } : { type: "object", properties: {}, ...siblings };
  }

  // 2) collapse any root combinator into a single object schema
  for (const key of ROOT_COMBINATORS) {
    if (Array.isArray(p[key])) p = mergeRootCombinator(p, key);
  }

  // 3) coerce a type array to one concrete type
  if (Array.isArray(p.type)) {
    p = { ...p, type: p.type.includes("object") ? "object" : (p.type.find((t) => t !== "null") || "object") };
  }

  // 4) root must be a concrete object with a properties map
  if (p.type !== "object") p = { ...p, type: "object" };
  if (!isSchemaObject(p.properties)) p = { ...p, properties: {} };

  // 5) prune dangling required keys
  if (Array.isArray(p.required)) {
    const required = p.required.filter((r) => r in p.properties);
    if (required.length) p = { ...p, required };
    else { const { required: _drop, ...rest } = p; p = rest; }
  }

  return p;
}

// Downgrade the `parameters`/`input_schema` of every tool to a strict-safe root.
// Handles OpenAI chat (function.parameters), Responses (parameters) and Claude
// (input_schema) shapes. Returns a new array; original untouched. Fail-open.
export function sanitizeToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!isSchemaObject(tool)) return tool;
    try {
      if (isSchemaObject(tool.function) && isSchemaObject(tool.function.parameters)) {
        return { ...tool, function: { ...tool.function, parameters: normalizeToolParametersSchema(tool.function.parameters) } };
      }
      if (isSchemaObject(tool.parameters)) {
        return { ...tool, parameters: normalizeToolParametersSchema(tool.parameters) };
      }
      if (isSchemaObject(tool.input_schema)) {
        return { ...tool, input_schema: normalizeToolParametersSchema(tool.input_schema) };
      }
    } catch {
      /* fail-open: a schema we can't parse is dispatched unchanged */
    }
    return tool;
  });
}

// Gate: only providers declaring `quirks.sanitizeToolSchema` get the downgrade.
export function shouldSanitizeToolSchemas(provider, tools, PROVIDERS) {
  return (
    Array.isArray(tools)
    && tools.length > 0
    && PROVIDERS?.[provider]?.quirks?.sanitizeToolSchema === true
  );
}

