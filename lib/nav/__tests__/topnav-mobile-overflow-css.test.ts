/**
 * Mobile-Top-Bar-Overflow-Guard (D1-Fix, 2026-05-30).
 *
 * Owner-Kernanspruch „mobil Übersicht UND KONTROLLE": auf 360/390px ragten
 * die rechten Steuer-Icons (Pause/Share/Terminal/GitHub/Settings/Profil)
 * off-screen, weil `.topnav-right` `flex-shrink:0` hatte und kein Collapse
 * sie abfing. Dieser Test fixiert die CSS- + JSX-Disziplin, damit der Defekt
 * nicht zurückwächst:
 *   1. `.topnav-right` schrumpft (min-width:0), NICHT mehr flex-shrink:0.
 *   2. Es gibt eine ≤640px-Query, die die Identitäts-Switcher ellipsen lässt.
 *   3. TopNav.tsx verlegt Terminal/Settings/Profil per `topnav-right-mobile-hide`.
 *   4. MobileDrawer.tsx bietet die verlegten Aktionen (Terminal · Settings) an.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/nav/__tests__/topnav-mobile-overflow-css.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMPONENTS_CSS = readFileSync(
  join(ROOT, 'app', 'components.css'),
  'utf8',
);
const TOPNAV_TSX = readFileSync(
  join(ROOT, 'lib', 'nav', 'TopNav.tsx'),
  'utf8',
);
const DRAWER_TSX = readFileSync(
  join(ROOT, 'lib', 'nav', 'MobileDrawer.tsx'),
  'utf8',
);
const OVERFLOW_TSX = readFileSync(
  join(ROOT, 'lib', 'nav', 'OverflowMenu.tsx'),
  'utf8',
);

describe('D1 — TopNav mobile-overflow guard (CSS)', () => {
  it('.topnav-right schrumpft (min-width:0) statt flex-shrink:0', () => {
    // CSS-Kommentare strippen, damit erklärender Prosa-Text ("war
    // flex-shrink:0 →") die Deklarations-Prüfung nicht verfälscht.
    const noComments = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const m = noComments.match(/\.topnav-right\s*\{[^}]*\}/);
    expect(m).not.toBeNull();
    const block = m![0];
    expect(block).toContain('min-width: 0');
    expect(block).not.toMatch(/flex-shrink:\s*0/);
  });

  it('hat eine ≤640px-Query, die die Workspace-Identitäts-Zeile ellipsen lässt', () => {
    expect(COMPONENTS_CSS).toMatch(/@media\s*\(max-width:\s*640px\)/);
    // Workspace-Trigger-Label bekommt einen Mobile-Max-Width-Cap.
    expect(COMPONENTS_CSS).toMatch(
      /\.topnav-ws-trigger-label\s*\{[^}]*max-width:[^}]*\}/,
    );
  });
});

describe('Apple-Reduktion — Sekundär-Aktionen im •••-Overflow / Drawer (JSX)', () => {
  it('TopNav-Bar trägt nur die primären Targets + EIN Health + ••• + Profil', () => {
    // Die einzelnen Status-Indicators dürfen NICHT mehr direkt in der Bar
    // gerendert werden — sie leben im StatusCluster-Sheet. Render-Critic
    // HOCH: „5 konkurrierende Farben in der Bar" → genau EIN Health-Punkt.
    expect(TOPNAV_TSX).not.toMatch(/<TpmIndicator\s*\/>/);
    expect(TOPNAV_TSX).not.toMatch(/<ObservatoryIndicator\s*\/>/);
    expect(TOPNAV_TSX).not.toMatch(/<BackgroundActivityIndicator\s*\/>/);
    expect(TOPNAV_TSX).not.toMatch(/<PushToggle\b/);
    expect(TOPNAV_TSX).not.toMatch(/<AutoModeToggle\s*\/>/);
    expect(TOPNAV_TSX).not.toMatch(/<CompactButton\s*\/>/);
    expect(TOPNAV_TSX).not.toMatch(/<GitHubIndicator\s*\/>/);
    // Sekundäre Settings-Gear / Terminal-Button sind NICHT mehr direkt in
    // der Bar — sie wandern ins •••-Overflow bzw. den Drawer.
    expect(TOPNAV_TSX).not.toMatch(/data-testid="topnav-gear-settings"/);
    expect(TOPNAV_TSX).not.toContain('topnav-terminal');

    // Genau EIN Health-Indikator (StatusCluster) + EIN Overflow-Menü.
    expect(TOPNAV_TSX).toMatch(/<StatusCluster\b/);
    expect(TOPNAV_TSX).toMatch(/<OverflowMenu\s*\/>/);
  });

  it('OverflowMenu ist auf Mobile ausgeblendet (Drawer übernimmt dort)', () => {
    // Der Wrapper trägt topnav-right-mobile-hide → unter 768px weg, der
    // Hamburger-Drawer trägt dieselben Ziele.
    expect(OVERFLOW_TSX).toMatch(
      /className="topnav-overflow topnav-right-mobile-hide"/,
    );
  });

  it('OverflowMenu bündelt Terminal · GitHub · Observatory · Settings · Design', () => {
    expect(OVERFLOW_TSX).toContain('overflow-terminal');
    expect(OVERFLOW_TSX).toContain('overflow-github');
    expect(OVERFLOW_TSX).toContain('overflow-observatory');
    expect(OVERFLOW_TSX).toContain('overflow-settings');
    expect(OVERFLOW_TSX).toContain('overflow-design');
    // Terminal öffnet via dasselbe Custom-Event wie der Drawer (kein
    // Prop-Drilling) — keine Funktion verloren.
    expect(OVERFLOW_TSX).toContain("new Event('lazyos:terminal:open')");
  });

  it('TopNav hört auf das Terminal-Event (Overflow + Drawer dispatchen es)', () => {
    expect(TOPNAV_TSX).toContain("'lazyos:terminal:open'");
  });

  it('MobileDrawer bietet Terminal + Einstellungen weiterhin als Tools-Aktionen', () => {
    expect(DRAWER_TSX).toContain('drawer-tools-terminal');
    expect(DRAWER_TSX).toContain('drawer-tools-settings');
    expect(DRAWER_TSX).toContain("new Event('lazyos:terminal:open')");
  });
});

describe('Apple-Reduktion — •••-Overflow CSS', () => {
  it('hat eine Overflow-Menü-Regel mit anchored Popover-Position', () => {
    expect(COMPONENTS_CSS).toMatch(/\.topnav-overflow-menu\s*\{/);
    const m = COMPONENTS_CSS.match(/\.topnav-overflow-menu\s*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('--popover-anchor-top');
  });

  it('Overflow-Items haben ≥44px Touch-Target (min-height)', () => {
    const m = COMPONENTS_CSS.match(/\.topnav-overflow-item\s*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
  });
});
