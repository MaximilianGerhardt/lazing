/**
 * Magic-Login-Email-Template (Phase ORG SP-4).
 *
 * Triggered by `/api/auth/magic/issue` when intent='login'.
 * Plain HTML inline-styled (no React-Email for phase 1, overkill).
 */

import type { RenderedTemplate } from "../types";
import { BRAND_NAME } from "@/lib/brand";

export interface MagicLoginVars {
  displayName: string;
  verifyUrl: string;
  expiresInMin: number;
  ipHint?: string;
}

export function renderMagicLogin(v: MagicLoginVars): RenderedTemplate {
  const subject = `Dein ${BRAND_NAME}-Login-Link`;
  const text =
    `Hi ${v.displayName},\n\n` +
    `klicke diesen Link um dich bei ${BRAND_NAME} einzuloggen (gültig ${v.expiresInMin} Minuten):\n\n` +
    `${v.verifyUrl}\n\n` +
    (v.ipHint
      ? `Anfrage von IP ${v.ipHint}. Wenn du das nicht warst, ignorier die Mail.\n\n`
      : `Wenn du das nicht warst, ignorier die Mail.\n\n`) +
    `— ${BRAND_NAME}`;

  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; background:#0a0a0a; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:#e6e6e6;">
  <div style="max-width:520px; margin:40px auto; padding:32px; background:#111; border-radius:14px; border:1px solid #1f1f1f;">
    <div style="font-size:20px; font-weight:600; letter-spacing:-0.01em; margin-bottom:24px;">${escapeHtml(BRAND_NAME)}</div>
    <h1 style="font-size:18px; font-weight:500; margin:0 0 16px; color:#ffffff;">Hi ${escapeHtml(v.displayName)},</h1>
    <p style="font-size:14px; line-height:1.55; color:#cccccc; margin:0 0 24px;">
      klicke diesen Link um dich einzuloggen. Der Link ist <strong>${v.expiresInMin} Minuten</strong> gültig und kann nur einmal verwendet werden.
    </p>
    <div style="text-align:center; margin:32px 0;">
      <a href="${escapeAttr(v.verifyUrl)}"
         style="display:inline-block; padding:12px 28px; background:#3b82f6; color:#ffffff; text-decoration:none; border-radius:8px; font-size:14px; font-weight:500;">
        In ${escapeHtml(BRAND_NAME)} einloggen
      </a>
    </div>
    <p style="font-size:12px; line-height:1.5; color:#888; margin:24px 0 0;">
      Falls der Button nicht funktioniert, kopier diese URL in deinen Browser:<br>
      <span style="font-family:ui-monospace,Menlo,monospace; word-break:break-all; color:#aaa;">${escapeHtml(v.verifyUrl)}</span>
    </p>
    ${v.ipHint ? `<p style="font-size:11px; color:#666; margin:24px 0 0;">Anfrage von IP ${escapeHtml(v.ipHint)}. Wenn du das nicht warst, ignorier die Mail.</p>` : ""}
  </div>
</body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
