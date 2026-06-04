# ADR 0001 — pnpm Version Pin

**Status:** accepted  
**Date:** 2026-05-20  
**Deciders:** maintainers (autonomous decision)

---

## Context

- Since around 2026-05-15, corepack ships `pnpm@11.1.2` as "latest" by default.
- `pnpm@11` is incompatible with Node 22.11.0 — it manifests as
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` on the first `pnpm install`.
- On macOS there is also an xattr drift in the pnpm store: the
  `com.apple.provenance` attribute is missing on partial installs after
  `pnpm@11` usage, which leads to `_interop_require_default._ is not a function`
  in the app server.
- Both errors were observed and diagnosed during a crash-repair session on
  2026-05-20.
- Reference environment: macOS Apple Silicon, Node 22.11.0, pnpm 9.15.0 active
  (set manually via `corepack prepare pnpm@9.15.0 --activate`).

## Decision

pnpm is pinned to version **9.15.0**:

1. `package.json` carries the field `"packageManager": "pnpm@9.15.0"` — corepack
   reads this field and activates the correct version automatically.
2. The `install` script and `CONTRIBUTING.md` document the recovery path:
   ```bash
   corepack prepare pnpm@9.15.0 --activate
   pnpm install --force    # repairs xattr drift after an accidental pnpm@11 run
   ```

## Consequences

**Positive:**
- Reproducible builds on macOS + VPS (no "works on my machine").
- A known recovery path for xattr drift.
- corepack-based → no `.nvmrc`-style script needed; IDE integration via corepack
  works out of the box.

**Negative / accepted:**
- pnpm@9 is not the latest; future plugin incompatibilities will require a
  re-evaluation.
- pnpm@10/11 features (new patch mechanics, the catalog feature) are not
  available until the pin is upgraded.

**Reversibility:**
```bash
corepack prepare pnpm@latest --activate && pnpm install --force
```
Plus adjusting the `package.json` field.

**Sources:**
- Internal decision log.
- Local runbook notes (xattr drift, pnpm recovery).
