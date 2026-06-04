/**
 * Email-Adapter-Interface (Phase ORG SP-4 — 2026-04-27).
 *
 * Single Provider-Interface; Implementierungen in `providers/`.
 *
 * Provider-Switch via env `LAZYOS_EMAIL_PROVIDER`:
 *   - `null` (Default in dev) → loggt nur, sendet nicht
 *   - `resend` → POST https://api.resend.com/emails (EU-Region opt-in)
 *
 * GDPR: recommend Resend in the EU region; the DPA is held by Resend.
 * Email = Art. 6(1)(b) contract fulfillment at login. IP/UA logging
 * only on auth actions (audit layer).
 */

export type EmailTemplate =
  | "magic-login"
  | "org-invite"
  | "workspace-invite";

export interface EmailSendInput {
  to: string;
  template: EmailTemplate;
  vars: Record<string, unknown>;
  /** Optional Reply-To-Header. */
  replyTo?: string;
  /** Optional Override des From-Felds (z.B. Org-spezifisch in Phase-3). */
  fromOverride?: string;
}

export interface EmailSendResult {
  ok: boolean;
  /** Provider-Message-ID, falls erfolgreich. */
  messageId?: string;
  /** Provider: "resend" | "null". */
  provider: string;
  /** Bei Fehler: kurze Beschreibung. */
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

/** Render-Output einer Template-Funktion. */
export interface RenderedTemplate {
  subject: string;
  text: string;
  html: string;
}
