// The "earliest package expiry" badge must not round a multi-day wait down to a
// bare day count ("1d" when 1d 17h remain). Two components carry their own copy
// of formatExpiry, so both are guarded here — the duplication is pre-existing and
// silently drifting one copy back to `${days}d` is exactly the bug this catches.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");
const COPIES = [
  "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js",
  "src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js",
];

describe("expiry countdown badge", () => {
  for (const rel of COPIES) {
    it(`${rel} renders days together with the leftover hours`, () => {
      const src = readFileSync(resolve(rootDir, rel), "utf8");
      const fn = /function formatExpiry\(iso\) \{[\s\S]*?\n\}/.exec(src);
      expect(fn, "formatExpiry disappeared").toBeTruthy();
      const body = fn[0];

      // The bare one-unit day return is the bug.
      expect(body).not.toMatch(/return\s+`\$\{days\}d`;/);
      // Days must be paired with the remainder, and an exact multiple must stay bare.
      expect(body).toMatch(/hours % 24 \? `\$\{days\}d \$\{hours % 24\}h` : `\$\{days\}d`/);
    });
  }

  it("behaves as intended (same arithmetic as formatExpiry)", () => {
    const show = (hoursFromNow) => {
      const hours = Math.floor(hoursFromNow);
      if (hours < 24) return `${hours}h`;
      const days = Math.floor(hours / 24);
      if (days < 30) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
      return "date";
    };
    expect(show(41)).toBe("1d 17h"); // the case the user reported
    expect(show(24)).toBe("1d");
    expect(show(72)).toBe("3d");
    expect(show(455)).toBe("18d 23h");
    expect(show(23)).toBe("23h"); // never a fractional day
    expect(show(720)).toBe("date"); // >= 30 days falls back to the date
  });
});
