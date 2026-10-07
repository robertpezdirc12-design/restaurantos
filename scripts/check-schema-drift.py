#!/usr/bin/env python3
"""Issue #4 §13 — schema drift check (read-only).

Primerja seznam modelov (`^model \\w+`) med:
  prisma/schema.prisma        (produkcijska Neon Postgres shema)
  prisma/schema.sqlite.prisma (lokalna SQLite zrcalna shema, AVTOMATSKO generirana)

Če model obstaja samo v eni shemi → exit 1 z izpisom manjkajočih (CI quality-gate).
Zavedno READ-ONLY: ne poganja scripts/build-sqlite-mirror.py (ta piše DST v place,
regeneracija zrcala ostane ročni korak po vsaki schema spremembi).

Poganja se v GitLab CI (quality-gate) in lokalno: python3 scripts/check-schema-drift.py
"""
import re
import sys

SRC = 'prisma/schema.prisma'
DST = 'prisma/schema.sqlite.prisma'

MODEL_RE = re.compile(r'^model\s+(\w+)', flags=re.M)


def models(path: str) -> set[str]:
    try:
        src = open(path, encoding='utf-8').read()
    except FileNotFoundError:
        print(f'ERROR: ni mogoče prebrati {path} (datoteka manjka?)')
        sys.exit(2)
    return set(MODEL_RE.findall(src))


def main() -> int:
    pg = models(SRC)
    lite = models(DST)

    missing_in_sqlite = sorted(pg - lite)
    missing_in_pg = sorted(lite - pg)

    print(f'schema.prisma: {len(pg)} modelov · schema.sqlite.prisma: {len(lite)} modelov')

    if not missing_in_sqlite and not missing_in_pg:
        print('OK: seznam modelov je usklajen (brez drifta).')
        return 0

    if missing_in_sqlite:
        print(f'DRIFT: {len(missing_in_sqlite)} modelov MANJKA v prisma/schema.sqlite.prisma:')
        for m in missing_in_sqlite:
            print(f'  - {m}')
        print('  → regeneriraj zrcalo: python3 scripts/build-sqlite-mirror.py')

    if missing_in_pg:
        print(f'DRIFT: {len(missing_in_pg)} modelov obstaja SAMO v schema.sqlite.prisma (manjkajo v schema.prisma):')
        for m in missing_in_pg:
            print(f'  - {m}')

    print('FAIL: schema drift — usklajuj obe shemi pred merge.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
