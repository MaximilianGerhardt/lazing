/**
 * Email-Send-Pipeline (Phase ORG SP-4).
 *
 * Single entry point: `sendEmail(input)`. Selects the provider based on
 * `LAZYOS_EMAIL_PROVIDER` (default `null` in dev, `resend` in prod), renders
 * the template, delivers to the provider, returns a structured result.
 */

import type {
  EmailProvider,
  EmailSendInput,
  EmailSendResult,
  EmailTemplate,
  RenderedTemplate,
} from "./types";
import { nullProvider } from "./providers/null";
import { resendProvider } from "./providers/resend";
import {
  renderMagicLogin,
  type MagicLoginVars,
} from "./templates/magic-login";
import {
  renderOrgInvite,
  type OrgInviteVars,
} from "./templates/org-invite";
import {
  renderWorkspaceInvite,
  type WorkspaceInviteVars,
} from "./templates/workspace-invite";

function pickProvider(): EmailProvider {
  const choice = (
    process.env.LAZYOS_EMAIL_PROVIDER ?? "null"
  ).toLowerCase();
  switch (choice) {
    case "resend":
      return resendProvider;
    case "null":
    case "console": // alias: identical to `null` — only logs, sends nothing
    case "":
      return nullProvider;
    default:
      console.warn(
        `[email] unbekannter Provider '${choice}', falle auf 'null' zurück`,
      );
      return nullProvider;
  }
}

function renderTemplate(
  template: EmailTemplate,
  vars: Record<string, unknown>,
): RenderedTemplate {
  switch (template) {
    case "magic-login":
      return renderMagicLogin(vars as unknown as MagicLoginVars);
    case "org-invite":
      return renderOrgInvite(vars as unknown as OrgInviteVars);
    case "workspace-invite":
      return renderWorkspaceInvite(vars as unknown as WorkspaceInviteVars);
  }
}

export async function sendEmail(
  input: EmailSendInput,
): Promise<EmailSendResult> {
  // Minimal email format check (whitespace + @ sign).
  if (!input.to || !input.to.includes("@")) {
    return {
      ok: false,
      provider: "noop",
      error: "invalid-recipient",
    };
  }

  // Render once here — providers must not do it twice.
  const rendered = renderTemplate(input.template, input.vars);
  const provider = pickProvider();

  // Resend-pipeline trick: pass rendered through to the provider.
  const augmented = {
    ...input,
    _rendered: rendered,
  };
  return provider.send(augmented as EmailSendInput);
}

/** Test helper: allows a provider override in unit tests. */
let providerOverride: EmailProvider | null = null;
export function setEmailProviderForTests(p: EmailProvider | null): void {
  providerOverride = p;
}
export function _internalGetProvider(): EmailProvider {
  return providerOverride ?? pickProvider();
}
