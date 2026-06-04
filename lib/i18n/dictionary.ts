/**
 * Phase OSS.3 — i18n-Foundation.
 *
 * Single-source dictionary für alle UI-Strings die später lokalisiert
 * werden müssen. Default-Locale ist `de`; `en` wird Schritt-für-Schritt
 * gefüllt. Weitere Sprachen (fr/es/zh/ja) kommen in einer 2. Welle —
 * der Loader fällt für fehlende Keys auf `en` und am Ende auf `de` zurück.
 *
 * Keine `next-intl`-Abhängigkeit, kein Provider-Tree-Setup. Wir wollen
 * heute nur die Foundation: ein Hook + eine zentrale Dictionary.
 *
 * Konventionen:
 * - Keys sind path-like (`nav.chat`, `org.list.title`, …)
 * - Values dürfen `{name}`-Platzhalter enthalten (siehe `t(key, params)`)
 * - Pluralisierung: für jetzt manuell (`'1 Workspace' | '2 Workspaces'` via
 *   eigene Helper) — kein ICU-Parser. Halten wir simple.
 */

export type Locale = 'de' | 'en' | 'fr' | 'es' | 'zh' | 'ja';

export const DEFAULT_LOCALE: Locale = 'de';
export const FALLBACK_LOCALE: Locale = 'en';
export const SUPPORTED_LOCALES: readonly Locale[] = [
  'de',
  'en',
  'fr',
  'es',
  'zh',
  'ja',
] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  de: 'Deutsch',
  en: 'English',
  fr: 'Français',
  es: 'Español',
  zh: '中文',
  ja: '日本語',
};

type Dict = Record<string, string>;

