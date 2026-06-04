/**
 * Server-side web-push singleton.
 * Configures VAPID once on first call.
 * Throws explicitly when env vars are missing — better than silent 500s.
 */
import webpush from "web-push";

let configured = false;

export function getPushClient(): typeof webpush {
  if (!configured) {
    const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!pub || !priv || !subject) {
      throw new Error(
        "Web-Push-Env unvollstaendig. NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT erforderlich.",
      );
    }
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  }
  return webpush;
}
