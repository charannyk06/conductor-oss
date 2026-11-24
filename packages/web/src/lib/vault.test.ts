import assert from "node:assert/strict";
import { test } from "node:test";

import { describeVaultImport, parseVaultCredentials, parseVaultImportResult } from "./vault";

test("parseVaultCredentials keeps valid entries and drops malformed ones", () => {
  const parsed = parseVaultCredentials({
    credentials: [
      { id: "a", name: "Mail", url: "https://mail.test", username: "ada", source: "1password", createdAt: "2026-11-24T00:00:00Z" },
      { id: "", source: "chrome" },
      { id: "b", source: "lastpass" },
      null,
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.source, "1password");
  assert.deepEqual(parseVaultCredentials(null), []);
  assert.deepEqual(parseVaultCredentials({ credentials: "nope" }), []);
});

test("describeVaultImport summarises only the non-zero counts", () => {
  const full = parseVaultImportResult({ source: "bitwarden", imported: 3, updated: 1, unchanged: 2, skipped: 4 });
  assert.ok(full);
  assert.equal(
    describeVaultImport(full),
    "Imported from Bitwarden: 3 new, 1 updated, 2 already saved, 4 skipped (no password).",
  );
  const minimal = parseVaultImportResult({ source: "chrome", imported: 0 });
  assert.ok(minimal);
  assert.equal(describeVaultImport(minimal), "Imported from Chrome: 0 new.");
  assert.equal(parseVaultImportResult({ source: "other" }), null);
});
