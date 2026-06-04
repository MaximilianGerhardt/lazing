/**
 * POST /api/auth/2fa/verify
 *
 * Step 2 after magic link / master code: the user enters a 6-digit TOTP code
 * or a recovery code.
 *
 * Body: { pendingId: string, code: string }
 *
 *   - 6 digits (`\d{6}$`) → TOTP verify against the decrypted secret.
 *   - 14 chars with `-` (`XXXX-XXXX-XXXX`) → consume recovery code.
 *
 * On success: delete the pendingToken, issue the session via the existing
 * finalize path. (Current iteration: we return `{ ok, userId }` and
 * let the caller set the session cookie — the magic-link verify
 * handler knows the path. Sprint 3.2: integrated directly in the magic link.)
 *
 * Rate limit: 5 attempts per pendingToken (auth_2fa_pending.attempts).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createDecipheriv } from 'node:crypto';

import { verifyTotp } from '@/lib/auth/2fa/totp';
import {
  loadPendingToken,
  bumpPendingAttempts,
  deletePendingToken,
  getUserTotp,
  recordTotpUse,
  consumeRecoveryCode,
  countRemainingRecoveryCodes,
} from '@/lib/auth/2fa/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  pendingId: z.string().min(8).max(64),
  code: z.string().min(6).max(20),
});

const MAX_ATTEMPTS = 5;

function getEncryptionKey(): Buffer | null {
  const raw = process.env.LAZYOS_2FA_KEY;
  if (!raw || raw.length !== 64) return null;
  try {
    return Buffer.from(raw, 'hex');
  } catch {
    return null;
  }
}

function decryptSecret(blob: string, key: Buffer): string | null {
  try {
    const [ivB64, tagB64, ctB64] = blob.split('.');
    if (!ivB64 || !tagB64 || !ctB64) return null;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid-body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 },
    );
  }

  const pending = loadPendingToken(body.pendingId);
  if (!pending) {
    return NextResponse.json({ error: 'pending-expired-or-unknown' }, { status: 401 });
  }
  if (pending.attempts >= MAX_ATTEMPTS) {
    deletePendingToken(body.pendingId);
    return NextResponse.json({ error: 'too-many-attempts' }, { status: 429 });
  }

  const userTotp = getUserTotp(pending.userId);
  if (!userTotp || !userTotp.totp_secret_ciphertext) {
    return NextResponse.json({ error: 'totp-not-set' }, { status: 400 });
  }

  // Path 1: recovery code (format XXXX-XXXX-XXXX, 12 hex)
  const isRecovery = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/i.test(body.code);
  if (isRecovery) {
    const consumed = consumeRecoveryCode(pending.userId, body.code);
    if (!consumed) {
      bumpPendingAttempts(body.pendingId);
      return NextResponse.json({ error: 'invalid-recovery-code' }, { status: 401 });
    }
    deletePendingToken(body.pendingId);
    const remaining = countRemainingRecoveryCodes(pending.userId);
    return NextResponse.json({
      ok: true,
      method: 'recovery-code',
      userId: pending.userId,
      recoveryCodesRemaining: remaining,
      warning:
        remaining < 3
          ? `Nur noch ${remaining} Recovery-Codes übrig — neue im Account-Settings generieren.`
          : null,
    });
  }

  // Path 2: TOTP
  if (!/^\d{6}$/.test(body.code)) {
    bumpPendingAttempts(body.pendingId);
    return NextResponse.json({ error: 'invalid-code-format' }, { status: 400 });
  }

  const key = getEncryptionKey();
  if (!key) {
    return NextResponse.json({ error: 'encryption-key-missing' }, { status: 503 });
  }

  const secret = decryptSecret(userTotp.totp_secret_ciphertext, key);
  if (!secret) {
    return NextResponse.json({ error: 'secret-decrypt-failed' }, { status: 500 });
  }

  const verdict = verifyTotp({
    secret,
    token: body.code,
    lastCounter: userTotp.totp_last_counter ?? null,
  });
  if (!verdict.ok || verdict.counter === null) {
    bumpPendingAttempts(body.pendingId);
    return NextResponse.json({ error: 'invalid-totp' }, { status: 401 });
  }

  recordTotpUse(pending.userId, verdict.counter);
  deletePendingToken(body.pendingId);

  return NextResponse.json({
    ok: true,
    method: 'totp',
    userId: pending.userId,
  });
}
