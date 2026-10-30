#!/bin/sh
# OSS-13 (v1.207.0) — vstopna točka Docker/CasaOS paketa.
# Kontrakt: src/lib/selfhost-kit.ts (validateEntrypointContract); vodnik:
# docs/SELFHOST-CASAOS.md. NIČ nove logike — izvrši OBSTOJEČI lokalni profil
# (scripts/local-start.ts), ki uredi podatkovno mapo, skrivnosti, shemo,
# WAL in dnevno kopijo. TLS NAMERNO ni del paketa (CasaOS/obratni posrednik).

set -eu

DATA_DIR="${RESTAURANTOS_DATA_DIR:-/data}"

# Prvi zagon v zabojniku: brez TLS fronte čarovnik /setup prevzema ne more
# prevzeti (dokaz računa fronta), zato mora identiteta priti IZ OKOLJA.
# Pogreška ni smrtna (strežnik vstane z prazno bazo in glasnim opozorilom),
# a jo izpišemo takoj — lastnik ne ugiba.
if [ -z "${RESTAURANTOS_OWNER_EMAIL:-}" ] || [ -z "${RESTAURANTOS_OWNER_PIN:-}" ]; then
  echo "[selfhost] OPOZORILO: RESTAURANTOS_OWNER_EMAIL / RESTAURANTOS_OWNER_PIN nista nastavljena." >&2
  echo "[selfhost] Prvi prevzem namestitve v zabojniku poteka prek okolja (brez TLS ni čarovnika)." >&2
  echo "[selfhost] Nastavite ju v deploy/.env in znova zaženite storitev." >&2
fi

set -- bun scripts/local-start.ts --port 3000 --data-dir "$DATA_DIR"

if [ -n "${RESTAURANTOS_NAME:-}" ]; then
  set -- "$@" --restaurant-name "$RESTAURANTOS_NAME"
fi
if [ -n "${RESTAURANTOS_OWNER_EMAIL:-}" ]; then
  set -- "$@" --owner-email "$RESTAURANTOS_OWNER_EMAIL"
fi
if [ -n "${RESTAURANTOS_OWNER_PIN:-}" ]; then
  set -- "$@" --owner-pin "$RESTAURANTOS_OWNER_PIN"
fi
if [ -n "${RESTAURANTOS_TAX_ID:-}" ]; then
  set -- "$@" --tax-id "$RESTAURANTOS_TAX_ID"
fi
if [ -n "${RESTAURANTOS_BUSINESS_ID:-}" ]; then
  set -- "$@" --business-id "$RESTAURANTOS_BUSINESS_ID"
fi

exec "$@"
