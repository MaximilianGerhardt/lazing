/**
 * Orgs repository (Phase ORG SP-5).
 *
 * DB operations for `organizations` + membership lookups. The service
 * layer (`service.ts`) wraps these with auth + audit.
 */

import { and, asc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  orgMemberships,
  type MembershipRole,
  type OrgMembershipRow,
} from "@/db/schema/memberships";
import { organizations } from "@/db/schema/organizations";
import {
  workspaces as workspacesTable,
  type WorkspaceRow,
} from "@/db/schema/workspaces";
import { users, type UserRow } from "@/db/schema/users";

/* ------------------------------------------------------------------ */
/* Types — extended org with brand/legal fields from migration 0025  */
/* ------------------------------------------------------------------ */

export interface OrgFull {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  paletteIndex: number;
  description: string | null;
  archived: boolean;
  // Brand/legal from migration 0025 + 0033
  logoUrl: string | null;
  wordmarkUrl: string | null;
  brandColors: string[] | null;
  brandVoice: string | null;
  addressLines: string[] | null;
  vatId: string | null;
  imprintMd: string | null;
  responsibleUserId: string | null;
  canonicalDomain: string | null;
  emailFrom: string | null;
  // Phase 2026-04-28 — mandatory legal fields
  legalName: string | null;
  registrationNo: string | null;
  phone: string | null;
  bankIban: string | null;
  bankBic: string | null;
  bankName: string | null;
  responsibleLabel: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawOrgRow {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  palette_index: number;
  description: string | null;
  archived: number;
  logo_url: string | null;
  wordmark_url: string | null;
  brand_colors: string | null;
  brand_voice: string | null;
  address_lines: string | null;
  vat_id: string | null;
  imprint_md: string | null;
  responsible_user_id: string | null;
  canonical_domain: string | null;
  email_from: string | null;
  legal_name: string | null;
  registration_no: string | null;
  phone: string | null;
  bank_iban: string | null;
  bank_bic: string | null;
  bank_name: string | null;
  responsible_label: string | null;
  created_at: number;
  updated_at: number;
}

function rowToOrg(r: RawOrgRow): OrgFull {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id,
    paletteIndex: r.palette_index,
    description: r.description,
    archived: !!r.archived,
    logoUrl: r.logo_url,
    wordmarkUrl: r.wordmark_url,
    brandColors: r.brand_colors ? safeJsonArray(r.brand_colors) : null,
    brandVoice: r.brand_voice,
    addressLines: r.address_lines ? safeJsonArray(r.address_lines) : null,
    vatId: r.vat_id,
    imprintMd: r.imprint_md,
    responsibleUserId: r.responsible_user_id,
    canonicalDomain: r.canonical_domain,
    emailFrom: r.email_from,
    legalName: r.legal_name,
    registrationNo: r.registration_no,
    phone: r.phone,
    bankIban: r.bank_iban,
    bankBic: r.bank_bic,
    bankName: r.bank_name,
    responsibleLabel: r.responsible_label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeJsonArray(raw: string): string[] | null {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function findOrgById(id: string): OrgFull | null {
  const db = getDb();
  const rows = db.$raw
    .prepare("SELECT * FROM organizations WHERE id = ?")
    .all(id) as RawOrgRow[];
  const r = rows[0];
  return r ? rowToOrg(r) : null;
}

export function listAllOrgs(opts?: { includeArchived?: boolean }): OrgFull[] {
  const db = getDb();
  const sqlText = opts?.includeArchived
    ? "SELECT * FROM organizations ORDER BY name"
    : "SELECT * FROM organizations WHERE archived = 0 ORDER BY name";
  const rows = db.$raw.prepare(sqlText).all() as RawOrgRow[];
  return rows.map(rowToOrg);
}

export function listOrgsForUser(userId: string): OrgFull[] {
  const db = getDb();
  const rows = db.$raw
    .prepare(
      `SELECT o.*
       FROM organizations o
       INNER JOIN org_memberships om ON om.org_id = o.id
       WHERE om.user_id = ? AND o.archived = 0
       ORDER BY o.name`,
    )
    .all(userId) as RawOrgRow[];
  return rows.map(rowToOrg);
}

/**
 * Phase IA consolidation 2026-04-29: for the TopNav OrgSwitcher show only the
 * top-level orgs (parent_id IS NULL). Sub-orgs (e.g. Energie
 * Heimat as a customer of Example Company) are
 * visible in /orgs/[id], not in the switcher.
 */
export function listTopLevelOrgsForUser(userId: string): OrgFull[] {
  const db = getDb();
  const rows = db.$raw
    .prepare(
      `SELECT o.*
       FROM organizations o
       INNER JOIN org_memberships om ON om.org_id = o.id
       WHERE om.user_id = ? AND o.archived = 0
         AND o.parent_id IS NULL
       ORDER BY o.name`,
    )
    .all(userId) as RawOrgRow[];
  return rows.map(rowToOrg);
}

/**
 * Phase IA consolidation 2026-04-29: all sub-orgs of a top-level org.
 */
export function listSubOrgs(parentOrgId: string): OrgFull[] {
  const db = getDb();
  const rows = db.$raw
    .prepare(
      `SELECT * FROM organizations
        WHERE parent_id = ? AND archived = 0
        ORDER BY name`,
    )
    .all(parentOrgId) as RawOrgRow[];
  return rows.map(rowToOrg);
}

export function listOrgWorkspaces(orgId: string): WorkspaceRow[] {
  const db = getDb();
  return db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.organizationId, orgId))
    .orderBy(asc(workspacesTable.label))
    .all();
}

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

export interface OrgMemberWithUser {
  membership: OrgMembershipRow;
  user: Pick<UserRow, "id" | "email" | "displayName" | "avatarUrl" | "status">;
}

export function listOrgMembers(orgId: string): OrgMemberWithUser[] {
  const db = getDb();
  const memberships = db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.orgId, orgId))
    .all();
  if (memberships.length === 0) return [];
  const userIds = memberships.map((m) => m.userId);
  const placeholders = userIds.map(() => "?").join(",");
  const userRows = db.$raw
    .prepare(
      `SELECT id, email, display_name, avatar_url, status
       FROM users WHERE id IN (${placeholders})`,
    )
    .all(...userIds) as Array<{
    id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    status: string;
  }>;
  const userMap = new Map(
    userRows.map((u) => [
      u.id,
      {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        status: u.status as UserRow["status"],
      },
    ]),
  );
  return memberships
    .map((m) => {
      const user = userMap.get(m.userId);
      return user ? { membership: m, user } : null;
    })
    .filter((x): x is OrgMemberWithUser => x !== null);
}

