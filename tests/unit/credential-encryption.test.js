// Credential encryption at rest (issue #9, item 2).
//
// The point of this layer is that the *database file* stops being a credential
// dump: backups, cloud-synced data directories, a database copied out for
// debugging. Two properties have to hold, and they pull in opposite directions:
//
//   * nothing readable is left in the column, and
//   * every reader still gets the token back, with no caller having to know.
//
// Plus the failure mode that matters: a database restored without its key file
// must NOT read as "no credential" (which would silently disable the account) —
// it must be visible.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalSecret = process.env.CREDENTIAL_SECRET;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cred-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.CREDENTIAL_SECRET;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSecret === undefined) delete process.env.CREDENTIAL_SECRET;
  else process.env.CREDENTIAL_SECRET = originalSecret;
});

const cipher = () => import("@/lib/db/crypto/credentialCipher.js");

describe("credential cipher primitives", () => {
  it("round-trips a secret", async () => {
    const { encryptSecret, decryptSecret, isEncrypted } = await cipher();
    const encrypted = encryptSecret("sk-secret-value");
    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toContain("sk-secret-value");
    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe("sk-secret-value");
  });

  it("uses a fresh IV per value — identical secrets never look identical", async () => {
    const { encryptSecret } = await cipher();
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
  });

  it("encrypting twice is a no-op (idempotent)", async () => {
    const { encryptSecret, decryptSecret } = await cipher();
    const once = encryptSecret("tok");
    expect(encryptSecret(once)).toBe(once);
    expect(decryptSecret(once)).toBe("tok");
  });

  it("passes legacy plaintext through untouched", async () => {
    const { decryptSecret, isEncrypted } = await cipher();
    expect(isEncrypted("plain-token")).toBe(false);
    expect(decryptSecret("plain-token")).toBe("plain-token");
  });

  it("leaves empty and non-string values alone", async () => {
    const { encryptSecret } = await cipher();
    expect(encryptSecret("")).toBe("");
    expect(encryptSecret(null)).toBe(null);
    expect(encryptSecret(undefined)).toBe(undefined);
  });

  it("refuses to silently return an empty credential when the key is wrong", async () => {
    const { encryptSecret, decryptSecret, resetCredentialKeyCache, CredentialCryptoError } = await cipher();
    const encrypted = encryptSecret("original-token");

    // Simulate a restored database whose key file is gone, replaced by another.
    fs.writeFileSync(path.join(tempDir, "credential-key"), "a-totally-different-key", { mode: 0o600 });
    resetCredentialKeyCache();

    expect(() => decryptSecret(encrypted)).toThrow(CredentialCryptoError);
  });

  it("flags malformed ciphertext instead of guessing", async () => {
    const { decryptSecret, CredentialCryptoError } = await cipher();
    expect(() => decryptSecret("enc:v1:not-enough-parts")).toThrow(CredentialCryptoError);
  });
});

describe("connection field coverage", () => {
  it("encrypts the top-level credential fields", async () => {
    const { encryptConnectionData, isEncrypted } = await cipher();
    const out = encryptConnectionData({
      accessToken: "at",
      refreshToken: "rt",
      idToken: "it",
      apiKey: "sk-1",
      email: "user@example.com",
      expiresAt: "2026-01-01T00:00:00Z",
      providerSpecificData: { userId: "u1" },
    });
    for (const f of ["accessToken", "refreshToken", "idToken", "apiKey"]) {
      expect(isEncrypted(out[f])).toBe(true);
    }
    // Non-secrets stay readable so the database is still inspectable.
    expect(out.email).toBe("user@example.com");
    expect(out.expiresAt).toBe("2026-01-01T00:00:00Z");
    expect(out.providerSpecificData.userId).toBe("u1");
  });

  it("encrypts secret-looking nested values (mimoPassToken, proxy URLs)", async () => {
    const { encryptConnectionData, isEncrypted } = await cipher();
    const out = encryptConnectionData({
      providerSpecificData: {
        mimoPassToken: "pass-token",
        connectionProxyUrl: "http://user:pw@proxy:8080",
        authMethod: "browser",
        userId: "u1",
      },
    });
    expect(isEncrypted(out.providerSpecificData.mimoPassToken)).toBe(true);
    expect(isEncrypted(out.providerSpecificData.connectionProxyUrl)).toBe(true);
    expect(out.providerSpecificData.authMethod).toBe("browser");
    expect(out.providerSpecificData.userId).toBe("u1");
  });

  it("does not mutate the input object", async () => {
    const { encryptConnectionData } = await cipher();
    const input = { accessToken: "at", providerSpecificData: { mimoPassToken: "pt" } };
    const out = encryptConnectionData(input);
    expect(input.accessToken).toBe("at");
    expect(input.providerSpecificData.mimoPassToken).toBe("pt");
    expect(out.accessToken).not.toBe("at");
  });

  it("does not mistake an empty value for a plaintext secret", async () => {
    // `connectionProxyUrl` is stored as "" when a connection has no proxy.
    // Counting that as "still in plain text" made the Security card report an
    // encryption failure on a fully encrypted database.
    const { encryptConnectionData, connectionDataHasPlaintextSecrets } = await cipher();
    const conn = encryptConnectionData({
      apiKey: "sk-1",
      providerSpecificData: { connectionProxyUrl: "", connectionNoProxy: "", connectionProxyEnabled: false },
    });
    expect(connectionDataHasPlaintextSecrets(conn)).toBe(false);
    expect(connectionDataHasPlaintextSecrets({ providerSpecificData: { connectionProxyUrl: "" } })).toBe(false);
  });

  it("still flags a real plaintext value next to an empty one", async () => {
    const { encryptConnectionData, connectionDataHasPlaintextSecrets } = await cipher();
    const conn = encryptConnectionData({
      apiKey: "sk-1",
      providerSpecificData: { connectionProxyUrl: "" },
    });
    conn.providerSpecificData = { ...conn.providerSpecificData, mimoPassToken: "left-in-the-clear" };
    expect(connectionDataHasPlaintextSecrets(conn)).toBe(true);
  });

  it("reports plaintext leftovers and round-trips", async () => {
    const { encryptConnectionData, decryptConnectionData, connectionDataHasPlaintextSecrets } = await cipher();
    const plain = { accessToken: "at", providerSpecificData: { mimoPassToken: "pt" } };
    expect(connectionDataHasPlaintextSecrets(plain)).toBe(true);

    const encrypted = encryptConnectionData(plain);
    expect(connectionDataHasPlaintextSecrets(encrypted)).toBe(false);

    const { data, error } = decryptConnectionData(encrypted);
    expect(error).toBe(null);
    expect(data).toEqual(plain);
  });
});

