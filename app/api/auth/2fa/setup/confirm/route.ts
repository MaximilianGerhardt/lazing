/**
 * POST /api/auth/2fa/setup/confirm
 *
 * Body: { secret: string, token: string }
 *
 * Schritt 2 des Setups:
 *   1. Verify den 6-stelligen Token gegen das geclaimte Secret.
 *   2. Wenn ok: encrypt Secret + persistiere in users.totp_secret_ciphertext.
 *   3. Issue 10 Recovery-Codes (1× zurückgeben, danach nur Hash speichern).
 *   4. Setze totp_enabled_at + counter.
 *
 * Encryption-Strategie (2026-04-30 minimal, Sprint 3.1 verbessert):
 *   - Symmetric-Key aus ENV `LAZYOS_2FA_KEY` (32 hex bytes = 64 chars).
 *   - AES-256-GCM mit random IV.
 *   - Wenn ENV fehlt: Fail-Closed mit klarer Fehlermeldung statt fallback.
 *
 * Sprint 3.1: Switch auf libsodium-Vault (siehe lib/security/vault.ts) +
 * per-User Key-Wrapping. Aktuell genug für Single-Operator-Self-Host.
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
