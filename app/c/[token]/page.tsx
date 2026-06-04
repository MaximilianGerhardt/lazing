/**
 * /c/[token] — öffentliche externe Sub-Chat-Seite (Gathering-Intelligence-Goal).
 *
 * Public (middleware PUBLIC_PREFIXES `/c/`). Kein Login — der Token autorisiert.
 * Reine Shell; die Client-Komponente lädt + postet via /api/subchats/external/.
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
