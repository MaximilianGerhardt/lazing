// Template smoke + matcher tests — BACKPORT-03 (2026-05-23).

import { describe, expect, it } from 'vitest';

import {
  matchTemplate,
  templateToProposedPlan,
  TEMPLATES_BY_ID,
} from '../templates';
import {
  matchesBugFixIntent,
  BUG_FIX_IMPERATIVE_REGEX,
  BUG_FIX_NOUN_REGEX,
  CODE_NOUN_REGEX,
} from '../templates/bug-fix';

let idCounter = 0;
function mintTestId(): string {
  idCounter += 1;
  return `TEST-${idCounter}`;
}

describe('matchTemplate — N6 deterministic regex selector', () => {
  it('matches bug-fix verbs with priority', () => {
    expect(matchTemplate('fix the auth regression')?.id).toBe('bug-fix');
    expect(matchTemplate('behebe den bug im sign-in')?.id).toBe('bug-fix');
    expect(matchTemplate('hotfix login')?.id).toBe('bug-fix');
  });
  it('matches security audit', () => {
    expect(matchTemplate('audit the auth deps for CVEs')?.id).toBe(
      'security-audit',
    );
    expect(matchTemplate('harden the surface')?.id).toBe('security-audit');
  });
  it('matches perf investigation', () => {
    expect(matchTemplate('the page is too slow')?.id).toBe(
      'perf-investigation',
    );
    expect(matchTemplate('profile the dispatch')?.id).toBe(
      'perf-investigation',
    );
  });
  it('matches test coverage', () => {
    expect(matchTemplate('schreibe Tests für den walker')?.id).toBe(
      'test-coverage',
    );
    expect(matchTemplate('add tests for the dispatcher')?.id).toBe(
      'test-coverage',
    );
  });
  it('matches refactor', () => {
    expect(matchTemplate('refactor the route handlers')?.id).toBe('refactor');
    expect(matchTemplate('migrate from drizzle 0.30 to 0.45')?.id).toBe(
      'refactor',
    );
  });
  it('matches feature-implement as the catch-all', () => {
    expect(matchTemplate('add a new dashboard widget')?.id).toBe(
      'feature-implement',
    );
    expect(matchTemplate('implementiere notifications')?.id).toBe(
      'feature-implement',
    );
  });
  it('returns null on non-matching intents', () => {
    expect(matchTemplate('')).toBeNull();
    expect(matchTemplate('   ')).toBeNull();
    expect(matchTemplate('hello there')).toBeNull();
  });
  it('is deterministic — same input yields same template', () => {
    const a = matchTemplate('fix the bug')?.id;
    const b = matchTemplate('fix the bug')?.id;
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Bug-fix matcher — Slice A sharpening (2026-05-29).
//
// Root-cause regression suite for the owner-reported defect where the
// original single-flat regex (`lib/plan-first/templates/bug-fix.ts:21-22`
// before this slice) matched any prompt containing the bare word
// "problem" / "fehler" — promoting business / strategy / market briefs
// to the 5-step bug-fix template with 0 tool-calls and 0 discovery.
//
// Two tests-as-truth pillars:
//   (1) NEGATIVE — owner-prompt + 4 generic-noun phrasings MUST NOT match.
//   (2) POSITIVE — 9 real bug-fix phrasings MUST still match (imperative
//       verbs + bug-nouns with code-noun proximity).
// ---------------------------------------------------------------------------

// Owner prompt verbatim (from DB example-website-3 run, 2026-05-29).
// Preserved verbatim per N1 — this is the load-bearing regression
// fixture that motivated the entire slice.
const OWNER_PROMPT_VERBATIM =
  'Ich möchte eine website erstellen weil wir aktuell das problem ahben das die dienstleistung nicht klar genug erklärt wird und potenzielle kunden nicht verstehen was wir anbieten. Wir machen KI-Beratung für mittelständische Unternehmen in der Energiebranche und brauchen eine professionelle Webseite die unsere Expertise zeigt, Case Studies hervorhebt, und einen klaren Call-to-Action für Erstgespräche hat. Die Webseite soll modern aussehen, schnell laden, mobile-first sein, und unsere Positionierung als premium Beratung kommunizieren. Wir brauchen eine Hero-Section, eine Services-Übersicht, eine About-Section mit unserem Team, Case Studies, eine Insights/Blog-Section, und einen Kontakt-Bereich mit Terminbuchung. Design-Sprache: clean, vertrauenswürdig, mit subtilen KI-Akzenten aber nicht überladen. Targeting CEOs und Geschäftsführer von 50-500 Mitarbeiter-Unternehmen.';

describe('matchesBugFixIntent — Slice A sharpening (2026-05-29)', () => {
  describe('NEGATIVE — generic problem/fehler nouns without code-noun proximity', () => {
    it('does NOT match the owner-prompt verbatim (the 2026-05-29 regression)', () => {
      expect(matchesBugFixIntent(OWNER_PROMPT_VERBATIM)).toBe(false);
      expect(matchTemplate(OWNER_PROMPT_VERBATIM)?.id).not.toBe('bug-fix');
    });
    it('does NOT match "erstelle eine Webseite weil wir aktuell das problem haben dass …"', () => {
      expect(
        matchesBugFixIntent(
          'erstelle eine Webseite weil wir aktuell das problem haben dass …',
        ),
      ).toBe(false);
    });
    it('does NOT match "das problem unserer Dienstleistung"', () => {
      expect(matchesBugFixIntent('das problem unserer Dienstleistung')).toBe(
        false,
      );
    });
    it('does NOT match "wir haben ein Problem im Markt"', () => {
      expect(matchesBugFixIntent('wir haben ein Problem im Markt')).toBe(false);
    });
    it('does NOT match "mein Fehler — ich meinte was anderes"', () => {
      expect(matchesBugFixIntent('mein Fehler — ich meinte was anderes')).toBe(
        false,
      );
    });
    it('does NOT match "die Strategie ist fehlerhaft"', () => {
      // "fehlerhaft" doesn't even hit the bug-noun list — sanity check
      // that the matcher is conservative around derived adjectives.
      expect(matchesBugFixIntent('die Strategie ist fehlerhaft')).toBe(false);
    });
  });

  describe('POSITIVE — real bug-fix intents MUST still match', () => {
    it('matches "fix the auth regression" (imperative verb at start)', () => {
      expect(matchesBugFixIntent('fix the auth regression')).toBe(true);
      expect(matchTemplate('fix the auth regression')?.id).toBe('bug-fix');
    });
    it('matches "behebe den login-bug" (DE imperative)', () => {
      expect(matchesBugFixIntent('behebe den login-bug')).toBe(true);
      expect(matchTemplate('behebe den login-bug')?.id).toBe('bug-fix');
    });
    it('matches "hotfix the merge" (imperative)', () => {
      expect(matchesBugFixIntent('hotfix the merge')).toBe(true);
    });
    it('matches "patch the route handler" (imperative)', () => {
      expect(matchesBugFixIntent('patch the route handler')).toBe(true);
    });
    it('matches "Problem im API-Handler bei POST /workspaces" (bug-noun + code-noun proximity)', () => {
      expect(
        matchesBugFixIntent('Problem im API-Handler bei POST /workspaces'),
      ).toBe(true);
      expect(
        matchTemplate('Problem im API-Handler bei POST /workspaces')?.id,
      ).toBe('bug-fix');
    });
    it('matches "Fehler in der Migration 0042" (bug-noun + code-noun proximity)', () => {
      expect(matchesBugFixIntent('Fehler in der Migration 0042')).toBe(true);
    });
    it('matches "bug in route /login throws 500" (bug-noun + code-noun proximity)', () => {
      expect(matchesBugFixIntent('bug in route /login throws 500')).toBe(true);
    });
    it('matches "debug the spawn-pipeline exception" (imperative)', () => {
      expect(matchesBugFixIntent('debug the spawn-pipeline exception')).toBe(
        true,
      );
    });
    it('matches "korrigiere die Race-Condition im Reducer" (DE imperative)', () => {
      expect(
        matchesBugFixIntent('korrigiere die Race-Condition im Reducer'),
      ).toBe(true);
    });
  });

  describe('exported regex anchors are sane (N6 deterministic)', () => {
    it('BUG_FIX_IMPERATIVE_REGEX fires on imperative verbs', () => {
      expect(BUG_FIX_IMPERATIVE_REGEX.test('fix the bug')).toBe(true);
      expect(BUG_FIX_IMPERATIVE_REGEX.test('behebe das Problem')).toBe(true);
      expect(BUG_FIX_IMPERATIVE_REGEX.test('hotfix')).toBe(true);
    });
    it('BUG_FIX_NOUN_REGEX matches bug-nouns but does not by itself imply intent', () => {
      expect(BUG_FIX_NOUN_REGEX.test('problem')).toBe(true);
      expect(BUG_FIX_NOUN_REGEX.test('fehler')).toBe(true);
      expect(BUG_FIX_NOUN_REGEX.test('regression')).toBe(true);
      expect(BUG_FIX_NOUN_REGEX.test('race condition')).toBe(true);
      // by-itself does not call matchesBugFixIntent → confirms gating works.
      expect(matchesBugFixIntent('problem')).toBe(false);
    });
    it('CODE_NOUN_REGEX matches code-anchor vocabulary', () => {
      expect(CODE_NOUN_REGEX.test('handler')).toBe(true);
      expect(CODE_NOUN_REGEX.test('migration')).toBe(true);
      expect(CODE_NOUN_REGEX.test('endpoint')).toBe(true);
      expect(CODE_NOUN_REGEX.test('reducer')).toBe(true);
      expect(CODE_NOUN_REGEX.test('Dienstleistung')).toBe(false);
      expect(CODE_NOUN_REGEX.test('Markt')).toBe(false);
    });
    it('is deterministic — same input yields same matcher verdict (N6)', () => {
      const fixtures = [
        OWNER_PROMPT_VERBATIM,
        'fix the bug',
        'Problem im API-Handler bei POST /workspaces',
        'das problem unserer Dienstleistung',
      ];
      for (const f of fixtures) {
        expect(matchesBugFixIntent(f)).toBe(matchesBugFixIntent(f));
      }
    });
  });

  describe('matchTemplate integration — bug-fix priority preserved', () => {
    it('preserves the existing rule: bug-fix wins when bug-fix verb + feature verb co-occur', () => {
      // Operator types "fix the bug AND add a new endpoint" — bug-fix
      // should still win per the priority order documented in index.ts.
      expect(matchTemplate('fix the auth bug and add new endpoint')?.id).toBe(
        'bug-fix',
      );
    });
    it('owner prompt now falls through bug-fix (no false promotion)', () => {
      // The owner prompt no longer matches bug-fix; downstream classifier
      // (Slice intent-flow-classifier, parallel) decides feature-implement.
      const matched = matchTemplate(OWNER_PROMPT_VERBATIM);
      expect(matched?.id).not.toBe('bug-fix');
    });
  });
});

describe('templateToProposedPlan', () => {
  it('projects every template into a ProposedPlan with the right step count', () => {
    const counts: Record<string, number> = {
      'bug-fix': 5,
      'feature-implement': 7,
      refactor: 4,
      'test-coverage': 3,
      'perf-investigation': 5,
      'security-audit': 4,
    };
    for (const id of Object.keys(TEMPLATES_BY_ID)) {
      const t = TEMPLATES_BY_ID[id as keyof typeof TEMPLATES_BY_ID];
      const plan = templateToProposedPlan(
        t,
        `original intent for ${id}`,
        mintTestId,
        () => 1_700_000_000_000,
      );
      expect(plan.steps).toHaveLength(counts[id]);
      // N1 — originalIntent verbatim
      expect(plan.originalIntent).toBe(`original intent for ${id}`);
      // Every step has a verbatim title + rationale
      for (const s of plan.steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.rationale.length).toBeGreaterThan(0);
      }
    }
  });
});
