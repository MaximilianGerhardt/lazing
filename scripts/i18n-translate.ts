/**
 * scripts/i18n-translate.ts — Phase OSS.3.
 *
 * Machine translation of the DE source strings in `lib/i18n/dictionary.ts`
 * via the DeepL API. Output is a JSON patch that is merged manually into the
 * dictionary (with `// TODO: review` markers).
 *
 * Mandatory ENV: DEEPL_API_KEY (free at https://www.deepl.com/pro-api
 * with 500,000 characters/month on the free tier).
 *
 * Usage:
 *   pnpm tsx scripts/i18n-translate.ts            # all languages
 *   pnpm tsx scripts/i18n-translate.ts fr es      # only French + Spanish
 *
 * Output:
 *   /tmp/i18n-translations-<lang>.json with { key: value }
 *   Merge manually into lib/i18n/dictionary.ts.
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

  // Import the dictionary source dynamically to avoid side effects.
  const dict = await import('../lib/i18n/dictionary');
  // We need the DE dict — it is not exported directly, so we
  // resolve the keys via t() for all known top-10 keys.

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
