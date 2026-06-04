/**
 * Tests fuer das Attachment-Staging-Modell (Owner-Hard-Requirement 2026-05-26).
 *
 * Kernanforderung (verbatim): „Datei steht oberhalb des Inputs fixiert …
 * ich möchte dazu ggf. noch etwas schreiben … Datei(en) + Text gehen
 * GEMEINSAM in derselben Message raus und werden ZUSAMMEN an den Agent
 * übergeben."
 *
 * Diese Tests verifizieren die pure Logik:
 *   - buildBubbleContent: Bubble zeigt Anhang-Card(s) + Caption.
 *   - buildAgentPrompt: Agent-Text enthält BEIDES — Datei-Pfad UND Caption.
 *   - reiner Anhang (kein Text) ist sendbar.
 *   - mehrere Anhänge stapelbar.
 */

import { describe, it, expect } from 'vitest';

import {
  attachmentSurfaceMarkup,
  buildAgentPrompt,
  buildBubbleContent,
  canSendWithAttachments,
  agentPathRef,
  type StagedAttachment,
} from '../attachment-message';

function mkAttachment(over: Partial<StagedAttachment> = {}): StagedAttachment {
  return {
    id: 'ART-IMG1',
    filename: 'foto.jpeg',
    mime: 'image/jpeg',
    bytes: 1291509,
    pages: null,
    workspaceId: 'demo-workspace',
    workspaceLabel: 'Demo Workspace',
    downloadUrl: '/api/cloud/ART-IMG1',
    previewUrl: '/api/cloud/ART-IMG1/preview',
    thumbnailUrl: '/api/cloud/ART-IMG1/thumb',
    storagePath: 'demo-workspace/ART-IMG1',
    absPath: '/tmp/lazyos-test/.lazyos/cloud/demo-workspace/ART-IMG1',
    ...over,
  };
}

describe('attachment-message · Bubble-Content', () => {
  it('Anhang + Caption → Card oben, Text darunter (WhatsApp-Layout)', () => {
    const a = mkAttachment();
    const content = buildBubbleContent([a], 'Was hältst du von dem Foto?');
    expect(content).toContain('<surface:document>');
    expect(content).toContain('foto.jpeg');
    // Caption steht NACH der Card.
    const cardIdx = content.indexOf('</surface:document>');
    const capIdx = content.indexOf('Was hältst du von dem Foto?');
    expect(cardIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(cardIdx);
  });

  it('Nur Anhang (kein Text) → nur Card, kein Trailing-Whitespace', () => {
    const content = buildBubbleContent([mkAttachment()], '   ');
    expect(content).toContain('<surface:document>');
    expect(content.endsWith('</surface:document>')).toBe(true);
  });

  it('Mehrere Anhänge → mehrere Cards', () => {
    const a = mkAttachment({ id: 'ART-1', filename: 'a.pdf', mime: 'application/pdf' });
    const b = mkAttachment({ id: 'ART-2', filename: 'b.png', mime: 'image/png' });
    const content = buildBubbleContent([a, b], 'beide bitte');
    const count = content.split('<surface:document>').length - 1;
    expect(count).toBe(2);
    expect(content).toContain('a.pdf');
    expect(content).toContain('b.png');
    expect(content).toContain('beide bitte');
  });

  it('Surface-Markup enthält die id für spätere Stream/Download-Links', () => {
    const markup = attachmentSurfaceMarkup(mkAttachment());
    expect(markup).toContain('"id":"ART-IMG1"');
    expect(markup).toContain('"previewUrl":"/api/cloud/ART-IMG1/preview"');
  });
});

describe('attachment-message · Agent-Prompt (Datei + Text GEMEINSAM)', () => {
  it('Anhang + Caption → Agent-Text enthält BEIDES (Pfad UND Text)', () => {
    const a = mkAttachment();
    const prompt = buildAgentPrompt([a], 'Erkenne den Text im Bild.');
    // Datei-Referenz mit absolutem Pfad (Read/Vision-fähig).
    expect(prompt).toContain('[Angehängt:');
    expect(prompt).toContain('foto.jpeg');
    expect(prompt).toContain('/tmp/lazyos-test/.lazyos/cloud/demo-workspace/ART-IMG1');
    // UND der User-Text.
    expect(prompt).toContain('Erkenne den Text im Bild.');
    // Reihenfolge: Pfad-Header VOR dem Text.
    expect(prompt.indexOf('[Angehängt:')).toBeLessThan(
      prompt.indexOf('Erkenne den Text im Bild.'),
    );
  });

  it('Bild wird als „Bild" gelabelt, Doc als „Datei"', () => {
    const img = buildAgentPrompt([mkAttachment({ mime: 'image/png' })], 'x');
    expect(img).toContain('[Angehängt: Bild');
    const doc = buildAgentPrompt(
      [mkAttachment({ mime: 'application/pdf', filename: 'd.pdf' })],
      'x',
    );
    expect(doc).toContain('[Angehängt: Datei');
  });

  it('Nur Anhang (kein Text) → Default-Auftrag statt leerem Turn', () => {
    const prompt = buildAgentPrompt([mkAttachment()], '');
    expect(prompt).toContain('[Angehängt:');
    expect(prompt.trim().length).toBeGreaterThan(0);
    expect(prompt.toLowerCase()).toContain('angehängt');
  });

  it('Kein Anhang → Agent-Text == reiner User-Text', () => {
    expect(buildAgentPrompt([], 'nur text')).toBe('nur text');
  });

  it('agentPathRef bevorzugt absPath, faellt auf storagePath/downloadUrl zurück', () => {
    expect(agentPathRef(mkAttachment())).toBe(
      '/tmp/lazyos-test/.lazyos/cloud/demo-workspace/ART-IMG1',
    );
    expect(agentPathRef(mkAttachment({ absPath: null }))).toBe(
      'demo-workspace/ART-IMG1',
    );
    expect(
      agentPathRef(mkAttachment({ absPath: null, storagePath: undefined })),
    ).toBe('/api/cloud/ART-IMG1');
  });
});

describe('attachment-message · Send-Gate', () => {
  it('reiner Anhang ohne Text ist sendbar', () => {
    expect(canSendWithAttachments([mkAttachment()], '')).toBe(true);
  });
  it('reiner Text ohne Anhang ist sendbar', () => {
    expect(canSendWithAttachments([], 'hallo')).toBe(true);
  });
  it('weder Text noch Anhang ist NICHT sendbar', () => {
    expect(canSendWithAttachments([], '   ')).toBe(false);
  });
});
