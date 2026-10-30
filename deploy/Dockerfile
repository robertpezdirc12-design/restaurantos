# OSS-13 (v1.207.0) — Docker slika za samogostiteljstvo (NAS/CasaOS/ZimaOS).
# docs/SELFHOST-CASAOS.md — vodnik; src/lib/selfhost-kit.ts — kontrakt (pineže ta recept).
#
# ZASNOVANJE:
#  - isti runtime kot repozitorij (bun); node shebangi se IZOGIBAMO — vsi ukazi
#    tečejo prek bun na eksplicitnih poteh (vzorec scripts/local-start.ts).
#  - RESTAURANTOS_LOCAL=1: lokalni profil (sqlite, brez standalone izhoda) —
#    enako vedenje kot `bun run local` na lastnikovem računalniku.
#  - TLS NI del slike: na NAS-u ga pokrije CasaOS/ZimaOS ali obratni posrednik.
#  - podatki: /data (nosilec) — baza, skrivnosti (config.json), dnevne kopije.
#  - kontrakt preverja `bun scripts/selfhost-check.ts` in tests/v207-selfhost-kit.
#  - v1.208.0: recept IZMERJEN v čistem klonu (vse plasti); vrh gradnje ~3,7 GB RAM;
#    Railway gradi to sliko prek korenskega railway.json (builder DOCKERFILE).

FROM oven/bun:1.4 AS base

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    RESTAURANTOS_LOCAL=1

WORKDIR /app

# ── 1. odvisnosti (ločena plast za predpomnilnik; brez skript — postinstall
#      kliče `node`, ki v bun sliki ni na voljo; sqlite generate je ekspliciten) ──
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# ── 2. vir ──
COPY prisma ./prisma
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh
COPY next.config.ts tsconfig.json components.json postcss.config.mjs tailwind.config.ts ./

# ── 3. sqlite odjemalec + ograda za gradnjo (statične strani potrebujejo shemo) ──
RUN bun node_modules/prisma/build/index.js generate --schema prisma/schema.sqlite.prisma
ENV DATABASE_URL=file:/tmp/build-placeholder.db
RUN bun node_modules/prisma/build/index.js db push --schema prisma/schema.sqlite.prisma --skip-generate

# ── 4. gradnja aplikacije (isti vzorec kot scripts/local-start.ts) ──
RUN bun node_modules/next/dist/bin/next build

# ── 5. podatkovna mapa + ne-root uporabnik ──
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
ENV DATABASE_URL=file:/data/restaurantos.db \
    PORT=3000
EXPOSE 3000

# Sonda meri resnično zdravje: povezava + shema (dvostopenjska ruta, issue #76).
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
