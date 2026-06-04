/**
 * POST /api/subchats/external/[token]/upload  — Anhang-Upload für externe Gäste
 *
 * Der Share-Token IST die Autorisierung (kein Login). Lädt eine Datei in den
 * Cloud-Artifact-Store des Workspace, zu dem der Sub-Chat gehört, und gibt eine
 * Referenz zurück, die der Client dann als Anhang an eine Nachricht hängt
 * (POST /api/subchats/external/[token]). Public-Route (middleware PUBLIC_PREFIXES
 * `/api/subchats/external/`). WhatsApp-Standard: Dokumente/Medien/Fotos für alle.
 *
 * Gathering-Intelligence-Goal (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { uploadArtifact, CloudError } from '@/lib/cloud/service';
import { resolveExternalToken } from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Externer Hard-Cap (niedriger als intern): 25 MB pro Upload. */
const MAX_EXTERNAL_BYTES = 25 * 1024 * 1024;

/* ---- Härtung des anonymen Uploads (sicheres OSS-Hosting, 2026-06-02) ---- */

// Nie erlaubt: aktive/scriptbare Typen (XSS/RCE-Risiko beim Öffnen).
const DENY_EXT = new Set([
  'svg', 'html', 'htm', 'xhtml', 'js', 'mjs', 'jsx', 'ts',
  'exe', 'sh', 'bat', 'cmd', 'com', 'scr', 'msi', 'app', 'jar', 'dll', 'pkg', 'deb', 'apk',
]);
// Ohne verlässliche Magic-Bytes nur per Extension erlaubt (Dokumente/Text/Medien).
const ALLOW_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md', 'rtf', 'zip',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif',
  'mp4', 'mov', 'webm', 'm4v', 'mp3', 'm4a', 'wav', 'aac', 'ogg',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Magic-Byte-Sniff für inline-sichere Bild-/PDF-Typen. */
function sniffMagic(buf: Buffer): { mime: string; kind: 'image' } | { mime: 'application/pdf'; kind: 'file' } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', kind: 'image' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (buf.length >= 6 && buf.toString('ascii', 0, 6) === 'GIF89a') return { mime: 'image/gif', kind: 'image' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'file' };
  return null;
}

/**
 * Eingehende Datei prüfen: Reject scriptbare Typen; Bilder/PDF per Magic-Bytes
 * verifizieren (vertrauenswürdiger als client-mime); sonst per Extension-Allow.
 * Liefert den ZU SPEICHERNDEN (vertrauenswürdigen) MIME + kind, oder einen Fehler.
 */
function validateUpload(buf: Buffer, filename: string, declaredMime: string):
  | { ok: true; mime: string; kind: 'image' | 'file' }
  | { ok: false; reason: string } {
  const ext = extOf(filename);
  if (DENY_EXT.has(ext)) return { ok: false, reason: 'type-not-allowed' };
  if (declaredMime === 'image/svg+xml' || declaredMime.startsWith('text/html') || declaredMime.includes('javascript')) {
    return { ok: false, reason: 'type-not-allowed' };
  }
  const magic = sniffMagic(buf);
  if (magic) return { ok: true, mime: magic.mime, kind: magic.kind };
  // Kein erkanntes Magic → nur erlaubte Extensions (Office/Text/Medien) durchlassen.
  if (ALLOW_EXT.has(ext)) {
    const safeMime = declaredMime && !/(svg|html|javascript)/i.test(declaredMime) ? declaredMime : 'application/octet-stream';
    return { ok: true, mime: safeMime, kind: safeMime.startsWith('image/') ? 'image' : 'file' };
  }
  return { ok: false, reason: 'type-not-allowed' };
}

// Stopgap-Throttle (in-memory, pro IP) bis der Middleware-Rate-Limit-Fix greift
// (siehe docs/plans/2026-06-02_secure-oss-hosting-plan.md P0 #4). Fenster 60s.
const UPLOADS_PER_MIN = 8;
const ipHits = new Map<string, number[]>();
function clientIp(req: NextRequest): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}
function throttled(ip: string): boolean {
  const now = Date.now();
  const arr = (ipHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= UPLOADS_PER_MIN) {
    ipHits.set(ip, arr);
    return true;
  }
  arr.push(now);
  ipHits.set(ip, arr);
  if (ipHits.size > 5000) ipHits.clear(); // grober Schutz gegen Map-Wachstum
  return false;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const sc = resolveExternalToken(token);
  if (!sc) {
    return NextResponse.json({ error: 'invalid_or_expired' }, { status: 404 });
  }
  if (throttled(clientIp(req))) {
    return NextResponse.json({ error: 'rate-limited', hint: 'Zu viele Uploads — kurz warten.' }, { status: 429 });
  }

  const ct = req.headers.get('content-type') ?? '';
  if (!ct.startsWith('multipart/form-data')) {
    return NextResponse.json(
      { error: 'expected-multipart', hint: 'multipart/form-data mit file=<File>' },
      { status: 415 },
    );
  }
  const cl = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(cl) && cl > MAX_EXTERNAL_BYTES + 64 * 1024) {
    return NextResponse.json({ error: 'file-too-large', maxBytes: MAX_EXTERNAL_BYTES }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json({ error: 'form-parse-failed', message: (err as Error).message }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'missing-file', hint: "form-field 'file'" }, { status: 400 });
  }
  const filename = (file as File).name || 'upload.bin';
  const mime = file.type || 'application/octet-stream';
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength === 0) {
    return NextResponse.json({ error: 'empty-file' }, { status: 400 });
  }
  if (buffer.byteLength > MAX_EXTERNAL_BYTES) {
    return NextResponse.json({ error: 'file-too-large', maxBytes: MAX_EXTERNAL_BYTES }, { status: 413 });
  }

  // Typ-Härtung: scriptbare Typen ablehnen, Bilder/PDF per Magic-Bytes verifizieren.
  const verdict = validateUpload(buffer, filename, mime);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.reason, hint: 'Erlaubt: Fotos, PDF, Office-Dokumente, Text, Medien. Keine ausführbaren/Script-Dateien oder SVG.' },
      { status: 415 },
    );
  }

  try {
    const row = await uploadArtifact({
      workspaceId: sc.workspaceId,
      filename,
      mime: verdict.mime, // vertrauenswürdiger (gesnifft/safe), nicht der rohe Client-MIME
      data: buffer,
      createdBy: `external:${sc.id}`,
      metadata: { subchatId: sc.id, via: 'external-subchat' },
    });
    return NextResponse.json(
      {
        artifactId: row.id,
        filename: row.filename,
        mime: row.mime,
        bytes: row.bytes,
        kind: row.mime.startsWith('image/') ? 'image' : 'file',
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof CloudError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.code === 'workspace-not-found' ? 404 : 403 });
    }
    console.error('[subchat external upload]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
