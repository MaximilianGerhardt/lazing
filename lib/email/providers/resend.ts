/**
 * Resend email provider (Phase ORG SP-4).
 *
 * Native fetch to the Resend HTTP API — no npm package. Bundle size
 * minimal, runtime-agnostic (Node + Edge).
 *
 * env configuration:
 *   - LAZYOS_RESEND_API_KEY  — required
 *   - LAZYOS_EMAIL_FROM      — default-from override, e.g. `laz.ing <noreply@mail.example.com>`
 *                              (default comes from @/lib/brand BRAND_EMAIL_FROM_DEFAULT)
 *   - LAZYOS_RESEND_REGION   — optional, "eu-west-1" for the GDPR region
 *
 * GDPR: Resend offers an EU region (Frankfurt) + DPA. For Phase ORG
 * we configure the EU region via the `region` param of the Resend API.
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
    // Accepts both: RESEND_API_KEY (standard convention) and
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

    // Rendering happens in the send pipeline (lib/email/send.ts) — here
    // the rendered content comes in via input.vars.__rendered.
    // (Trick: the send pipeline renders ahead of time and stuffs the result
    //  through.) We read it strictly here.
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
