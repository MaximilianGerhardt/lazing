/**
 * /c/[token] — public external sub-chat page (gathering-intelligence goal).
 *
 * Public (middleware PUBLIC_PREFIXES `/c/`). No login — the token authorizes.
 * Pure shell; the client component loads + posts via /api/subchats/external/.
 */

import type { Metadata } from 'next';

import { ExternalSubchat } from './ExternalSubchat';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Projekt-Chat · laz.ing',
  robots: { index: false, follow: false },
};

export default async function ExternalSubchatPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.ReactElement> {
  const { token } = await params;
  return <ExternalSubchat token={token} />;
}
