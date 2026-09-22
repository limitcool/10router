// The dashboard changelog is fetched from the repo's `main` branch (see
// GITHUB_CONFIG.changelogUrlBase) so that a user on an older build can still
// read what shipped after it — but that also means a section written during
// development for the *next* release reaches every installed client the moment
// it lands on main, telling 1.1.3 users about features they do not have.
// Cap what we render at the newest version that actually exists.
//
// Both inputs come from /api/version: `latestVersion` (npm registry = what is
// really published) and `currentVersion` (this build's package.json). Taking the
// higher of the two keeps a released build from hiding its own notes when the
// registry lookup lags or fails, while still cutting anything above the
// newest release. Returns null when neither is known (offline NAS install) —
// callers must then render the changelog unsliced, which is the old behaviour.
export function resolveChangelogCap({ currentVersion, latestVersion } = {}) {
  const parsed = [parseVersion(currentVersion), parseVersion(latestVersion)].filter(Boolean);
  if (!parsed.length) return null;
  const newest = parsed.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  // 0.0.0 means "this build does not know its own version" (the getAppVersion
  // fallback). Capping there would hide every section and leave a blank modal.
  if (newest[0] === 0 && newest[1] === 0 && newest[2] === 0) return null;
  return newest.join(".");
}

// "1.1.4" -> [1, 1, 4]; null for anything that is not a triple. Deliberately
// strict: an unparsable version must never be treated as 0.0.0, which would
// silently drop every real section below it.
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

// Release sections are level-2 headings starting with a version (`## v1.1.3
// (2026-09-20)`), preceded by a level-1 title + intro we must keep. Drop whole
// sections whose version is above the cap; keep anything we cannot parse as a
// version (an "Unreleased" or hand-written heading is nobody's business to
// delete) so a malformed cap or new heading style degrades to "show it".
export function capChangelogByVersion(markdown, cap) {
  if (!markdown || typeof markdown !== "string") return markdown || "";
  const capParsed = parseVersion(cap);
  if (!capParsed) return markdown;

  const lines = markdown.split("\n");
  const headingAt = (line) => /^##\s+/.test(line);
  const out = [];
  let buffer = [];
  let dropping = false;

  const flush = () => {
    if (!dropping) out.push(...buffer);
    buffer = [];
  };

  for (const line of lines) {
    if (headingAt(line)) {
      flush();
      const sectionVersion = parseVersion(line.replace(/^##\s+/, ""));
      dropping = sectionVersion !== null && compareVersions(sectionVersion, capParsed) > 0;
    }
    buffer.push(line);
  }
  flush();

  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}
