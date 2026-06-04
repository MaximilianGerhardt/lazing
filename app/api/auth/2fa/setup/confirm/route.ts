/**
 * POST /api/auth/2fa/setup/confirm
 *
 * Body: { secret: string, token: string }
 *
 * Step 2 of the setup:
 *   1. Verify the 6-digit token against the claimed secret.
 *   2. If ok: encrypt the secret + persist in users.totp_secret_ciphertext.
 *   3. Issue 10 recovery codes (return once, then store only the hash).
 *   4. Set totp_enabled_at + counter.
 *
 * Encryption strategy (2026-04-30 minimal, improved in Sprint 3.1):
 *   - Symmetric key from ENV `LAZYOS_2FA_KEY` (32 hex bytes = 64 chars).
 *   - AES-256-GCM with random IV.
 *   - If ENV is missing: fail-closed with a clear error message instead of fallback.
 *
 * Sprint 3.1: switch to libsodium vault (see lib/security/vault.ts) +
 * per-user key wrapping. Currently sufficient for single-operator self-host.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createCipheriv, randomBytes } from 'node:crypto';

import { currentUserIdResolved } from '@/lib/security/subject-server';
import { verifyTotp, generateRecoveryCodes } from '@/lib/auth/2fa/totp';
import {
  setUserTotpSecret,
  enableUserTotp,
  storeRecoveryCodes,
} from '@/lib/auth/2fa/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  secret: z.string().min(16).max(64),
  token: z.string().regex(/^\d{6}$/),
});

function getEncryptionKey(): Buffer | null {
  const raw = process.env.LAZYOS_2FA_KEY;
  if (!raw || raw.length !== 64) return null;
  try {
    return Buffer.from(raw, 'hex');
  } catch {
    return null;
  }
}

function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv) . base64(tag) . base64(ct)
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid-body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 },
    );
  }

  const key = getEncryptionKey();
  if (!key) {
    return NextResponse.json(
      {
        error: 'encryption-key-missing',
        hint:
          'LAZYOS_2FA_KEY (64 hex chars = 32 bytes) muss in .env.local gesetzt sein. Generieren: `openssl rand -hex 32`',
      },
      { status: 503 },
    );
  }

  const verdict = verifyTotp({
    secret: body.secret,
    token: body.token,
    lastCounter: null,
  });
  if (!verdict.ok || verdict.counter === null) {
    return NextResponse.json({ error: 'invalid-token' }, { status: 400 });
  }

  const ciphertext = encryptSecret(body.secret, key);
  setUserTotpSecret({ userId, ciphertext });
  enableUserTotp(userId, verdict.counter);

  const recoveryCodes = generateRecoveryCodes(10);
  storeRecoveryCodes(userId, recoveryCodes);

  return NextResponse.json({
    ok: true,
    enabled: true,
    recoveryCodes,
    note:
      'Recovery-Codes EINMAL anzeigen + offline speichern. Sie sind danach nur als Hash in der DB.',
  });
}
