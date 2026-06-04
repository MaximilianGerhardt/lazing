#!/usr/bin/env node
/**
 * lazyos-tunnel — gebündelter Tunnel-Manager für den öffentlichen Kundenzugang
 * (Gathering-Intelligence / sicheres OSS-Hosting, 2026-06-02).
 *
 * Problem: Kunden-Share-Links zeigten auf localhost oder eine EPHEMERE
 * trycloudflare-URL, die bei jedem Neustart stirbt. Dieser Manager hält einen
 * Tunnel am Leben, schreibt die öffentliche URL automatisch nach
 * LAZYOS_PREVIEW_BASE_URL (.env.local — von publicBaseUrl() bevorzugt gelesen)
 * und WARNT laut, wenn eine Quick-Tunnel-URL rotiert (alte Links sterben →
 * reissue nötig).
 *
 * Verben:
 *   node scripts/lazyos-tunnel.mjs up                  # Quick-Tunnel (Zero-Config, ephemer)
 *   node scripts/lazyos-tunnel.mjs up --named --hostname chat.example.com
 *   node scripts/lazyos-tunnel.mjs status
 *   node scripts/lazyos-tunnel.mjs down
 *
 * Empfehlung (siehe docs/plans/2026-06-02_secure-oss-hosting-plan.md):
 *  - DEFAULT für echte Kunden = Named Tunnel (persistente URL, am Edge auf NUR
 *    /c/ + /api/subchats/external/ beschränkt).
 *  - Zero-Config-Fallback = Quick Tunnel (ephemer, „demo/dev only").
 *
 * Reine Node-ESM, keine Build-Abhängigkeit. cloudflared muss installiert sein
 * (brew install cloudflared / apt). Keine Secrets werden geloggt.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const ENV_FILE = join(REPO, '.env.local');
// Laufzeit-Datei: publicBaseUrl() (lib/hosting/public-base.ts) liest sie PRO
// REQUEST → eine neue Tunnel-URL propagiert LIVE in alle Kunden-Links, OHNE
// App-Neustart (anders als .env.local, das `next start` beim Boot einfriert).
const RUNTIME_URL_FILE = join(REPO, 'data', 'public-url');
const LOG = '/tmp/lazyos-cf-tunnel.log';
const LOCAL_PORT = Number(process.env.LAZYOS_PORT || 4200);
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TS_URL_RE = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
function log(...a) { console.log('[tunnel]', ...a); }
function warnBox(lines) {
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '─'.repeat(w);
  console.log(c.yellow(`┌${bar}┐`));
  for (const l of lines) console.log(c.yellow(`│  ${l.padEnd(w - 2)}│`));
  console.log(c.yellow(`└${bar}┘`));
}

function haveCloudflared() {
  const r = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * cloudflared sicherstellen — bei Bedarf automatisch installieren (Out-of-the-Box).
 * macOS: Homebrew, sonst offizielles Binary nach ~/.local/bin. Linux: Binary.
 * Liefert true, wenn am Ende verfügbar.
 */
function ensureCloudflared() {
  if (haveCloudflared()) return true;
  log(c.yellow('cloudflared nicht gefunden — versuche automatische Installation …'));
  const plat = process.platform;
  if (plat === 'darwin') {
    if (spawnSync('brew', ['--version']).status === 0) {
      log(c.dim('… via Homebrew (brew install cloudflared)'));
      spawnSync('brew', ['install', 'cloudflared'], { stdio: 'inherit' });
      if (haveCloudflared()) return true;
    }
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
    return downloadCloudflared(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`, true);
  }
  if (plat === 'linux') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    return downloadCloudflared(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`, false);
  }
  console.error(c.red('Automatische Installation für diese Plattform nicht unterstützt — bitte cloudflared manuell installieren: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'));
  return false;
}

