import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { sql, eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { users } from '@/db/schema/users';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { isOssMode } from '@/lib/onboarding/oss-mode';
import { ChatsOverviewClient } from './ChatsOverviewClient';

export const dynamic = 'force-dynamic';

/**
 * Authoritative DB backstop for the OSS first-run gate — IDENTICAL to the one
 * in `app/page.tsx:31` (ossFirstRunBackstop). Security acceptance criterion
 * (IA-realign critic): a new top-level route must NOT rely on the Edge cookie
 * check alone. The middleware does the cheap cookie redirect, but a cleared /
 * forged `lazyos_onboarded` cookie would slip past it — so we re-check
 * `oss_onboarding_completed_at` in the DB and redirect to the wizard if it has
 * never completed. Cheap single-row read; only runs when OSS mode is enabled.
 *
 * Without this, a forged cookie could serve `/chats` (a customer-chat surface)
 * while `/` would still redirect — an isolation/onboarding-bypass hole.
 */
async function ossFirstRunBackstop(): Promise<void> {
  if (!isOssMode()) return;
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) return; // unauthenticated — middleware handles login redirect
  const db = getDb();
  const row = db
    .select({ done: sql<number | null>`oss_onboarding_completed_at` })
    .from(users)
    .where(eq(users.id, userId))
    .all()[0];
  if (!row?.done) {
    redirect('/oss-onboarding');
  }
}

/**
 * /chats — the WhatsApp-style chat OVERVIEW (mobile-IA realign 2026-06-06).
 *
 * The new home of the Chat tab. A list of chats with two sections:
 *   1. Communities — chats GROUPED by Org/Workspace (reuses the shared
 *      `groupCommunityNodes` algorithm that backs the drawer's "Kunden"
 *      section, so the two surfaces cannot drift).
 *   2. Recent chats (flat) — the most-recent conversations across workspaces
 *      (main chats + sub-chats), newest first, with a last-message scent.
 *
 * `/workspaces` becomes purely "workspace settings" — no longer the de-facto
 * chat entry (Bug A fix). The active conversation is reachable as a row here.
 *
 * Server component: just the onboarding guard + the client list. All data
 * (workspaces, orgs, activity) is fetched client-side via the existing hooks /
 * `/api/subchats/activity`, same as the drawer (member-gated per N2/N9).
 */
export default async function ChatsOverviewPage(): Promise<React.JSX.Element> {
  await ossFirstRunBackstop();
  return <ChatsOverviewClient />;
}
