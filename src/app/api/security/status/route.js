import { NextResponse } from "next/server";
import os from "node:os";
import { getSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver";
import { connectionDataHasPlaintextSecrets } from "@/lib/db/crypto/credentialCipher";

// Read-out behind the Security card (Settings → Experimental → Security): the
// point of the card is to put the *facts* next to the switches that change them,
// so an operator can see what is actually exposed instead of trusting a default.
// Auth-gated by the guard — it is deliberately not in PUBLIC_API_PATHS.
export const dynamic = "force-dynamic";

// IPv4 addresses a LAN peer could reach this instance on. Mirrors the launcher's
// getLanIp() (interface name + address, virtual interfaces left in — a VPN
// address is a real exposure path here, so hiding it would be a lie).
function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal || addr.family !== "IPv4") continue;
      out.push({ iface: name, address: addr.address });
    }
  }
  return out;
}

export async function GET(request) {
  try {
    const settings = await getSettings();
    const rawHost = request.headers.get("host") || "";
    const port = rawHost.includes(":") ? rawHost.split(":").pop() : "";

    // Issue #9 item 2: report what is actually on disk rather than what the
    // release intends. A row whose credentials could not be encrypted (no
    // writable key material) stays in the clear, and that has to be visible.
    let credentialsEncrypted = null;
    try {
      const rows = (await getAdapter()).all(`SELECT data FROM providerConnections`);
      credentialsEncrypted = rows.every((row) => {
        let data;
        try {
          data = JSON.parse(row.data || "{}");
        } catch {
          return true; // unparsable rows are not a plaintext-secret signal here
        }
        return !connectionDataHasPlaintextSecrets(data);
      });
    } catch {
      credentialsEncrypted = null;
    }

    return NextResponse.json({
      // The switches themselves
      dashboardLocalOnly: settings?.dashboardLocalOnly === true,
      requireLogin: settings?.requireLogin !== false,
      // Exposure facts
      hasPassword: !!settings?.password,
      bootstrapPassword: !!process.env.INITIAL_PASSWORD,
      listenHost: process.env.HOSTNAME || process.env.HOST || null,
      port: port || null,
      lanAddresses: lanAddresses(),
      credentialsEncrypted,
      credentialKeyFromEnv: !!(process.env.CREDENTIAL_SECRET || "").trim(),
      // Anything other than password/SSO means a remote caller has nothing to
      // present; the guard then refuses it and only loopback gets in.
      ssoConfigured: Boolean(
        (String(settings?.oidcIssuerUrl || "").trim() &&
          String(settings?.oidcClientId || "").trim() &&
          String(settings?.oidcClientSecret || "").trim()) ||
          (settings?.samlEntryPoint && settings?.samlCert),
      ),
    });
  } catch (error) {
    console.error("[security] status read failed:", error);
    return NextResponse.json({ error: "Failed to read security status" }, { status: 500 });
  }
}
