/**
 * Workspace-Invite-Email-Template (Phase ORG SP-4).
 * Guest variant: user is assigned to a workspace without org membership.
 */

import type { RenderedTemplate } from "../types";
import { BRAND_NAME } from "@/lib/brand";

export interface WorkspaceInviteVars {
  displayName: string;
  inviterName: string;
  workspaceLabel: string;
  role: string;
  verifyUrl: string;
  expiresInMin: number;
}

export function renderWorkspaceInvite(v: WorkspaceInviteVars): RenderedTemplate {
  const subject = `${v.inviterName} teilt ${v.workspaceLabel} mit dir`;
  const text =
    `Hi ${v.displayName},\n\n` +
    `${v.inviterName} hat dir Zugriff auf den Workspace "${v.workspaceLabel}" ` +
    `als ${v.role} gegeben.\n\n` +
    `Klicke um den Workspace zu öffnen (Link gültig ${v.expiresInMin} Min):\n\n` +
    `${v.verifyUrl}\n\n— ${BRAND_NAME}`;

  const html = `<!doctype html>
<html lang="de">
<body style="margin:0; padding:0; background:#0a0a0a; font-family:system-ui,sans-serif; color:#e6e6e6;">
  <div style="max-width:520px; margin:40px auto; padding:32px; background:#111; border-radius:14px; border:1px solid #1f1f1f;">
    <div style="font-size:20px; font-weight:600; margin-bottom:24px;">${escapeHtml(BRAND_NAME)}</div>
    <h1 style="font-size:18px; margin:0 0 16px; color:#fff;">Workspace freigegeben</h1>
    <p style="font-size:14px; line-height:1.55; color:#ccc;">
      <strong>${escapeHtml(v.inviterName)}</strong> hat dir Zugriff auf den Workspace
      <strong>${escapeHtml(v.workspaceLabel)}</strong> als <strong>${escapeHtml(v.role)}</strong> gegeben.
    </p>
    <div style="text-align:center; margin:32px 0;">
      <a href="${escapeAttr(v.verifyUrl)}" style="display:inline-block; padding:12px 28px; background:#3b82f6; color:#fff; text-decoration:none; border-radius:8px;">
        Workspace öffnen
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
