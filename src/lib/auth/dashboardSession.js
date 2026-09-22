import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";

// There is deliberately no hardcoded fallback password. A fresh install used to
// accept the literal "123456", and because the launcher binds 0.0.0.0 by
// default that made every un-configured instance admin-open to the whole LAN in
// one guess (issue #9: default listener + default password + plaintext
// credentials). Instead:
//   * `INITIAL_PASSWORD` is the only non-interactive bootstrap password (it is
//     what Docker / fnOS installs set, and it is never "123456" by default);
//   * with no password configured at all the dashboard is loopback-only, so the
//     operator sitting at the machine can set one while remote clients are
//     refused outright (see dashboardGuard.isAuthenticated).
const BOOTSTRAP_PASSWORD_ENV = "INITIAL_PASSWORD";

export function getBootstrapPassword() {
  const fromEnv = process.env[BOOTSTRAP_PASSWORD_ENV];
  return typeof fromEnv === "string" ? fromEnv.trim() : "";
}

// Does the dashboard have *any* way to authenticate a client? Password hash,
// bootstrap env var or SSO. When false, "unauthenticated" means "nothing to ask
// for", and the guard falls back to loopback trust so a password can be set.
// The SSO checks mirror isOidcConfigured / isSamlConfigured but are inlined on
// purpose: this helper runs inside the per-request proxy, and importing the SAML
// module there would pull XML/crypto machinery into that graph for two key
// reads.
export function isDashboardAuthConfigured(settings) {
  if (settings?.password) return true;
  if (getBootstrapPassword()) return true;
  const oidcReady =
    String(settings?.oidcIssuerUrl || "").trim() &&
    String(settings?.oidcClientId || "").trim() &&
    String(settings?.oidcClientSecret || "").trim();
  if (oidcReady) return true;
  return Boolean(settings?.samlEntryPoint && settings?.samlCert);
}

// Session lifetime. The token's `exp` and the cookie's `maxAge` are both derived
// from this one value on purpose: with no maxAge at all the browser treats
// `auth_token` as a session cookie and drops it on browser close, so a user who
// is still well inside their token gets logged out by closing a window.
//
// Shortened from 24h (issue #9, item 8: a stolen cookie stayed usable for a
// whole day). Two hours is only comfortable because the session SLIDES: see
// renewDashboardAuthCookie — any authenticated page view re-issues the token
// once it is past half its life, so an active operator is never interrupted
// while a token that leaks is worthless within two hours.
const SESSION_MAX_AGE_SEC = 2 * 60 * 60;

// Placeholder values that ship in .env.example / old builds' source. A secret
// the whole internet can guess is worse than no secret — fall back to the
// auto-generated one instead of signing sessions with a public string.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "change-me-to-a-long-random-secret",
  "10router-default-secret-change-me",
  "change-me-to-a-random-string", // legacy fnOS fpk-generated .env default
  "change-me",
]);

function loadJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (!KNOWN_PLACEHOLDER_SECRETS.has(fromEnv)) return fromEnv;
    console.warn(
      "[auth] JWT_SECRET is a known placeholder value — ignoring it. " +
        "Leave JWT_SECRET unset (a random secret is generated to " +
        path.join(DATA_DIR, "jwt-secret") + ") or set a long random value.",
    );
  }
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  // Multi-hop proxies may send "https,http" — trust the first (client-facing) hop.
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
  const firstHop = String(forwardedProto).split(",")[0].trim().toLowerCase();
  return forceSecureCookie || firstHop === "https";
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Sliding session (issue #9, item 8). Call on an authenticated request: when the
// presented token is past half its life, hand back a fresh one so an active user
// never hits an expiry, while a token that leaked has a short window. Failures are
// silent — the worst case is the old behaviour (the user re-authenticates).
export async function renewDashboardAuthCookie(cookieStore, request, session) {
  try {
    const iat = typeof session?.iat === "number" ? session.iat * 1000 : 0;
    if (!iat) return false;
    const halfLifeMs = (SESSION_MAX_AGE_SEC * 1000) / 2;
    if (Date.now() - iat < halfLifeMs) return false;
    await setDashboardAuthCookie(cookieStore, request, {
      ...(session?.oidcName ? { oidcName: session.oidcName } : {}),
      ...(session?.oidcEmail ? { oidcEmail: session.oidcEmail } : {}),
      ...(session?.samlName ? { samlName: session.samlName } : {}),
      ...(session?.samlEmail ? { samlEmail: session.samlEmail } : {}),
      ...(session?.oidc ? { oidc: true } : {}),
      ...(session?.saml ? { saml: true } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  const bootstrap = getBootstrapPassword();
  if (!bootstrap) return false;
  return password === bootstrap;
}
