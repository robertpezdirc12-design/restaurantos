#!/usr/bin/env bash
# Issue #11 §8 — backup-database: varnostna kopija baze (sqlite ali Postgres/Neon).
# Raba: bash scripts/backup-database.sh [izhodna_mapa]
# sqlite (DATABASE_URL=file:...) → sqlite3 .backup (konsistentna kopija; fallback cp)
# Postgres (DATABASE_URL=postgresql://…) → pg_dump -Fc (custom format, pg_restore)
set -euo pipefail

OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  # .env fallback (samo DATABASE_URL vrstica, brez eha vrednosti)
  DB_URL="$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
fi

if [ -z "$DB_URL" ]; then
  echo "✗ DATABASE_URL ni nastavljen (.env ali okolje)." >&2
  exit 2
fi

if [[ "$DB_URL" == file:* ]]; then
  DB_PATH="${DB_URL#file:}"
  OUT="$OUT_DIR/backup-$STAMP.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$OUT'"
  else
    cp "$DB_PATH" "$OUT"
  fi
  echo "✓ sqlite backup: $OUT ($(du -h "$OUT" | cut -f1))"
  exit 0
fi

if [[ "$DB_URL" == postgresql://* || "$DB_URL" == postgres://* ]]; then
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "✗ pg_dump ni nameščen." >&2
    exit 2
  fi
  OUT="$OUT_DIR/backup-$STAMP.dump"
  pg_dump "$DB_URL" -Fc -f "$OUT"
  echo "✓ Postgres backup: $OUT ($(du -h "$OUT" | cut -f1))"
  exit 0
fi

echo "✗ Nepoznan DATABASE_URL protokol (pričakovano file: ali postgresql://)." >&2
exit 2
