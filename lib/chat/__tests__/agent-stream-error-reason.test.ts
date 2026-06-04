/**
 * Bug 1 (2026-05-30, Owner verbatim): „wenn ich nicht drücke sondern nur
 * eingebe ‚Eigenes Video' kam jetzt Stream-Fehler: Agent-Fehler".
 *
 * Wurzel: `dispatchEvent` (useAgentStream.ts) setzte bei `done{is_error}`/
 * `done{error}` ohne separates `error`-Frame stur `errorMessage='Agent-Fehler'`
 * — die ECHTE Ursache (subtype / result_text) wurde verworfen. Diese Tests
 * pinnen den Extraktor, der jetzt die reale Ursache zieht statt der generischen
 * Zeile.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *      lib/chat/__tests__/agent-stream-error-reason.test.ts
 */

import { describe, expect, it } from 'vitest';

import { extractDoneErrorReason } from '../useAgentStream';

describe('extractDoneErrorReason — echte Ursache statt „Agent-Fehler"', () => {
  it('bevorzugt result_text (CLI-Final-Text bei Crash)', () => {
    expect(
      extractDoneErrorReason({
        result_text: 'Tool „Bash" ist im read-only Workspace nicht erlaubt.',
        subtype: 'error_during_execution',
      }),
    ).toBe('Tool „Bash" ist im read-only Workspace nicht erlaubt.');
  });

  it('result_text wird getrimmt', () => {
    expect(extractDoneErrorReason({ result_text: '   echte Ursache  ' })).toBe(
      'echte Ursache',
    );
  });

  it('mappt bekannte subtypes auf verständliche Sätze', () => {
    expect(extractDoneErrorReason({ subtype: 'error_max_turns' })).toBe(
      'Der Agent hat die maximale Anzahl an Schritten erreicht.',
    );
    expect(extractDoneErrorReason({ subtype: 'error_during_execution' })).toBe(
      'Während der Ausführung trat ein Fehler auf.',
    );
  });

  it('unbekannter subtype → roh durchgereicht (besser als „Agent-Fehler")', () => {
    expect(extractDoneErrorReason({ subtype: 'error_weirdcase' })).toBe(
      'Agent-Abbruch (error_weirdcase)',
    );
  });

  it('leeres Payload → null (Caller nutzt den menschlichen Fallback, NICHT „Agent-Fehler")', () => {
    expect(extractDoneErrorReason({})).toBeNull();
    expect(extractDoneErrorReason({ result_text: '   ', subtype: '  ' })).toBeNull();
  });

  it('die generische Zeichenkette „Agent-Fehler" taucht nie als Rückgabe auf', () => {
    const samples = [
      { result_text: 'x' },
      { subtype: 'error_max_turns' },
      { subtype: 'foo' },
      {},
    ];
    for (const s of samples) {
      expect(extractDoneErrorReason(s)).not.toBe('Agent-Fehler');
    }
  });
});
