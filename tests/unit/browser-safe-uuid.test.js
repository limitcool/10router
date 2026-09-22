// Browser-safe uuid helper (insecure-context regression).
//
// `crypto.randomUUID` is only defined in a secure context, so a dashboard opened
// over plain http:// on a LAN address threw `crypto.randomUUID is not a function`
// and killed the MiMo browser sign-in (the server rejects /authorize without a
// client-generated state, so that call is mandatory, not decorative).
import { describe, it, expect, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { uuid } from "@/shared/utils/uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const originalCrypto = globalThis.crypto;

function setCrypto(value) {
  Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
}

afterEach(() => setCrypto(originalCrypto));

describe("uuid()", () => {
  it("uses native randomUUID when available", () => {
    setCrypto(webcrypto);
    expect(uuid()).toMatch(V4);
    expect(uuid("mimo-").startsWith("mimo-")).toBe(true);
  });

  it("falls back to getRandomValues when randomUUID is missing (insecure context)", () => {
    // Exactly what a browser over http://LAN-IP exposes: getRandomValues yes, randomUUID no.
    setCrypto({ getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    expect(typeof globalThis.crypto.randomUUID).toBe("undefined");
    expect(uuid()).toMatch(V4);
  });

  it("sets the v4 version and RFC-4122 variant bits on the fallback path", () => {
    setCrypto({
      getRandomValues: (arr) => {
        arr.fill(0xff);
        return arr;
      },
    });
    // 0xff & 0x0f | 0x40 = 0x4f (version 4), 0xff & 0x3f | 0x80 = 0xbf (RFC 4122 variant)
    expect(uuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("still returns unique ids with no WebCrypto at all", () => {
    setCrypto(undefined);
    const ids = new Set(Array.from({ length: 2000 }, () => uuid()));
    expect(ids.size).toBe(2000);
  });

  it("never throws in any of the three environments", () => {
    for (const env of [webcrypto, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, undefined]) {
      setCrypto(env);
      expect(() => uuid()).not.toThrow();
    }
  });
});
