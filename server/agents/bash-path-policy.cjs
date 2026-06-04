#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * bash-path-policy.cjs — laz.ing (lazyOS) PreToolUse-Bash Workspace-Path-Policy
 * ============================================================================
 *
 * WAS DAS IST (und was NICHT)
 * ---------------------------
 * Ein Claude-Code PreToolUse-Hook auf das `Bash`-Tool. Er prüft jeden
 * Shell-Befehl, den der Live-Chat-Agent ausführen will, gegen die Pfad-
 * Allowlist des aktiven Workspace und blockt Zugriffe, die in fremde
 * Workspaces oder in Secret-Zonen (`~/.ssh`, `.env`, `~/.lazyos/*` ausser
 * `cloud`, …) greifen.
 *
 * WICHTIG — ehrliche Grenze: Das ist ein DETERMINISTISCHER GUARDRAIL gegen
 * VERSEHENTLICHEN Cross-Workspace-/Secret-Zugriff, KEINE bulletproof-Sandbox
 * gegen absichtliche Obfuskation. Sobald `Bash` gewährt ist, kann ein
 * böswilliger/halluzinierender Agent die hier verwendete Token-Heuristik
 * umgehen (z.B. Pfade per Variable/`$()`/base64/`printf`/Heredoc/`eval`
 * konstruieren, Working-Directory wechseln, `find /` ohne Argument-Pfad).
 * Solche Fälle fängt nur eine echte Kernel-FS-Sandbox — die hier bewusst
 * NICHT verwendet wird, weil `claude` unter sandbox-exec beim API-Turn
 * lautlos stumm wird (empirisch verworfen). Dieser Hook ist die pragmatische
 * Schutzschicht, die OHNE den Chat zu brechen den 95%-Fall abdeckt.
 *
 * KONTRAKT (empirisch gegen claude 2.1.150 verifiziert)
 * -----------------------------------------------------
 *  - stdin = JSON: { "tool_name":"Bash", "tool_input":{ "command":"<cmd>" }, "cwd":"...", ... }
 *  - ERLAUBEN: exit 0, KEIN stdout.
 *  - BLOCKEN:  exit 0 + stdout = JSON:
 *      {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *        "permissionDecision":"deny","permissionDecisionReason":"<grund>"}}
 *    claude meldet dann „command was blocked" + zeigt den Grund.
 *
 * ENV (vom Spawn in server/workspace-session.ts gesetzt)
 * ------------------------------------------------------
 *  - LAZYOS_WORKSPACE_ID — aktiver Workspace (Pflicht für sinnvolles Gating).
 *  - LAZYOS_DB_PATH      — SQLite-Pfad. Default './data/lazyos.db' relativ zum
 *                          Repo-Root (NICHT zum Hook-cwd!).
 *  - LAZYOS_REPO_ROOT    — Repo-Root, gegen den ein relativer LAZYOS_DB_PATH
 *                          aufgelöst wird. Fallback: __dirname/../.. (der Hook
 *                          liegt unter server/agents/, also ../.. = Repo-Root).
 *
 * FAIL-OPEN-DOKTRIN
 * -----------------
 * Interner Fehler (DB nicht lesbar, JSON-Parse-Fehler, kein WORKSPACE_ID) →
 * ERLAUBEN + stderr-Log. Wir brechen niemals den Chat wegen eines
 * Infrastruktur-Fehlers. ABER: ein Treffer in einer SENSITIVE-Zone ist der
 * deterministische Kern → der blockt auch wenn die Allowlist leer/unklar ist.
 *
 * Deny-Grund ist maschinenlesbar-ish formuliert, damit der Chat ihn später als
 * Bridge-Card (Cross-Scope-Grant) rendern kann:
 *   POLICY_BLOCK [scope]: <pfad> liegt außerhalb des Workspace »<id>«. ...
 *
 * Performance: ein einziger besser-sqlite3-readonly-Open, zwei SELECTs, sonst
 * reine String-Arbeit. Weit unter dem 5s-Hook-Timeout.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

// --------------------------------------------------------------------------
// Decision helpers — der EINZIGE Ort, der stdout/exit schreibt.
// --------------------------------------------------------------------------

/** Erlauben: kein stdout, exit 0. */
function allow() {
  process.exit(0);
}

