#!/bin/bash
# Taor — pre-publish verification script
# Run before `npm publish --workspaces` to verify all quality gates.
set -e

echo "=== Build ==="
npm run build

echo "=== Typecheck ==="
npm run typecheck

echo "=== Test ==="
npm run test

echo "=== Audit (production deps) ==="
npm audit --audit-level=high --omit=dev

echo "=== Pack dry-run ==="
for pkg in packages/*/; do
  (cd "$pkg" && npm pack --dry-run 2>&1 | grep -q "total files" && echo "  $pkg: OK") || {
    echo "  $pkg: FAILED"
    exit 1
  }
done

echo "=== ALL CHECKS PASSED ==="
