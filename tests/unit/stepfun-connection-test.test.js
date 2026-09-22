// StepFun connection test routing (dashboard "Provider test not supported" repro).
//
// All four StepFun channels (Domestic/International × Pay-as-you-go/Step Plan)
// expose a plain Bearer-auth GET {base}/models, so they must share the generic
// OpenAI-compatible validator. Before this they had no case in the test switch
// and the "Test connection" / "逐个测试连接" buttons answered
// `Provider test not supported` even for a healthy Step Plan key.
//
// Offline by construction: global.fetch is mocked, so the test asserts the
// ROUTING (which URL + auth header is probed) and the verdict mapping, never a
// live provider call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let db;
let fetchCalls;

const VALIDATE_URLS = {
  "stepfun-cn": "https://api.stepfun.com/v1/models",
  "stepfun-plan-cn": "https://api.stepfun.com/step_plan/v1/models",
  stepfun: "https://api.stepfun.ai/v1/models",
  "stepfun-plan": "https://api.stepfun.ai/step_plan/v1/models",
};

beforeAll(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-stepfun-test-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler) {
  fetchCalls = [];
  const mock = vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), headers: opts.headers || {} });
    return handler(String(url));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runTest(provider, apiKey) {
  const conn = await db.createProviderConnection({ provider, authType: "apikey", name: provider, apiKey });
  const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
  return { conn, result: await testSingleConnection(conn.id) };
}

describe("stepfun connection test routing", () => {
  for (const [provider, validateUrl] of Object.entries(VALIDATE_URLS)) {
    it(`${provider} probes GET ${validateUrl} with Bearer and reports success`, async () => {
      stubFetch((url) => {
        if (url === validateUrl) return jsonResponse({ data: [{ id: "step-5-preview" }] });
        // background quota/expiry refresh may hit /accounts etc. — keep it inert
        return jsonResponse({});
      });
      const { conn, result } = await runTest(provider, "sk-test-key");
      expect(result.error).not.toBe("Provider test not supported");
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();

      const probe = fetchCalls.find((c) => c.url === validateUrl);
      expect(probe, `expected a GET to ${validateUrl}`).toBeTruthy();
      expect(probe.headers.Authorization).toBe("Bearer sk-test-key");

      const stored = await db.getProviderConnectionById(conn.id);
      expect(stored.testStatus).toBe("active");
      expect(stored.lastError).toBeNull();
    });
  }

  it("a 401 from the validator is reported as invalid (not 'not supported')", async () => {
    stubFetch((url) =>
      url === VALIDATE_URLS["stepfun-plan-cn"]
        ? jsonResponse({ error: { message: "Incorrect API key provided" } }, 401)
        : jsonResponse({})
    );
    const { conn, result } = await runTest("stepfun-plan-cn", "sk-bad");
    expect(result.error).not.toBe("Provider test not supported");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid API key");
    const stored = await db.getProviderConnectionById(conn.id);
    expect(stored.testStatus).toBe("error");
  });

  it("a 403 with an HTML body is treated as maintenance, not a bad key", async () => {
    stubFetch((url) =>
      url === VALIDATE_URLS["stepfun-cn"]
        ? new Response("<html>cf-challenge</html>", { status: 403, headers: { "content-type": "text/html" } })
        : jsonResponse({})
    );
    const { result } = await runTest("stepfun-cn", "sk-test");
    expect(result.valid).toBe(false);
    expect(result.error).not.toBe("Provider test not supported");
  });
});
