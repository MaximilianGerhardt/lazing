/**
 * RagStatusCard-Mount im Workspace-Detail (TG-2 Audit-Fix · 2026-05-28)
 *
 * Audit-Befund (docs/audits/2026-05-28_ux-redundancy-flow-audit.md, TG-2 P0):
 *   - app/workspaces/[id]/RagStatusCard.tsx hatte 0 Konsumenten.
 *   - Tabs waren: overview / branding / credentials / folders / cloud — kein
 *     `rag`-Tab.
 *
 * Fix: 'rag' als Tab-Wert + RagStatusCard im Tab-Content-Block mounted
 * (analog zu credentials/folders).
 *
 * Dieser Test verifiziert die Implementations-Invariante via Quellcode-
 * Inspektion — gleicher Stil wie die existierenden ChatTopBar/EnginePill
 * Source-Assertions in app/api/chat/stream/__tests__/engine-mode-routing.test.ts.
 * Eine echte Render-Suite wäre nice-to-have, lohnt aber für die einfache
 * Mount-Assertion nicht den happy-dom-Setup-Overhead.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     app/workspaces/\[id\]/__tests__/rag-status-card-mounted.test.ts
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_PATH = path.resolve(__dirname, '..', 'page.tsx');
const CARD_PATH = path.resolve(__dirname, '..', 'RagStatusCard.tsx');

describe('app/workspaces/[id]/page.tsx — RagStatusCard-Konsumer (TG-2)', () => {
  it('RagStatusCard ist importiert', () => {
    const src = fs.readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/import \{ RagStatusCard \} from '\.\/RagStatusCard'/);
  });

  it("'rag' ist als Tab-Wert + im TAB_LABELS-Mapping enthalten", () => {
    const src = fs.readFileSync(PAGE_PATH, 'utf8');
    // type Tab union enthält 'rag'
    expect(src).toMatch(/type Tab = .*'rag'.*/);
    // TAB_LABELS hat einen 'rag'-Eintrag
    expect(src).toMatch(/rag:\s*'RAG'/);
    // searchParams-Sicherung akzeptiert sp.tab === 'rag'
    expect(src).toMatch(/sp\.tab === 'rag'/);
  });

  it('RagStatusCard ist im Tab-Content-Block mounted und bekommt workspaceId-Prop', () => {
    const src = fs.readFileSync(PAGE_PATH, 'utf8');
    // tab==='rag' ? <RagStatusCard workspaceId={id} /> : null  (analog credentials/folders)
    expect(src).toMatch(/tab === 'rag'/);
    expect(src).toMatch(/<RagStatusCard\s+workspaceId=\{id\}\s*\/>/);
  });
});

describe('RagStatusCard — Props-Vertrag stabil', () => {
  it('exportiert RagStatusCard mit { workspaceId: string }-Props', () => {
    const src = fs.readFileSync(CARD_PATH, 'utf8');
    expect(src).toMatch(/export function RagStatusCard\s*\(\s*\{\s*workspaceId\s*\}\s*:\s*Props\s*\)/);
    expect(src).toMatch(/interface Props \{\s*workspaceId:\s*string;?\s*\}/);
  });
});
