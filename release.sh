#!/usr/bin/env bash
set -euo pipefail

# Usage: ./release.sh patch|minor|major "Changelog description"

BUMP_TYPE="${1:-}"
DESCRIPTION="${2:-}"

if [[ -z "$BUMP_TYPE" || -z "$DESCRIPTION" ]]; then
    echo "Usage: ./release.sh patch|minor|major \"Changelog description\""
    exit 1
fi

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
    echo "Error: bump type must be patch, minor, or major"
    exit 1
fi

echo "Running tests and lint..."
npm test
npm run lint

echo "Bumping version ($BUMP_TYPE)..."
NEW_VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version | tr -d 'v')
TAG="v$NEW_VERSION"
TODAY=$(date +%Y-%m-%d)

echo "Updating CHANGELOG.md..."
ENTRY="#### $NEW_VERSION ($TODAY)\n\n$DESCRIPTION\n"
sed -i '' "1s/^/$ENTRY\n/" CHANGELOG.md

echo "Committing changes..."
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release $TAG"

echo "Creating GitHub release (tag: $TAG)..."
gh release create "$TAG" --title "$TAG" --notes "$DESCRIPTION"

echo "Publishing to npm..."
npm publish

echo "Released $TAG"