function downloadCloudflared(url, isTgz) {
  const bin = join(homedir(), '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const dest = join(bin, isTgz ? 'cloudflared.tgz' : 'cloudflared');
  log(c.dim(`… lade ${url}`));
  const dl = spawnSync('curl', ['-fsSL', '-o', dest, url], { stdio: 'inherit' });
  if (dl.status !== 0) { console.error(c.red('Download fehlgeschlagen.')); return false; }
  if (isTgz) {
    spawnSync('tar', ['-xzf', dest, '-C', bin], { stdio: 'inherit' });
  }
  spawnSync('chmod', ['+x', join(bin, 'cloudflared')]);
  // PATH-Hinweis, falls ~/.local/bin nicht drin ist.
  process.env.PATH = `${bin}:${process.env.PATH}`;
  if (haveCloudflared()) { log(c.green(`✔ cloudflared installiert → ${join(bin, 'cloudflared')}`)); return true; }
  console.error(c.yellow(`cloudflared liegt in ${bin}, ist aber nicht im PATH. Füge hinzu: export PATH="${bin}:$PATH"`));
  return false;
}

/** LAZYOS_PREVIEW_BASE_URL in .env.local upserten (andere Zeilen unberührt). */
function writeEnvBase(url) {
  let body = '';
  if (existsSync(ENV_FILE)) body = readFileSync(ENV_FILE, 'utf8');
  const line = `LAZYOS_PREVIEW_BASE_URL=${url}`;
  if (/^LAZYOS_PREVIEW_BASE_URL=.*$/m.test(body)) {
    body = body.replace(/^LAZYOS_PREVIEW_BASE_URL=.*$/m, line);
    writeFileSync(ENV_FILE, body);
  } else if (existsSync(ENV_FILE)) {
    appendFileSync(ENV_FILE, (body.endsWith('\n') ? '' : '\n') + line + '\n');
  } else {
    writeFileSync(ENV_FILE, line + '\n');
  }
  // Laufzeit-Datei für LIVE-Propagation (kein App-Neustart nötig).
  writeRuntimeUrl(url);
}

/** Aktuelle öffentliche URL in data/public-url schreiben (live von der App gelesen). */
function writeRuntimeUrl(url) {
  try {
    mkdirSync(dirname(RUNTIME_URL_FILE), { recursive: true });
    writeFileSync(RUNTIME_URL_FILE, url.replace(/\/+$/, '') + '\n');
  } catch (e) {
    log(c.yellow('Konnte data/public-url nicht schreiben: ' + (e?.message || e)));
  }
}
function readEnvBase() {
  if (!existsSync(ENV_FILE)) return null;
  const m = readFileSync(ENV_FILE, 'utf8').match(/^LAZYOS_PREVIEW_BASE_URL=(.*)$/m);
  return m ? m[1].trim() : null;
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--named') a.named = true;
    else if (t === '--tailscale') a.tailscale = true;
    else if (t === '--hostname') a.hostname = argv[++i];
    else a._.push(t);
  }
  return a;
}

