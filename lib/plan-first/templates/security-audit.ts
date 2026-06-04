// Plan template — security-audit (4 steps).
//
// BACKPORT-03 from Lazing-V2 (2026-05-23). Bytewise identical to the V2 source.
//
// Threat-model → static-audit → fix → re-audit. Matches security /
// auth / CVE / vuln / "harden" intents.

import type { PlanTemplate } from './index';

export const SECURITY_AUDIT_REGEX =
  /\b(security|secure|harden|hardening|audit\s+(?:the\s+)?(?:code|repo|auth|deps)|cve|vuln(?:erability|erable)?|sql\s*injection|xss|csrf|prüfe?\s+(?:auf\s+)?(?:sicherheit|security))\b/i;

export const securityAuditTemplate: PlanTemplate = {
  id: 'security-audit',
  label: 'Security audit (threat-model → static → fix → re-audit)',
  estimatedComplexity: 'L',
  steps: [
    {
      index: 1,
      title: 'Threat-model the affected surface',
      rationale:
        'Enumerate the trust boundaries, untrusted inputs, and high-value assets; record assumptions so reviewers can challenge them.',
      subagentRole: 'architect',
    },
    {
      index: 2,
      title: 'Run static checks + manual code review',
      rationale:
        'Use the relevant scanner (semgrep / cargo-audit / npm-audit / etc.) AND a manual reading pass — automated tools miss intent-level flaws.',
      subagentRole: 'reviewer',
    },
    {
      index: 3,
      title: 'Apply scoped fixes for each finding',
      rationale:
        'One commit per finding so each fix is reviewable in isolation; reference the threat-model entry in the commit body.',
      subagentRole: 'coder',
    },
    {
      index: 4,
      title: 'Re-audit + sign off',
      rationale:
        'Re-run the static checks, re-read the surface against the threat model; produce a short sign-off note listing accepted residual risks.',
      subagentRole: 'reviewer',
    },
  ],
};