/** Blocken: deny-JSON auf stdout, exit 0. */
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/** stderr-Log, ohne den Chat zu brechen. */
function warn(msg) {
  try {
    process.stderr.write(`[bash-path-policy] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

// --------------------------------------------------------------------------
// Pfad-Normalisierung
// --------------------------------------------------------------------------

/** ~ / ~/x → $HOME-expandiert. */
function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

/**
 * Normalisiert einen Pfad auf eine absolute, ent-`..`-te Form OHNE Symlinks
 * aufzulösen (realpath würde fehlschlagen wenn der Pfad noch nicht existiert,
 * z.B. bei einem geplanten Write). Trailing-Slash entfernt (ausser root).
 */
function normalizeAbs(p, cwd) {
  let abs = expandHome(p);
  if (!path.isAbsolute(abs)) abs = path.resolve(cwd, abs);
  abs = path.normalize(abs);
  if (abs.length > 1 && abs.endsWith(path.sep)) abs = abs.slice(0, -1);
  return abs;
}

/** Liegt `child` unter (oder ist gleich) `parent`? Beide absolut+normalisiert. */
function isUnder(child, parent) {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

// --------------------------------------------------------------------------
// Pfad-Extraktion aus dem Shell-Command (pragmatische Heuristik)
// --------------------------------------------------------------------------
//
// GRENZEN (bewusst dokumentiert): Wir parsen NICHT die Shell-Grammatik. Wir
// finden Tokens, die *wie* Pfade aussehen:
//   - absolute:      /etc/passwd, /home/user/...
//   - Home:          ~/.ssh/id_rsa, ~  (→ $HOME)
//   - explizit rel.: ./src/x, ../sibling/y  (→ gegen cwd aufgelöst)
// NICHT erfasst (→ fail-open für diese Formen):
//   - bare relative ohne ./ (z.B. `cat foo/.env`) — zu viele False-Positives
//     gegen Subcommands/Flags; wir erfassen aber `.env`-Dateinamen separat (s.u.)
//   - Variablen/Substitution ($HOME/x, $(...), `...`), base64/printf-Tricks
//   - Heredocs, eval, geschachtelte Quotes
// Das ist die inhärente Grenze (siehe Header). Der Secret-Filename-Check und
// die absolute/Home/dotslash-Extraktion decken den realistischen Versehens-
// Fall ab.

function extractPathTokens(command) {
  const tokens = new Set();

  // 1) Absolute + Home + ./ + ../ Pfade. Erlaubte Pfad-Zeichen konservativ:
  //    Buchstaben/Ziffern und ./_-~@+ sowie / als Separator. Stoppt an Quotes,
  //    Whitespace, Shell-Metazeichen.
  const PATH_RE = /(?:^|[\s'"`=(:,;|&><])((?:~|\.{1,2}|\/)[A-Za-z0-9._~@+\-/]*)/g;
  let m;
  while ((m = PATH_RE.exec(command)) !== null) {
    const tok = m[1];
    if (!tok) continue;
    // Reine '.' / '..' / '~' ohne Weiteres sind cwd/home — separat behandelt
    // (cwd ist allowlisted, home als Token ist harmlos da wir nur SENSITIVE
    // Unterpfade blocken). Trotzdem aufnehmen für Vollständigkeit.
    tokens.add(tok);
  }

  // 2) Secret-DATEINAMEN unabhängig von der Pfad-Form: jedes Token, dessen
  //    Basename auf .env / .env.* matcht (auch bare-relative wie `cat .env`
  //    oder `cat config/.env.production`). Das ist der wichtigste Versehens-
  //    Fall, den (1) ohne ./-Präfix verpassen würde.
  const ENVFILE_RE = /(?:^|[\s'"`=(:,;|&><\/])([A-Za-z0-9._~@+\-\/]*\.env(?:\.[A-Za-z0-9._\-]+)?)\b/g;
  while ((m = ENVFILE_RE.exec(command)) !== null) {
    const tok = m[1];
    if (tok) tokens.add(tok);
  }

  return Array.from(tokens);
}

// --------------------------------------------------------------------------
// Allowlist + Sensitive-Zonen aus der DB bauen
// --------------------------------------------------------------------------

function resolveRepoRoot() {
  if (process.env.LAZYOS_REPO_ROOT) {
    return path.resolve(process.env.LAZYOS_REPO_ROOT);
  }
  // Hook liegt unter <repo>/server/agents/bash-path-policy.cjs → ../.. = repo
  return path.resolve(__dirname, '..', '..');
}

function resolveDbPath(repoRoot) {
  const raw = process.env.LAZYOS_DB_PATH ?? './data/lazyos.db';
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(repoRoot, raw);
}

/**
 * Öffnet die DB readonly und baut die Policy-Daten:
 *   - allow:    Liste absolute Allowlist-Roots (Workspace-Roots + cloud + tmp + cwd + ro-System)
 *   - sensitive: Liste { abs, label } absoluter Deny-Zonen-Roots
 * Wirft bei DB-Fehler → Caller fängt → fail-open (aber Secret-Filename-Check
 * läuft trotzdem, s. main()).
 */
function buildPolicy(dbPath, workspaceId, cwd) {
  const allow = [];
  const sensitive = [];

  // --- Immer erlaubt (unabhängig von DB) -----------------------------------
  const cloudRoot = path.join(HOME, '.lazyos', 'cloud');
  allow.push(cloudRoot); // Cloud-Upload-Root
  allow.push('/tmp', '/private/tmp');
  // Systemweite read-only Tool-Binaries — harmlos, NICHT denyen.
  allow.push('/usr', '/bin', '/sbin', '/opt', '/System', '/Library', '/etc', '/var/folders');
  if (cwd) allow.push(normalizeAbs(cwd, cwd)); // der Hook-cwd ist immer erlaubt

  // --- Immer sensitive (unabhängig von DB) ---------------------------------
  // ~/.lazyos komplett deny — AUSSER der cloud-Unterbaum (steht in allow, und
  // allow gewinnt, s. classifyPath). Wir tragen .lazyos als sensitive ein.
  sensitive.push({ abs: path.join(HOME, '.lazyos'), label: 'secret:lazyos-internal' });
  sensitive.push({ abs: path.join(HOME, '.ssh'), label: 'secret:ssh' });
  sensitive.push({ abs: path.join(HOME, '.aws'), label: 'secret:aws' });
  sensitive.push({ abs: path.join(HOME, '.codex'), label: 'secret:codex' });
  // ~/.claude/credentials + .credentials* (Datei ODER Verzeichnis).
  sensitive.push({ abs: path.join(HOME, '.claude', 'credentials'), label: 'secret:claude-credentials' });
  sensitive.push({ abs: path.join(HOME, '.claude', '.credentials'), label: 'secret:claude-credentials' });

  // --- DB-getriebene Workspace-Allowlist + Fremd-Workspace-Deny ------------
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Allowlist: alle FS-Roots des AKTIVEN Workspace.
    let ownRoots = [];
    try {
      ownRoots = db
        .prepare('SELECT abs_path FROM workspace_fs_roots WHERE workspace_id = ?')
        .all(workspaceId)
        .map((r) => r.abs_path)
        .filter((p) => typeof p === 'string' && p.length > 0);
    } catch (e) {
      warn(`workspace_fs_roots query failed: ${e && e.message}`);
    }
    // Fallback: der Single-Path aus workspaces.path (Rückwärtskompat — FS-Roots
    // kann leer sein, dann ist workspaces.path der Primary-Root).
    try {
      const wrow = db
        .prepare('SELECT path FROM workspaces WHERE id = ?')
        .get(workspaceId);
      if (wrow && typeof wrow.path === 'string' && wrow.path.length > 0) {
        ownRoots.push(wrow.path);
      }
    } catch (e) {
      warn(`workspaces query failed: ${e && e.message}`);
    }
    for (const r of ownRoots) allow.push(normalizeAbs(r, cwd));

    // Fremd-Workspace-Roots → sensitive. Alle ANDEREN Workspaces (id != ?):
    // deren fs_roots UND deren workspaces.path.
    try {
      const otherFsRoots = db
        .prepare(
          `SELECT r.abs_path AS p FROM workspace_fs_roots r
             WHERE r.workspace_id != ?`,
        )
        .all(workspaceId);
      for (const row of otherFsRoots) {
        if (row && typeof row.p === 'string' && row.p.length > 0) {
          sensitive.push({ abs: normalizeAbs(row.p, cwd), label: 'cross-workspace' });
        }
      }
    } catch (e) {
      warn(`other fs_roots query failed: ${e && e.message}`);
    }
    try {
      const otherWs = db
        .prepare('SELECT path FROM workspaces WHERE id != ?')
        .all(workspaceId);
      for (const row of otherWs) {
        if (row && typeof row.path === 'string' && row.path.length > 0) {
          sensitive.push({ abs: normalizeAbs(row.path, cwd), label: 'cross-workspace' });
        }
      }
    } catch (e) {
      warn(`other workspaces query failed: ${e && e.message}`);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  // Andere bekannte Projekt-Sammelordner, die NICHT in der Allowlist sind →
  // sensitive als Eltern-Heuristik. Ein konkreter Unterordner, der zum aktiven
  // Workspace gehört, steht in `allow` und gewinnt (classifyPath bevorzugt den
  // spezifischsten Allow-Treffer). Generische Projektwurzeln:
  sensitive.push({ abs: path.join(HOME, 'Documents'), label: 'cross-project' });
  sensitive.push({ abs: path.join(HOME, 'projects'), label: 'cross-project' });

  return { allow, sensitive };
}

// --------------------------------------------------------------------------
// Klassifikation eines einzelnen Pfads
// --------------------------------------------------------------------------
//
// Regel: Ein Pfad wird geblockt, wenn er in einer SENSITIVE-Zone liegt UND
// NICHT von einem (gleich-spezifischen oder spezifischeren) Allow-Root
// abgedeckt ist. „Allow gewinnt bei Spezifität" löst:
//   - ~/.lazyos/cloud/x  → allow(cloud, len) > sensitive(.lazyos, kürzer) → ALLOW
//   - ~/Documents/demo-crm (= eigener Workspace-Root) → allow > sensitive(Documents) → ALLOW
//   - ~/Documents/fremd  → kein allow-Treffer, sensitive(Documents) → DENY
//
// Rückgabe: null (ok) oder { label, zone } (block).

function classifyPath(abs, policy) {
  // Bester (= längster) Allow-Root, der abs abdeckt.
  let bestAllowLen = -1;
  for (const a of policy.allow) {
    if (isUnder(abs, a) && a.length > bestAllowLen) bestAllowLen = a.length;
  }
  // Bester (= längster) Sensitive-Root, der abs abdeckt.
  let bestSens = null;
  let bestSensLen = -1;
  for (const s of policy.sensitive) {
    if (isUnder(abs, s.abs) && s.abs.length > bestSensLen) {
      bestSensLen = s.abs.length;
      bestSens = s;
    }
  }
  if (!bestSens) return null; // in keiner Deny-Zone → ok
  // In einer Deny-Zone. Allow gewinnt nur, wenn der Allow-Root MINDESTENS so
  // spezifisch ist wie die Deny-Zone (>=). Bei exakt gleichem Pfad (z.B. der
  // Workspace-Root selbst überschneidet sich nie mit einer Secret-Zone, aber
  // cloud == .lazyos/cloud ist spezifischer als .lazyos) → allow.
  if (bestAllowLen >= bestSensLen) return null;
  return { label: bestSens.label, zone: bestSens.abs };
}

// --------------------------------------------------------------------------
// Deny-Grund (maschinenlesbar-ish, Bridge-Card-tauglich)
// --------------------------------------------------------------------------

function buildDenyReason(hit, offendingPath, workspaceId) {
  const wsLabel = workspaceId || '(unbekannt)';
  if (hit.label && hit.label.startsWith('secret')) {
    return (
      `POLICY_BLOCK [secret]: »${offendingPath}« ist eine geschützte Secret-Zone ` +
      `(${hit.label}) und liegt außerhalb des Workspace »${wsLabel}«. ` +
      `Zugriff auf Credentials/Keys braucht eine explizite Bridge-Freigabe.`
    );
  }
  // cross-workspace | cross-project
  const scope = hit.label === 'cross-workspace' ? 'cross-workspace' : 'cross-scope';
  return (
    `POLICY_BLOCK [${scope}]: »${offendingPath}« liegt außerhalb des Workspace ` +
    `»${wsLabel}«. Cross-Scope-Zugriff braucht eine Bridge-Freigabe.`
  );
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

function readStdin() {
  try {
    // fd 0, synchron — der Hook bekommt einen kompakten JSON-Blob.
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    warn(`stdin read failed: ${e && e.message}`);
    return '';
  }
}

function main() {
  const raw = readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    warn(`JSON parse failed → fail-open: ${e && e.message}`);
    return allow();
  }

  const command =
    input && input.tool_input && typeof input.tool_input.command === 'string'
      ? input.tool_input.command
      : '';
  const cwd =
    input && typeof input.cwd === 'string' && input.cwd.length > 0
      ? input.cwd
      : process.cwd();

  if (!command.trim()) return allow(); // nichts zu prüfen

  const tokens = extractPathTokens(command);
  if (tokens.length === 0) return allow(); // kein pfad-artiges Token → ok

  // Deterministischer Secret-Kern OHNE DB-Abhängigkeit: jeder Token, dessen
  // Basename auf .env / .env.* matcht, ist UNBEDINGT sensitiv — auch innerhalb
  // des eigenen Workspace (Secrets sind workspace-übergreifend tabu; .env
  // gehört in den Credential-Vault, nicht in einen `cat`). Greift VOR der
  // Allowlist-Logik, weil die cwd-Allowlist eine Workspace-lokale .env sonst
  // durchlassen würde.
  for (const tok of tokens) {
    const base = path.basename(expandHome(tok));
    if (/^\.env(\..+)?$/.test(base)) {
      let abs;
      try {
        abs = normalizeAbs(tok, cwd);
      } catch {
        abs = tok;
      }
      return deny(
        `POLICY_BLOCK [secret]: »${abs}« ist eine Secret-Datei (.env). ` +
          `Klartext-Zugriff auf Umgebungs-Secrets ist gesperrt — nutze den ` +
          `Credential-Vault. Eine Ausnahme braucht eine Bridge-Freigabe.`,
      );
    }
  }

  const workspaceId = process.env.LAZYOS_WORKSPACE_ID || '';
  const repoRoot = resolveRepoRoot();
  const dbPath = resolveDbPath(repoRoot);

  // Policy bauen. DB-Fehler → fail-open für die DB-getriebenen Teile, ABER der
  // deterministische Secret-Kern (Home-Zonen + .env-Dateinamen) läuft auch ohne
  // DB. Dazu bauen wir bei DB-Fehler eine reduzierte Policy ohne Cross-WS-Roots.
  let policy;
  try {
    if (!workspaceId) {
      warn('LAZYOS_WORKSPACE_ID not set → DB-Allowlist übersprungen, nur Secret-Kern aktiv');
      throw new Error('no-workspace-id'); // → reduzierte Policy
    }
    policy = buildPolicy(dbPath, workspaceId, cwd);
  } catch (e) {
    warn(`buildPolicy failed → reduzierter Secret-Kern: ${e && e.message}`);
    policy = buildReducedPolicy(cwd);
  }

  // Jeden Token klassifizieren; erster Block-Treffer gewinnt.
  for (const tok of tokens) {
    let abs;
    try {
      abs = normalizeAbs(tok, cwd);
    } catch {
      continue; // unparsebares Token überspringen
    }
    const hit = classifyPath(abs, policy);
    if (hit) {
      return deny(buildDenyReason(hit, abs, workspaceId));
    }
  }

  return allow();
}

/**
 * Reduzierte Policy ohne DB (fail-open-Fall): nur der deterministische
 * Secret-Kern + die unabhängig-erlaubten Roots. Cross-Workspace-Erkennung
 * entfällt (mangels DB), Cross-Project-Heuristik bleibt.
 */
function buildReducedPolicy(cwd) {
  const allow = [];
  const sensitive = [];
  allow.push(path.join(HOME, '.lazyos', 'cloud'));
  allow.push('/tmp', '/private/tmp');
  allow.push('/usr', '/bin', '/sbin', '/opt', '/System', '/Library', '/etc', '/var/folders');
  if (cwd) allow.push(normalizeAbs(cwd, cwd));
  sensitive.push({ abs: path.join(HOME, '.lazyos'), label: 'secret:lazyos-internal' });
  sensitive.push({ abs: path.join(HOME, '.ssh'), label: 'secret:ssh' });
  sensitive.push({ abs: path.join(HOME, '.aws'), label: 'secret:aws' });
  sensitive.push({ abs: path.join(HOME, '.codex'), label: 'secret:codex' });
  sensitive.push({ abs: path.join(HOME, '.claude', 'credentials'), label: 'secret:claude-credentials' });
  sensitive.push({ abs: path.join(HOME, '.claude', '.credentials'), label: 'secret:claude-credentials' });
  return { allow, sensitive };
}

main();
