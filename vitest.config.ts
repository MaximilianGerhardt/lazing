/**
 * lazyOS · vitest config (eingefuehrt 2026-04-27 mit Streaming-Recovery V2 Tests).
 *
 * - Co-located tests via `*.test.ts(x)` neben den Sources.
 * - happy-dom als DOM-Env (fuer lib/chat/draft.ts — localStorage).
 * - Pfad-Alias `@/*` analog tsconfig.json damit Tests `@/lib/...` importieren koennen.
 * - `node_modules` und `.next` aus Discovery raus (Default ist OK, wir sind explizit).
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      'server/tools.v1-mcp-deprecated/**',
    ],
    globals: false,
    // Tests laufen sequenziell — wir benutzen :memory: SQLite-Instanzen
    // in den Streaming-Recovery-Tests und wollen keine cross-test-Stoerung.
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
