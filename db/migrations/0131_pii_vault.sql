-- 0131_pii_vault.sql — Local PII tokenization vault (privacy / GDPR).
--
-- Real entity values (emails, IBANs, names, …) are AES-256-GCM-encrypted and
-- stored ONLY in this local table; what leaves the machine to an external LLM is
-- an opaque placeholder token like [[EMAIL_1]]. The token<->value mapping never
-- leaves the box. workspace_id-scoped (N9). Append-mostly; the unique indexes
-- give stable, deduplicated tokens per (workspace, value).
CREATE TABLE IF NOT EXISTS pii_vault (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  token         TEXT NOT NULL,        -- placeholder shown to external LLMs, e.g. [[EMAIL_1]]
  entity_type   TEXT NOT NULL,        -- EMAIL | IBAN | CARD | PHONE | IP | PERSON | ORG | LOCATION
  value_enc     TEXT NOT NULL,        -- AES-256-GCM ciphertext of the real value (local only)
  value_hash    TEXT NOT NULL,        -- sha256(workspace_id\0type\0value) for dedup/lookup
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pii_vault_ws_hash ON pii_vault(workspace_id, value_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pii_vault_ws_token ON pii_vault(workspace_id, token);
