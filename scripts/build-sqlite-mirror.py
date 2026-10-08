#!/usr/bin/env python3
"""Generira prisma/schema.sqlite.prisma (lokalno zrcalo) iz prisma/schema.prisma (produkcija Neon Postgres).
Razlike: provider sqlite, Json->String, enumi->String (quoted defaults), brez @db.Decimal anotacij.
Aplikacijska koda je združljiva z obema shemama (jparse/jstr v src/lib/map.ts)."""
import re, sys

SRC = 'prisma/schema.prisma'
DST = 'prisma/schema.sqlite.prisma'
src = open(SRC).read()

enums = re.findall(r'^enum\s+(\w+)\s*\{', src, flags=re.M)
out = re.sub(r'(datasource db \{\s*provider\s*=\s*")postgresql(")', r'\1sqlite\2', src)
out = re.sub(r'@db\.Decimal\(\d+,\s*\d+\)', '', out)
for e in enums:
    out = re.sub(rf'\b{e}\b', 'String', out)
out = re.sub(r'^enum\s+\w+\s*\{[^}]*\}\n\n?', '', out, flags=re.M)
out = re.sub(r'@default\(([a-z_][a-z0-9_]*)\)', r'@default("\1")', out)
out = re.sub(r'@default\("(true|false)"\)', lambda m: '@default(' + m.group(1) + ')', out)
out = re.sub(r'\bJson\b', 'String', out)

header = '''// RestavrantOS — LOKALNA SQLite zrcalna shema (AVTOMATSKO generirana)
// Iz prisma/schema.prisma (produkcijska Neon Postgres shema, 110 modelov).
// Ponovno generiraj: python3 scripts/build-sqlite-mirror.py
// Razlike od produkcije: Json -> String (SQLite ne podpira Json), enumi -> String.
// Aplikacijska koda je združljiva z obema (jparse/jstr helperji v src/lib/map.ts).

'''
open(DST, 'w').write(header + out)
print(f'OK: {DST} (enums: {len(enums)})')
