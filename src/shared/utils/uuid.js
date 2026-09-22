// Browser-safe unique id / nonce.
//
// `crypto.randomUUID` only exists in a SECURE context (HTTPS, or http://localhost /
// 127.0.0.1). A dashboard reached over plain HTTP on a LAN address — the normal way
// to open a self-hosted / NAS instance from another device — has no `randomUUID`
// at all, so a bare call throws `crypto.randomUUID is not a function` and the
// feature behind it silently dies (this broke the MiMo browser sign-in).
//
// `crypto.getRandomValues` is NOT secure-context-restricted, so build the v4 UUID
// from it and keep the native call as the fast path.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * @param {string} [prefix] optional prefix (e.g. a provider name) for readability
 * @returns {string} an RFC-4122 v4-shaped unique id
 */
export function uuid(prefix = "") {
  const c = globalThis.crypto;

  if (typeof c?.randomUUID === "function") return prefix + c.randomUUID();

  // Insecure context (http://LAN-IP): still cryptographically random.
  if (typeof c?.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    return (
      prefix +
      HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + "-" +
      HEX[b[4]] + HEX[b[5]] + "-" +
      HEX[b[6]] + HEX[b[7]] + "-" +
      HEX[b[8]] + HEX[b[9]] + "-" +
      HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
    );
  }

  // No WebCrypto at all (ancient browser / non-browser import): uniqueness still
  // holds well enough for a UI nonce, and callers only need a collision-free token.
  return (
    prefix +
    Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2, 10) + "-" +
    Math.random().toString(36).slice(2, 10)
  );
}
