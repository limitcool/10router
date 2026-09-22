const path = require("path");
const fs = require("fs");
const forge = require("node-forge");
const { MITM_DIR } = require("../paths");

const ROOT_CA_KEY_PATH = path.join(MITM_DIR, "rootCA.key");
const ROOT_CA_CERT_PATH = path.join(MITM_DIR, "rootCA.crt");

/**
 * Check if cert file is expired or expiring within 30 days
 */
function isCertExpired(certPath) {
  try {
    const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, "utf8"));
    const expiryThreshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return cert.validity.notAfter < expiryThreshold;
  } catch {
    return true; // treat unreadable cert as expired
  }
}

/**
 * Restrict the Root CA private key to the owning account.
 *
 * Whoever holds this key can mint a trusted certificate for any domain on this
 * machine, so it must never be readable by other accounts. `mode` on
 * writeFileSync only applies when the file is created, so this also repairs keys
 * written by older versions.
 *
 * POSIX: 0600. Windows: POSIX bits do not apply — a file created under the user
 * profile inherits ACLs that typically include Users/Authenticated Users, so the
 * key used to sit there readable by anyone who could reach the path (issue #9,
 * item 7). `icacls /inheritance:r` drops the inherited entries and a single
 * explicit grant to the owning account replaces them.
 * Best-effort in both branches: a warning, never a hard failure — MITM being
 * broken is worse than a permissive key, and the warning tells the operator.
 */
function hardenKeyPermissions() {
  if (!fs.existsSync(ROOT_CA_KEY_PATH)) return;

  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("node:child_process");
      const os = require("node:os");
      const account =
        [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\") || os.userInfo().username;
      // (F) = full control for the owner. (R,W) looks sufficient but is not: it
      // omits DELETE, and the expired-cert regeneration path unlinks this file —
      // hardening it that way made the owner unable to remove its own key.
      execFileSync("icacls", [ROOT_CA_KEY_PATH, "/inheritance:r", "/grant:r", `${account}:(F)`], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (e) {
      console.warn(`⚠️  Could not restrict ACLs on ${ROOT_CA_KEY_PATH}: ${e.message}`);
    }
    return;
  }

  try {
    fs.chmodSync(ROOT_CA_KEY_PATH, 0o600);
  } catch (e) {
    console.warn(`⚠️  Could not restrict permissions on ${ROOT_CA_KEY_PATH}: ${e.message}`);
  }
}

/**
 * Generate Root CA certificate (only once, auto-regenerate if expired)
 * This Root CA will sign all dynamic leaf certificates
 */
function generateRootCA() {
  const exists = fs.existsSync(ROOT_CA_KEY_PATH) && fs.existsSync(ROOT_CA_CERT_PATH);
  if (exists && !isCertExpired(ROOT_CA_CERT_PATH)) {
    hardenKeyPermissions();
    console.log("✅ Root CA already exists");
    return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
  }
  if (exists) {
    console.log("🔐 Root CA expired or expiring soon — regenerating...");
    try { fs.unlinkSync(ROOT_CA_KEY_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(ROOT_CA_CERT_PATH); } catch { /* ignore */ }
  }

  if (!fs.existsSync(MITM_DIR)) {
    fs.mkdirSync(MITM_DIR, { recursive: true, mode: 0o700 });
  }

  console.log("🔐 Generating Root CA certificate...");

  // Generate RSA key pair
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create Root CA certificate
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "10Router MITM Root CA" },
    { name: "organizationName", value: "10Router" },
    { name: "countryName", value: "US" }
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs); // Self-signed

  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: true,
      critical: true
    },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      critical: true
    },
    {
      name: "subjectKeyIdentifier"
    }
  ]);

  // Self-sign the certificate
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Save to disk
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(ROOT_CA_KEY_PATH, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(ROOT_CA_CERT_PATH, certPem);
  hardenKeyPermissions();

  console.log("✅ Root CA generated successfully");
  return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
}

/**
 * Load Root CA from disk
 */
function loadRootCA() {
  if (!fs.existsSync(ROOT_CA_KEY_PATH) || !fs.existsSync(ROOT_CA_CERT_PATH)) {
    throw new Error("Root CA not found. Generate it first.");
  }

  const keyPem = fs.readFileSync(ROOT_CA_KEY_PATH, "utf8");
  const certPem = fs.readFileSync(ROOT_CA_CERT_PATH, "utf8");

  return {
    key: forge.pki.privateKeyFromPem(keyPem),
    cert: forge.pki.certificateFromPem(certPem)
  };
}

/**
 * Generate leaf certificate for a specific domain, signed by Root CA
 */
function generateLeafCert(domain, rootCA) {
  // Generate key pair for leaf cert
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create leaf certificate
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Math.floor(Math.random() * 1000000).toString();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([
    { name: "commonName", value: domain }
  ]);

  cert.setIssuer(rootCA.cert.subject.attributes);

  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: false
    },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
      clientAuth: true
    },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: domain }, // DNS
        { type: 2, value: `*.${domain}` } // Wildcard
      ]
    }
  ]);

  // Sign with Root CA
  cert.sign(rootCA.key, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert)
  };
}

module.exports = {
  generateRootCA,
  loadRootCA,
  generateLeafCert,
  isCertExpired,
  ROOT_CA_CERT_PATH,
  ROOT_CA_KEY_PATH
};
