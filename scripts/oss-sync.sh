#!/usr/bin/env bash
# laz.ing · OSS sync (maintainer tool)
#
# Copies a clean snapshot of a PRIVATE source tree into this public repo, excluding
# git history, secrets, databases, build output and known private artifacts, then
# runs the secret-gate denylist. Scrubbing any NEWLY introduced client data or
# German comments is a manual review step afterwards (see RELEASING.md).
#
# Usage:  LAZYOS_PRIVATE_SRC=/path/to/private/tree bash scripts/oss-sync.sh
#
# Safe: it only writes into the current repo (the public one) and never touches
# the source tree.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${LAZYOS_PRIVATE_SRC:-}"
[ -n "$SRC" ] || { echo "Set LAZYOS_PRIVATE_SRC=/path/to/private/tree"; exit 1; }
[ -d "$SRC" ] || { echo "Not a directory: $SRC"; exit 1; }

echo "▶ rsync clean snapshot from $SRC …"
rsync -a \
  --exclude='.git' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='data/' --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' --exclude='*.bak-*' \
  --exclude='.credential-manifest.json' \
  --exclude='.claude/worktrees/' --exclude='.claude/agent-memory/' --exclude='.claude/settings.local.json' \
  --exclude='.claude-flow/' \
  --exclude='node_modules/' \
  --exclude='.next' --exclude='.next/' --exclude='.next *' --exclude='.next-*' --exclude='.next.*' \
  --exclude='out/' --exclude='build/' --exclude='coverage/' --exclude='*.tsbuildinfo' \
  --exclude='_pending/' --exclude='docs/plans/' --exclude='docs/audits/' \
  --exclude='.mailmap' --exclude='data/max_twin.yaml' \
  --exclude='scripts/seed-prime-associates.ts' \
  --exclude='HANDOVER.md' --exclude='STARTSCHUSS.md' \
  "$SRC"/ ./

echo "▶ running secret-gate denylist …"
PATTERN='p-a\\?\.llc|prime[ -]?associates|pa-website|greenlight-fitness|energie-?heimat|energieheimat|montorrent|\bjunto\b|\bcgmh\b|\bvesso\b|bodylab|trusted[ -]?ai[ -]?partners|god[ -]?meets[ -]?humans|aivinity|\bmueller\b|@mueller|/home/dev|/Users/dev|maximiliangerhardtofficial|@gmail\.com|\.env\.prime|credential-manifest|tail0f191d|formerly-knives'
if grep -rniE "$PATTERN" --exclude-dir=node_modules --exclude-dir=.git \
     --exclude=secret-gate.yml --exclude=oss-sync.sh --exclude=RELEASING.md . ; then
  echo "⚠ Forbidden tokens found above — scrub them before committing."
  exit 1
fi
echo "✓ Sync done, secret-gate clean. Review the diff + re-translate any new German, then commit."
