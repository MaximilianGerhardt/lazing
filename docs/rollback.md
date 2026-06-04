# Rollback guide

Fast paths back if a release breaks on prod or local. Tag a known-good commit
before each release — the tag is the only anchor you need.

## Tags

Create an annotated git tag before each significant change, e.g.
`pre-<change>-YYYY-MM-DD`. Tags are **not** deleted — they are the audit log.

## Rollback steps (VPS, lazyos-web / lazyos-agent)

```bash
cd /opt/lazyos

# 1. Preserve the current state (in case you need to recover after rollback)
git tag broken-$(date -u +%Y%m%d-%H%M%S) HEAD

# 2. Go back to the tag
git fetch --tags
git reset --hard <your-good-tag>

# 3. Re-build
pnpm install --frozen-lockfile
pnpm build

# 4. Restart services
systemctl restart lazyos-web
systemctl restart lazyos-agent

# 5. Verify
systemctl is-active lazyos-web lazyos-agent
curl -fsS http://127.0.0.1:4200/api/health
curl -fsS http://127.0.0.1:4201/api/health
```

## Rollback the database

DB migrations are **forward-only**. If a migration round-trip broke something:

```bash
# Restore a backup if you have one
cp /backup/lazyos-<date>.db ${HOME}/.lazyos/lazyos.db
systemctl restart lazyos-web lazyos-agent
```

**Backup recommendation:** before each migration tag, run
`cp ~/.lazyos/lazyos.db ~/.lazyos/lazyos-<tag>.db`.

## Rollback on a PaaS (if you deploy there too)

Most PaaS providers let you promote a previous production deployment back from
their dashboard or CLI. Consult your provider's docs.

## Known build issue (PDF generation)

A production build can fail with a file-tracing error originating from
`lib/cloud/pdf-from-markdown.ts`, which uses `path.join(process.cwd(),
"node_modules", "pdfkit", ...)` to load PDF fonts. Some bundlers' tracing flags
this as unsafe.

**Workaround:** a local `pnpm build` runs cleanly. Possible fixes:
- Ship the `pdfkit` fonts statically in `public/` (no more `process.cwd()`).
- Lazy-load `lib/cloud/pdf-from-markdown.ts` via dynamic import (see below).
- Move PDF generation to a separate worker service.

```ts
// lib/cloud/pdf-from-markdown.ts → top-level only type defs.
// Isolate fs calls in an async function loaded only at runtime via dynamic import:
export async function generatePdf(md: string): Promise<Buffer> {
  const { _internal } = await import('./pdf-from-markdown.impl.js');
  return _internal(md);
}
```

## Tagging (before each new change)

```bash
TAG="pre-<change>-$(date +%Y-%m-%d)"
git tag -a "$TAG" HEAD -m "State before <change>. <short description>"
git push origin "$TAG"
echo "Rollback point: $TAG"
```
