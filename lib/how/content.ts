/**
 * /how — Content für die 7 Sub-Pages.
 *
 * Bewusst als Daten-Struktur, nicht als JSX:
 *   - Bilingual DE/EN, Default DE.
 *   - Single-Source für /how/[slug].
 *   - Keine Übersetzungs-Library — der Inhalt ist Teil des Produkts und
 *     ändert sich mit dem Code.
 *
 * Texte sind absichtlich substanziell. Max muss aus der Page das mentale
 * Modell ableiten können, ohne den Code zu lesen.
 */

import type { Locale } from './locale';

export type Bi<T> = { de: T; en: T };

export interface Section {
  heading: Bi<string>;
  body: Bi<string>;
  bullets?: Bi<string[]>;
  /**
   * Optional: ein <surface:KIND>-Tag der im Chat zur Sektion gehört. Wird
   * unterhalb des Body als kleines Code-Pill gerendert.
   */
  surfaceTag?: string;
  /**
   * Optional: Code-Snippet (z.B. Shell-Beispiel oder Migration-Snippet).
   * Wird als <pre><code> gerendert.
   */
  code?: string;
}

export interface SubPageContent {
  slug: string;
  title: Bi<string>;
  lead: Bi<string>;
  sections: Section[];
  /** Pfade auf andere lazyOS-Routen (intern). */
  relatedRoutes: { href: string; label: Bi<string> }[];
  /** Optional: Welche DB-Tabelle/Live-Stat in der Hero-Zeile zeigen. */
  liveStat?:
    | { kind: 'skills' }
    | { kind: 'workspaces' }
    | { kind: 'sessions' };
}

