/**
 * Org-Invite-Email-Template (Phase ORG SP-4).
 */

import type { RenderedTemplate } from "../types";
import { BRAND_NAME } from "@/lib/brand";

export interface OrgInviteVars {
  displayName: string;
  inviterName: string;
  orgName: string;
  role: string;
  verifyUrl: string;
  expiresInMin: number;
}

export function renderOrgInvite(v: OrgInviteVars): RenderedTemplate {
  const subject = `${v.inviterName} hat dich zu ${v.orgName} eingeladen`;
  const text =
    `Hi ${v.displayName},\n\n` +
    `${v.inviterName} hat dich zu der Organisation "${v.orgName}" eingeladen ` +
    `(Rolle: ${v.role}).\n\n` +
    `Klicke diesen Link um die Einladung anzunehmen (gültig ${v.expiresInMin} Min):\n\n` +
    `${v.verifyUrl}\n\n` +
    `Wenn du diese Einladung nicht erwartest, ignorier die Mail.\n\n— ${BRAND_NAME}`;

  const html = `<!doctype html>
<html lang="de">
<body style="margin:0; padding:0; background:#0a0a0a; font-family:system-ui,sans-serif; color:#e6e6e6;">
  <div style="max-width:520px; margin:40px auto; padding:32px; background:#111; border-radius:14px; border:1px solid #1f1f1f;">
    <div style="font-size:20px; font-weight:600; margin-bottom:24px;">${escapeHtml(BRAND_NAME)}</div>
    <h1 style="font-size:18px; margin:0 0 16px; color:#fff;">Einladung zu ${escapeHtml(v.orgName)}</h1>
    <p style="font-size:14px; line-height:1.55; color:#ccc;">
      <strong>${escapeHtml(v.inviterName)}</strong> hat dich als <strong>${escapeHtml(v.role)}</strong> in die Organisation
      <strong>${escapeHtml(v.orgName)}</strong> eingeladen.
    </p>
    <div style="text-align:center; margin:32px 0;">
      <a href="${escapeAttr(v.verifyUrl)}" style="display:inline-block; padding:12px 28px; background:#3b82f6; color:#fff; text-decoration:none; border-radius:8px;">
        Einladung annehmen
      </a>
    </div>
    <p style="font-size:11px; color:#666;">Gültig ${v.expiresInMin} Minuten. Single-Use.</p>
  </div>
</body>
</html>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