const de: Dict = {
  // Navigation
  'nav.chat': 'Chat',
  'nav.inbox': 'Inbox',
  'nav.workstreams': 'Workstreams',
  'nav.tickets': 'Tickets',
  'nav.orgs': 'Organisationen',
  'nav.orgs.active': 'Aktive Organisation',
  'nav.orgs.manage': 'Organisationen verwalten',
  'nav.workspaces': 'Workspaces',
  'nav.members': 'Mitglieder',
  'nav.routines': 'Routinen',
  'nav.observatory': 'Observatorium',
  'nav.how': 'Anleitung',
  'nav.logout': 'Abmelden',
  'nav.skills': 'Skills',
  'nav.sessions': 'Sessions',
  'nav.calendar': 'Kalender',
  'nav.menu': 'Menü öffnen',
  'nav.menu.close': 'Menü schließen',
  'nav.org.switcher.aria': 'Organisation: {name}. Klick zum Wechseln.',
  'nav.org.edit': 'Organisation bearbeiten',
  'nav.org.placeholder': 'Org wählen',
  'nav.locale.label': 'Sprache',

  // Sandwich-Sections
  'nav.section.work': 'Arbeiten',
  'nav.section.org': 'Organisation',
  'nav.section.system': 'System',

  // Org-List
  'org.list.title': 'Organisationen',
  'org.list.lead':
    '{count} sichtbar · {totalWs} Workspaces gesamt. Eine Organisation ist dein Geschäfts-Container — sie hält Mitglieder und beliebig viele Workspaces.',
  'org.list.section.own': 'Eigenprojekte',
  'org.list.section.clients': 'Kunden',
  'org.list.section.tools': 'Tools',
  'org.list.section.private': 'Privat',
  'org.list.section.other': 'Sonstige',
  'org.list.empty':
    'Du bist (noch) in keiner Organisation Mitglied. Wenn du Owner bist, melde dich neu an.',
  'org.list.create': 'Organisation anlegen',
  'org.manage.crumb': 'Organisationen · Verwalten',
  'org.manage.title': 'Organisationen verwalten',
  'org.manage.lead':
    '{count} sichtbar · {totalWs} Workspaces gesamt. Hier legst du Organisationen an, archivierst sie oder änderst den Type.',

  // Org-Detail-Tabs
  'org.tab.workspaces': 'Workspaces',
  'org.tab.overview': 'Übersicht',
  'org.tab.members': 'Mitglieder',
  'org.tab.branding': 'Branding',
  'org.suborgs.lead': '{name} hat {count} Sub-Organisation{plural}. Klick auf eine Karte öffnet die Sub-Org mit ihren Workspaces.',
  'org.workspaces.empty': 'Keine Workspaces dieser Organisation zugeordnet. Lege unten einen an.',
  'org.attach.title': 'Workspace zuordnen',

  // Workspace-List
  'workspace.list.title': 'Alle Workspaces',
  'workspace.list.lead': '{count} sichtbar.',
  'workspace.list.empty':
    'Du siehst keine Workspaces. Bitte einen Admin um Mitgliedschaft.',

  // Login
  'login.title': 'laz.ing Login',
  'login.subtitle': 'Multi-Agent OS für Claude — gebaut für Solo-Builder und Agenturen.',
  'login.email.label': 'Email',
  'login.email.placeholder': 'du@example.com',
  'login.email.submit': 'Login-Link per Mail senden',
  'login.email.sending': 'Sende …',
  'login.email.success': 'Wir haben einen Login-Link an {email} geschickt.',
  'login.email.recheck': 'Mail nicht angekommen? In 30 Sekunden nochmal probieren.',
  'login.master.toggle.show': '→ Solo-Self-Host: Login per Master-Code',
  'login.master.toggle.hide': '↑ Schließen',
  'login.master.title': 'Solo-Self-Host',
  'login.master.hint':
    'Master-Code aus deiner .env.local. Direktes Login als Founder, ohne Mail-Versand.',
  'login.master.code.label': 'Master-Code',
  'login.master.submit': 'Einloggen mit Code',
  'login.master.bootstrap.hint':
    'Erst-Installation? Nimm Operator-Bootstrap mit Email + Display-Name.',
  'login.bootstrap.title': 'Operator-Bootstrap',
  'login.bootstrap.hint':
    'Nur einmal: legt den ersten Founder-User an + erste Org. Danach 410 Gone.',
  'login.bootstrap.email': 'Founder-Email',
  'login.bootstrap.name': 'Display-Name',
  'login.bootstrap.code': 'Access-Code',
  'login.bootstrap.submit': 'Founder anlegen',

  // /innovate (Phase IN)
  'innovate.crumb': 'Innovation · Preview',
  'innovate.hero.q1': 'Was wäre, wenn diese {scope}',
  'innovate.hero.q2': 'komplett neu gedacht würde?',
  'innovate.hero.lead':
    'Die meisten KI-Tools generieren Code. laz.ing denkt UI-Strukturen neu. Drück den Innovation-Button — und ein Schwarm aus Designer-Agenten reißt die aktuelle Sicht ab.',
  'innovate.status.label': 'STATUS',
  'innovate.status.body':
    'Konzept-Phase · Skeleton-Endpoint /api/innovate liefert 501 Not Implemented mit dokumentiertem Future-Vertrag.',
  'innovate.section.flow': 'Was passiert, wenn du den Button drückst',
  'innovate.section.personas': 'Personas die du wählen kannst',
  'innovate.section.usp': 'USP gegen Cline / Roo / Cursor',
  'innovate.section.preview': 'Heute klickbar (Preview)',
  'innovate.usp.them.label': 'Sie',
  'innovate.usp.them.body': 'generieren Code aus dem Prompt.',
  'innovate.usp.us.label': 'laz.ing',
  'innovate.usp.us.body': 'denkt UI-Strukturen neu, dann erst Code.',

  // /inbox
  'inbox.title.empty': 'Nichts zu tun.',
  'inbox.title.has': '{count} Item{plural} warten auf dich.',
  'inbox.crumb': 'Inbox · Action Required',
  'inbox.empty.body':
    'Genieß es. Sobald ein Ticket auf Review steht, ein Workstream stehen bleibt oder ein Approval ansteht, taucht es hier auf.',
  'inbox.lead': 'Sortiert nach Priorität. Klick öffnet das Item direkt.',

  // Save-Status (Editoren)
  'status.idle': 'bereit',
  'status.saving': 'speichert …',
  'status.saved': 'gespeichert',
  'status.error': 'Fehler',
  'status.changes.autosave':
    'Änderungen werden beim Verlassen des Feldes automatisch gespeichert.',

  // Sniper / Workstreams
  'sniper.pause.live': 'Pause läuft · Inject möglich',
  'sniper.pause.ended': 'Pause vorbei',
  'sniper.pause.inject.placeholder':
    'Korrektur eintippen — wird wörtlich in die nächste Welle integriert.',
  'sniper.pause.inject.submit': 'Inject senden',
  'sniper.pause.cancel': 'Trotzdem stoppen',

  // Generic
  'common.save': 'Speichern',
  'common.cancel': 'Abbrechen',
  'common.delete': 'Löschen',
  'common.create': 'Anlegen',
  'common.back': 'Zurück',
  'common.continue': 'Weiter',
  'common.loading': 'Lädt …',
  'common.noresults': 'Keine Treffer.',
};

