// MiMo plan/billing alignment with MiMo Desktop (P0 + P1 + P3).
//
// Evidence base: MiMo Desktop's app.asar. The desktop decides plan vs billing by
// the OAuth payload's returned `url` (auth.json metadata.base_url containing
// "token-plan"), and its bundled per-region catalogs list the exact model set
// token-plan-{cn,sgp,ams} serve (three regions, identical 7 models, no omni).
//
// Offline by construction: global.fetch stubbed, temp DATA_DIR DB, no real keys,
// no cookie-store reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

import tokenplanRegistry from "open-sse/providers/registry/xiaomi-tokenplan.js";
import { normalizeMimoApiBase, resolveXiaomiTokenplanBaseUrl } from "open-sse/config/providers.js";
import { XiaomiMimoExecutor } from "open-sse/executors/xiaomi-mimo.js";
import mimoTts from "open-sse/handlers/ttsProviders/xiaomi-mimo.js";
import { getTtsAdapter } from "open-sse/handlers/ttsProviders/index.js";
import { registerXiaomiMimoSession, getXiaomiMimoSessionStatus } from "@/lib/oauth/utils/server.js";

const BILLING = "https://api.xiaomimimo.com/v1";
const PLAN_OPENAI_RT = { format: "openai", baseUrl: `${BILLING}/chat/completions` };
const PLAN_CLAUDE_RT = { format: "claude", baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages" };

// ───────────────────────────── normalizeMimoApiBase ─────────────────────────────

describe("normalizeMimoApiBase", () => {
  it("accepts and canonicalizes the forms a connection may carry", () => {
    expect(normalizeMimoApiBase(BILLING)).toBe(BILLING);
    expect(normalizeMimoApiBase(`${BILLING}/`)).toBe(BILLING);
    expect(normalizeMimoApiBase(`${BILLING}/chat/completions`)).toBe(BILLING);
    expect(normalizeMimoApiBase("https://api.xiaomimimo.com/anthropic/v1/messages")).toBe(BILLING);
    expect(normalizeMimoApiBase("https://token-plan-sgp.xiaomimimo.com/v1/models")).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
    expect(normalizeMimoApiBase("https://token-plan-cn.xiaomimimo.com")).toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });

  it("refuses garbage instead of routing to it", () => {
    expect(normalizeMimoApiBase("")).toBe("");
    expect(normalizeMimoApiBase(undefined)).toBe("");
    expect(normalizeMimoApiBase("not a url")).toBe("");
    expect(normalizeMimoApiBase("ftp://example.com/v1")).toBe("");
  });
});

// ───────────────────────────── P0: token-plan catalog ─────────────────────────────

describe("xiaomi-tokenplan registry (desktop-catalog alignment)", () => {
  const ids = tokenplanRegistry.models.map((m) => m.id);

  it("drops mimo-v2-omni — absent from all three regional plan catalogs", () => {
    expect(ids).not.toContain("mimo-v2-omni");
  });

  it("keeps the models every plan region serves", () => {
    for (const id of ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-tts", "mimo-v2.5-tts"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("marks every speech model kind:'tts' and no chat model carries a kind", () => {
    for (const m of tokenplanRegistry.models) {
      const speech = /tts/.test(m.id);
      expect(Boolean(m.kind === "tts"), m.id).toBe(speech);
    }
    expect(tokenplanRegistry.serviceKinds).toEqual(expect.arrayContaining(["llm", "tts"]));
    expect(tokenplanRegistry.ttsConfig).toBeTruthy();
  });

  it("defaults to the cn cluster like the desktop's own plan preset", () => {
    expect(tokenplanRegistry.defaultRegion).toBe("cn");
    expect(tokenplanRegistry.transport.defaultRegion).toBe("cn");
    expect(tokenplanRegistry.transport.baseUrl).toContain("token-plan-cn");
  });

  it("points key management at the platform console (mimo.xiaomi.com is the desktop site)", () => {
    expect(tokenplanRegistry.display.notice.apiKeyUrl).toContain("platform.xiaomimimo.com");
  });

  it("resolveXiaomiTokenplanBaseUrl maps regions and falls back to cn", () => {
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: { region: "sgp" } })).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: { region: "ams" } })).toBe("https://token-plan-ams.xiaomimimo.com/v1");
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: { region: "mars" } })).toBe("https://token-plan-cn.xiaomimimo.com/v1");
    expect(resolveXiaomiTokenplanBaseUrl({ providerSpecificData: {} })).toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });
});

