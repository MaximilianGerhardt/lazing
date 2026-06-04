/**
 * 2FA-Smoke-Test (kein DB-Touch).
 *   1. Secret generieren
 *   2. Code für aktuelle Zeit "berechnen" (otplib generate)
 *   3. Über verifyTotp prüfen
 *   4. Recovery-Codes erzeugen + hash + verify
 *   5. QR-Data-URL erzeugen (länge prüfen)
 */

import { generateSync as otpGenerate } from 'otplib';
import {
  generateSecret,
  buildOtpauthUrl,
  buildQrDataUrl,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../lib/auth/2fa/totp';

async function main() {
  const secret = generateSecret();
  console.log('[1] Secret:', secret, '(len=' + secret.length + ')');

  const otpauth = buildOtpauthUrl({ secret, userEmail: 'max@laz.ing' });
  console.log('[2] otpauth:', otpauth);

  const qr = await buildQrDataUrl(otpauth);
  console.log('[3] QR-DataURL bytes:', qr.length, 'starts:', qr.slice(0, 30));

  const code = otpGenerate({ secret, period: 30, digits: 6, algorithm: 'sha1' });
  console.log('[4] Generated current TOTP:', code);

  const verdict = verifyTotp({ secret, token: code, lastCounter: null });
  console.log('[5] Verify result:', verdict);

  const verdictWrong = verifyTotp({ secret, token: '000000', lastCounter: null });
  console.log('[6] Verify wrong:', verdictWrong);

  const recovery = generateRecoveryCodes(10);
  console.log('[7] Recovery (sample 3):', recovery.slice(0, 3));

  const sample = recovery[0];
  const h1 = hashRecoveryCode(sample);
  const h2 = hashRecoveryCode(sample);
  const h3 = hashRecoveryCode('AAAA-AAAA-AAAA');
  console.log('[8] Hash deterministisch:', h1 === h2);
  console.log('[9] Hash different code differs:', h1 !== h3);
  console.log('   h1=', h1.slice(0, 20));
  console.log('   h3=', h3.slice(0, 20));

  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