// English voll gefüllt — Single-Source nach DE für maschinelle Übersetzung.
const en: Dict = {
  // Navigation
  'nav.chat': 'Chat',
  'nav.inbox': 'Inbox',
  'nav.workstreams': 'Workstreams',
  'nav.tickets': 'Tickets',
  'nav.orgs': 'Organizations',
  'nav.orgs.active': 'Active organization',
  'nav.orgs.manage': 'Manage organizations',
  'nav.workspaces': 'Workspaces',
  'nav.members': 'Members',
  'nav.routines': 'Routines',
  'nav.observatory': 'Observatory',
  'nav.how': 'Guide',
  'nav.logout': 'Sign out',
  'nav.skills': 'Skills',
  'nav.sessions': 'Sessions',
  'nav.calendar': 'Calendar',
  'nav.menu': 'Open menu',
  'nav.menu.close': 'Close menu',
  'nav.org.switcher.aria': 'Organization: {name}. Click to switch.',
  'nav.org.edit': 'Edit organization',
  'nav.org.placeholder': 'Pick org',
  'nav.locale.label': 'Language',

  // Sandwich-Sections
  'nav.section.work': 'Work',
  'nav.section.org': 'Organization',
  'nav.section.system': 'System',

  // Org-List
  'org.list.title': 'Organizations',
  'org.list.lead':
    '{count} visible · {totalWs} workspaces total. An organization is your business container — it holds members and any number of workspaces.',
  'org.list.section.own': 'Own projects',
  'org.list.section.clients': 'Clients',
  'org.list.section.tools': 'Tools',
  'org.list.section.private': 'Private',
  'org.list.section.other': 'Other',
  'org.list.empty':
    "You aren't a member of any organization yet. If you are the owner, sign in again.",
  'org.list.create': 'Create organization',
  'org.manage.crumb': 'Organizations · Manage',
  'org.manage.title': 'Manage organizations',
  'org.manage.lead':
    '{count} visible · {totalWs} workspaces total. Create new orgs, archive, or change type here.',

  // Org-Detail-Tabs
  'org.tab.workspaces': 'Workspaces',
  'org.tab.overview': 'Overview',
  'org.tab.members': 'Members',
  'org.tab.branding': 'Branding',
  'org.suborgs.lead': '{name} has {count} sub-organization{plural}. Click a card to open it with its workspaces.',
  'org.workspaces.empty': 'No workspaces linked to this organization. Add one below.',
  'org.attach.title': 'Attach workspace',

  // Workspace-List
  'workspace.list.title': 'All workspaces',
  'workspace.list.lead': '{count} visible.',
  'workspace.list.empty': 'No workspaces visible. Ask an admin for membership.',

  // Login
  'login.title': 'laz.ing Login',
  'login.subtitle': 'Multi-agent OS for Claude — built for solo builders and agencies.',
  'login.email.label': 'Email',
  'login.email.placeholder': 'you@example.com',
  'login.email.submit': 'Send login link',
  'login.email.sending': 'Sending …',
  'login.email.success': 'Login link sent to {email}.',
  'login.email.recheck': "Didn't arrive? Try again in 30 seconds.",
  'login.master.toggle.show': '→ Solo self-host: log in with master code',
  'login.master.toggle.hide': '↑ Close',
  'login.master.title': 'Solo self-host',
  'login.master.hint':
    'Master code from your .env.local. Direct founder-login without sending mail.',
  'login.master.code.label': 'Master code',
  'login.master.submit': 'Sign in with code',
  'login.master.bootstrap.hint':
    'First install? Use operator-bootstrap with email + display name.',
  'login.bootstrap.title': 'Operator bootstrap',
  'login.bootstrap.hint':
    'One-shot: creates the first founder + first org. Then 410 Gone.',
  'login.bootstrap.email': 'Founder email',
  'login.bootstrap.name': 'Display name',
  'login.bootstrap.code': 'Access code',
  'login.bootstrap.submit': 'Create founder',

  // /innovate (Phase IN)
  'innovate.crumb': 'Innovation · Preview',
  'innovate.hero.q1': 'What if this {scope}',
  'innovate.hero.q2': 'was redesigned from scratch?',
  'innovate.hero.lead':
    'Most AI tools generate code. laz.ing rethinks UI structures. Press the Innovation button — and a swarm of designer agents tears the current view apart.',
  'innovate.status.label': 'STATUS',
  'innovate.status.body':
    'Concept phase · Skeleton endpoint /api/innovate returns 501 Not Implemented with documented future contract.',
  'innovate.section.flow': 'What happens when you press the button',
  'innovate.section.personas': 'Personas you can pick',
  'innovate.section.usp': 'USP vs Cline / Roo / Cursor',
  'innovate.section.preview': 'Clickable today (preview)',
  'innovate.usp.them.label': 'They',
  'innovate.usp.them.body': 'generate code from the prompt.',
  'innovate.usp.us.label': 'laz.ing',
  'innovate.usp.us.body': 'rethinks UI structures, then writes the code.',

  // /inbox
  'inbox.title.empty': 'Nothing to do.',
  'inbox.title.has': '{count} item{plural} waiting.',
  'inbox.crumb': 'Inbox · Action required',
  'inbox.empty.body':
    "Enjoy it. As soon as a ticket needs review, a workstream stalls, or an approval is due, it shows up here.",
  'inbox.lead': 'Sorted by priority. Click opens the item directly.',

  // Save-Status
  'status.idle': 'ready',
  'status.saving': 'saving …',
  'status.saved': 'saved',
  'status.error': 'error',
  'status.changes.autosave': 'Changes save automatically when you leave the field.',

  // Sniper / Workstreams
  'sniper.pause.live': 'Pause active · inject possible',
  'sniper.pause.ended': 'Pause ended',
  'sniper.pause.inject.placeholder':
    'Type a correction — gets integrated verbatim into the next wave.',
  'sniper.pause.inject.submit': 'Send inject',
  'sniper.pause.cancel': 'Stop anyway',

  // Generic
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.create': 'Create',
  'common.back': 'Back',
  'common.continue': 'Continue',
  'common.loading': 'Loading …',
  'common.noresults': 'No results.',
};

