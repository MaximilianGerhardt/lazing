#!/usr/bin/env bash
# laz.ing — cut a release.
#
#   bash scripts/release.sh            # tag the CURRENT package.json version
#   bash scripts/release.sh 0.2.0      # bump package.json to 0.2.0, commit, tag
#
# Pushes a `v<version>` tag; the release.yml workflow then publishes a GitHub
# Release with auto-generated notes. The in-app "Update available" signal compares
# installed package.json against that release, so this is what makes updates land.

set -euo pipefail
cd "$(dirname "$0")/.."

c() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
die() { c "1;31" "✗ $*"; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required."

CUR="$(node -p "require('./package.json').version")"
NEW="${1:-$CUR}"

if [ "$NEW" != "$CUR" ]; then
  c "1;34" "▶ Bumping version $CUR → $NEW"
  node -e "const f='package.json';const p=require('./'+f);p.version=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$NEW"
  git add package.json
  git commit -m "chore(release): v$NEW"
fi

TAG="v$NEW"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "Tag $TAG already exists. Bump the version: bash scripts/release.sh <new-version>"
fi

c "1;34" "▶ Tagging $TAG"
git tag -a "$TAG" -m "laz.ing $TAG"

c "1;34" "▶ Pushing main + tag (the release.yml workflow publishes the GitHub Release)"
git push origin HEAD
git push origin "$TAG"

c "1;32" "✓ Pushed $TAG — watch the release workflow on GitHub Actions."
