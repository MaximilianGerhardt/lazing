/**
 * Null-Email-Provider (Phase ORG SP-4).
 *
 * Default in dev: only logs the send, sends nothing. Makes magic-link
 * tests possible without a Resend account or DNS setup. The `verifyUrl`
 * token is visible in the server log — dev can copy-paste it.
 */

import type {
  EmailProvider,
  EmailSendInput,
  EmailSendResult,
} from "../types";

export const nullProvider: EmailProvider = {
  name: "null",
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    console.log(
      "[email/null] would send",
      JSON.stringify(
        {
          to: input.to,
          template: input.template,
          vars: input.vars,
          replyTo: input.replyTo,
        },
        null,
        2,
      ),
    );
    return {
      ok: true,
      provider: "null",
      messageId: `null-${Date.now()}`,
    };
  },
};
