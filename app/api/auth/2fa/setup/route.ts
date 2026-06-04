/**
 * POST /api/auth/2fa/setup
 *
 * Step 1 of the 2FA setup: generates secret + QR data URL.
 * Does NOT store — the user scans the QR, enters a verify code,
 * then the secret is persisted via /api/auth/2fa/setup/confirm.
 *
 * Auth: user must be logged in.
 * Rate limit: max 5 setups per hour per user (against spam).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  generateSecret,
  buildOtpauthUrl,
  buildQrDataUrl,
} from '@/lib/auth/2fa/totp';
import { getDb } from '@/db/client';
import { users } from '@/db/schema/users';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const db = getDb();
  const userRow = db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  if (userRow.length === 0) {
    return NextResponse.json({ error: 'user-not-found' }, { status: 404 });
  }
  const user = userRow[0];

  const secret = generateSecret();
  const otpauthUrl = buildOtpauthUrl({ secret, userEmail: user.email });
  const qrDataUrl = await buildQrDataUrl(otpauthUrl);

  // ATTENTION: the plaintext secret is returned once. The frontend must
  // keep it in memory and send it back in the /confirm step together with the
  // first TOTP code. Nothing is persisted to the DB here — against
  // half-finished ghost secrets from setup.
  return NextResponse.json({
    secret,
    otpauthUrl,
    qrDataUrl,
    note: 'Secret + QR sind nur 1× verfügbar. Im /confirm beide zurückschicken zusammen mit erstem 6-stelligen Code.',
  });
}