export function findUserOrgMembership(
  userId: string,
  orgId: string,
): OrgMembershipRow | null {
  const db = getDb();
  const rows = db
    .select()
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.orgId, orgId),
      ),
    )
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function countFoundersInOrg(orgId: string): number {
  const db = getDb();
  const r = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.role, "founder"),
      ),
    )
    .all();
  return Number(r[0]?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

export interface UpdateOrgBrandInput {
  // Core fields
  name?: string;
  description?: string | null;
  type?: string;
  parentId?: string | null;
  paletteIndex?: number;
  // Brand
  logoUrl?: string | null;
  wordmarkUrl?: string | null;
  brandColors?: string[] | null;
  brandVoice?: string | null;
  addressLines?: string[] | null;
  vatId?: string | null;
  imprintMd?: string | null;
  responsibleUserId?: string | null;
  canonicalDomain?: string | null;
  emailFrom?: string | null;
  legalName?: string | null;
  registrationNo?: string | null;
  phone?: string | null;
  bankIban?: string | null;
  bankBic?: string | null;
  bankName?: string | null;
  responsibleLabel?: string | null;
}

export function updateOrgBrand(orgId: string, patch: UpdateOrgBrandInput): void {
  const db = getDb();
  const now = Date.now();
  const set: Array<{ col: string; value: unknown }> = [];
  // Core fields
  if (patch.name !== undefined && patch.name.trim().length >= 2) {
    set.push({ col: "name", value: patch.name.trim().slice(0, 120) });
  }
  if (patch.description !== undefined) {
    set.push({
      col: "description",
      value: patch.description ? patch.description.slice(0, 2000) : null,
    });
  }
  if (
    patch.type !== undefined &&
    ["company", "client", "product", "tool", "archived", "private"].includes(
      patch.type,
    )
  ) {
    set.push({ col: "type", value: patch.type });
  }
  if (patch.parentId !== undefined) {
    set.push({ col: "parent_id", value: patch.parentId });
  }
  if (
    patch.paletteIndex !== undefined &&
    Number.isInteger(patch.paletteIndex) &&
    patch.paletteIndex >= 0 &&
    patch.paletteIndex < 40
  ) {
    set.push({ col: "palette_index", value: patch.paletteIndex });
  }
  if (patch.logoUrl !== undefined) set.push({ col: "logo_url", value: patch.logoUrl });
  if (patch.wordmarkUrl !== undefined) set.push({ col: "wordmark_url", value: patch.wordmarkUrl });
  if (patch.brandColors !== undefined) {
    set.push({
      col: "brand_colors",
      value: patch.brandColors ? JSON.stringify(patch.brandColors) : null,
    });
  }
  if (patch.brandVoice !== undefined) set.push({ col: "brand_voice", value: patch.brandVoice });
  if (patch.addressLines !== undefined) {
    set.push({
      col: "address_lines",
      value: patch.addressLines ? JSON.stringify(patch.addressLines) : null,
    });
  }
  if (patch.vatId !== undefined) set.push({ col: "vat_id", value: patch.vatId });
  if (patch.imprintMd !== undefined) set.push({ col: "imprint_md", value: patch.imprintMd });
  if (patch.responsibleUserId !== undefined) set.push({ col: "responsible_user_id", value: patch.responsibleUserId });
  if (patch.canonicalDomain !== undefined) set.push({ col: "canonical_domain", value: patch.canonicalDomain });
  if (patch.emailFrom !== undefined) set.push({ col: "email_from", value: patch.emailFrom });
  if (patch.legalName !== undefined) set.push({ col: "legal_name", value: patch.legalName });
  if (patch.registrationNo !== undefined) set.push({ col: "registration_no", value: patch.registrationNo });
  if (patch.phone !== undefined) set.push({ col: "phone", value: patch.phone });
  if (patch.bankIban !== undefined) set.push({ col: "bank_iban", value: patch.bankIban });
  if (patch.bankBic !== undefined) set.push({ col: "bank_bic", value: patch.bankBic });
  if (patch.bankName !== undefined) set.push({ col: "bank_name", value: patch.bankName });
  if (patch.responsibleLabel !== undefined) set.push({ col: "responsible_label", value: patch.responsibleLabel });

  if (set.length === 0) return;
  set.push({ col: "updated_at", value: now });

  const cols = set.map((s) => `${s.col} = ?`).join(", ");
  const stmt = db.$raw.prepare(`UPDATE organizations SET ${cols} WHERE id = ?`);
  stmt.run(...set.map((s) => s.value), orgId);
}

export function updateOrgMembershipRole(
  membershipId: string,
  role: MembershipRole,
): void {
  const db = getDb();
  db.update(orgMemberships)
    .set({ role, updatedAt: new Date() })
    .where(eq(orgMemberships.id, membershipId))
    .run();
}

export function deleteOrgMembership(membershipId: string): void {
  const db = getDb();
  db.delete(orgMemberships)
    .where(eq(orgMemberships.id, membershipId))
    .run();
}

/* ------------------------------------------------------------------ */
/* Brand-inheritance read (for SP-6)                                   */
/* ------------------------------------------------------------------ */

export function findOrgForWorkspace(workspaceId: string): OrgFull | null {
  const db = getDb();
  const r = db.$raw
    .prepare(
      `SELECT o.*
       FROM organizations o
       INNER JOIN workspaces w ON w.organization_id = o.id
       WHERE w.id = ?
       LIMIT 1`,
    )
    .get(workspaceId) as RawOrgRow | undefined;
  return r ? rowToOrg(r) : null;
}
