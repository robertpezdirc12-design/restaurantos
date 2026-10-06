# Rekonstrukcija — opombe

## Prisma sheme
- `prisma/schema.prisma` — razvojna (SQLite) shema za lokalno demo aplikacijo
- `prisma/schema.production.prisma` — **1:1 TOČNA produkcijска shema** (110 modelov, 20 enumov,
  2983 vrstic), introspekcija z `prisma db pull` iz Neon Postgres (projekt patient-violet-36825841,
  branch "main", 43 MB). Uporablja env `NEON_URI`.

## Produkcijski podatki (števec, 2026-10-06, read-only)
Location: 1 · Employee: 8 · Table: 15 · Order: 58 · OrderItem: 135 · MenuItem: 437 ·
Category: 39 · Reservation: 10 · Payment: 5 · Receipt: 3 · InventoryItem: 26 ·
LoyaltyAccount: 4 · ZReport: 3 · AuditLog: 292 · DeviceRegistry: 6 · HaccpEntry: 1

## Naslednja faza (priključitev na pravo bazo)
1. `NEON_URI=... prisma generate --schema prisma/schema.production.prisma`
2. API rute prevezati na produkcijske modele (CashRegisterShift, StaffShift, EmployeeJob,
   KotDocument, RestaurantSettings, ModifierGroups, …)
3. Deploy na Vercel projekt "restaurantos" (env se podeduje samodejno)