// ───────────────────────────── P1: chat routing by cluster ─────────────────────────────

describe("xiaomi-mimo executor honors the sign-in returned cluster", () => {
  const executor = new XiaomiMimoExecutor();
  const creds = (baseUrl, rt) => ({ providerSpecificData: baseUrl ? { baseUrl } : {}, runtimeTransport: rt });

  it("billing (default) base reproduces the registry transports byte-for-byte", () => {
    expect(executor.buildUrl("mimo-v2.5-pro", true, 0, creds(BILLING, PLAN_OPENAI_RT))).toBe(`${BILLING}/chat/completions`);
    expect(executor.buildUrl("mimo-v2.5-pro", true, 0, creds(BILLING, PLAN_CLAUDE_RT))).toBe("https://api.xiaomimimo.com/anthropic/v1/messages");
  });

  it("a token-plan baseUrl routes chat AND anthropic traffic to that cluster", () => {
    const plan = "https://token-plan-sgp.xiaomimimo.com/v1";
    expect(executor.buildUrl("mimo-v2.5-pro", false, 0, creds(plan, PLAN_OPENAI_RT))).toBe(`${plan}/chat/completions`);
    expect(executor.buildUrl("mimo-v2.5-pro", false, 0, creds(plan, PLAN_CLAUDE_RT))).toBe("https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages");
  });

  it("missing or malformed stored base keeps the registry transport", () => {
    expect(executor.buildUrl("mimo-v2.5", true, 0, creds(undefined, PLAN_OPENAI_RT))).toBe(`${BILLING}/chat/completions`);
    expect(executor.buildUrl("mimo-v2.5", true, 0, creds("garbage", PLAN_OPENAI_RT))).toBe(`${BILLING}/chat/completions`);
  });

  it("preview models stay on the account-service route regardless of baseUrl (regression)", () => {
    const url = executor.buildUrl("mimo-x-flash-preview", true, 0, creds("https://token-plan-cn.xiaomimimo.com/v1", PLAN_OPENAI_RT));
    expect(url).toBe("https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions");
  });
});

// ───────────────────────────── P1: connection test probes the right cluster ─────────────────────────────

const originalDataDir = process.env.DATA_DIR;
let db;
let fetchCalls;

beforeAll(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-mimo-plan-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(responder) {
  fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), headers: opts.headers || {} });
    return responder(String(url));
  }));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function runTest(connectionFields) {
  const conn = await db.createProviderConnection({ provider: "xiaomi-mimo", authType: "apikey", name: "plan-route", ...connectionFields });
  const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
  return { conn, result: await testSingleConnection(conn.id) };
}

