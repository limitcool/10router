// Encrypt stored credentials in place (issue #9, item 2).
//
// New writes were already encrypted by the repo layer, but an existing database
// would keep its tokens in plain text until each connection happened to be
// rewritten — which for a working account can be never. This walks every row
// once and encrypts the credential fields, so the file on disk stops being a
// credential dump the moment the release is installed.
//
// Idempotent: already-encrypted values are skipped (the cipher returns them
// unchanged), and the framework stamps schemaVersion so it runs once.
//
// Fail-open on purpose. Encryption needs key material (a key file or
// CREDENTIAL_SECRET); if that cannot be created — unwritable data directory,
// read-only mount — startup must not be bricked by a hardening step. Rows stay
// plaintext and the failure is logged loudly, and the repo layer will encrypt
// them on their next write.

import {
  encryptConnectionData,
  connectionDataHasPlaintextSecrets,
} from "../crypto/credentialCipher.js";

export default {
  version: 3,
  name: "encrypt-credentials",
  up(db) {
    let rows;
    try {
      rows = db.all(`SELECT id, data FROM providerConnections`);
    } catch (err) {
      console.warn("[migration] encrypt-credentials: could not read connections:", err?.message || err);
      return;
    }

    let encrypted = 0;
    let failed = 0;
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data || "{}");
      } catch {
        continue;
      }
      if (!connectionDataHasPlaintextSecrets(data)) continue;
      try {
        db.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [
          JSON.stringify(encryptConnectionData(data)),
          row.id,
        ]);
        encrypted += 1;
      } catch (err) {
        failed += 1;
        if (failed === 1) {
          console.warn(
            "[migration] encrypt-credentials: could not encrypt a connection — " +
              "credentials stay in plain text until they are rewritten:",
            err?.message || err,
          );
        }
      }
    }

    if (encrypted) {
      console.log(`[migration] encrypt-credentials: encrypted ${encrypted} connection row(s)`);
    }
    if (failed) {
      console.warn(`[migration] encrypt-credentials: ${failed} row(s) left in plain text`);
    }
  },
};
