# RestaurantOS — Arhitektura (issue #12 §8)

> Posodobljeno: v1.82.8 (writeAudit). Ta dokument opisuje DEJANSKO arhitekturo, ne želeno.

## Sistemski pregled

```
Client (POS web / kiosk / QR gost / delivery platforma / print agent)
        │
        ▼
API Security Layer  ── src/lib/api.ts + auth.ts + tenant.ts + rate-limit.ts
   • authentication (Bearer HMAC žeton, sessionVersion revokacija)
   • authorization  (RBAC: CanonicalPermission, requirePermission)
   • tenant/location scope (assertResourceLocation, locationScope, assertTenantScope)
   • rate limit (RateLimitStore: memoryStore | upstashStore)
   • audit (AuditLog) + dogodki (EventLog publish/dispatch)
        │
        ▼
Domain API (139 Next.js route.ts handlerjev; App Router, vse prek /api/*)
   orders · kitchen · tables · menus · employees · shifts · furs · delivery
   devices · sync · public (QR/kiosk) · enterprise · events · reports · print
   haccp · ap/ar · expenses · batch · recurring · cron · admin/migrate-* …
        │
        ▼
Data layer — Prisma ORM
   • produkcija: Neon Postgres (prisma/schema.prisma, 118 modelov, 20 enumov)
   • lokalni dev: SQLite zrcalo (prisma/schema.sqlite.prisma — ista koda, preslikani tipi; drift-check v CI)
   • durable tipe uporablja koda (src/lib/prisma-types.ts) — deluje z obema clientoma
        │
        ▼
Integracije (Adapterji)
   • FURS fiskalizacija (simulacija; EOR/ZOI; fursEnvironment=test)
   • Delivery platforme (Glovo/Wolt webhook: HMAC + idempotencija + rate limit)
   • Payment terminal (src/lib/devices/terminal.ts — brez kartičnih podatkov)
```

## Identiteta in hierarhija

```
Tenant/Organization → Brand → Property → Location (operativno sidro)
                                        ├─ RevenueCenter
                                        ├─ Workstation
                                        ├─ DeviceRegistry
                                        └─ Employee (RBAC + sessionVersion + MFA)
```

