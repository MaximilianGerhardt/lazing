/**
 * Connector Capability Coverage Validator — ACL-4 · 2026-05-24.
 *
 * Public API:
 *   validateCoverage(requiredCapabilities, profile) → CoverageResult
 *   detectVersionDrift(declaredVersion, profileVersion)  → boolean
 *
 * Design principles:
 *
 *  N6 (Deterministic validators precede symbolic reasoning):
 *    Both functions are PURE and deterministic. Given the same inputs they
 *    always return the same output. No I/O, no LLM, no randomness.
 *    The caller (SOP Step 2 Validator, SAR-3 plan bridge) MUST invoke
 *    validateCoverage() BEFORE any LLM-based reasoning on the profile.
 *
 *  Fail-closed semantics (why, by design):
 *    - If `profile` is null/undefined/empty → ok: false.
 *      Rationale: an absent or empty profile means we have no verified knowledge
 *      of what the connector can do. Permitting a workflow to run against an
 *      unknown profile would silently skip the coverage gate — an invisible
 *      failure mode that is worse than an explicit one.
 *    - If any required capability is not present in the profile → ok: false.
 *      Rationale: a missing required capability means the connector cannot
 *      fulfill its declared purpose for the calling workflow. The workflow
 *      would fail at runtime, potentially mid-execution, with partial side
 *      effects. Fail-closed at planning time is safer.
 *    - If requiredCapabilities is non-empty but profile.capabilities is empty
 *      or undefined → ok: false (special case of the above).
 *    - Extra capabilities in the profile (present but not required) are noted
 *      in result.extra[] but do NOT affect ok. They are informational.
 *
 *  N10 (Tamper-evidence):
 *    This module does NOT compute hashes — that is catalog.ts's concern.
 *    The profile passed here should already have been fetched via
 *    getConnectorProfile() which returns a ConnectorCatalogRow (with its
 *    content_hash intact). The caller is responsible for hash verification
 *    if tamper-evidence is needed before validation.
 *
 * Dependencies: NONE (pure, zero imports beyond type-only).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal profile shape required by the validator.
 *
 * Intentionally NOT tied to ConnectorCatalogRow + ConnectorCapabilityRow so
 * that the validator can be used in contexts where capabilities are inlined
 * (e.g. during onboarding before a DB round-trip).
 */
export type ValidatableProfile = {
  /** Provider slug, e.g. 'heygen'. */
  provider: string;
  /** Semver or date-string API version, e.g. 'v2' or '2024-01-01'. */
  apiVersion?: string | null;
  /** Capability names this profile declares. */
  capabilities?: ReadonlyArray<{ name: string }> | null;
};

/**
 * Result of validateCoverage().
 *
 * ok = true only when ALL of the following hold:
 *   1. profile is non-null and non-empty (has ≥1 capability).
 *   2. Every string in requiredCapabilities is present in profile.capabilities.
 *
 * missing[] — capabilities in requiredCapabilities not found in profile.
 * extra[]   — capabilities in profile not present in requiredCapabilities.
 *             These are informational; they do NOT affect ok.
 * versionMatch — true if the caller did not declare a version to check, OR
 *                if profile.apiVersion matches the checked version exactly.
 *                versionMatch: false is informational here (it does NOT affect ok).
 *                Use detectVersionDrift() for a hard version-drift check.
 */
export type CoverageResult = {
  /** true only when all required capabilities are present in the profile. */
  ok: boolean;
  /** Required capabilities missing from the profile. Empty when ok=true. */
  missing: string[];
  /** Profile capabilities not in the required set. Always informational. */
  extra: string[];
  /**
   * Whether the profile's apiVersion matches the version that was checked.
   * Always true when no version was passed to validateCoverage().
   * Informational only — does NOT affect ok. Call detectVersionDrift() for
   * a hard gate.
   */
  versionMatch: boolean;
};

// ---------------------------------------------------------------------------
// validateCoverage
// ---------------------------------------------------------------------------

