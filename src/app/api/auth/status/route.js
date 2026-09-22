import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { getDashboardAuthSession, isDashboardAuthConfigured, renewDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isLocalRequest } from "@/dashboardGuard";

// The guard's peer check needs a real request object; this route is also called
// without one (tests, and the pre-flight probe path), and an unparsable request
// must not turn into a 500.
function cameFromThisMachine(request) {
  try {
    return isLocalRequest(request);
  } catch {
    return false;
  }
}

export async function GET(request) {
  try {
    const settings = await getSettings();
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    const requireLogin = settings.requireLogin !== false;
    const authMode = settings.authMode || "password";
    const ssoType = settings.ssoType || "oidc";
    const oidcName = String(session?.oidcName || "").trim();
    const oidcEmail = String(session?.oidcEmail || "").trim();
    const samlName = String(session?.samlName || "").trim();
    const samlEmail = String(session?.samlEmail || "").trim();

    const displayName =
      samlName ||
      samlEmail ||
      oidcName ||
      oidcEmail ||
      (session?.saml ? "SAML user" : session?.oidc ? "OIDC user" : "Password user");

    const loginMethod = session?.saml ? "SAML" : session?.oidc ? "OIDC" : "Password";

    // Sliding session (issue #9, item 8): the dashboard calls this on every
    // navigation (the header remounts per route), so re-issuing here is what keeps
    // a 2h token from logging an active operator out. No-op while the token is
    // fresh, and never fatal — a failed renewal just means re-authenticating later.
    if (session) {
      await renewDashboardAuthCookie(cookieStore, request, session);
    }

    // Nothing configured at all (no password hash, no INITIAL_PASSWORD, no SSO)
    // and the caller is not on the machine itself: there is no secret they could
    // ever present, and the old behaviour of accepting the literal "123456" is
    // exactly the hole #9 reported. Tell them what to do instead of looping
    // "Invalid password" at them. Only non-local callers can even be in this
    // state, so the flag leaks nothing a port scan wouldn't.
    const isLocal = cameFromThisMachine(request);
    const needsLocalSetup = !isDashboardAuthConfigured(settings) && !isLocal;
    // Same state, seen from the machine itself: the dashboard is open (guard
    // lets loopback through) but a password still has to be set.
    const bootstrapLocal = !isDashboardAuthConfigured(settings) && isLocal;

    return NextResponse.json({
      needsLocalSetup,
      bootstrapLocal,
      requireLogin,
      authMode,
      ssoType,
      oidcConfigured: isOidcConfigured(settings),
      oidcLoginLabel: (settings.oidcLoginLabel || "Sign in with OIDC").trim() || "Sign in with OIDC",
      samlConfigured: isSamlConfigured(settings),
      samlLoginLabel: (settings.samlLoginLabel || "Sign in with SAML SSO").trim() || "Sign in with SAML SSO",
      hasPassword: !!settings.password,
      displayName,
      loginMethod,
      authenticated: !!session,
      oidcName: oidcName || null,
      oidcEmail: oidcEmail || null,
      oidcLogin: !!session?.oidc,
      samlName: samlName || null,
      samlEmail: samlEmail || null,
      samlLogin: !!session?.saml,
    });
  } catch {
    return NextResponse.json({
      needsLocalSetup: false,
      bootstrapLocal: false,
      requireLogin: true,
      authMode: "password",
      ssoType: "oidc",
      oidcConfigured: false,
      oidcLoginLabel: "Sign in with OIDC",
      samlConfigured: false,
      samlLoginLabel: "Sign in with SAML SSO",
      hasPassword: false,
      displayName: "Password user",
      loginMethod: "Password",
      authenticated: false,
      oidcName: null,
      oidcEmail: null,
      oidcLogin: false,
      samlName: null,
      samlEmail: null,
      samlLogin: false,
    });
  }
}