describe("connections repo round-trip", () => {
  it("stores credentials encrypted and reads them back transparently", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createProviderConnection, getProviderConnectionById, getProviderConnections } = await import(
      "@/lib/db/repos/connectionsRepo.js"
    );
    const db = await getAdapter();

    const created = await createProviderConnection({
      provider: "qoder-cn",
      authType: "oauth",
      email: "user@example.com",
      accessToken: "ACCESS-TOKEN-PLAINTEXT",
      refreshToken: "REFRESH-TOKEN-PLAINTEXT",
      providerSpecificData: { mimoPassToken: "PASS-TOKEN-PLAINTEXT", userId: "u1" },
    });

    // The column itself must not contain any of it.
    const raw = db.get(`SELECT data FROM providerConnections WHERE id = ?`, [created.id]);
    expect(raw.data).not.toContain("ACCESS-TOKEN-PLAINTEXT");
    expect(raw.data).not.toContain("REFRESH-TOKEN-PLAINTEXT");
    expect(raw.data).not.toContain("PASS-TOKEN-PLAINTEXT");
    expect(raw.data).toContain("enc:v1:");
    // …but non-secrets in `data` are still legible (email lives in its own
    // column, so check a field that really is inside the JSON blob).
    expect(raw.data).toContain("u1");
    expect(raw.data).toContain("providerSpecificData");

    // And every reader gets the real value back.
    const one = await getProviderConnectionById(created.id);
    expect(one.accessToken).toBe("ACCESS-TOKEN-PLAINTEXT");
    expect(one.refreshToken).toBe("REFRESH-TOKEN-PLAINTEXT");
    expect(one.providerSpecificData.mimoPassToken).toBe("PASS-TOKEN-PLAINTEXT");

    const all = await getProviderConnections({ provider: "qoder-cn" });
    expect(all[0].accessToken).toBe("ACCESS-TOKEN-PLAINTEXT");
  });

  it("keeps the OAuth refresh race path writable (update does not double-encrypt)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createProviderConnection, updateProviderConnection, getProviderConnectionById } = await import(
      "@/lib/db/repos/connectionsRepo.js"
    );
    const db = await getAdapter();

    const created = await createProviderConnection({
      provider: "qoder",
      authType: "oauth",
      email: "u@example.com",
      accessToken: "AT-1",
      refreshToken: "RT-1",
    });

    // A token refresh merges onto the existing row (this is the hot path).
    await updateProviderConnection(created.id, { accessToken: "AT-2" });
    const afterFirst = await getProviderConnectionById(created.id);
    expect(afterFirst.accessToken).toBe("AT-2");
    expect(afterFirst.refreshToken).toBe("RT-1");

    // A second refresh must not layer encryption.
    await updateProviderConnection(created.id, { accessToken: "AT-3", refreshToken: "RT-3" });
    const afterSecond = await getProviderConnectionById(created.id);
    expect(afterSecond.accessToken).toBe("AT-3");
    expect(afterSecond.refreshToken).toBe("RT-3");

    const raw = db.get(`SELECT data FROM providerConnections WHERE id = ?`, [created.id]);
    expect(raw.data).not.toContain("AT-3");
    expect((raw.data.match(/enc:v1:/g) || []).length).toBe(2);
  });

  it("surfaces an unreadable credential instead of treating it as missing", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createProviderConnection, getProviderConnectionById } = await import("@/lib/db/repos/connectionsRepo.js");
    const { resetCredentialKeyCache } = await import("@/lib/db/crypto/credentialCipher.js");
    await getAdapter();

    const created = await createProviderConnection({
      provider: "qoder-cn",
      authType: "oauth",
      email: "u@example.com",
      accessToken: "AT-SECRET",
    });

    // Key rotation / restored database without its key file.
    fs.writeFileSync(path.join(tempDir, "credential-key"), "different-key-entirely", { mode: 0o600 });
    resetCredentialKeyCache();

    const conn = await getProviderConnectionById(created.id);
    expect(conn.accessToken).toBeUndefined(); // never the ciphertext, never ""
    expect(conn.testStatus).toBe("unavailable");
    expect(conn.lastError).toContain("unreadable");
  });
});

