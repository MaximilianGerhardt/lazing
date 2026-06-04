/**
 * scripts/i18n-translate.ts — Phase OSS.3.
 *
 * Maschinenübersetzung der DE-Source-Strings in `lib/i18n/dictionary.ts`
 * via DeepL-API. Output ist ein JSON-Patch der manuell ins Dictionary
 * übernommen wird (mit `// TODO: review`-Markern).
 *
 * Pflicht-ENV: DEEPL_API_KEY (auf https://www.deepl.com/pro-api kostenfrei
 * mit 500.000 Zeichen/Monat im Free-Tier).
 *
 * Usage:
 *   pnpm tsx scripts/i18n-translate.ts            # alle Sprachen
 *   pnpm tsx scripts/i18n-translate.ts fr es      # nur Französisch + Spanisch
 *
 * Output:
 *   /tmp/i18n-translations-<lang>.json mit { key: value }
 *   Manuell in lib/i18n/dictionary.ts mergen.
 */

const DEEPL_LANG_MAP: Record<string, string> = {
  fr: 'FR',
  es: 'ES',
  zh: 'ZH',
  ja: 'JA',
  en: 'EN-US',
};

interface DeepLResponse {
  translations: Array<{ text: string; detected_source_language: string }>;
}

async function translateBatch(
  texts: string[],
  targetLang: string,
  apiKey: string,
): Promise<string[]> {
  const url = apiKey.startsWith('free:')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  const cleanKey = apiKey.replace(/^free:/, '');

  const params = new URLSearchParams();
  for (const t of texts) params.append('text', t);
  params.append('source_lang', 'DE');
  params.append('target_lang', targetLang);
  params.append('preserve_formatting', '1');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${cleanKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!res.ok) {
    throw new Error(`DeepL ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as DeepLResponse;
  return data.translations.map((t) => t.text);
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPL_API_KEY?.trim();
  if (!apiKey) {
    console.error('DEEPL_API_KEY is required. Get a free key at https://www.deepl.com/pro-api.');
    console.error('Set with prefix `free:` for the Free-Tier API endpoint.');
    process.exit(1);
  }

  const targets = process.argv.slice(2).filter((a) => a in DEEPL_LANG_MAP);
  const finalTargets = targets.length > 0 ? targets : ['fr', 'es', 'zh', 'ja'];

  // Dictionary-Source dynamisch importieren um Side-Effects zu vermeiden.
  const dict = await import('../lib/i18n/dictionary');
  // Wir brauchen den DE-Dict — der ist nicht direkt exportiert, also
  // resolven wir die Keys via t() für alle bekannten Top-10-Keys.

  const KEYS_TO_TRANSLATE = [
    'nav.chat',
    'nav.inbox',
    'nav.workstreams',
    'nav.tickets',
    'nav.orgs',
    'nav.workspaces',
    'nav.members',
    'nav.routines',
    'nav.observatory',
    'nav.how',
    'nav.logout',
    'nav.section.work',
    'nav.section.org',
    'nav.section.system',
    'org.list.title',
    'org.list.lead',
    'org.list.section.own',
    'org.list.section.clients',
    'org.list.section.tools',
    'org.list.section.private',
    'org.list.section.other',
    'org.list.empty',
    'org.list.create',
    'workspace.list.title',
    'workspace.list.lead',
    'workspace.list.empty',
    'login.title',
    'login.email.label',
    'login.email.submit',
    'login.email.success',
    'login.master.title',
    'login.master.hint',
    'login.master.submit',
    'status.idle',
    'status.saving',
    'status.saved',
    'status.error',
  ];

  for (const lang of finalTargets) {
    console.log(`\n=== Translating to ${lang} (${DEEPL_LANG_MAP[lang]}) ===`);
    const sourceTexts = KEYS_TO_TRANSLATE.map((k) => dict.t('de', k));
    try {
      const translated = await translateBatch(sourceTexts, DEEPL_LANG_MAP[lang], apiKey);
      const out: Record<string, string> = {};
      for (let i = 0; i < KEYS_TO_TRANSLATE.length; i++) {
        out[KEYS_TO_TRANSLATE[i]] = translated[i];
      }
      const fs = await import('node:fs');
      const path = `/tmp/i18n-translations-${lang}.json`;
      fs.writeFileSync(path, JSON.stringify(out, null, 2));
      console.log(`✓ Saved ${path}`);
    } catch (err) {
      console.error(`✗ Failed for ${lang}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('\nMerge: lib/i18n/dictionary.ts. Setze // TODO: review hinter jeden Wert.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
