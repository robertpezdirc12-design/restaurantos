#!/usr/bin/env bash
# Issue #12 §5 — post-deploy smoke test (za varno izdajo + rollback odločitev).
# Uporaba:
#   BASE_URL=https://restaurantos-theta.vercel.app ./scripts/smoke-test.sh
#   # opcijsko prijava: SMOKE_EMAIL=... SMOKE_PIN=...
# Izhodna koda: 0 = vse OK, 1 = napaka (CI-gate za rollback).
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
FAIL=0

step() { printf '%s\n' "→ $1"; }
pass() { printf '%s\n' "  ✓ $1"; }
err()  { printf '%s\n' "  ✗ $1"; FAIL=1; }

step "1/4 zdravje (/api/health)"
HEALTH="$(curl -sS --max-time 15 "$BASE_URL/api/health" 2>/dev/null || true)"
echo "$HEALTH" | grep -q '"status":"ok"' && pass "status=ok" || err "health ni ok: $HEALTH"
echo "$HEALTH" | grep -q '"database":"connected"' && pass "database=connected" || err "baza ni povezana"

step "2/4 lokacije (/api/auth/locations)"
LOCS="$(curl -sS --max-time 15 "$BASE_URL/api/auth/locations" 2>/dev/null || true)"
echo "$LOCS" | grep -q '"id"' && pass "lokacije dostopne" || err "lokacije niso dostopne: $(echo "$LOCS" | head -c 120)"

step "3/4 javni endpointi ne uhajajo (/api/public/menu)"
PUB="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$BASE_URL/api/public/menu" 2>/dev/null || true)"
# 200 = javni meni odprt; 401 = zaščiten brez QR žetona/identitete naprave (issue #3 fail-closed);
# 404 = ruta ne obstaja. Nobeden od teh ne uhaja celotnega menija.
[ "$PUB" = "200" ] || [ "$PUB" = "401" ] || [ "$PUB" = "404" ] && pass "javni meni varno odgovarja ($PUB)" || err "public/menu HTTP $PUB"

step "4/4 zaščita avtorizacije (protected route brez žetona = 401)"
CODE="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$BASE_URL/api/orders" 2>/dev/null || true)"
[ "$CODE" = "401" ] && pass "401 brez žetona (fail-closed deluje)" || err "/api/orders brez žetona = HTTP $CODE (pričakovano 401)"

if [ "${SMOKE_EMAIL:-}" != "" ] && [ "${SMOKE_PIN:-}" != "" ]; then
  step "5/5 prijava ($SMOKE_EMAIL)"
  LOGIN="$(curl -sS --max-time 15 -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SMOKE_EMAIL\",\"pin\":\"$SMOKE_PIN\"}" "$BASE_URL/api/auth/login" 2>/dev/null || true)"
  echo "$LOGIN" | grep -q '"token"' && pass "prijava uspešna" || err "prijava ni uspela"
fi

if [ "$FAIL" = "0" ]; then
  printf '%s\n' "SMOKE OK — deploy je zdrav."
else
  printf '%s\n' "SMOKE FAILED — razmislite o rollbacku (vercel rollback <deployment-url> ali GitLab revert)."
fi
exit $FAIL