describe("backup export / import keep working (existing users)", () => {
  // exportDb/importDb move whole tables and so bypass the repo — they are the
  // paths an existing user actually hits (Download backup / Import backup).
  // Export must stay restorable elsewhere, which means readable credentials in
  // the file; import must not put them back unencrypted.
  it("exports readable credentials and imports them encrypted", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createProviderConnection, getProviderConnectionById } = await import("@/lib/db/repos/connectionsRepo.js");
    const { exportDb, importDb } = await import("@/lib/db/index.js");
    const db = await getAdapter();

    await createProviderConnection({
      provider: "qoder-cn",
      authType: "oauth",
      email: "backup@example.com",
      accessToken: "BACKUP-TOKEN",
      refreshToken: "BACKUP-REFRESH",
      providerSpecificData: { mimoPassToken: "BACKUP-PASS" },
    });

    const payload = await exportDb();
    const exported = payload.providerConnections.find((c) => c.email === "backup@example.com");
    expect(exported).toBeTruthy();
    // The backup is portable: real values, no ciphertext.
    expect(exported.accessToken).toBe("BACKUP-TOKEN");
    expect(exported.providerSpecificData.mimoPassToken).toBe("BACKUP-PASS");
    expect(JSON.stringify(payload.providerConnections)).not.toContain("enc:v1:");

    // Wipe and restore it the way the dashboard does.
    db.run(`DELETE FROM providerConnections`);
    await importDb(payload);

    // Restored rows are encrypted again, and readable through the repo.
    const raw = db.get(`SELECT id, data FROM providerConnections WHERE email = ?`, ["backup@example.com"]);
    expect(raw.data).toContain("enc:v1:");
    expect(raw.data).not.toContain("BACKUP-TOKEN");
    const conn = await getProviderConnectionById(raw.id);
    expect(conn.accessToken).toBe("BACKUP-TOKEN");
    expect(conn.providerSpecificData.mimoPassToken).toBe("BACKUP-PASS");
  });

  it("importing an older plaintext backup does not leave credentials in the clear", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { importDb } = await import("@/lib/db/index.js");
    const db = await getAdapter();

    // Shape of a backup taken by a pre-encryption release.
    await importDb({
      settings: {},
      providerConnections: [
        {
          id: "legacy-backup",
          provider: "stepfun-cn",
          authType: "apikey",
          name: "key",
          priority: 1,
          isActive: true,
          apiKey: "OLD-BACKUP-PLAINTEXT-KEY",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const raw = db.get(`SELECT data FROM providerConnections WHERE id = 'legacy-backup'`);
    expect(raw.data).not.toContain("OLD-BACKUP-PLAINTEXT-KEY");
    expect(raw.data).toContain("enc:v1:");
  });
});

describe("003-encrypt-credentials migration", () => {
  it("encrypts existing plaintext rows once and is idempotent", async () => {
    // 1st boot: schema at the pre-encryption version, holding a plaintext row.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "conn-legacy",
        "stepfun-cn",
        "apikey",
        "key",
        null,
        1,
        1,
        JSON.stringify({ apiKey: "LEGACY-PLAINTEXT-KEY", testStatus: "active" }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    db.run(`UPDATE _meta SET value = '2' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: the migration runs.
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const { getProviderConnectionById } = await import("@/lib/db/repos/connectionsRepo.js");
    const db2 = await getAdapter2();

    expect(parseInt(db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value, 10)).toBe(latestVersion());

    const raw = db2.get(`SELECT data FROM providerConnections WHERE id = 'conn-legacy'`);
    expect(raw.data).not.toContain("LEGACY-PLAINTEXT-KEY");
    expect(raw.data).toContain("enc:v1:");

    // Still readable through the repo, and still idempotent on a later run.
    const conn = await getProviderConnectionById("conn-legacy");
    expect(conn.apiKey).toBe("LEGACY-PLAINTEXT-KEY");

    const { default: migration } = await import("@/lib/db/migrations/003-encrypt-credentials.js");
    migration.up(db2);
    const raw2 = db2.get(`SELECT data FROM providerConnections WHERE id = 'conn-legacy'`);
    expect(raw2.data).toBe(raw.data);
  });
});
