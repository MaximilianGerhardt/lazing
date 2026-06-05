# Releasing laz.ing

This document describes how maintainers cut releases and keep the public repository
free of private/owner/client data.

## Repository model

- **This public repo** (`MaximilianGerhardt/lazing`) is the open-source release. It
  must never contain client data, owner PII, machine-specific paths, or secrets.
- Development may happen in a separate private working tree. Whatever the source,
  the **de-sensitization invariants** below must hold before every push.

## De-sensitization invariants (enforced by CI)

The [`secret-gate`](.github/workflows/secret-gate.yml) workflow blocks any push/PR
that reintroduces forbidden tokens (client names, owner emails/domains, `/home/dev`
or `/Users/dev` paths, credential manifests, etc.). Locally, run the same check:

```bash
grep -rniE 'p-a\.llc|prime-associates|greenlight-fitness|energie-?heimat|montorrent|\bjunto\b|\bcgmh\b|bodylab|trusted-ai-partners|/home/dev|/Users/dev|@gmail\.com|\.env\.prime' \
  --exclude-dir=node_modules --exclude-dir=.git .
# expected: no output
```

Additional rules:
- **English only** for all docs, comments, and commit messages.
- A fresh install must seed **only a generic default org/workspace** — never real orgs/workspaces.
- Keep the `lazyos-*` code identifiers (legacy schema behind the laz.ing brand).
- New source files carry an `SPDX-License-Identifier: AGPL-3.0-or-later` header.

## Syncing from a private source tree

If you develop in a private tree, use the helper to copy a clean snapshot in and
re-run the gate (it never copies `.git`, `.env*`, `data/`, build dirs, or other
private artifacts):

```bash
LAZYOS_PRIVATE_SRC=/path/to/private/tree bash scripts/oss-sync.sh
# then review the diff, re-scrub any NEW client/German content, and commit.
```

`oss-sync.sh` does the mechanical copy + secret-gate; scrubbing newly-introduced
client data or German comments is a manual review step.

## Cutting a release

The in-app update check (`GET /api/system/version`) and `scripts/lazyos-update.sh`
compare against the **latest GitHub release tag**, so every release needs a tag.

**One command** (recommended):

```bash
pnpm typecheck                    # no NEW errors vs the documented baseline
bash scripts/release.sh 0.2.0     # bump package.json → commit → tag v0.2.0 → push
#   (omit the version to tag the CURRENT package.json version)
```

Pushing the `v*` tag triggers `.github/workflows/release.yml`, which publishes a
GitHub Release with auto-generated notes. Until a release exists that is newer
than a running instance's `package.json`, the in-app "Update available" signal
stays quiet.

Manual equivalent, if you prefer:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main --tags
gh release create vX.Y.Z --generate-notes
```

Self-hosters then update either **in-app** (What's new → **Update now**, localhost
only) or with `bash scripts/lazyos-update.sh` (pull → install → migrate → guarded
build swap → restart, DB backed up first). Both run the same script.