/**
 * Validate that all required capabilities are declared in a connector profile.
 *
 * Fail-closed: returns ok=false whenever:
 *  - profile is null or undefined.
 *  - profile.capabilities is null, undefined, or empty.
 *  - requiredCapabilities is non-empty AND any required capability is absent.
 *
 * Note: if requiredCapabilities is empty, ok=true (vacuously satisfied) as
 * long as the profile itself is non-null. An empty requirement set means
 * "any profile will do".
 *
 * @param requiredCapabilities - Capability names the caller needs.
 * @param profile              - Profile fetched from the connector catalog.
 *                               Accepts null/undefined for fail-closed guard.
 * @param checkVersion         - Optional version string to compare against
 *                               profile.apiVersion. Only affects versionMatch
 *                               in the result — does NOT affect ok.
 */
export function validateCoverage(
  requiredCapabilities: readonly string[],
  profile: ValidatableProfile | null | undefined,
  checkVersion?: string,
): CoverageResult {
  // ── Fail-closed: absent profile ────────────────────────────────────────────
  if (profile == null) {
    return {
      ok: false,
      missing: [...requiredCapabilities],
      extra: [],
      versionMatch: checkVersion == null ? true : false,
    };
  }

  // ── Build profile capability set ──────────────────────────────────────────
  const profileCaps: ReadonlyArray<{ name: string }> = profile.capabilities ?? [];

  // Fail-closed: non-empty requirements against an empty profile → ok: false
  if (requiredCapabilities.length > 0 && profileCaps.length === 0) {
    return {
      ok: false,
      missing: [...requiredCapabilities],
      extra: [],
      versionMatch: computeVersionMatch(profile.apiVersion, checkVersion),
    };
  }

  const profileNameSet = new Set(profileCaps.map((c) => c.name));
  const requiredSet = new Set(requiredCapabilities);

  // Missing: required but not in profile
  const missing = requiredCapabilities.filter((cap) => !profileNameSet.has(cap));

  // Extra: in profile but not required (informational)
  const extra = profileCaps.map((c) => c.name).filter((name) => !requiredSet.has(name));

  const versionMatch = computeVersionMatch(profile.apiVersion, checkVersion);

  return {
    ok: missing.length === 0,
    missing,
    extra,
    versionMatch,
  };
}

// ---------------------------------------------------------------------------
// detectVersionDrift
// ---------------------------------------------------------------------------

/**
 * Detect API version drift between what a SOP/workflow was written against
 * and what the current connector profile declares.
 *
 * Returns true when drift is detected (versions differ and are both non-null).
 * Returns false when:
 *   - either version string is null/undefined/empty (no drift detectable — the
 *     caller should treat this as a missing-version warning, not a hard block,
 *     but detectVersionDrift() itself does not make that policy decision).
 *   - the version strings are identical.
 *
 * Semantics: drift=true means the profile's declared API version has changed
 * relative to the version the calling SOP/workflow was written against.
 * The CALLER must decide whether drift=true is a hard block or a warning.
 * The convention in ACL-4 / ACL-5 is: drift=true → fail-closed (do not invoke
 * the API without a re-validation run with the new version).
 *
 * @param declaredVersion  - The version the SOP/workflow was authored against.
 *                           e.g. 'v1', '2024-01-01'.
 * @param profileVersion   - The version currently in the connector profile.
 *                           Typically profile.apiVersion from getConnectorProfile().
 */
export function detectVersionDrift(
  declaredVersion: string | null | undefined,
  profileVersion: string | null | undefined,
): boolean {
  if (!declaredVersion || !profileVersion) {
    // One or both versions unknown — cannot confirm drift, cannot confirm match.
    // Return false (no detected drift) but callers should log this as a warning.
    return false;
  }

  // Exact string comparison — no semver parsing needed because API versions
  // are opaque strings in the catalog (e.g. 'v1', 'v2', '2024-01-01', '2').
  // The convention is: any change in the declared version string signals drift.
  return declaredVersion.trim() !== profileVersion.trim();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compare the profile version against an optional checkVersion.
 * Returns true when no checkVersion was provided (vacuous match),
 * or when the versions are identical.
 */
function computeVersionMatch(
  profileVersion: string | null | undefined,
  checkVersion: string | undefined,
): boolean {
  if (checkVersion == null) return true;
  if (!profileVersion) return false;
  return profileVersion.trim() === checkVersion.trim();
}
