import { describe, it, expect } from "vitest";
import {
  sanitizeToolSchemas,
  shouldSanitizeToolSchemas,
  normalizeToolParametersSchema,
} from "../../open-sse/translator/concerns/toolCall.js";

// OpenAI-chat tool shape used by the pipeline.
const fnTool = (name, parameters) => ({ type: "function", function: { name, description: "d", parameters } });
const paramsOf = (tool) => tool.function.parameters;

describe("shouldSanitizeToolSchemas gate", () => {
  const tools = [fnTool("x", { type: "object", properties: {} })];
  const PROVIDERS = {
    "codebuddy-cn": { quirks: { sanitizeToolSchema: true } },
    "codebuddy-intl": { quirks: {} },
    mimo: {},
  };

  it("fires only for providers declaring the quirk", () => {
    expect(shouldSanitizeToolSchemas("codebuddy-cn", tools, PROVIDERS)).toBe(true);
    expect(shouldSanitizeToolSchemas("codebuddy-intl", tools, PROVIDERS)).toBe(false);
    expect(shouldSanitizeToolSchemas("mimo", tools, PROVIDERS)).toBe(false);
    expect(shouldSanitizeToolSchemas("unknown", tools, PROVIDERS)).toBe(false);
  });

  it("no-ops on empty / non-array tools", () => {
    expect(shouldSanitizeToolSchemas("codebuddy-cn", [], PROVIDERS)).toBe(false);
    expect(shouldSanitizeToolSchemas("codebuddy-cn", undefined, PROVIDERS)).toBe(false);
    expect(shouldSanitizeToolSchemas("codebuddy-cn", "nope", PROVIDERS)).toBe(false);
  });
});

describe("normalizeToolParametersSchema — root downgrade (issue #27)", () => {
  it("collapses root anyOf into a merged object", () => {
    const p = normalizeToolParametersSchema({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(p.type).toBe("object");
    expect(Object.keys(p.properties).sort()).toEqual(["a", "b"]);
    expect(p.anyOf).toBeUndefined();
    // anyOf → intersection of required → empty → dropped
    expect(p.required).toBeUndefined();
  });

  it("collapses root oneOf into a merged object", () => {
    const p = normalizeToolParametersSchema({
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    });
    expect(p.type).toBe("object");
    expect(Object.keys(p.properties).sort()).toEqual(["a", "b"]);
    expect(p.oneOf).toBeUndefined();
  });

  it("unions required for root allOf", () => {
    const p = normalizeToolParametersSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(p.type).toBe("object");
    expect(new Set(p.required)).toEqual(new Set(["a", "b"]));
    expect(p.allOf).toBeUndefined();
  });

  it("resolves a root $ref against local $defs", () => {
    const p = normalizeToolParametersSchema({
      $ref: "#/$defs/P",
      $defs: { P: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } },
    });
    expect(p.type).toBe("object");
    expect(p.properties.x).toBeDefined();
    expect(p.$ref).toBeUndefined();
    expect(p.required).toEqual(["x"]);
  });

  it("resolves a root $ref against legacy definitions/", () => {
    const p = normalizeToolParametersSchema({
      $ref: "#/definitions/Q",
      definitions: { Q: { type: "object", properties: { y: { type: "integer" } } } },
    });
    expect(p.type).toBe("object");
    expect(p.properties.y).toBeDefined();
  });

  it("falls back to an empty object for an unresolvable / external root $ref", () => {
    expect(normalizeToolParametersSchema({ $ref: "#/$defs/Missing" })).toEqual({ type: "object", properties: {} });
    expect(normalizeToolParametersSchema({ $ref: "https://x/y#/$defs/Z" })).toEqual({ type: "object", properties: {} });
  });

  it("adds a missing root type when properties are present", () => {
    const p = normalizeToolParametersSchema({ properties: { a: { type: "string" } } });
    expect(p.type).toBe("object");
    expect(p.properties.a).toBeDefined();
  });

  it("coerces a root type array to a concrete type", () => {
    expect(normalizeToolParametersSchema({ type: ["object"], properties: {} }).type).toBe("object");
    expect(normalizeToolParametersSchema({ type: ["null", "object"], properties: {} }).type).toBe("object");
  });

  it("forces object for scalar / null / empty / non-object roots", () => {
    for (const bad of [{ type: "null" }, { type: "string" }, {}, "nope", null, undefined, 42]) {
      const p = normalizeToolParametersSchema(bad);
      expect(p.type).toBe("object");
      expect(p.properties).toEqual(expect.any(Object));
    }
  });

  it("prunes dangling required keys", () => {
    const p = normalizeToolParametersSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    });
    expect(p.required).toEqual(["a"]);
  });

  it("leaves a valid object root untouched (idempotent, nested preserved)", () => {
    const good = {
      type: "object",
      properties: {
        a: { anyOf: [{ type: "string" }, { type: "null" }] },
        b: { $ref: "#/$defs/B" },
        c: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      },
      required: ["a"],
      $defs: { B: { type: "object", properties: { z: { type: "string" } } } },
    };
    const p = normalizeToolParametersSchema(structuredClone(good));
    expect(p).toEqual(good);
  });

  it("is stable under double application", () => {
    const once = normalizeToolParametersSchema({ anyOf: [{ type: "object", properties: { a: { type: "string" } } }] });
    const twice = normalizeToolParametersSchema(once);
    expect(twice).toEqual(once);
  });
});

describe("sanitizeToolSchemas — tool shapes", () => {
  it("downgrades OpenAI chat function.parameters", () => {
    const out = sanitizeToolSchemas([fnTool("a", { anyOf: [{ type: "object", properties: { a: { type: "string" } } }] })]);
    expect(paramsOf(out[0]).type).toBe("object");
    expect(paramsOf(out[0]).properties.a).toBeDefined();
  });

  it("downgrades flat Responses parameters", () => {
    const flat = { type: "function", name: "f", parameters: { $ref: "#/$defs/P", $defs: { P: { type: "object", properties: { a: { type: "string" } } } } } };
    const out = sanitizeToolSchemas([flat]);
    expect(out[0].parameters.type).toBe("object");
    expect(out[0].parameters.properties.a).toBeDefined();
  });

  it("downgrades Claude input_schema", () => {
    const claude = { name: "c", description: "d", input_schema: { properties: { a: { type: "string" } } } };
    const out = sanitizeToolSchemas([claude]);
    expect(out[0].input_schema.type).toBe("object");
  });

  it("does not mutate the original tools", () => {
    const original = fnTool("a", { anyOf: [{ type: "object", properties: { a: { type: "string" } } }] });
    const snapshot = structuredClone(original);
    sanitizeToolSchemas([original]);
    expect(original).toEqual(snapshot);
  });

  it("passes through tools with no parameter schema and non-array input", () => {
    const noParams = { type: "function", function: { name: "n" } };
    expect(sanitizeToolSchemas([noParams])[0]).toEqual(noParams);
    expect(sanitizeToolSchemas("nope")).toBe("nope");
  });

  it("survives a pathological schema without throwing (fail-open)", () => {
    const cyclic = { type: "object", properties: {} };
    cyclic.properties.self = cyclic; // reference cycle
    // Must not hang/throw; returns an array of the same length.
    const out = sanitizeToolSchemas([fnTool("cyc", cyclic)]);
    expect(out).toHaveLength(1);
  });
});