// ── QUICK TUNNEL (Zero-Config, ephemer) ──────────────────────────────────────
function up_quick() {
  if (!ensureCloudflared()) process.exit(1);
  log(c.bold('Quick-Tunnel') + c.dim(` → http://127.0.0.1:${LOCAL_PORT}  (ephemer, „demo/dev only")`));
  let current = null;
  let child = null;
  let stopping = false;

  const start = () => {
    child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${LOCAL_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf) => {
      const s = buf.toString();
      try { appendFileSync(LOG, s); } catch { /* ignore */ }
      const m = s.match(URL_RE);
      if (m) {
        const url = m[0];
        if (url !== current) {
          if (current === null) {
            current = url;
            writeRuntimeUrl(url); // nur Datei (live, kein App-Neustart) — Quick-URL ist ephemer
            console.log('');
            console.log(c.green('✔ öffentliche URL aktiv: ') + c.bold(url));
            console.log(c.dim('  → in data/public-url geschrieben. Kunden-Links nutzen sie SOFORT (kein Neustart).'));
            console.log(c.dim(`  → Beispiel-Kundenlink: ${url}/c/<token>`));
            console.log('');
          } else {
            // ROTATION — alte Links sterben.
            current = url;
            writeRuntimeUrl(url);
            warnBox([
              'QUICK-TUNNEL-URL HAT ROTIERT — alte Kundenlinks sind TOT.',
              `neue URL: ${url}`,
              'Bereits verschickte Links müssen NEU ausgestellt werden.',
              'Für eine STABILE URL: up --named --hostname chat.deine-domain.tld',
            ]);
          }
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (stopping) return;
      console.error(c.yellow(`cloudflared beendet (code ${code}) — Neustart in 2s …`));
      setTimeout(start, 2000);
    });
  };

  process.on('SIGINT', () => { stopping = true; child?.kill(); log('beendet.'); process.exit(0); });
  process.on('SIGTERM', () => { stopping = true; child?.kill(); process.exit(0); });
  start();
  log(c.dim('Supervisor läuft (Auto-Restart an). Beenden mit Strg-C. Log: ' + LOG));
}

// ── NAMED TUNNEL (persistent, path-scoped am Edge) ───────────────────────────
const CFG_DIR = join(homedir(), '.cloudflared');
const CFG_FILE = join(CFG_DIR, 'lazyos-config.yml');

function cloudflaredConfig(hostname, tunnelName) {
  // Edge-Ingress NUR auf die öffentlichen Kunden-Prefixe + statische Assets,
  // alles andere 404 (defense-in-depth über middleware.ts PUBLIC_PREFIXES).
  return `# laz.ing Named-Tunnel — generiert von scripts/lazyos-tunnel.mjs
# Nur die Kunden-/Public-Prefixe erreichen den Origin; alles andere → 404.
tunnel: ${tunnelName}
credentials-file: ${join(CFG_DIR, tunnelName + '.json')}

ingress:
  - hostname: ${hostname}
    path: ^/c(/.*)?$
    service: http://127.0.0.1:${LOCAL_PORT}
  - hostname: ${hostname}
    path: ^/api/subchats/external(/.*)?$
    service: http://127.0.0.1:${LOCAL_PORT}
  - hostname: ${hostname}
    path: ^/(_next/static|icon|apple-touch-icon|manifest\\.webmanifest|favicon)(/.*)?.*$
    service: http://127.0.0.1:${LOCAL_PORT}
  # Catch-all: alles andere (Operator-Flächen, /login, /terminal …) bleibt unerreichbar.
  - service: http_status:404
`;
}

function up_named(hostname) {
  if (!hostname) {
    console.error(c.red('--hostname fehlt. Beispiel: up --named --hostname chat.deine-domain.tld'));
    process.exit(1);
  }
  if (!ensureCloudflared()) process.exit(1);
  const tunnelName = 'lazyos';
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(CFG_FILE, cloudflaredConfig(hostname, tunnelName));
  log(c.green('✔ path-scoped Ingress-Config geschrieben: ') + CFG_FILE);
  console.log('');
  console.log(c.bold('Named-Tunnel-Setup (einmalig, account-/domain-abhängig):'));
  console.log(c.cyan(`  1) cloudflared tunnel login`) + c.dim('   # Browser-Login, wählt deine Cloudflare-Domain'));
  console.log(c.cyan(`  2) cloudflared tunnel create ${tunnelName}`) + c.dim('   # erzeugt Tunnel + Credentials-JSON'));
  console.log(c.cyan(`  3) cloudflared tunnel route dns ${tunnelName} ${hostname}`));
  console.log(c.cyan(`  4) cloudflared tunnel --config ${CFG_FILE} run ${tunnelName}`) + c.dim('   # bzw. service install'));
  console.log('');
  console.log(c.bold('Danach in .env.local setzen (mache ich jetzt):'));
  writeEnvBase(`https://${hostname}`);
  console.log(c.green(`  ✔ LAZYOS_PREVIEW_BASE_URL=https://${hostname}`));
  console.log(c.dim('  → App einmal neu starten, dann zeigen alle Kunden-Links stabil auf diese Domain.'));
  console.log('');
  console.log(c.bold('Verifiziere die Path-Scope-Invariante:'));
  console.log(c.dim(`  curl -sI https://${hostname}/api/health   # erwartet: erreichbar (public)`));
  console.log(c.dim(`  curl -sI https://${hostname}/decisions     # erwartet: 404 (Operator-Fläche NICHT exponiert)`));
}

// ── TAILSCALE FUNNEL (stabile URL, kostenloser Account, KEINE eigene Domain) ──
function haveTailscale() {
  return spawnSync('tailscale', ['version'], { encoding: 'utf8' }).status === 0;
}

function up_tailscale() {
  if (!haveTailscale()) {
    console.error(c.red('tailscale nicht gefunden.'));
    console.log(c.bold('Installieren (kostenlos, ergibt eine STABILE URL ohne eigene Domain):'));
    console.log(c.cyan('  macOS:  brew install tailscale   ') + c.dim('(oder Tailscale-App)'));
    console.log(c.cyan('  Linux:  curl -fsSL https://tailscale.com/install.sh | sh'));
    process.exit(1);
  }
  const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (st.status !== 0) {
    console.error(c.yellow('Tailscale nicht aktiv/eingeloggt. Einmalig: ') + c.cyan('tailscale up') + c.dim('  (kostenloser Account)'));
    process.exit(1);
  }
  let dns = null;
  try { dns = JSON.parse(st.stdout)?.Self?.DNSName?.replace(/\.$/, ''); } catch { /* ignore */ }

  log(c.bold('Tailscale Funnel') + c.dim(` → http://127.0.0.1:${LOCAL_PORT}  (stabile URL, kostenloser Account, keine Domain)`));
  const f = spawnSync('tailscale', ['funnel', '--bg', String(LOCAL_PORT)], { encoding: 'utf8' });
  if (f.status !== 0) {
    console.error(c.red('Funnel-Aktivierung fehlgeschlagen:'));
    console.error(c.dim((f.stderr || f.stdout || '').trim()));
    console.log(c.yellow('Funnel + HTTPS müssen im Tailscale-Admin (Access Controls / Funnel) fürs Tailnet erlaubt sein.'));
    process.exit(1);
  }
  let url = dns ? `https://${dns}` : null;
  const fs2 = spawnSync('tailscale', ['funnel', 'status'], { encoding: 'utf8' });
  const m = (fs2.stdout || '').match(TS_URL_RE);
  if (m) url = m[0];
  if (!url) { console.error(c.red('Konnte Funnel-URL nicht ermitteln (tailscale funnel status).')); process.exit(1); }
  writeEnvBase(url);
  console.log('');
  console.log(c.green('✔ STABILE öffentliche URL aktiv: ') + c.bold(url));
  console.log(c.dim('  → .env.local + data/public-url (live). Bleibt über App-/Rechner-Neustarts gleich.'));
  console.log(c.dim(`  → Beispiel-Kundenlink: ${url}/c/<token>`));
  console.log(c.dim('  → Läuft im Hintergrund (tailscaled). Stoppen: tailscale funnel --bg ' + LOCAL_PORT + ' off'));
}

function readRuntimeUrl() {
  try { const v = readFileSync(RUNTIME_URL_FILE, 'utf8').trim(); return v || null; } catch { return null; }
}

function status() {
  // Effektive Reihenfolge wie die App: Datei zuerst, dann ENV.
  const fileUrl = readRuntimeUrl();
  const envUrl = readEnvBase();
  const base = fileUrl || envUrl;
  const running = spawnSync('pgrep', ['-f', 'cloudflared tunnel'], { encoding: 'utf8' }).stdout.trim();
  const tsRunning = spawnSync('pgrep', ['-f', 'tailscaled'], { encoding: 'utf8' }).stdout.trim();
  log('aktive öffentliche URL:', base ? c.bold(base) : c.red('(keine — pnpm public)'));
  log('  Quelle:', fileUrl ? c.dim('data/public-url (live)') : envUrl ? c.dim('.env.local (ENV)') : c.dim('—'));
  log('cloudflared läuft:', running ? c.green('ja (PID ' + running.split('\n').join(', ') + ')') : c.dim('nein'));
  if (tsRunning) log('tailscaled läuft:', c.green('ja'));
  if (base && /^https?:\/\//.test(base) && !/localhost|127\.0\.0\.1/.test(base)) {
    const r = spawnSync('curl', ['-s', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', base + '/api/health'], { encoding: 'utf8' });
    log('öffentliche Erreichbarkeit /api/health:', r.stdout === '200' ? c.green('200') : c.red(r.stdout || 'fehlgeschlagen'));
  }
}

function down() {
  const r = spawnSync('pkill', ['-f', 'cloudflared tunnel'], { encoding: 'utf8' });
  log(r.status === 0 ? c.green('cloudflared-Tunnel beendet.') : c.dim('kein laufender cloudflared-Tunnel gefunden.'));
  // Laufzeit-URL löschen → Share-Links fallen sauber auf Request-Origin/ENV
  // zurück statt auf eine tote Tunnel-URL zu zeigen.
  try { rmSync(RUNTIME_URL_FILE, { force: true }); log(c.dim('data/public-url entfernt.')); } catch { /* ignore */ }
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const verb = args._[0] || 'up';
if (verb === 'up') {
  if (args.tailscale) up_tailscale();
  else if (args.named) up_named(args.hostname);
  else up_quick();
} else if (verb === 'status') {
  status();
} else if (verb === 'down') {
  down();
} else {
  console.log('Verwendung: node scripts/lazyos-tunnel.mjs <up|status|down> [--tailscale | --named --hostname H]');
  console.log('  up               Quick-Tunnel (Zero-Config, kein Account, ephemere URL)  ← Default');
  console.log('  up --tailscale   Tailscale Funnel (kostenloser Account, STABILE URL, keine Domain)');
  console.log('  up --named --hostname chat.deine-domain.tld   (eigene Domain, edge-path-scoped)');
  process.exit(1);
}
