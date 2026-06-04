/**
 * Tests fuer den Upload-Storage-Layer (VPS-Disk) + Filename-Sanitizer.
 *
 * Owner-Bug-Kontext: „Erstens findet kein echter Upload statt." — der echte
 * Upload schreibt via VpsDiskBackend.put() auf die Disk. Diese Tests
 * verifizieren das deterministisch (Temp-Dir, kein DB):
 *   - put → get Roundtrip schreibt die Datei wirklich raus.
 *   - Path-Traversal-Keys (.., absolute, NUL, Backslash) werden ABGELEHNT.
 *   - absolutePath bleibt unter dem Root (für den Agent-Prompt-Pfad).
 *   - sanitizeFilename strippt Control-Bytes + Path-Separatoren.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VpsDiskBackend } from '../storage/vps-disk';
import { StorageBackendError } from '../storage/types';
import { sanitizeFilename } from '../sanitize';

const NUL = String.fromCharCode(0);
const RLO = String.fromCharCode(0x202e); // Right-to-Left-Override (Spoof-Vektor)

let root: string;
let backend: VpsDiskBackend;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lazyos-cloud-test-'));
  backend = new VpsDiskBackend(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('VpsDiskBackend · echter Upload (put/get)', () => {
  it('put schreibt die Datei tatsaechlich auf die Disk', async () => {
    const key = 'ws-a/ART-123';
    const data = Buffer.from('hello world', 'utf8');
    await backend.put(key, data);

    const full = path.join(root, 'ws-a', 'ART-123');
    expect(existsSync(full)).toBe(true);
    expect(readFileSync(full).toString('utf8')).toBe('hello world');
  });

  it('get liest zurueck was put geschrieben hat', async () => {
    const key = 'ws-a/ART-bin';
    const data = Buffer.from([0, 1, 2, 3, 255]);
    await backend.put(key, data);
    const out = await backend.get(key);
    expect(Buffer.compare(out, data)).toBe(0);
  });

  it('size liefert die Bytes-Groesse', async () => {
    await backend.put('ws-a/ART-s', Buffer.alloc(42));
    expect(await backend.size('ws-a/ART-s')).toBe(42);
  });

  it('legt fehlende Parent-Verzeichnisse rekursiv an', async () => {
    await backend.put('deep/nested/dir/ART-x', Buffer.from('x'));
    expect(existsSync(path.join(root, 'deep', 'nested', 'dir', 'ART-x'))).toBe(
      true,
    );
  });
});

describe('VpsDiskBackend · Path-Traversal-Schutz', () => {
  it('lehnt ".." Segmente ab', async () => {
    await expect(backend.put('../escape', Buffer.from('x'))).rejects.toThrow(
      StorageBackendError,
    );
    await expect(
      backend.put('ws/../../escape', Buffer.from('x')),
    ).rejects.toThrow(StorageBackendError);
  });

  it('lehnt absolute Pfade ab', async () => {
    await expect(backend.put('/etc/passwd', Buffer.from('x'))).rejects.toThrow(
      StorageBackendError,
    );
  });

  it('lehnt NUL-Bytes ab', async () => {
    await expect(
      backend.put(`ws/ART${NUL}evil`, Buffer.from('x')),
    ).rejects.toThrow(StorageBackendError);
  });

  it('lehnt Backslash-Segmente ab', async () => {
    await expect(
      backend.put('ws\\..\\escape', Buffer.from('x')),
    ).rejects.toThrow(StorageBackendError);
  });

  it('absolutePath bleibt IMMER unter dem Root', () => {
    const abs = backend.absolutePath('ws-a/ART-123');
    expect(abs.startsWith(root + path.sep)).toBe(true);
    expect(() => backend.absolutePath('../escape')).toThrow(
      StorageBackendError,
    );
  });
});

describe('sanitizeFilename', () => {
  it('ersetzt Path-Separatoren durch _', () => {
    expect(sanitizeFilename('a/b\\c.txt')).toBe('a_b_c.txt');
  });
  it('strippt Control-Bytes (NUL)', () => {
    expect(sanitizeFilename(`evil${NUL}.pdf`)).toBe('evil.pdf');
  });
  it('strippt RLO-Bidi-Override (Spoof-Schutz)', () => {
    expect(sanitizeFilename(`inv${RLO}exe.pdf`)).toBe('invexe.pdf');
  });
  it('lehnt "." und ".." ab (leerer String)', () => {
    expect(sanitizeFilename('.')).toBe('');
    expect(sanitizeFilename('..')).toBe('');
  });
  it('behaelt normale Unicode-Namen', () => {
    expect(sanitizeFilename('Tagesbericht-clientb 2026.pdf')).toBe(
      'Tagesbericht-clientb 2026.pdf',
    );
  });
});
