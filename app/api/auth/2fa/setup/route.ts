/**
 * POST /api/auth/2fa/setup
 *
 * Schritt 1 des 2FA-Setups: Generiert Secret + QR-Data-URL.
 * Speichert NICHT — der User scannt den QR, gibt einen Verify-Code ein,
 * dann wird via /api/auth/2fa/setup/confirm das Secret persistiert.
 *
 * Auth: User muss eingeloggt sein.
 * Rate-Limit: max 5 Setups pro Stunde pro User (gegen Spam).
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

  // ACHTUNG: Klartext-Secret wird einmalig zurückgegeben. Frontend muss es
  // im Memory halten und im /confirm-Step zusammen mit dem ersten TOTP-Code
  // zurückschicken. Nichts wird hier in DB persistiert — gegen Setup-
  // Halbfertig-Geister-Secrets.
  return NextResponse.json({
    secret,
    otpauthUrl,
    qrDataUrl,
    note: 'Secret + QR sind nur 1× verfügbar. Im /confirm beide zurückschicken zusammen mit erstem 6-stelligen Code.',
  });
}
