/**
 * Resend-Email-Provider (Phase ORG SP-4).
 *
 * Native fetch zur Resend HTTP-API — kein npm-Package. Bundle-Size
 * minimal, runtime-agnostic (Node + Edge).
 *
 * env-Konfiguration:
 *   - LAZYOS_RESEND_API_KEY  — Pflicht
 *   - LAZYOS_EMAIL_FROM      — Default-From-Override, z.B. `laz.ing <noreply@mail.example.com>`
 *                              (Default kommt aus @/lib/brand BRAND_EMAIL_FROM_DEFAULT)
 *   - LAZYOS_RESEND_REGION   — optional, "eu-west-1" für DSGVO-Region
 *
 * DSGVO: Resend bietet EU-Region (Frankfurt) + AVV. Für Phase ORG
 * konfigurieren wir EU-Region per `region`-Param der Resend-API.
 */

import type {
  EmailProvider,
  EmailSendInput,
  EmailSendResult,
  RenderedTemplate,
} from "../types";
import { BRAND_EMAIL_FROM_DEFAULT } from "@/lib/brand";

const RESEND_API_URL = "https://api.resend.com/emails";

export const resendProvider: EmailProvider = {
  name: "resend",
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    // Akzeptiert beide: RESEND_API_KEY (Standard-Convention) und
    // LAZYOS_RESEND_API_KEY (legacy SP-4).
    const apiKey =
      process.env.RESEND_API_KEY?.trim() ||
      process.env.LAZYOS_RESEND_API_KEY?.trim();
    const fromDefault =
      process.env.LAZYOS_EMAIL_FROM?.trim() || BRAND_EMAIL_FROM_DEFAULT;
    if (!apiKey) {
      return {
        ok: false,
        provider: "resend",
        error: "RESEND_API_KEY (or LAZYOS_RESEND_API_KEY) not set",
      };
    }

    // Render passiert in der Send-Pipeline (lib/email/send.ts) — hier
    // kommt der gerenderte Inhalt via input.vars.__rendered rein.
    // (Trick: Send-Pipeline rendert vorab und stopft das Ergebnis
    //  durch.) Wir lesen es hier strikt.
    const rendered = (input as unknown as { _rendered?: RenderedTemplate })
      ._rendered;
    if (!rendered) {
      return {
        ok: false,
        provider: "resend",
        error: "internal: missing _rendered template payload",
      };
    }

    const body: Record<string, unknown> = {
      from: input.fromOverride ?? fromDefault,
      to: [input.to],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    };
    if (input.replyTo) body.reply_to = input.replyTo;
    const region = process.env.LAZYOS_RESEND_REGION?.trim();
    if (region) body.region = region;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    let res: Response;
    try {
      res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        provider: "resend",
        error: err instanceof Error ? err.message : "network",
      };
    }
    clearTimeout(timer);

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        ok: false,
        provider: "resend",
        error: `HTTP ${res.status}: ${txt.slice(0, 200)}`,
      };
    }
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
    };
    return {
      ok: true,
      provider: "resend",
      messageId: json.id,
    };
  },
};
