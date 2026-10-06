# Rekonstrukcija — opombe

## Prisma sheme (faza 3 — DOKONČANA)
- `prisma/schema.prisma` — **CANONICAL produkcijska shema** (Neon Postgres, 110 modelov, 20 enumov,
  2983+ vrstic; 1:1 introspekcija `prisma db pull`). Uporablja env `DATABASE_URL` (Vercel podeduje
  obstoječe vrednosti). Vercel build teče proti tej shemi.
- `prisma/schema.sqlite.prisma` — **lokalno zrcalo** (avtomatsko generirano z
  `python3 scripts/build-sqlite-mirror.py`). Razlike: `Json → String` (SQLite ne podpira Json),
  `enum → String`. Aplikacijska koda je združljiva z OBEHEMA shemami prek `jparse`/`jstr` v `src/lib/map.ts`.
- `scripts/prisma-postinstall.cjs` — postinstall izbere shemo: `file:` URL → sqlite zrcalo, sicer produkcija.

## Mapper sloj (src/lib/map.ts)
UI ohranja obliko iz rekonstrukcije (UPPERCASE statusi, name/zone/seats, qty/unitPrice, ...),
konverzije na produkcijska polja potekajo v `src/lib/map.ts`:
- Table: `number`↔`name`, `area`↔`zone`, `capacity`↔`seats`, statusi available/occupied/reserved/cleaning
- Order: `orderNumber` (števec per lokacija), statusi open/sent/prepared/paid/cancelled, `notes`, `paidAt`
- OrderItem: `quantity`, `price`, `vatRate`, `menuItemName`, statusi pending/preparing/ready/served
- Employee: `pin` (scrypt, sol=email) + `pinLookup` (HMAC) + `status=active`, vloge admin/manager/staff/chef/kitchen
- Payment potek produkcije: **Check → Payment** (type: cash|card|mobile|...) + **Receipt** (FURS) + Order update
- Decimal polja: `num()` konverzija; denar zaokrožen z `r2()` na 2 decimalki

## FURS
- Simulacija: `FURS_ALLOW_SIMULATION=true` (obstojeci env na Vercelu) ALI `FURS_ENVIRONMENT=test/simulation`.
- Račun: `receiptNumber = YYYY-M-seq-premisesId`, ZOI = MD5 payload (simulacija), EOR = UUID,
  `fiscalStatus=verified`, `vatBreakdown` (JSON po stopnjah DDV).
- Produkcija piše v modela Receipt + cis* polja ostanejo default.

## Produkcijski podatki (števec, 2026-10-06, read-only)
Location: 1 · Employee: 8 · Table: 15 · Order: 58 · OrderItem: 135 · MenuItem: 437 ·
Category: 39 · Reservation: 10 · Payment: 5 · Receipt: 3 · InventoryItem: 26 ·
LoyaltyAccount: 4 · ZReport: 3 · AuditLog: 292 · DeviceRegistry: 6 · HaccpEntry: 1

## Dostop (bootstrap)
Produkcija ima lastne PIN-e (neznana originalna shema). Za obnovo dostopa dodaj na Vercel env:
`BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PIN` → prijava deluje 2h token; nato prek
`POST /api/employees` (ADMIN) nastavi PIN-e zaposlenim z novo shemo in env odstrani.

## Status faz
1. ✅ Rekonstrukcija aplikacije (Task 1) — UI + API + FURS simulacija, E2E potrjeno
2. ✅ Točna produkcijska shema (Task 2) — prisma db pull, 110 modelov
3. ✅ Prevezava API rut na produkcijske modele (Task 3) — 35 rut, mapper sloj, seed, E2E (agent-browser)
4. ⏳ Deploy na Vercel projekt "restaurantos" (env se podeduje samodejno)