describe("xiaomi-mimo connection test follows psd.baseUrl", () => {
  it("probes the stored token-plan cluster, tolerating its 403 the plan provider does", async () => {
    stubFetch((url) => (url === "https://token-plan-sgp.xiaomimimo.com/v1/models" ? jsonResponse({ error: { message: "forbidden" } }, 403) : jsonResponse({})));
    const { result } = await runTest({ apiKey: "sk-test", providerSpecificData: { baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" } });
    expect(fetchCalls.some((c) => c.url === "https://token-plan-sgp.xiaomimimo.com/v1/models")).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("401 from the plan cluster is still an invalid key", async () => {
    stubFetch((url) => (url.includes("token-plan") ? jsonResponse({}, 401) : jsonResponse({})));
    const { result } = await runTest({ apiKey: "sk-bad", providerSpecificData: { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" } });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid API key");
  });

  it("billing cluster keeps strict semantics: 403 is NOT accepted there", async () => {
    stubFetch((url) => (url === `${BILLING}/models` ? jsonResponse({}, 403) : jsonResponse({})));
    const { result } = await runTest({ apiKey: "sk-test", providerSpecificData: { baseUrl: BILLING } });
    expect(result.valid).toBe(false);
  });

  it("without a stored base it probes the billing host as before (regression)", async () => {
    stubFetch((url) => (url === `${BILLING}/models` ? jsonResponse({ data: [] }) : jsonResponse({})));
    const { result } = await runTest({ apiKey: "sk-test", providerSpecificData: {} });
    expect(fetchCalls.some((c) => c.url === `${BILLING}/models`)).toBe(true);
    expect(result.valid).toBe(true);
  });
});

// ───────────────────────────── TTS reaches the same clusters ─────────────────────────────

describe("mimo tts adapter routing", () => {
  const audioOk = () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ choices: [{ message: { audio: { data: "QUJD" } } }] }),
  });

  function stub() {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body || "{}") });
      return audioOk();
    }));
    return calls;
  }

  it("shares one adapter between both providers", () => {
    expect(getTtsAdapter("xiaomi-mimo")).toBe(mimoTts);
    expect(getTtsAdapter("xiaomi-tokenplan")).toBe(mimoTts);
  });

  it("tokenplan routes by the connection's region", async () => {
    const calls = stub();
    await mimoTts.synthesize("hi", "mimo-v2.5-tts", { apiKey: "tp-x", providerSpecificData: { region: "ams" } }, "mp3", { provider: "xiaomi-tokenplan" });
    expect(calls[0].url).toBe("https://token-plan-ams.xiaomimimo.com/v1/chat/completions");
  });

  it("base provider follows the OAuth-stored plan url; plain rows keep billing", async () => {
    const calls = stub();
    await mimoTts.synthesize("hi", "mimo-v2.5-tts", { apiKey: "sk-x", providerSpecificData: { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" } }, "mp3", { provider: "xiaomi-mimo" });
    expect(calls[0].url).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
    await mimoTts.synthesize("hi", "mimo-v2.5-tts", { apiKey: "sk-x", providerSpecificData: {} }, "mp3", { provider: "xiaomi-mimo" });
    expect(calls[1].url).toBe(`${BILLING}/chat/completions`);
  });

  it("non-default speech models survive parsing", async () => {
    const calls = stub();
    await mimoTts.synthesize("hi", "mimo-v2-tts", { apiKey: "sk-x", providerSpecificData: {} }, "mp3", { provider: "xiaomi-mimo" });
    expect(calls[0].body.model).toBe("mimo-v2-tts"); // must NOT be rewritten to the default
    await mimoTts.synthesize("hi", "mimo-v2.5-tts-voiceclone/茉莉", { apiKey: "sk-x", providerSpecificData: {} }, "mp3", { provider: "xiaomi-mimo" });
    expect(calls[1].body.model).toBe("mimo-v2.5-tts-voiceclone");
    expect(calls[1].body.audio.voice).toBe("茉莉");
  });
});

// ───────────────────────────── P3: pending-key cap (desktop parity cap:8) ─────────────────────────────

describe("xiaomi-mimo pending sessions are capped", () => {
  it("registers never exceed 8 live private keys, oldest evicted first", () => {
    const states = Array.from({ length: 12 }, (_, i) => `cap-test-${i}`);
    for (const s of states) expect(registerXiaomiMimoSession({ state: s, privateKeyDer: Buffer.from(`der-${s}`) })).toBe(true);
    expect(getXiaomiMimoSessionStatus("cap-test-0")).toBeNull();
    expect(getXiaomiMimoSessionStatus("cap-test-3")).toBeNull();
    for (const s of states.slice(4)) {
      expect(getXiaomiMimoSessionStatus(s)?.status).toBe("pending");
    }
  });
});
