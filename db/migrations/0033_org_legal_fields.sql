-- Phase 2026-04-28: org legal fields for invoices, contracts, letters.
-- organizations currently has: address_lines, vat_id, imprint_md, email_from,
-- canonical_domain. For legal outbound documents the following are missing: phone, bank
-- details (IBAN/BIC/bank name), commercial-register number, separate legal name,
-- responsible-person plaintext.

ALTER TABLE organizations ADD COLUMN legal_name        TEXT;
ALTER TABLE organizations ADD COLUMN registration_no   TEXT;
ALTER TABLE organizations ADD COLUMN phone             TEXT;
ALTER TABLE organizations ADD COLUMN bank_iban         TEXT;
ALTER TABLE organizations ADD COLUMN bank_bic          TEXT;
ALTER TABLE organizations ADD COLUMN bank_name         TEXT;
ALTER TABLE organizations ADD COLUMN responsible_label TEXT;