// 2. Welle — minimale Top-Strings. Rest fällt auf EN/DE zurück.
// Vollständige Übersetzung via scripts/i18n-translate.ts (DeepL).
const fr: Dict = {
  'nav.chat': 'Chat',
  'nav.inbox': 'Boîte de réception',
  'nav.workstreams': 'Workstreams',
  'nav.tickets': 'Tickets',
  'nav.orgs': 'Organisations',
  'nav.workspaces': 'Workspaces',
  'nav.section.work': 'Travail',
  'nav.section.org': 'Organisation',
  'nav.section.system': 'Système',
  'nav.locale.label': 'Langue',
  'org.list.title': 'Organisations',
  'org.list.section.own': 'Projets propres',
  'org.list.section.clients': 'Clients',
  'org.list.section.tools': 'Outils',
  'org.list.section.private': 'Privé',
  'login.email.submit': 'Envoyer le lien de connexion',
  'login.email.sending': 'Envoi …',
  'login.master.submit': 'Se connecter avec le code',
  'common.save': 'Enregistrer',
  'common.cancel': 'Annuler',
};
const es: Dict = {
  'nav.chat': 'Chat',
  'nav.inbox': 'Bandeja',
  'nav.workstreams': 'Workstreams',
  'nav.tickets': 'Tickets',
  'nav.orgs': 'Organizaciones',
  'nav.workspaces': 'Workspaces',
  'nav.section.work': 'Trabajo',
  'nav.section.org': 'Organización',
  'nav.section.system': 'Sistema',
  'nav.locale.label': 'Idioma',
  'org.list.title': 'Organizaciones',
  'org.list.section.own': 'Proyectos propios',
  'org.list.section.clients': 'Clientes',
  'org.list.section.tools': 'Herramientas',
  'org.list.section.private': 'Privado',
  'login.email.submit': 'Enviar enlace de acceso',
  'login.email.sending': 'Enviando …',
  'login.master.submit': 'Iniciar sesión con código',
  'common.save': 'Guardar',
  'common.cancel': 'Cancelar',
};
const zh: Dict = {
  'nav.chat': '聊天',
  'nav.inbox': '收件箱',
  'nav.section.work': '工作',
  'nav.section.org': '组织',
  'nav.section.system': '系统',
  'nav.locale.label': '语言',
  'login.email.submit': '发送登录链接',
};
const ja: Dict = {
  'nav.chat': 'チャット',
  'nav.inbox': '受信トレイ',
  'nav.section.work': '作業',
  'nav.section.org': '組織',
  'nav.section.system': 'システム',
  'nav.locale.label': '言語',
  'login.email.submit': 'ログインリンクを送信',
};

const DICTS: Record<Locale, Dict> = { de, en, fr, es, zh, ja };

/**
 * Resolve a key in a given locale with fallback chain:
 * locale → FALLBACK → DEFAULT → key itself (so missing keys are visible).
 */
export function resolve(locale: Locale, key: string): string {
  return (
    DICTS[locale][key] ??
    DICTS[FALLBACK_LOCALE][key] ??
    DICTS[DEFAULT_LOCALE][key] ??
    key
  );
}

/**
 * Translate. Replaces `{placeholder}` tokens from `params` if given.
 */
export function t(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  let str = resolve(locale, key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}

/**
 * Sniff locale from `navigator.language` / `Accept-Language` etc. Falls
 * back to `de` if nothing matches.
 */
export function sniffLocale(input: string | null | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  const lower = input.toLowerCase();
  for (const loc of SUPPORTED_LOCALES) {
    if (lower.startsWith(loc)) return loc;
  }
  return DEFAULT_LOCALE;
}
