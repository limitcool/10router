import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { encodeDataUri } from "../concerns/image.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { collapseTextParts } from "../concerns/message.js";

// Anthropic and OpenAI both cap stop sequences at 4; a client that sends more
// would 400 upstream, so trim instead of forwarding a request the provider rejects.
const MAX_STOP_SEQUENCES = 4;

function stripAnthropicBillingHeader(text) {
  if (typeof text !== "string") return "";
  return text.replace(/^x-anthropic-billing-header:[^\n]*(?:\r?\n)?/i, "");
}

// Convert Claude request to OpenAI format
export function claudeToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Max tokens
  if (body.max_tokens) {
    result.max_tokens = adjustMaxTokens(body);
  }

  // Stop sequences — Anthropic `stop_sequences` is OpenAI `stop` (both cap at 4).
  // Dropping it is NOT cosmetic (issue #18): Claude Code's auto-mode classifier
  // sends stop_sequences:["</block>"] together with max_tokens:64 and relies on
  // the model halting the instant it emits the verdict tag. Without the stop the
  // model keeps generating past the tag, the 64-token budget truncates the turn,
  // and the client's xml_2stage parser rejects it — its severity parser demands
  // stop_reason ∈ {stop_sequence, end_turn}, so a `max_tokens` truncation parses
  // as null → "classifier unavailable". Affects every claude→openai request (any
  // client-supplied stop sequence was silently ignored), not just the classifier.
  if (body.stop_sequences !== undefined) {
    const stops = (Array.isArray(body.stop_sequences) ? body.stop_sequences : [body.stop_sequences])
      .filter((s) => typeof s === "string" && s.length > 0)
      .slice(0, MAX_STOP_SEQUENCES);
    if (stops.length > 0) result.stop = stops;
  }

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // System message
  if (body.system) {
    const systemContent = Array.isArray(body.system)
      ? body.system.map(s => stripAnthropicBillingHeader(s.text || "")).filter(Boolean).join("\n")
      : stripAnthropicBillingHeader(body.system);
    
    if (systemContent) {
      result.messages.push({
        role: ROLE.SYSTEM,
        content: systemContent
      });
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const converted = convertClaudeMessage(msg);
      if (converted) {
        // Handle array of messages (multiple tool results)
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Fix missing tool responses - OpenAI requires every tool_call to have a response.
  // Local variant: scans contiguous tool replies + inserts "[No response received]"
  // (distinct from the global immediate-next check in concerns/toolCall, runs on the openai leg).
  fixMissingToolResponsesOpenAI(result.messages);

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => ({
      type: OPENAI_BLOCK.FUNCTION,
      function: {
        name: tool.name,
        description: String(tool.description || ""),
        parameters: tool.input_schema || { type: "object", properties: {} }
      }
    }));
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  if (body.reasoning_effort !== undefined) {
    result.reasoning_effort = body.reasoning_effort;
  } else if (body.reasoning?.effort !== undefined) {
    result.reasoning_effort = body.reasoning.effort;
  }

  if (body.reasoning !== undefined) {
    result.reasoning = body.reasoning;
  }

  return result;
}

// Fix missing tool responses - add empty responses for tool_calls without responses
function fixMissingToolResponsesOpenAI(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = msg.tool_calls.map(tc => tc.id);
      
      // Collect all tool response IDs that IMMEDIATELY follow this assistant message
      const respondedIds = new Set();
      let insertPosition = i + 1;
      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === ROLE.TOOL && nextMsg.tool_call_id) {
          respondedIds.add(nextMsg.tool_call_id);
          insertPosition = j + 1;
        } else {
          break;
        }
      }
      
      // Find missing responses and insert them
      const missingIds = toolCallIds.filter(id => !respondedIds.has(id));
      
      if (missingIds.length > 0) {
        const missingResponses = missingIds.map(id => ({
          role: ROLE.TOOL,
          tool_call_id: id,
          content: "[No response received]"
        }));
        messages.splice(insertPosition, 0, ...missingResponses);
        i = insertPosition + missingResponses.length - 1;
      }
    }
  }
}

// Wrap mid-conversation system text so it ends as a user turn (avoids Anthropic prefill 400).
// Uses <instructions> tags that Claude models treat as authoritative directives.
function systemReminderText(content) {
  const parts = Array.isArray(content)
    ? content.filter(c => c?.type === CLAUDE_BLOCK.TEXT).map(c => c.text || "")
    : [typeof content === "string" ? content : ""];
  const text = parts.filter(Boolean).join("\n");
  if (!text.trim()) return "";
  return `<instructions>\n${text}\n</instructions>`;
}

// Convert single Claude message - returns single message or array of messages
function convertClaudeMessage(msg) {
  // Mid-conversation system message -> user (per Anthropic placement rules)
  if (msg.role === ROLE.SYSTEM) {
    const text = systemReminderText(msg.content);
    return text ? { role: ROLE.USER, content: text } : null;
  }

  const role = msg.role === ROLE.USER || msg.role === ROLE.TOOL ? ROLE.USER : ROLE.ASSISTANT;
  
  // Simple string content
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  // Array content
  if (Array.isArray(msg.content)) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of msg.content) {
      switch (block.type) {
        case CLAUDE_BLOCK.TEXT:
          parts.push({ type: OPENAI_BLOCK.TEXT, text: block.text });
          break;

        case CLAUDE_BLOCK.IMAGE:
          if (block.source?.type === "base64") {
            parts.push({
              type: OPENAI_BLOCK.IMAGE_URL,
              image_url: {
                url: encodeDataUri(block.source.media_type, block.source.data)
              }
            });
          }
          break;

        case CLAUDE_BLOCK.TOOL_USE:
          toolCalls.push({
            id: block.id,
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          });
          break;

        case CLAUDE_BLOCK.TOOL_RESULT:
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .filter(c => c.type === CLAUDE_BLOCK.TEXT)
              .map(c => c.text)
              .join("\n") || JSON.stringify(block.content);
          } else if (block.content) {
            resultContent = JSON.stringify(block.content);
          }
          
          toolResults.push({
            role: ROLE.TOOL,
            tool_call_id: block.tool_use_id,
            content: resultContent
          });
          break;
      }
    }

    // If has tool results, return array of tool messages
    if (toolResults.length > 0) {
      if (parts.length > 0) {
        return [...toolResults, { role: ROLE.USER, content: collapseTextParts(parts) }];
      }
      return toolResults;
    }

    // If has tool calls, return assistant message with tool_calls
    if (toolCalls.length > 0) {
      const result = { role: ROLE.ASSISTANT };
      if (parts.length > 0) {
        result.content = collapseTextParts(parts);
      }
      result.tool_calls = toolCalls;
      return result;
    }

    // Return content
    if (parts.length > 0) {
      return {
        role,
        content: collapseTextParts(parts)
      };
    }
    
    // Empty content array
    if (msg.content.length === 0) {
      return { role, content: "" };
    }
  }

  return null;
}

// Convert tool choice
function convertToolChoice(choice) {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  
  switch (choice.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "tool": return { type: OPENAI_BLOCK.FUNCTION, function: { name: choice.name } };
    default: return "auto";
  }
}

// Register
register(FORMATS.CLAUDE, FORMATS.OPENAI, claudeToOpenAIRequest, null);
