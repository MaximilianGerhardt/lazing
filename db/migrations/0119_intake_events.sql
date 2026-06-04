-- ============================================================
-- 0119_intake_events.sql — Phase 2 W2.2 · Lane A Communication Intake
--
-- Owner-Direktive (verbatim, N1):
--
-- Master-Briefing §25.1 Lane A (verbatim):
--   „Communication Intake. Ziel: Klaeren, wie WhatsApp/Telegram/Voice/
--    Meeting-Kommunikation ohne Copy-Paste in laz.ing einfliessen kann.
--    Artefakte: Source Envelope · Consent-Modell · Context Intake Surface ·
--    No-auto-run-State-Machine · Nudge-Klassen."
--
-- Master-Briefing §7.2 (verbatim):
--   „Imported context must not auto-run."
--
-- Master-Briefing §7.3 Pipeline (verbatim):
--   „1. Verbatim speichern. 2. Quelle, Sprecher, Zeit, Projekt und
--    Sensitivitaet erfassen. 3. Klassifizieren. 4. Relevante Begriffe,
--    Entscheidungen, Fragen und Konflikte extrahieren. 5. In Decision
--    Brief, Why Bank, Glossary oder Open Questions ueberfuehren. 6. Erst
--    nach Freigabe in Planung oder Build uebergeben."
--
-- Diese Tabelle ist das Substrat von Lane A. Lane A schreibt (verbatim,
-- §7.3 Schritt 1+2), klassifiziert (Schritt 3) und markiert ready-for-compile
-- (Schritt 4). Lane B (Expertise-Compiler, 0120) liest spaeter daraus —
-- KEIN auto-run (§7.2), der Status-Uebergang nach Lane B ist human-gated.
--
-- Substrat-Disziplin:
--   - N1:  raw_content wird VERBATIM persistiert (keine TEXT(N)-Laengen-
--          begrenzung in SQL, keine .slice/.substring in JS).
--   - N4:  rein additiv — keine bestehende Tabelle geaendert. KEIN Eingriff in
--          workstream_decisions, workspace_beliefs oder events.
--   - N6:  CHECK-Constraints auf source_kind, sensitivity, raw_content_type,
--          nudge_class, fsm_state.
--   - N8:  „Append-only-Light" — der Trigger blockt DELETE und blockt die
--          Mutation der Kern-Identitaet (id/workspace_id/source_kind/
--          raw_content/content_hash). UPDATE auf nudge_class + fsm_state +
--          speaker_local_id + updated_at ist erlaubt (Pipeline-Fortschritt:
--          staged → classified → ready-for-compile, Speaker-Resolution).
--   - N9:  workspace_id = ManifestCoord-Scope. Bewusst KEIN harter FK auf
--          workspaces (analog 0113/0118/0111/0112).
--   - N10: content_hash (sha256 ueber kanonisches JSON) pro Row → Idempotenz.
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS. Timestamps
-- INTEGER ms-Epoch. IDs TEXT (ULID mit Prefix INE-).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. intake_events — eingehende Kommunikation (§7.3 Schritt 1-4)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intake_events (
  id                 TEXT    PRIMARY KEY NOT NULL,
  workspace_id       TEXT    NOT NULL,                  -- ManifestCoord-Scope (N9)
  external_id        TEXT,                              -- ID vom externen System (nullable)
  source_kind        TEXT    NOT NULL                   -- = DataSource (lib/governance/consent.ts)
                     CHECK (source_kind IN (
                       'whatsapp',
                       'telegram',
                       'voice',
                       'meeting',
                       'email',
                       'browser-shadow',
                       'screen-capture',
                       'keystroke-capture',
                       'workspace-derive'
                     )),
  speaker_external_id TEXT,                             -- externe Sprecher-ID (nullable)
  speaker_local_id   TEXT,                              -- gemappter lokaler User/Contact (nullable)
  received_at        INTEGER NOT NULL,                  -- ms-Epoch, wann die Quelle entstand
  sensitivity        TEXT    NOT NULL
                     CHECK (sensitivity IN (
                       'public','internal','confidential','restricted'
                     )),
  raw_content        TEXT    NOT NULL,                  -- N1 VERBATIM, keine Laengenbegrenzung
  raw_content_type   TEXT    NOT NULL
                     CHECK (raw_content_type IN (
                       'text','audio','image','video','pdf','html'
                     )),
  parent_envelope_id TEXT,                              -- Reply/Forward-Kette, Soft-FK auf intake_events.id
  nudge_class        TEXT                               -- nullable bis Schritt 3 (Klassifikation)
                     CHECK (nudge_class IS NULL OR nudge_class IN (
                       'urgent','decision-needed','info-only','noise'
                     )),
  fsm_state          TEXT    NOT NULL                   -- No-auto-run-State-Machine (§7.3)
                     CHECK (fsm_state IN (
                       'staged','classified','ready-for-compile','blocked'
                     )),
  content_hash       TEXT    NOT NULL,                  -- N10 sha256 ueber kanonisches JSON
  created_at         INTEGER NOT NULL,                  -- ms-Epoch
  updated_at         INTEGER NOT NULL                   -- ms-Epoch, steigt bei FSM-Fortschritt
);

-- Primary access pattern: pro Workspace nach FSM-State filtern (z.B. „alle
-- ready-for-compile events fuer Lane B" oder „alle staged fuer Owner-Surface").
CREATE INDEX IF NOT EXISTS idx_intake_ws_state
  ON intake_events (workspace_id, fsm_state);

-- Nudge-Surface: pro Workspace nach Nudge-Klasse (z.B. „alle urgent").
CREATE INDEX IF NOT EXISTS idx_intake_ws_nudge
  ON intake_events (workspace_id, nudge_class)
  WHERE nudge_class IS NOT NULL;

-- Hash-Lookup: Idempotenz-Pruefung (gleicher Input → gleicher content_hash →
-- kein doppeltes Insert, dedupliziert auf vorhandene Row).
CREATE INDEX IF NOT EXISTS idx_intake_hash
  ON intake_events (content_hash);

-- Reply/Forward-Kette: schneller Lookup der Kinder eines Envelopes.
CREATE INDEX IF NOT EXISTS idx_intake_parent
  ON intake_events (parent_envelope_id)
  WHERE parent_envelope_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Append-only-Light Trigger (N8) — analog 0120 knowledge_forms
--
-- Erlaubt:
--   - UPDATE auf nudge_class       (Schritt 3: Klassifikation)
--   - UPDATE auf fsm_state         (FSM-Fortschritt staged → classified → …)
--   - UPDATE auf speaker_local_id  (spaetere Speaker-Resolution; Annotation)
--   - UPDATE auf updated_at        (Begleit-Update zum FSM-Fortschritt)
-- Blockt:
--   - DELETE (use fsm_state='blocked')
--   - UPDATE auf id, workspace_id, source_kind, raw_content, content_hash
--     (Kern-Identitaet unveraenderlich — N1 verbatim + N10 Tamper-Evidenz).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS intake_events_no_core_mutation
  BEFORE UPDATE OF id, workspace_id, source_kind, raw_content, content_hash
  ON intake_events
BEGIN
  SELECT RAISE(ABORT, 'intake_events core fields are immutable (N1/N10)');
END;

CREATE TRIGGER IF NOT EXISTS intake_events_no_delete
  BEFORE DELETE ON intake_events
BEGIN
  SELECT RAISE(ABORT, 'intake_events is append-only — use fsm_state=''blocked'' (N8)');
END;
