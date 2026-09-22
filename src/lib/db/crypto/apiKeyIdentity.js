// Key identity for stored usage records (issue #9, item 5).
//
// The usage log used to keep the full `sk-…` value in every row — the largest
// and most-shared table in the database, and the one people screenshot, export
// and paste into issues. Nothing needs the raw value back: the log only ever
// *groups* by key (per-key stats) and *labels* it (the name from the apiKeys
// table), both of which work off a stable digest, while the display only needs
// the first few characters.
//
// So a record now carries:
//   * a masked value for display (`sk-496f00…`), and
//   * a SHA-256 digest for grouping and for looking the key's name up.
//
// The digest is not secret (it is a one-way function of a value the holder
// already has), which is the point: reading the database no longer hands over a
// usable credential, and grouping/lookup keep working unchanged.

import crypto from "node:crypto";

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

export function hashApiKey(key) {
  if (!key || typeof key !== "string") return null;
  return crypto.createHash("sha256").update(key).digest("hex");
}

// Everything the usage log stores about a key, derived from the raw value.
export function apiKeyIdentity(key) {
  return { apiKeyMasked: maskApiKey(key), apiKeyHash: hashApiKey(key) };
}

// True when a stored value is already masked (`sk-496f00***`), so migrations can
// skip rows that have been converted and stay idempotent.
export function isMaskedApiKey(value) {
  return typeof value === "string" && value.endsWith("***");
}
