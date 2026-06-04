/**
 * Connector Onboarding Write Path — ACL-4 · 2026-05-24.
 *
 * Public API:
 *   persistDiscoveredProfile(rawProfile) → ConnectorCatalogRow
 *
 * This module is the NON-DESTRUCTIVE write path for discovered connector
 * profiles. It receives the output of the SOP Scribe step (a validated
 * ConnectorProfileInput) and persists it to the platform-global connector
 * catalog.
 *
 * What this module does:
 *   1. Calls assertNonSensitiveProfile() first (PII Hard-Guard, ACL-2).
 *   2. Calls upsertConnectorProfile() to write to the catalog.
 *   3. Returns the persisted ConnectorCatalogRow.
 *
 * What this module does NOT do (R3, ACL-5 boundary):
 *   - Does NOT call any external API.
 *   - Does NOT use a resolved credential.
 *   - Does NOT spawn a subagent or MCP tool call.
 *   - Does NOT validate coverage — that is lib/connectors/coverage.ts.
 *     The caller (SOP Step 2 Validator or SAR-3 bridge) is responsible for
 *     running validateCoverage() before calling persistDiscoveredProfile().
 *
 * The separation of concerns:
 *   coverage.ts   → deterministic validator (pure, no I/O)
 *   onboarding.ts → write path (I/O: DB only, no external network)
 *   catalog.ts    → CRUD layer (upsert/get/list)
 *
 * N10: content_hash is computed by upsertConnectorProfile() via hashCatalogRow().
 * N1:  capability descriptions are stored verbatim — no truncation here.
 *
 * Dependencies: lib/connectors/catalog.ts (assertNonSensitiveProfile, upsertConnectorProfile).
 */

import type { ConnectorCatalogRow } from "@/db/schema/connectors";
import {
  assertNonSensitiveProfile,
  upsertConnectorProfile,
  type ConnectorProfileInput,
} from "./catalog";

// ---------------------------------------------------------------------------
// persistDiscoveredProfile
// ---------------------------------------------------------------------------

/**
 * Persist a discovered connector profile to the platform-global catalog.
 *
 * This is the ACL-4 write path for the SOP "connector-onboarding" (Step 3
 * result, after the Validator approves the profile). It is also callable
 * directly for programmatic onboarding outside the SOP pipeline.
 *
 * Fail-closed PII guard: assertNonSensitiveProfile() runs FIRST.
 * If the profile contains any forbidden key (workspace_id, org_id, user_id,
 * email, token, secret, api_key-value, credential, etc.), this function
 * throws before touching the database. See catalog.ts FORBIDDEN_KEYS for the
 * full list.
 *
 * Idempotent: calling this twice with the same provider and same data produces
 * the same content_hash (N10) and does not create duplicate rows.
 *
 * @param rawProfile - ConnectorProfileInput from the Scribe/Validator step.
 *                     Must NOT contain any PII or credential fields.
 * @returns The persisted ConnectorCatalogRow (with id and content_hash).
 * @throws {Error} with code 'CONNECTOR_PII_GUARD' if profile contains PII.
 */
export function persistDiscoveredProfile(rawProfile: ConnectorProfileInput): ConnectorCatalogRow {
  // 1. PII Hard-Guard (structural, always first — ACL-2 / N2)
  //    assertNonSensitiveProfile also checks nested capability objects.
  assertNonSensitiveProfile(rawProfile as unknown as Record<string, unknown>);

  // 2. Upsert to connector_catalog + connector_capabilities.
  //    upsertConnectorProfile internally re-runs assertNonSensitiveProfile
  //    (double-guard: belt and suspenders). N10 content_hash is computed here.
  return upsertConnectorProfile(rawProfile);
}
