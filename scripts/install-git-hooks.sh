#!/usr/bin/env bash
# scripts/install-git-hooks.sh
#
# Installiert die lazyos-spezifischen git-Hooks. .git/hooks/ ist NICHT
# Teil des Repos (git internals), darum dieser Installer.
#
# Was wird installiert:
#   - post-commit  → ruft scripts/auto-doc-touch.ts (CLAUDE.md +
#                    docs/CHANGELOG-AUTO.md auto-update) UND existing
#                    Commit-Bridge zum lazyos-chat.
#
# Idempotent — bei doppeltem Aufruf nichts kaputt. Bestehende Hooks die
# nicht von uns kommen werden vor Überschreiben gesichert (.bak.YYYYMMDD).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "[install-hooks] kein git repo — abort" >&2
  exit 1
fi

HOOKS_DIR="$REPO_ROOT/.git/hooks"
TARGET="$HOOKS_DIR/post-commit"
TS="$(date +%Y%m%d-%H%M%S)"

# Backup existing if it's not ours.
if [ -f "$TARGET" ] && ! grep -q "auto-doc-touch" "$TARGET" 2>/dev/null; then
  cp "$TARGET" "$TARGET.bak.$TS"
  echo "[install-hooks] gesichert: $TARGET.bak.$TS"
fi

cat > "$TARGET" <<'HOOK_EOF'
#!/usr/bin/env bash
# Auto-installed by scripts/install-git-hooks.sh
# Chained: Commit-Bridge (existing) + Auto-Doc-Touch (2026-05-03).

set +e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then exit 0; fi

# 1) Existing Commit-Bridge to lazyos-chat (best-effort).
if [ -f "$REPO_ROOT/scripts/post-commit-bridge.sh" ]; then
  (cd "$REPO_ROOT" && bash scripts/post-commit-bridge.sh) >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

# 2) Auto-Doc-Touch — CLAUDE.md + docs/CHANGELOG-AUTO.md.
#    NICHT auto-committen → sonst Endlos-Loop.
if [ -f "$REPO_ROOT/scripts/auto-doc-touch.ts" ] && command -v npx >/dev/null 2>&1; then
  (cd "$REPO_ROOT" && timeout 5 npx tsx scripts/auto-doc-touch.ts HEAD >/dev/null 2>&1) &
  disown 2>/dev/null || true
fi

exit 0
HOOK_EOF

chmod +x "$TARGET"
echo "[install-hooks] $TARGET installiert."