- `Location` je operativno sidro vseh transakcijskih podatkov (Order, Payment, Receipt, …) — vsi imajo `locationId`.
- Enterprise drevo (#11): `Location.propertyId → Property.brandId → Brand.organizationId`.
- Tenant meja (#12): če sta orgi uporabnika in vira znani in različni → 403 (fail-closed). Legacy nevezani podatki → obstoječa lokacijska zaščita. Glej `docs/TENANT-ISOLATION.md`.

## Kanonični sistemi (zero-duplication, issue #12 §9)

| Domain | Kanon | Kje |
|---|---|---|
| Narocila | `Order` + `OrderItem` (+ `createOrderCore`) | src/lib/ops.ts |
| Placila | `Payment` (cardLast4, brez PAN/CVV; idempotencyKey unique) | orders/[id], furs |
| Racuni/fiskal | `Receipt` + FURS modul | src/lib/furs, /api/furs |
| Meni | `Menu → Category → MenuItem` | /api/menus, /api/categories |
| Zaloge | `InventoryItem`, `StockTransaction`, `InventoryBatch` | /api/inventory |
| Zaposleni | `Employee` + `permissionOverrides` | /api/employees |
| Gosti | `Guest*`, `Reservation`, `WaitlistEntry` | /api/reservations, /api/guests |
| Naprave | `DeviceRegistry` (enroll/pair/revoke) | /api/devices |
| Audit | `AuditLog` (+ `EventLog` #11) | /api/audit, /api/events |
| Enterprise | `Organization → Brand → Property` | /api/enterprise |
| Offline/sync | `DeviceSyncOperation` (idempotentno) | /api/sync |
| Integracije | `Integration` + `IntegrationLog` | /api/integrations, /api/delivery |

**Ni dovoljeno** uvajati vzporednih sistemov za zgornje domene (issue #12 §9) — vedno razširi kanon.

## Frontend — dashboard plast

```
src/app/dashboard/page.tsx (~3.168 vrstic)
  └─ DashboardInner: stanje (121 hookov) + POS zavihki (pregled/mize/naročila/prodaja/kuhinja/meni/rezervacije/računi …)
       └─ src/components/dashboard-tabs.tsx — ČISTI BARREL (41 vrstic, samo re-exporti; edini potrošnik je page.tsx)
            └─ src/components/tabs/*.tsx — 14 domenskih datotek (~9.560 vrstic)
```

| Datoteka (src/components/tabs/) | Vrstic | Izvozi (komponente) |
|---|---|---|
| nabava-tab.tsx | 1421 | NabavaTab |
| ops-cards.tsx | 1266 | SalesByHourCard, LaborCostCard, DursCheckButton, NotificationsCard, BatchesCard, BatchPrepCard, UpsellCard, DisplayPromosCard |
| gostinske-ops-tab.tsx | 1170 | DarilneKarticeTab, OdpadTab, CakalnaListaTab |
| backoffice-tab.tsx | 1080 | DeliveryTab, AccountingExportCard, GlJournalCard, NapitnineTab |
| urniki-tab.tsx | 1016 | DelovniCasTab, OdpiralniCasTab, DiscountsTab |
| analitika-tab.tsx | 599 | MenuEngineeringTab (Kasavana-Smith), KdsStatsSection |
| zaloga-tab.tsx | 560 | InventoryTab |
| finance-tab.tsx | 523 | ShiftsTab, ExpensesTab |
| enterprise-tab.tsx | 405 | EnterpriseTab, MigrationsConsoleSection |
| urnik-izmen-tab.tsx | 380 | StaffScheduleTab |
| nastavitve-tab.tsx | 351 | JobsCard, SettingsEditor, DevicesCard |
| haccp-tab.tsx | 329 | HaccpTab |
| integracje-tab.tsx | 288 | IntegracijeTab |
| gostje-tab.tsx | 173 | LoyaltyTab, FeedbackTab |

- **Zgodovina razreza:** monolit dashboard-tabs.tsx 9.217 → 41 vrstic (−99,5 %; valovi v1.82.1→v1.82.7). Vsak premik byte-identičen (python diff dokazi v commitih); `page.tsx` (edini potrošnik) nespremenjen skozi vse valove. Nova komponenta gre v svojo domensko datoteko po grozdu — monolit ne sme več rasti.
- **Audit pisanje:** `src/lib/audit-chain.ts` (v1.82.8) — `writeAudit(prisma, opts)` centralizira nid() + auditChainFields() + auditLog.create(); 114/124 pisalnih mest v 80 API rutah uporablja helper (10 mest ročno: haccpEntry model, monitoring/errors vrača vrstico, webhook shorthand, staff-shifts ne-adjacent deklaracija).
- **Fiskalizacija:** `src/lib/furs/issue.ts` (v1.82.2) — izdajanje računov/EOR/ZOI (878 vrstic iz POST /api/furs rute); ruta ostaja tanek HTTP ovoj.

## Varnostni sloj — kje je kaj

| Funkcija | Datoteka |
|---|---|
| Žeton (HMAC, exp) + revokacija | src/lib/auth.ts (`createToken`, `sessionRevoked`) |
| requireAuth / requirePermission | src/lib/api.ts |
| Location scope | src/lib/api.ts (`assertResourceLocation`, `locationScope`, `requireUserLocation`) |
| Tenant scope | src/lib/tenant.ts (`guardResource`/`assertOrgScope` — ŽIVO povezano v rute od v1.53.0; `chainForLocation`, `assertTenantScope` jedro) |
| Enterprise hierarhija | src/lib/enterprise.ts (`enterpriseAllows`) |
| Rate limit (store seam) | src/lib/rate-limit.ts |
| MFA (TOTP + recovery) | src/lib/mfa.ts, /api/auth/mfa/* |
| Webhook podpisi | src/lib/delivery.ts (`verifyWebhookSignature`) |
| Javni QR/kiosk | src/lib/guest.ts (server-side ločevanje lokacije) |
| Device enroll/revoke | /api/devices/enroll, src/lib/devices/* |

## Deployment

- **Vercel** (Git integration: push na `main` → samodejni produkcijski build; produkcija: restaurantos-theta.vercel.app)
- **GitHub Actions = quality gate** (`ci.yml`: Neon Postgres drift-smoke + tsc/lint/testi/secrets na vsak push na main). POZOR (AUDIT-FIX opomba v1.82.1): Vercel Git integration deploya NEPOMEDEJENO s CI — rdeč CI ne ustavi deploya; disciplina je "pushamo le lokalno zeleno". Trajna rešitev: Vercel → Settings → Git → preklopi "Deploy only when checks pass" (ali GitHub Checks integracija).
- **Mirror**: GitHub = avtoritativna koda (Vercel deploy + CI); GitLab = push-mirror varnostna kopija (sync-check varovalka)
- Migracije: aditivni in-app endpointi (`/api/admin/migrate-*`) — idempotentne DDL, `requireCentralRole` + audit
- Podrobnosti odpornosti: `docs/DEPLOYMENT-RESILIENCE.md`
