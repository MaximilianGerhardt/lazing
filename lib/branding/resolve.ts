/**
 * Brand-Inheritance-Resolver (Phase ORG SP-6).
 *
 * Reads org and workspace branding and maps them into a
 * `ResolvedBrand` output with a per-field source marker (organization /
 * workspace / system / none).
 *
 * Inheritance rule per field:
 *   1. Workspace value → source='workspace'
 *   2. Org value       → source='organization'
 *   3. System default  → source='system'
 *   4. Otherwise null  → source='none'
 *
 * Special:
 *   - imprintMd, addressLines, vatId, responsiblePerson, canonicalDomain
 *     live ONLY on the org. There is no WS override.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { workspaces } from "@/db/schema/workspaces";
import { findOrgById, findOrgForWorkspace, type OrgFull } from "@/lib/orgs/repo";

export type BrandSource = "organization" | "workspace" | "system" | "none";

export interface ResolvedBrand {
  logoUrl: string | null;
  logoSource: BrandSource;
  wordmarkUrl: string | null;
  wordmarkSource: BrandSource;
  brandColors: string[];
  brandColorsSource: BrandSource;
  brandVoice: string | null;
  brandVoiceSource: BrandSource;
  emailSignature: string | null;
  emailSignatureSource: BrandSource;
  /** Nur Org-Ebene. */
  imprintMd: string | null;
  addressLines: string[];
  vatId: string | null;
  canonicalDomain: string | null;
  emailFrom: string | null;
  /** Optional: resolved responsible user. The caller fleshes this out itself. */
  responsibleUserId: string | null;
  /** Org reference: id and name (for the PDF header etc.). */
  orgId: string | null;
  orgName: string | null;
  /** Workspace reference. */
  workspaceId: string | null;
  workspaceLabel: string | null;
}

const SYSTEM_LOGO = "/icon.svg";
const SYSTEM_BRAND_COLORS: string[] = ["#070707", "#ffffff"];

interface WorkspaceBrandRow {
  id: string;
  label: string;
  organizationId: string | null;
  logoUrl: string | null;
  wordmarkUrl: string | null;
  brandColors: string | null;
  brandVoice: string | null;
  emailSignature: string | null;
}

function readWorkspace(workspaceId: string): WorkspaceBrandRow | null {
  const db = getDb();
  const rows = db
    .select({
      id: workspaces.id,
      label: workspaces.label,
      organizationId: workspaces.organizationId,
      logoUrl: workspaces.logoUrl,
      wordmarkUrl: workspaces.wordmarkUrl,
      brandColors: workspaces.brandColors,
      brandVoice: workspaces.brandVoice,
      emailSignature: workspaces.emailSignature,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

function parseColors(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      const out = v
        .map((c) => String(c))
        .filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c));
      return out.length > 0 ? out : null;
    }
  } catch {
    // ignore
  }
  return null;
}

interface ResolveInput {
  /** If only orgId is given: resolve only the org brand. */
  orgId?: string | null;
  /** If workspaceId: the org is looked up automatically via FK. */
  workspaceId?: string | null;
}

export function resolveBrand(input: ResolveInput): ResolvedBrand {
  const ws = input.workspaceId ? readWorkspace(input.workspaceId) : null;
  let org: OrgFull | null = null;
  if (ws?.organizationId) {
    org = findOrgById(ws.organizationId);
  } else if (input.workspaceId) {
    org = findOrgForWorkspace(input.workspaceId);
  } else if (input.orgId) {
    org = findOrgById(input.orgId);
  }

  // Field-by-field-Resolution.
  const wsColors = parseColors(ws?.brandColors);
  const orgColors = org?.brandColors ?? null;

  const out: ResolvedBrand = {
    // Logo
    logoUrl: null,
    logoSource: "none",
    wordmarkUrl: null,
    wordmarkSource: "none",
    brandColors: SYSTEM_BRAND_COLORS,
    brandColorsSource: "system",
    brandVoice: null,
    brandVoiceSource: "none",
    emailSignature: null,
    emailSignatureSource: "none",
    imprintMd: org?.imprintMd ?? null,
    addressLines: org?.addressLines ?? [],
    vatId: org?.vatId ?? null,
    canonicalDomain: org?.canonicalDomain ?? null,
    emailFrom: org?.emailFrom ?? null,
    responsibleUserId: org?.responsibleUserId ?? null,
    orgId: org?.id ?? null,
    orgName: org?.name ?? null,
    workspaceId: ws?.id ?? null,
    workspaceLabel: ws?.label ?? null,
  };

  // Logo
  if (ws?.logoUrl) {
    out.logoUrl = ws.logoUrl;
    out.logoSource = "workspace";
  } else if (org?.logoUrl) {
    out.logoUrl = org.logoUrl;
    out.logoSource = "organization";
  } else {
    out.logoUrl = SYSTEM_LOGO;
    out.logoSource = "system";
  }

  // Wordmark
  if (ws?.wordmarkUrl) {
    out.wordmarkUrl = ws.wordmarkUrl;
    out.wordmarkSource = "workspace";
  } else if (org?.wordmarkUrl) {
    out.wordmarkUrl = org.wordmarkUrl;
    out.wordmarkSource = "organization";
  } else {
    out.wordmarkUrl = null;
    out.wordmarkSource = "none";
  }

  // Brand-Colors
  if (wsColors) {
    out.brandColors = wsColors;
    out.brandColorsSource = "workspace";
  } else if (orgColors && orgColors.length > 0) {
    out.brandColors = orgColors;
    out.brandColorsSource = "organization";
  } else {
    out.brandColors = SYSTEM_BRAND_COLORS;
    out.brandColorsSource = "system";
  }

  // Brand voice (today WS only, Phase ORG+1: org too)
  if (ws?.brandVoice) {
    out.brandVoice = ws.brandVoice;
    out.brandVoiceSource = "workspace";
  } else if (org?.brandVoice) {
    out.brandVoice = org.brandVoice;
    out.brandVoiceSource = "organization";
  }

  // Email signature (WS only today)
  if (ws?.emailSignature) {
    out.emailSignature = ws.emailSignature;
    out.emailSignatureSource = "workspace";
  }

  return out;
}
