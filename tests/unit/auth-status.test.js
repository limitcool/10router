import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  cookies: vi.fn(),
  getSettings: vi.fn(),
  isOidcConfigured: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  isDashboardAuthConfigured: vi.fn(() => true),
  isLocalRequest: vi.fn(() => false),
  renewDashboardAuthCookie: vi.fn(async () => false),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: mocks.isOidcConfigured,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
  isDashboardAuthConfigured: mocks.isDashboardAuthConfigured,
  renewDashboardAuthCookie: mocks.renewDashboardAuthCookie,
}));

// The route asks the guard whether the caller is on this machine; mocking it keeps
// the peer-token plumbing out of an endpoint test.
vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: mocks.isLocalRequest,
}));

const { GET } = await import("../../src/app/api/auth/status/route.js");

describe("GET /api/auth/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true, authMode: "password" });
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: "session-token" })) });
    mocks.isOidcConfigured.mockReturnValue(false);
  });

  it("reports an authenticated session when the auth cookie is valid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, iat: 1 });

    const response = await GET();

    expect(response.body.authenticated).toBe(true);
    expect(mocks.getDashboardAuthSession).toHaveBeenCalledWith("session-token");
  });

  // Sliding session (issue #9, item 8): the dashboard hits this endpoint on every
  // navigation, and that is what lets a 2h token keep an active operator signed in.
  it("offers to renew the session whenever one is presented", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, iat: 1 });

    await GET();

    expect(mocks.renewDashboardAuthCookie).toHaveBeenCalledTimes(1);
    expect(mocks.renewDashboardAuthCookie.mock.calls[0][2]).toMatchObject({ iat: 1 });
  });

  it("does not try to renew without a session", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    await GET();

    expect(mocks.renewDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("reports unauthenticated when the auth cookie is invalid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
  });

  it("fails closed when status dependencies throw", async () => {
    mocks.getSettings.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
    expect(response.body.requireLogin).toBe(true);
  });

  // A fresh install has no password hash, no INITIAL_PASSWORD and no SSO. The
  // login form cannot possibly succeed in that state (the literal "123456"
  // fallback is gone), so the page has to be told which side of the wire the
  // caller is on: remote callers get "set it on the machine", the machine itself
  // gets "open the dashboard and set it".
  it("flags a remote caller when nothing is configured at all", async () => {
    mocks.isDashboardAuthConfigured.mockReturnValue(false);
    mocks.isLocalRequest.mockReturnValue(false);

    const response = await GET({});

    expect(response.body.needsLocalSetup).toBe(true);
    expect(response.body.bootstrapLocal).toBe(false);
  });

  it("flags the machine itself for the bootstrap path", async () => {
    mocks.isDashboardAuthConfigured.mockReturnValue(false);
    mocks.isLocalRequest.mockReturnValue(true);

    const response = await GET({});

    expect(response.body.needsLocalSetup).toBe(false);
    expect(response.body.bootstrapLocal).toBe(true);
  });

  it("stays quiet once a password exists", async () => {
    mocks.isDashboardAuthConfigured.mockReturnValue(true);
    mocks.isLocalRequest.mockReturnValue(false);

    const response = await GET({});

    expect(response.body.needsLocalSetup).toBe(false);
    expect(response.body.bootstrapLocal).toBe(false);
  });
});