export const SUB_PAGES: SubPageContent[] = [
  // ---------------------------------------------------------------------------
  // workstreams
  // ---------------------------------------------------------------------------
  {
    slug: 'workstreams',
    title: {
      de: 'Workstreams',
      en: 'Workstreams',
    },
    lead: {
      de: 'Ein Workstream ist der Container für eine größere Anfrage. Er bündelt einen Master-Plan, mehrere Sub-Tickets und parallele Claude-Sessions zu einer Einheit — mit eigenem Tier-Mix, Cost und Quality-Score.',
      en: 'A workstream is the container for a larger request. It bundles a master plan, multiple sub-tickets, and parallel Claude sessions into a single unit — with its own tier mix, cost and quality score.',
    },
    sections: [
      {
        heading: {
          de: 'Was ist ein Workstream?',
          en: 'What is a workstream?',
        },
        body: {
          de: 'Wenn deine Anfrage mindestens drei Sub-Themen oder eine Trigger-Phrase enthält ("Plane mir…", "Refaktor von…", "End-to-End"), erkennt der Lead-Agent das automatisch und schlägt eine Tier-Choice vor. Akzeptierst du, wird ein Workstream angelegt — alles weitere passiert in seinem Scope.',
          en: 'When your request contains at least three sub-topics or a trigger phrase ("Plan me…", "Refactor of…", "end-to-end"), the lead agent detects it automatically and offers a tier choice. If you accept, a workstream is created — everything that follows happens in its scope.',
        },
        bullets: {
          de: [
            'ID-Schema: WS-…',
            'Status: pending → running → consensus → synthesized → closed',
            'Bündelt: Master-Plan-Ticket + N Sub-Tickets + Tier-Mix + Cost + Quality',
            'Sichtbar als Liste oder Kanban unter /workstreams',
          ],
          en: [
            'ID scheme: WS-…',
            'Status: pending → running → consensus → synthesized → closed',
            'Bundles: master plan ticket + N sub-tickets + tier mix + cost + quality',
            'Visible as list or kanban at /workstreams',
          ],
        },
      },
      {
        heading: {
          de: 'Tier-Mix: Schnell · Balanced · Tief',
          en: 'Tier mix: Fast · Balanced · Deep',
        },
        body: {
          de: 'Beim Spawn entscheidest du, wieviele Slots auf welchem Modell laufen. laz.ing kennt drei Presets plus eigene Werte:',
          en: 'When spawning you decide how many slots run on which model. laz.ing knows three presets plus custom values:',
        },
        bullets: {
          de: [
            'Schnell — 0 Opus · 4 Sonnet · 8 Haiku · ≈ 90 s · breite Idee-Suche',
            'Balanced — 2 Opus · 6 Sonnet · 12 Haiku · ≈ 4 min · Default für Pläne',
            'Tief — 4 Opus · 8 Sonnet · 16 Haiku · ≈ 8 min · für komplexe Architektur',
            'Eigene Werte — Slider pro Tier, Effort separat wählbar',
          ],
          en: [
            'Fast — 0 opus · 4 sonnet · 8 haiku · ≈ 90 s · broad idea sweep',
            'Balanced — 2 opus · 6 sonnet · 12 haiku · ≈ 4 min · default for plans',
            'Deep — 4 opus · 8 sonnet · 16 haiku · ≈ 8 min · for complex architecture',
            'Custom — slider per tier, effort independently configurable',
          ],
        },
        surfaceTag: 'tier-choice',
      },
      {
        heading: {
          de: 'Master-Approval triggert Sub-Pipeline',
          en: 'Master approval triggers sub-pipeline',
        },
        body: {
          de: 'Sobald du den Master-Plan freigibst (Phase AD im Backlog), spawnt das System für jedes Sub-Ticket automatisch ein Drei-Agent-Team: senior-dev → code-reviewer → critic. Du musst nicht jeden Sub-Schritt einzeln anstoßen — du genehmigst den Plan, laz.ing exekutiert.',
          en: 'As soon as you approve the master plan (phase AD in the backlog), the system automatically spawns a three-agent team for each sub-ticket: senior-dev → code-reviewer → critic. You do not have to kick off every sub-step individually — you approve the plan, laz.ing executes.',
        },
      },
      {
        heading: {
          de: 'Synthesis durch den Lead-Agent',
          en: 'Synthesis by the lead agent',
        },
        body: {
          de: 'Wenn alle Sub-Sessions in den Status consensus gelaufen sind, sammelt der Lead-Agent ihre Ergebnisse, kombiniert sie zu einer einzigen kohärenten Antwort und postet diese als finale Surface-Card im Chat. Quellen + offene Fragen + Disagreements bleiben separat einsehbar.',
          en: 'Once all sub-sessions reach the consensus state, the lead agent collects their results, combines them into a single coherent answer and posts that as a final surface card in chat. Sources, open questions and disagreements remain separately inspectable.',
        },
        surfaceTag: 'live-swarm',
      },
    ],
    relatedRoutes: [
      { href: '/workstreams', label: { de: 'Workstreams öffnen', en: 'Open workstreams' } },
      { href: '/tickets', label: { de: 'Tickets', en: 'Tickets' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // tickets
  // ---------------------------------------------------------------------------
  {
    slug: 'tickets',
    title: {
      de: 'Tickets',
      en: 'Tickets',
    },
    lead: {
      de: 'Ein Ticket ist die kleinste eigenständige Aufgabe in laz.ing. Es lebt in einer Finite-State-Machine und ist die einzige Stelle im System, an der Aktionen verbindlich freigegeben werden.',
      en: 'A ticket is the smallest self-contained task in laz.ing. It lives inside a finite state machine and is the only place in the system where actions are formally approved.',
    },
    sections: [
      {
        heading: {
          de: 'Was definiert ein Ticket?',
          en: 'What defines a ticket?',
        },
        body: {
          de: 'Jedes Ticket hat einen Titel, einen optionalen Body, einen Workspace-Kontext, einen Status und ein Event-Log. Es kann zu einem Workstream gehören (parent_ticket_id zeigt auf das Master-Ticket) oder standalone existieren.',
          en: 'Every ticket has a title, an optional body, a workspace context, a status, and an event log. It can belong to a workstream (parent_ticket_id points to the master ticket) or live standalone.',
        },
        bullets: {
          de: [
            'ID-Schema: TCK-…',
            'Felder: title · body · workspace · status · parent_ticket_id · workstream_id',
            'Event-Log: jeder Status-Wechsel ist ein eigenes Event, nichts wird überschrieben',
            'Sichtbar im Chat als Surface-Card oder unter /tickets',
          ],
          en: [
            'ID scheme: TCK-…',
            'Fields: title · body · workspace · status · parent_ticket_id · workstream_id',
            'Event log: every status change is its own event — nothing is overwritten',
            'Visible in chat as a surface card or at /tickets',
          ],
        },
      },
      {
        heading: {
          de: 'Die FSM in fünf Schritten',
          en: 'The FSM in five steps',
        },
        body: {
          de: 'Tickets folgen einem klaren Pfad. Die linearen Schritte sind: draft → review → approved → executed → closed. Plus den Alt-Pfad rejected (mit reopen zurück nach draft) und den Rework-Zyklus (executed → review).',
          en: 'Tickets follow a clear path. The linear steps are: draft → review → approved → executed → closed. Plus the alt-path rejected (reopen returns to draft) and the rework cycle (executed → review).',
        },
        bullets: {
          de: [
            'draft — Entwurf, in Bearbeitung',
            'review — wartet auf Freigabe',
            'approved — bereit zur Ausführung',
            'executed — abgeschlossen, Ergebnis prüfen',
            'closed — archiviert (terminal)',
            'rejected — zurückgewiesen, reopen möglich',
          ],
          en: [
            'draft — draft, in progress',
            'review — waiting for approval',
            'approved — ready to execute',
            'executed — done, inspect the result',
            'closed — archived (terminal)',
            'rejected — rejected, can be reopened',
          ],
        },
        surfaceTag: 'workflow-pipeline',
      },
      {
        heading: {
          de: 'Was darf wer?',
          en: 'Who is allowed to do what?',
        },
        body: {
          de: 'Approve und Reject sind dem User vorbehalten — ein Agent darf niemals seinen eigenen Plan freigeben. Request-Approval, Execute und Close kann jeder Akteur. Reopen ist wieder user-only. Damit bleibt der Approval-Schritt eine bewusste menschliche Entscheidung, auch wenn alles drumherum automatisiert läuft.',
          en: 'Approve and reject are reserved for the user — an agent must never approve its own plan. Request-approval, execute and close can be performed by any actor. Reopen is user-only again. This keeps approval an explicit human decision, even when everything around it is automated.',
        },
      },
      {
        heading: {
          de: 'Sub-Ticket-Hierarchie',
          en: 'Sub-ticket hierarchy',
        },
        body: {
          de: 'Über parent_ticket_id formt sich ein Baum: ein Master-Plan-Ticket mit N Sub-Tickets darunter. Im Detail-View siehst du den Sub-Tree mit dem aktuellen Status jedes Knotens. Sub-Tickets erben den Workspace, aber haben eigene FSM-Zustände — du kannst Sub-A approven während Sub-B noch in review steht.',
          en: 'Through parent_ticket_id a tree forms: one master plan ticket with N sub-tickets beneath. The detail view shows the sub-tree with each node’s current status. Sub-tickets inherit the workspace but have independent FSM states — you can approve sub-A while sub-B is still in review.',
        },
      },
      {
        heading: {
          de: 'Auto-Advance vs. manuelle Aktionen',
          en: 'Auto-advance vs. manual actions',
        },
        body: {
          de: 'Wenn Auto-Mode in der TopBar aktiv ist und das System hohe Konfidenz hat, fließen draft → review und approved → executed automatisch — beim Approve-Schritt wird trotzdem auf dich gewartet. Bei niedriger Konfidenz oder destruktiven Aktionen erscheint immer eine explizite Aktions-Card im Chat.',
          en: 'When auto-mode is enabled in the top bar and the system has high confidence, draft → review and approved → executed flow automatically — the approve step still waits for you. With low confidence or destructive actions, an explicit action card is always shown in chat.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/tickets', label: { de: 'Alle Tickets', en: 'All tickets' } },
      { href: '/workstreams', label: { de: 'Workstreams', en: 'Workstreams' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // sessions
  // ---------------------------------------------------------------------------
  {
    slug: 'sessions',
    title: {
      de: 'Sessions & Agent',
      en: 'Sessions & agent',
    },
    lead: {
      de: 'Eine Session ist eine persistente claude-CLI-Instanz, die einem Workspace gehört. Sie merkt sich den Verlauf — über App-Neustarts, Server-Restarts, Schlaf-Modus hinweg. Verwaltet wird sie vom lazyos-agent-Service.',
      en: 'A session is a persistent claude-CLI instance owned by a workspace. It remembers the conversation across app restarts, server restarts, even sleep mode. It is managed by the lazyos-agent service.',
    },
    liveStat: { kind: 'sessions' },
    sections: [
      {
        heading: {
          de: 'Was ist der „Agent"? Klare Begriffe.',
          en: 'What is the "agent"? Clear terms.',
        },
        body: {
          de: 'Der Begriff Agent wird in laz.ing für GENAU EINE Sache verwendet: den lazyos-agent-Systemdienst (Port 4201). Das ist ein Node-Server, der Claude-CLI-Prozesse in tmux startet, ihren Output streamt und in der DB persistiert. Er ist NICHT der KI-Charakter selbst (das ist „Claude"), nicht ein Skill (z.B. „senior-dev", „User-Anwalt"), nicht eine Sub-Spawn (das ist ein „Tier-Spawn" oder „Roaster"). Wenn ich „Agent" sage, meine ich immer den Service.',
          en: 'The term agent in laz.ing is reserved for EXACTLY ONE thing: the lazyos-agent system service (port 4201). It is a Node server that launches Claude-CLI processes inside tmux, streams their output and persists it to the DB. It is NOT the AI character itself (that is "Claude"), nor a skill (e.g. "senior-dev", "user advocate"), nor a sub-spawn (that is a "tier spawn" or "roaster"). When I say agent, I always mean the service.',
        },
      },
      {
        heading: {
          de: 'Architektur: lazyos-web vs lazyos-agent',
          en: 'Architecture: lazyos-web vs lazyos-agent',
        },
        body: {
          de: 'Es laufen zwei systemd-Services parallel. lazyos-web (Port 4200) ist Next.js: alle UI-Routen, /api/*, Auth. lazyos-agent (Port 4201) ist der Claude-CLI-Orchestrator: er startet Spawns, liest tmux-Output, persistiert Streaming-Snapshots. Trennung ist Absicht: web kann oft restartet werden (Deploys, Build-Updates) ohne dass laufende Claude-Spawns sterben. Beide Services teilen sich dieselbe SQLite-DB.',
          en: 'Two systemd services run in parallel. lazyos-web (port 4200) is Next.js: all UI routes, /api/*, auth. lazyos-agent (port 4201) is the Claude-CLI orchestrator: it launches spawns, reads tmux output, persists streaming snapshots. The split is intentional: web can be restarted often (deploys, build updates) without killing live Claude spawns. Both services share the same SQLite DB.',
        },
      },
      {
        heading: {
          de: 'Deploy-Logik (manuelles wissen, nicht zu beachten)',
          en: 'Deploy logic (no manual action required)',
        },
        body: {
          de: 'Das Deploy-Skript scripts/lazyos-deploy-vps.sh restartet beide Services automatisch. Wenn server/-Code geändert wurde (z.B. workspace-session, streaming-snapshots, agent-server), kommt der Restart von lazyos-agent dadurch dazu — du musst nichts manuell tun. Vor 2026-04-27 lief nur web-Restart, das war ein Bug.',
          en: 'The deploy script scripts/lazyos-deploy-vps.sh restarts both services automatically. When server/* code changes (e.g. workspace-session, streaming-snapshots, agent-server), the agent restart kicks in automatically — no manual action needed. Before 2026-04-27 only the web service was restarted, that was a bug.',
        },
      },
      {
        heading: {
          de: 'Eine Session pro Workspace',
          en: 'One session per workspace',
        },
        body: {
          de: 'Jeder Workspace hat genau eine Claude-Session. Sie ist die "Hauptlinie" deines Gesprächs in diesem Kontext. Nach Boot prüft laz.ing in der Tabelle claude_sessions, ob für den Workspace noch eine UUID existiert — wenn ja, wird claude --resume <uuid> gestartet, sonst eine neue Session.',
          en: 'Every workspace owns exactly one Claude session. It is the "main thread" of your conversation in that context. After boot laz.ing checks the claude_sessions table whether a UUID still exists for the workspace — if so, claude --resume <uuid> is started, otherwise a new session begins.',
        },
        code: 'claude --resume 6e7a-...-c3 --model opus-4-7 --print',
      },
      {
        heading: {
          de: 'Tier-Spawns sind keine Sessions',
          en: 'Tier spawns are not sessions',
        },
        body: {
          de: 'Ein wichtiger Unterschied: Wenn ein Workstream 18 parallele Slots zündet, sind das keine Sessions im obigen Sinne. Es sind Wegwerf-Calls — claude --print --max-turns 1 — deren Output in eine Datei schreibt und dann stirbt. Persistent ist nur die Workspace-Session, in der die Synthesis ankommt.',
          en: 'An important distinction: when a workstream fires 18 parallel slots, those are not sessions in the sense above. They are throwaway calls — claude --print --max-turns 1 — that write output to a file and then die. Only the workspace session is persistent, and that is where the synthesis lands.',
        },
      },
      {
        heading: {
          de: 'LAZYOS_SESSION_ID Injection',
          en: 'LAZYOS_SESSION_ID injection',
        },
        body: {
          de: 'Damit Sub-Prozesse wissen, in welchem Session-Kontext sie laufen, exportiert laz.ing die Variable LAZYOS_SESSION_ID in das Environment der tmux-Pane. Hooks, Logger und Telemetry-Wrapper können sie auslesen — und Events landen sauber an der richtigen Konversation.',
          en: 'So that sub-processes know which session context they are in, laz.ing exports the LAZYOS_SESSION_ID variable into the environment of the tmux pane. Hooks, loggers and telemetry wrappers can read it — and events end up cleanly attached to the right conversation.',
        },
      },
      {
        heading: {
          de: 'Self-Heal bei Fehlern',
          en: 'Self-heal on errors',
        },
        body: {
          de: 'Wird beim Resume ein Fehler ("Session not found", "Token-Mismatch") erkannt, löscht laz.ing den Eintrag in claude_sessions und startet einen frischen Run. Du verlierst nichts Inhaltliches — der Chat-Verlauf liegt in der laz.ing-DB, nicht in der CLI-Session — aber das CLI-Side-State ist neu.',
          en: 'When an error is detected on resume ("session not found", "token mismatch"), laz.ing deletes the row in claude_sessions and starts a fresh run. You lose nothing of substance — the chat history is in the laz.ing DB, not in the CLI session — but the CLI-side state is reset.',
        },
      },
      {
        heading: {
          de: 'Stale-Checker',
          en: 'Stale checker',
        },
        body: {
          de: 'Im Hintergrund läuft ein Cron der Sessions sucht, die älter als 24 h ohne Activity sind. Sie werden geschlossen — die nächste User-Anfrage öffnet eine frische Session. Verhindert dass sich tmux-Panes über Wochen aufstapeln.',
          en: 'A background cron scans for sessions older than 24 h without activity. Those are closed — the next user request opens a fresh session. Prevents tmux panes from piling up over weeks.',
        },
      },
      {
        heading: {
          de: 'Zwei Services: lazyos-web + lazyos-agent',
          en: 'Two services: lazyos-web + lazyos-agent',
        },
        body: {
          de: 'Architektonisch laufen zwei systemd-Services nebeneinander. lazyos-web (Port 4200) ist das Next.js-Frontend mit allen UI-Routen und der API. lazyos-agent (Port 4201) orchestriert die Claude-CLI in tmux, persistiert Streaming-Snapshots und verwaltet die Workspace-Sessions. Trennung schützt: Web kann oft restartet werden (Deploys, Build-Updates) ohne dass laufende Claude-Spawns sterben. Beide Services nutzen dieselbe SQLite-DB und werden vom Deploy-Skript automatisch neugestartet.',
          en: 'Architecturally, two systemd services run side by side. lazyos-web (port 4200) is the Next.js frontend with all UI routes and the API. lazyos-agent (port 4201) orchestrates the Claude CLI in tmux, persists streaming snapshots and manages workspace sessions. The separation protects: Web can be restarted frequently (deploys, build updates) without killing running Claude spawns. Both services share the same SQLite DB and the deploy script restarts both automatically.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/sessions', label: { de: 'Aktive Sessions', en: 'Active sessions' } },
      { href: '/workspaces', label: { de: 'Workspaces', en: 'Workspaces' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // routines
  // ---------------------------------------------------------------------------
  {
    slug: 'routines',
    title: {
      de: 'Routines',
      en: 'Routines',
    },
    lead: {
      de: 'Eine Routine ist Cron + KI-Aufgabe. Du beschreibst in natürlicher Sprache, was zu tun ist und wann — laz.ing erzeugt daraus einen wiederkehrenden Workstream, der die Aufgabe selbstständig fährt.',
      en: 'A routine is cron plus an AI task. You describe in natural language what should be done and when — laz.ing turns that into a recurring workstream that runs the task on its own.',
    },
    sections: [
      {
        heading: {
          de: 'Was ist eine Routine?',
          en: 'What is a routine?',
        },
        body: {
          de: 'Eine Routine hat einen Namen, eine Beschreibung, einen Trigger und einen Workspace. Sie wird zur richtigen Zeit ausgelöst, eröffnet automatisch einen Workstream und führt die Aufgabe — meist mit einem festen Skill-Set — durch. Beispiel: "Jeden Morgen um 7:00, prüfe die Logs auf Errors der letzten 12 h und fasse sie zusammen."',
          en: 'A routine has a name, a description, a trigger and a workspace. It fires at the right time, automatically opens a workstream and runs the task — usually with a fixed skill set. Example: "Every morning at 7:00, check the logs for errors from the last 12 h and summarise them."',
        },
      },
      {
        heading: {
          de: 'Trigger-Modi',
          en: 'Trigger modes',
        },
        body: {
          de: 'Drei Modi sind möglich. Welche du wählst hängt davon ab, ob die Routine durch Zeit, durch externes Event oder ad-hoc angeworfen werden soll.',
          en: 'Three modes are available. Which one you pick depends on whether the routine should fire on time, on an external event, or ad-hoc.',
        },
        bullets: {
          de: [
            'manual — du startest sie manuell mit einem Klick auf /routines',
            'cron — Standard-Cron-Expression z.B. "0 7 * * *"',
            'event_match — fired wenn ein internes Event den Match-Pattern erfüllt',
          ],
          en: [
            'manual — you start it manually via /routines',
            'cron — standard cron expression e.g. "0 7 * * *"',
            'event_match — fires when an internal event matches the pattern',
          ],
        },
      },
      {
        heading: {
          de: 'Routine-Run = Workstream',
          en: 'Routine run = workstream',
        },
        body: {
          de: 'Jeder Routine-Lauf ist ein voller Workstream — mit Master-Ticket, Sub-Tickets und Tier-Mix. Du siehst die History der vergangenen Runs unter /routines/<id>/runs. Failed Runs sind genauso erste-Klasse wie Successful Runs: Logs, Disagreements und Errors bleiben einsehbar.',
          en: 'Every routine run is a full workstream — with master ticket, sub-tickets and tier mix. You can browse the history of past runs at /routines/<id>/runs. Failed runs are first-class just like successful ones: logs, disagreements and errors remain inspectable.',
        },
      },
      {
        heading: {
          de: 'Wann nutzen?',
          en: 'When to use?',
        },
        body: {
          de: 'Routinen lohnen sich überall dort, wo du sonst manuell die gleiche Anfrage erneut tippen würdest. Typische Kandidaten: tägliche Status-Reports, wöchentliche Retro, Wetterabhängiges PV-Posten, "Check ob meine Domain erreichbar ist", Backup-Verifikationen.',
          en: 'Routines pay off wherever you would otherwise re-type the same request manually. Typical candidates: daily status reports, weekly retros, weather-dependent PV postings, "check that my domain is reachable", backup verifications.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/routines', label: { de: 'Routinen verwalten', en: 'Manage routines' } },
      { href: '/workstreams', label: { de: 'Workstream-History', en: 'Workstream history' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // skills
  // ---------------------------------------------------------------------------
  {
    slug: 'skills',
    title: {
      de: 'Skills',
      en: 'Skills',
    },
    lead: {
      de: 'Ein Skill ist eine Fokus-Linse für einen Spawn-Slot. Er kombiniert ein Skill-Set, ein Modell-Tier und einen Effort-Level zu einem benannten Profil — z.B. "Critic auf Opus mit xhigh".',
      en: 'A skill is a focus lens for a spawn slot. It combines a skill set, a model tier, and an effort level into a named profile — e.g. "Critic on opus with xhigh".',
    },
    liveStat: { kind: 'skills' },
    sections: [
      {
        heading: {
          de: 'Was ist ein Skill?',
          en: 'What is a skill?',
        },
        body: {
          de: 'Ein Skill ist mehr als ein Label. Er definiert: aus welcher Perspektive ein Agent denkt (Skill-Set), wie tief er reasoned (Effort), und auf welchem Modell er läuft (Tier). Beim Tier-Spawn wird pro Slot der nächste aktive Skill gewählt — runde Verteilung, damit jede Perspektive vorkommt.',
          en: 'A skill is more than a label. It defines: from which perspective an agent thinks (skill set), how deeply it reasons (effort), and on which model it runs (tier). On tier spawn the next active skill is picked per slot — round-robin distribution so every perspective appears.',
        },
      },
      {
        heading: {
          de: '16 Built-Ins zum Boot',
          en: '16 built-ins at boot',
        },
        body: {
          de: 'Beim ersten Server-Start seedet laz.ing 16 Built-In-Skills in die DB: UX, Architecture, Cost, Risk, Speed, Maintenance, Brand, Mobile, Accessibility, Performance, Privacy, Failure, Onboarding, Migrate, Observability, Critic. Du kannst sie deaktivieren, aber nicht löschen — sie bilden die Basis-Diversität.',
          en: 'On first server boot laz.ing seeds 16 built-in skills into the DB: UX, Architecture, Cost, Risk, Speed, Maintenance, Brand, Mobile, Accessibility, Performance, Privacy, Failure, Onboarding, Migrate, Observability, Critic. You can deactivate them, but not delete — they form the baseline diversity.',
        },
      },
      {
        heading: {
          de: 'Eigene Skills',
          en: 'Custom skills',
        },
        body: {
          de: 'Unter /skills legst du beliebige eigene Skills an — Name, Prompt-Snippet, Default-Tier, Default-Effort, Default-Count im Tier-Mix. Beispiele aus der Praxis: "Insolvenzrecht-Sicht", "Demo PV-Brand-Fit", "Mobile-Performance-mit-Lighthouse-Gewicht". Sobald aktiv, fließt der Skill in die nächste Spawn-Runde ein.',
          en: 'At /skills you can create arbitrary custom skills — name, prompt snippet, default tier, default effort, default count in the tier mix. Real-world examples: "Insolvency law view", "Demo PV brand fit", "Mobile performance with Lighthouse weighting". Once active, the skill flows into the next spawn round.',
        },
      },
      {
        heading: {
          de: 'Default-Profile (Agent-Persona)',
          en: 'Default profiles (agent persona)',
        },
        body: {
          de: 'Skills sind die "Was denke ich?"-Achse. Daneben gibt es benannte Agent-Profile mit fester Rolle: senior-dev (schreibt Code), code-reviewer (prüft fertigen Code), critic (Advocatus Diaboli), db-architect (Schema/RLS), ux-analyst (Browser-Test). Diese Profile werden in der Sub-Pipeline nach Master-Approval verwendet.',
          en: 'Skills are the "what do I think?" axis. Alongside that there are named agent profiles with a fixed role: senior-dev (writes code), code-reviewer (reviews finished code), critic (devil’s advocate), db-architect (schema/RLS), ux-analyst (browser test). These profiles are used in the sub-pipeline after master approval.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/skills', label: { de: 'Skills verwalten', en: 'Manage skills' } },
      { href: '/workstreams', label: { de: 'Tier-Mix anwenden', en: 'Use tier mix' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // workspaces
  // ---------------------------------------------------------------------------
  {
    slug: 'workspaces',
    title: {
      de: 'Workspaces',
      en: 'Workspaces',
    },
    lead: {
      de: 'Ein Workspace ist ein Projekt-Kontext: ein Pfad auf der Disk, ein Sensitivity-Level, eine Akzentfarbe, ein Notes-Block und ein eigener Set Credentials. Alles, was du tust, passiert immer innerhalb eines Workspaces.',
      en: 'A workspace is a project context: a path on disk, a sensitivity level, an accent colour, a notes block and its own set of credentials. Everything you do always happens inside a workspace.',
    },
    liveStat: { kind: 'workspaces' },
    sections: [
      {
        heading: {
          de: 'Was definiert einen Workspace?',
          en: 'What defines a workspace?',
        },
        body: {
          de: 'Ein Workspace bündelt alles, was eine "Projekt-Identität" ausmacht. Er ist die Routing-Einheit: jede tmux-Pane, jede Claude-Session, jeder Workstream gehört zu genau einem Workspace.',
          en: 'A workspace bundles everything that makes up a "project identity". It is the routing unit: every tmux pane, every Claude session, every workstream belongs to exactly one workspace.',
        },
        bullets: {
          de: [
            'path — absoluter Pfad auf dem VPS, dort lebt der Code',
            'sensitivity — none · low · high (high = nichts in die Knowledge-Base)',
            'accent — Farbe für die UI-Identifikation',
            'notes — Mini-CLAUDE.md, wird in jeden System-Prompt injiziert',
            'brand — Logo, Tagline, Tone-of-Voice für Kunden-Projekte',
            'credentials — verschlüsselt, nur in diesem Workspace lesbar',
          ],
          en: [
            'path — absolute path on the VPS, where the code lives',
            'sensitivity — none · low · high (high = never lands in the knowledge base)',
            'accent — colour for UI identification',
            'notes — mini-CLAUDE.md, injected into every system prompt',
            'brand — logo, tagline, tone of voice for client projects',
            'credentials — encrypted, only readable inside this workspace',
          ],
        },
      },
      {
        heading: {
          de: 'Drei Tabs im Detail-View',
          en: 'Three tabs in detail view',
        },
        body: {
          de: 'Wenn du einen Workspace öffnest, siehst du drei Tabs nebeneinander:',
          en: 'When you open a workspace you see three tabs side by side:',
        },
        bullets: {
          de: [
            'Übersicht — Path, Sensitivity, Notes, letzte Sessions, letzte Workstreams',
            'Branding — Business-Brand für Kunden (Logo, Farben, Tone-of-Voice)',
            'Credentials — verschlüsselter Key-Value-Store, AES-256-GCM',
          ],
          en: [
            'Overview — path, sensitivity, notes, recent sessions, recent workstreams',
            'Branding — business brand for clients (logo, colours, tone of voice)',
            'Credentials — encrypted key-value store, AES-256-GCM',
          ],
        },
      },
      {
        heading: {
          de: 'Notes als Mini-CLAUDE.md',
          en: 'Notes as a mini CLAUDE.md',
        },
        body: {
          de: 'Im Notes-Feld trägst du Context ein, der bei jeder Anfrage in den System-Prompt fließt: Projekt-Konventionen, "immer English / immer Deutsch", "deploye via Vercel", "DB ist Drizzle, kein Prisma". Kurz halten — das geht ins jedes einzelne Prompt-Token-Budget ein.',
          en: 'Into the notes field you put context that flows into the system prompt on every request: project conventions, "always English / always German", "deploy via Vercel", "the DB is Drizzle, not Prisma". Keep it short — it counts against every single prompt token budget.',
        },
      },
      {
        heading: {
          de: 'Sensitivity-Gates',
          en: 'Sensitivity gates',
        },
        body: {
          de: 'Workspace-Sensitivity steuert was nach außen darf. high bedeutet: keine Synchronisierung in die Knowledge-Base, keine externen Telemetry-Sends, keine Logs ins Standard-File. Standard für Steuer- / Strafrechts- / Mandatsthemen ist immer high.',
          en: 'Workspace sensitivity controls what may leave the workspace. high means: no sync into the knowledge base, no external telemetry sends, no logs into the standard file. Default for tax / criminal / mandate topics is always high.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/workspaces', label: { de: 'Workspaces öffnen', en: 'Open workspaces' } },
      { href: '/credentials', label: { de: 'Credentials', en: 'Credentials' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // credentials
  // ---------------------------------------------------------------------------
  {
    slug: 'credentials',
    title: {
      de: 'Credentials',
      en: 'Credentials',
    },
    lead: {
      de: 'Credentials sind verschlüsselte Geheimnisse pro Workspace: API-Keys, Tokens, Passwörter. Sie sind AES-256-GCM-encrypted, nur im Server-Prozess lesbar, und liegen niemals als Klartext im Frontend.',
      en: 'Credentials are encrypted secrets per workspace: API keys, tokens, passwords. They are AES-256-GCM encrypted, only readable in the server process, and never appear as plaintext in the frontend.',
    },
    sections: [
      {
        heading: {
          de: 'Was ist gespeichert?',
          en: 'What is stored?',
        },
        body: {
          de: 'Pro Workspace ein Key-Value-Store: name (z.B. STRIPE_SECRET_KEY) → encrypted value. Auf dem Wire-Format liegen sie als Base64-Ciphertext mit IV und Auth-Tag. Nur der Server kann sie entschlüsseln — die PWA sieht nur Maskierung wie "sk_live_*****".',
          en: 'Per workspace a key-value store: name (e.g. STRIPE_SECRET_KEY) → encrypted value. On the wire they are base64 ciphertext with IV and auth tag. Only the server can decrypt — the PWA only sees masking such as "sk_live_*****".',
        },
        bullets: {
          de: [
            'Algorithmus: AES-256-GCM',
            'Schlüssel: env LAZYOS_CREDENTIAL_KEY (32 Hex-Bytes = 64 Hex-Chars)',
            'Speicher-Tabelle: workspace_credentials (Migration 0014)',
            'Frontend sieht: nur Name + Maskierung, nie den Klartext',
          ],
          en: [
            'Algorithm: AES-256-GCM',
            'Key: env LAZYOS_CREDENTIAL_KEY (32 hex bytes = 64 hex chars)',
            'Storage table: workspace_credentials (migration 0014)',
            'Frontend sees only name plus mask, never plaintext',
          ],
        },
      },
      {
        heading: {
          de: 'LAZYOS_CREDENTIAL_KEY rotieren',
          en: 'Rotating LAZYOS_CREDENTIAL_KEY',
        },
        body: {
          de: 'Wenn der Master-Key kompromittiert ist, rotiere mit der Rotate-Routine: alter Key wird benutzt um zu entschlüsseln, neuer Key zum erneuten Verschlüsseln, dann wird die env-Variable getauscht. Ohne Master-Key ist die Tabelle wertlos — Backups davon ohne Backup des Keys sind ungefährlich aber auch unbenutzbar.',
          en: 'If the master key is compromised, rotate via the rotate routine: old key is used to decrypt, new key to re-encrypt, then the env variable is swapped. Without the master key the table is worthless — backups without a backup of the key are harmless but also unusable.',
        },
        code: '# .env auf dem VPS\nLAZYOS_CREDENTIAL_KEY=2f5b...   # 64 hex chars',
      },
      {
        heading: {
          de: 'surface:credential-prompt im Chat',
          en: 'surface:credential-prompt in chat',
        },
        body: {
          de: 'Wenn ein Agent etwas tun soll, das einen Credential erfordert (z.B. Stripe-Call), aber der Workspace hat ihn noch nicht, emittiert der Agent eine surface:credential-prompt Card. Du siehst ein verschlüsselt-eingegebenes Input-Feld direkt im Chat — Submit speichert sofort, der Run setzt fort. Kein Wechsel in eine Settings-Page.',
          en: 'When an agent wants to do something that requires a credential (e.g. a Stripe call) but the workspace does not have it yet, the agent emits a surface:credential-prompt card. You see an encrypted input field right in the chat — submit saves immediately, the run continues. No detour into a settings page.',
        },
        surfaceTag: 'credential-prompt',
      },
      {
        heading: {
          de: 'Workspace-Isolation',
          en: 'Workspace isolation',
        },
        body: {
          de: 'Credentials sind streng pro Workspace getrennt. Auch wenn zwei Workspaces den gleichen Schlüssel-Namen verwenden (STRIPE_SECRET_KEY), sind die Werte separat — ein Bug im einen Projekt kann nie die Keys eines anderen offenlegen. Der Prime-Master-Key (.env.local) wird nicht in Workspace-Credentials kopiert.',
          en: 'Credentials are strictly partitioned per workspace. Even if two workspaces use the same key name (STRIPE_SECRET_KEY), the values are separate — a bug in one project can never leak the keys of another. The prime master key (.env.local) is never copied into workspace credentials.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/workspaces', label: { de: 'Workspaces', en: 'Workspaces' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // organizations (Phase OS / AU)
  // ---------------------------------------------------------------------------
  {
    slug: 'organizations',
    title: {
      de: 'Organisationen',
      en: 'Organizations',
    },
    lead: {
      de: 'Eine Organisation ist der Geschäfts-Container über deinen Workspaces. Sie hält Mitglieder UND Workspaces. Eine Org kann beliebig viele Workspaces verwalten — typisch: deine Agentur ist eine Org, jeder Kunde ist ein eigener Workspace darunter.',
      en: 'An organization is the business container over your workspaces. It holds members AND workspaces. One org can manage any number of workspaces — typical: your agency is an org, each client is a separate workspace under it.',
    },
    sections: [
      {
        heading: {
          de: 'Datenmodell User → Org → Workspace',
          en: 'Data model User → Org → Workspace',
        },
        body: {
          de: 'Ein User gehört zu einer oder mehreren Orgs (über org_memberships mit Rolle). Eine Org hat 1..n Workspaces (workspaces.organization_id). Jeder Workspace ist ein Projekt, ein Kunde, ein Bereich mit eigenem Chat, eigenen Tickets, eigenen Files. Eine Org bündelt alles für eine Geschäftseinheit — Mitglieder, Branding, Rechnungs-Aussteller, Cloud-Quota.',
          en: 'A user belongs to one or more orgs (via org_memberships with a role). An org has 1..n workspaces (workspaces.organization_id). Each workspace is a project, a client, a domain with its own chat, tickets, files. An org bundles everything for a business unit — members, branding, invoice issuer, cloud quota.',
        },
        bullets: {
          de: [
            'Default-Org "workspace" wird beim First-Boot angelegt (lib/orgs/constants.ts)',
            'Jeder Workspace gehört zu genau einer Org (workspaces.organization_id)',
            'org_memberships.role: founder, admin, member, viewer, guest',
            'Workspace-Override per workspace_memberships (z.B. Guest-Zugang)',
          ],
          en: [
            'Default-org "workspace" is created on first boot (lib/orgs/constants.ts)',
            'Each workspace belongs to exactly one org (workspaces.organization_id)',
            'org_memberships.role: founder, admin, member, viewer, guest',
            'Workspace-override via workspace_memberships (e.g. guest access)',
          ],
        },
      },
      {
        heading: {
          de: 'Workspace zu Org zuordnen',
          en: 'Linking a workspace to an org',
        },
        body: {
          de: 'Im Workspace-Editor (Übersicht-Tab) gibt es ein Dropdown "Organisation". Founder/Admin-Rechte in der Ziel-Org sind Pflicht. Im Org-Detail (Tab "Workspaces") kannst du auch in die andere Richtung anhängen: "+ Workspace hinzufügen" zeigt alle Workspaces, die nicht zu dieser Org gehören.',
          en: 'In the workspace editor (overview tab) there is an "Organization" dropdown. Founder/admin rights in the target org are required. In the org detail (workspaces tab) you can also attach from the other direction: "+ add workspace" shows all workspaces not belonging to this org yet.',
        },
        bullets: {
          de: [
            'Workspace-Editor → Tab Übersicht → Section "Organisation"',
            'Org-Detail → Tab "Workspaces" → "+ Workspace hinzufügen"',
            'Auto-Suggest-Hint: Workspace-ID → Org-Vorschlag aus data/org-suggestions.json',
          ],
          en: [
            'Workspace editor → Overview tab → "Organization" section',
            'Org detail → Workspaces tab → "+ add workspace"',
            'Auto-suggest hint: workspace ID → org suggestion from data/org-suggestions.json',
          ],
        },
      },
      {
        heading: {
          de: 'Rollen + Permissions',
          en: 'Roles + permissions',
        },
        body: {
          de: 'Permissions werden in lib/security/permissions.ts aus Org- und Workspace-Memberships abgeleitet. Founder darf alles, Admin verwaltet Workspaces + Mitglieder, Member arbeitet, Viewer liest, Guest sieht nur die Workspaces in denen er explizit Mitglied ist.',
          en: 'Permissions are derived in lib/security/permissions.ts from org and workspace memberships. Founder can do everything, admin manages workspaces + members, member works, viewer reads, guest only sees the workspaces they are explicit members of.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/orgs', label: { de: 'Organisationen', en: 'Organizations' } },
      { href: '/workspaces', label: { de: 'Workspaces', en: 'Workspaces' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // auth (Phase AU)
  // ---------------------------------------------------------------------------
  {
    slug: 'auth',
    title: {
      de: 'Auth + Onboarding',
      en: 'Auth + Onboarding',
    },
    lead: {
      de: 'laz.ing nutzt Magic-Link-First Login: du gibst auf /login deine Email ein, bekommst einen Login-Link per Mail, klickst, bist drin. Keine Passwörter, kein App-Geheimnis das geleakt werden kann. Beim ersten Login durchläufst du einen 6-Step-Onboarding-Wizard.',
      en: 'laz.ing uses magic-link-first login: enter your email on /login, get a login link via mail, click, you are in. No passwords, no app secret to leak. On your first login you go through a 6-step onboarding wizard.',
    },
    sections: [
      {
        heading: {
          de: 'Login-Flow',
          en: 'Login flow',
        },
        body: {
          de: 'Magic-Link wird in /api/auth/magic/issue ausgegeben (Rate-Limit: 5 pro Stunde pro Email). Wenn RESEND_API_KEY gesetzt ist, kommt die Mail über Resend; sonst landet der Verify-URL im Server-Log (Dev-Modus). Klick → /api/auth/magic/verify → Single-Use-Konsum → Session-Cookie (HttpOnly, Secure, 30 Tage TTL).',
          en: 'Magic link is issued at /api/auth/magic/issue (rate limit: 5 per hour per email). If RESEND_API_KEY is set the mail goes through Resend; otherwise the verify URL is logged to the server (dev mode). Click → /api/auth/magic/verify → single-use consumption → session cookie (HttpOnly, Secure, 30-day TTL).',
        },
        bullets: {
          de: [
            'Anti-Enumeration: API antwortet immer 200 sent:true, egal ob Email existiert',
            'Token: lzy_<43-base64url>, nur SHA-256-Hash in DB',
            'TTL: 30 Minuten (env LAZYOS_MAGIC_TTL_MS)',
            'Cookie: HttpOnly, Secure, SameSite=Lax, Format <ts>.<userId>.<hmac>',
          ],
          en: [
            'Anti-enumeration: API always answers 200 sent:true, regardless of email existence',
            'Token: lzy_<43-base64url>, only SHA-256 hash stored in DB',
            'TTL: 30 minutes (env LAZYOS_MAGIC_TTL_MS)',
            'Cookie: HttpOnly, Secure, SameSite=Lax, format <ts>.<userId>.<hmac>',
          ],
        },
      },
      {
        heading: {
          de: 'Operator-Bootstrap (fresh-installation)',
          en: 'Operator bootstrap (fresh installation)',
        },
        body: {
          de: 'Wenn die DB noch keinen Founder-User hat, schaltet die Login-Page eine zusätzliche Operator-Bootstrap-Sektion frei. Du gibst Email, Display-Name und LAZYOS_ACCESS_CODE ein, der erste Founder-Account wird angelegt, du landest direkt im Onboarding. Sobald ein Founder existiert, gibt /api/auth/bootstrap 410 Gone — single-use für die Erst-Installation.',
          en: 'If the DB has no founder user yet, the login page exposes an additional operator-bootstrap section. You enter email, display name and LAZYOS_ACCESS_CODE; the first founder account is created and you land in onboarding. Once a founder exists /api/auth/bootstrap returns 410 Gone — single use for the fresh install.',
        },
        bullets: {
          de: [
            'LAZYOS_ACCESS_CODE: 16+ Zeichen Random-Token aus .env',
            'Race-Schutz: COUNT(founder)-Check vor + nach dem Insert',
            'Audit-Log-Eintrag auth.bootstrap',
          ],
          en: [
            'LAZYOS_ACCESS_CODE: 16+ char random token in .env',
            'Race protection: COUNT(founder) check before and after the insert',
            'Audit log entry auth.bootstrap',
          ],
        },
      },
      {
        heading: {
          de: 'Onboarding-Wizard (6 Steps)',
          en: 'Onboarding wizard (6 steps)',
        },
        body: {
          de: 'Erst-User landen nach Login auf /onboarding und durchlaufen einen 6-Step-Wizard. State persistiert in users.onboarding_state, Refresh re-rendert beim aktuellen Step.',
          en: 'First-time users land on /onboarding after login and run through a 6-step wizard. State is persisted in users.onboarding_state; refresh re-renders at the current step.',
        },
        bullets: {
          de: [
            '1. Welcome — User → Org → Workspace Datenmodell-Diagramm',
            '2. Profile — Display-Name + Locale',
            '3. Organization — solo / eigene anlegen / Invite warten',
            '4. First-Workspace — Name + Sensitivity + Org (skippable)',
            '5. Claude-MAX — shared (System-Token) ODER own (eigene credentials.json)',
            '6. Done — Bestätigung + Auto-Redirect zum Workspace',
          ],
          en: [
            '1. Welcome — User → Org → Workspace data model diagram',
            '2. Profile — display name + locale',
            '3. Organization — solo / create own / wait for invite',
            '4. First workspace — name + sensitivity + org (skippable)',
            '5. Claude MAX — shared (system token) OR own (own credentials.json)',
            '6. Done — confirmation + auto redirect to workspace',
          ],
        },
      },
      {
        heading: {
          de: 'Bearer-Auth für Service-Calls',
          en: 'Bearer auth for service calls',
        },
        body: {
          de: 'Die middleware kennt drei zusätzliche Auth-Pfade neben Cookie: VPS-Bridge-Bearer (Vercel-edge → VPS), Agent/CLI-Bearer (lazyos-cli → /api/*), und Magic-Link-Token-Verify. Alle haben eigene Rate-Limits + timing-safe Compare in lib/security/bearer.ts und lib/security/crypto.ts.',
          en: 'The middleware recognizes three additional auth paths besides the cookie: VPS bridge bearer (Vercel-edge → VPS), agent/CLI bearer (lazyos-cli → /api/*), and magic-link token verify. All have their own rate limits + timing-safe compare in lib/security/bearer.ts and lib/security/crypto.ts.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/login', label: { de: 'Login', en: 'Login' } },
      { href: '/onboarding', label: { de: 'Onboarding', en: 'Onboarding' } },
      { href: '/orgs', label: { de: 'Organisationen', en: 'Organizations' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // inbox (Phase IB)
  // ---------------------------------------------------------------------------
  {
    slug: 'inbox',
    title: {
      de: 'Inbox',
      en: 'Inbox',
    },
    lead: {
      de: 'Die Inbox bündelt alles, was auf dich wartet — über alle Workspaces hinweg. Tickets in Review, approved-aber-noch-nicht-dispatchte Tickets, und stale Workstreams. Wenn nichts ansteht, ist sie leer — das ist gewollt.',
      en: 'The inbox bundles everything waiting for you — across all your workspaces. Tickets in review, approved-but-not-yet-dispatched tickets, and stale workstreams. If nothing is pending, it stays empty — that is intentional.',
    },
    sections: [
      {
        heading: {
          de: 'Quellen',
          en: 'Sources',
        },
        body: {
          de: 'Drei Aggregations-Quellen, sortiert nach Priorität (P0 zuerst). Filter: nur Workspaces, in denen du mindestens viewer bist.',
          en: 'Three aggregation sources, sorted by priority (P0 first). Filter: only workspaces in which you are at least viewer.',
        },
        bullets: {
          de: [
            'P0 · Tickets workflowState=review — wartet auf deine Freigabe',
            'P1 · Tickets workflowState=approved — wartet auf Dispatch',
            'P2 · Workstreams status=active aber updated_at > 24h — sollte das geschlossen werden?',
          ],
          en: [
            'P0 · tickets with workflowState=review — waiting for your approval',
            'P1 · tickets with workflowState=approved — waiting for dispatch',
            'P2 · workstreams with status=active but updated_at > 24h — should this be closed?',
          ],
        },
      },
      {
        heading: {
          de: 'TopNav-Badge',
          en: 'TopNav badge',
        },
        body: {
          de: '/api/inbox/count liefert ein schlankes JSON für UI-Polling. Pro User berechnet, respektiert Workspace-Permissions.',
          en: '/api/inbox/count returns a lightweight JSON for UI polling. Computed per-user, respects workspace permissions.',
        },
      },
      {
        heading: {
          de: 'Kein Push für jeden Inbox-Eintrag',
          en: 'No push for every inbox item',
        },
        body: {
          de: 'Inbox ist Pull, nicht Push — sie soll Stress reduzieren, nicht erzeugen. Echte @max-Mentions im Chat haben weiterhin ihren eigenen Push-Pfad (separat von der Inbox).',
          en: 'Inbox is pull, not push — it should reduce stress, not generate it. Real @max-mentions in chat still have their own push channel (separate from the inbox).',
        },
      },
    ],
    relatedRoutes: [
      { href: '/inbox', label: { de: 'Inbox', en: 'Inbox' } },
      { href: '/tickets', label: { de: 'Tickets', en: 'Tickets' } },
      { href: '/workstreams', label: { de: 'Workstreams', en: 'Workstreams' } },
    ],
  },

  // ---------------------------------------------------------------------------
  // ctx (Phase CTX — Compact-Button)
  // ---------------------------------------------------------------------------
  {
    slug: 'ctx',
    title: {
      de: 'Context-Compact',
      en: 'Context compact',
    },
    lead: {
      de: 'Lange Sessions im Terminal-Claude müssen irgendwann compactet werden. Der CTX-Button im TopNav schreibt vor dem Compact einen frischen Snapshot des aktuellen Workspaces ins Plan-File — sodass Claude beim Compact nicht den Faden verliert.',
      en: 'Long sessions in terminal Claude eventually need a compact. The CTX button in TopNav writes a fresh snapshot of the current workspace into the plan file before the compact — so Claude does not lose the thread when compacting.',
    },
    sections: [
      {
        heading: {
          de: 'Was im Snapshot steht',
          en: 'What goes in the snapshot',
        },
        body: {
          de: 'Pure data-driven Markdown (kein Claude-Spawn): Workspace-Header, aktive Tickets (review/approved/executing), aktive Workstreams, letzte 30 chat_message-Events. Block-Header `## Stand <ISO>` damit ein folgender Compact ihn als „aktueller Stand" erkennt.',
          en: 'Pure data-driven markdown (no Claude spawn): workspace header, active tickets (review/approved/executing), active workstreams, last 30 chat_message events. Block header `## Stand <ISO>` so a subsequent compact recognizes it as "current state".',
        },
      },
      {
        heading: {
          de: 'Wo es geschrieben wird',
          en: 'Where it gets written',
        },
        body: {
          de: 'Default-Pfad `/root/.claude/plans/active.md`. Override via env `LAZYOS_PLAN_FILE` oder POST-Body `planFile`. Cap auf 5 historische Snapshots — der jüngste oben, ältere werden abgeschnitten.',
          en: 'Default path `/root/.claude/plans/active.md`. Override via env `LAZYOS_PLAN_FILE` or POST body `planFile`. Cap of 5 historical snapshots — newest on top, older ones are trimmed.',
        },
      },
      {
        heading: {
          de: 'Eigentliche /compact passiert im Terminal',
          en: 'Actual /compact happens in terminal',
        },
        body: {
          de: 'Das Web-OS hat keinen `/compact`-Befehl — der existiert nur in Claude Code CLI. Der Button hier liefert nur den frischen Stand-Block ins Plan-File. Im Terminal-Claude kannst du danach `/compact` ausführen, und der frische Block sorgt für Kontinuität.',
          en: 'The web OS has no `/compact` command — that only exists in Claude Code CLI. The button here only writes the fresh state block into the plan file. In terminal Claude you then run `/compact`, and the fresh block keeps continuity.',
        },
      },
    ],
    relatedRoutes: [
      { href: '/', label: { de: 'Chat', en: 'Chat' } },
    ],
  },
];

export const SLUGS = SUB_PAGES.map((p) => p.slug);

export function getSubPage(slug: string): SubPageContent | null {
  return SUB_PAGES.find((p) => p.slug === slug) ?? null;
}

/** Locale-aware Card-Subline, nur Stil — wird in der Übersicht verwendet. */
export function subPageSubline(loc: Locale, slug: string): string {
  const map: Record<string, Bi<string>> = {
    workstreams: {
      de: 'Container für eine Anfrage',
      en: 'Container for a request',
    },
    tickets: {
      de: 'Atomare Aufgabe mit FSM',
      en: 'Atomic task with FSM',
    },
    sessions: {
      de: 'Persistente Claude-CLI',
      en: 'Persistent Claude CLI',
    },
    routines: {
      de: 'Cron + KI-Aufgabe',
      en: 'Cron plus AI task',
    },
    skills: {
      de: 'Fokus-Linse pro Slot',
      en: 'Focus lens per slot',
    },
    workspaces: {
      de: 'Projekt-Kontext',
      en: 'Project context',
    },
    credentials: {
      de: 'Verschlüsselter Vault',
      en: 'Encrypted vault',
    },
    organizations: {
      de: 'Geschäfts-Container',
      en: 'Business container',
    },
    auth: {
      de: 'Magic-Link + 6-Step',
      en: 'Magic link + 6-step',
    },
    inbox: {
      de: 'Was wartet auf dich?',
      en: 'What is waiting for you?',
    },
    ctx: {
      de: 'Snapshot vor /compact',
      en: 'Snapshot before /compact',
    },
  };
  return map[slug]?.[loc] ?? '';
}
