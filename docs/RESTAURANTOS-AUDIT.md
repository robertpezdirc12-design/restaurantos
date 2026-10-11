# RestaurantOS — P0 AUDIT poročilo

- **Datum:** 2026-10-09
- **HEAD ob auditu:** `main` (lokalno = GitLab = GitHub `c117548` + popravki tega audita)
- **Izvedel:** Z.ai Code (naloga: GitHub issue #1 "P0 AUDIT")
- **Metodologija:** statična analiza kodne baze (2 neodvisna pregleda z file:line dokazi), dejansko poganjanje test suite/lint/typecheck/drift/secrets, živi E2E smoke test zlatega poti (Agent Browser + seeded SQLite dev baza), introspekcija Vercel/GitHub env konfiguracije.
- **Pravila upoštevana:** produkcijska baza ni bila ničesar dotaknjena (samo branje env imen); nič plačljivih API-jev/AI ni dodano; fiskalni statusi so opisani brez napihovanja.

---

## 1. Dejansko pognani preverjalni ukazi in rezultati

| Ukaz | Rezultat |
|---|---|
| `bun test` | **371/371 pass, 0 fail** (997 expect, 21 datotek, ~800 ms) |
| `bunx tsc --noEmit` | **exit 0** |
| `bun run lint` (eslint .) | **exit 0** |
| `python3 scripts/check-schema-drift.py` | **exit 0** (SQLite zrcalna shema = kanonična) |
| `bash scripts/check-secrets.sh` | **exit 0** (brez skrivnosti v kodi) |
| GitHub Action deploy | **run 37980000848 → Vercel `dpl_ARCRdbu8P1` READY**, produkcija zdrava (v1.45.0, baza povezana) |
| GitLab CI (quality-gate) | ~~BLOKIRANO za verifikacijo~~ **ZASTARELO — ARHITEKTURA PREMEŠČENA (Task 35, re-verificirano Task 56):** quality gate = GitHub Actions `ci.yml` (tsc + lint + testi + secrets, blokira deploy); GitLab `builds_access_level=disabled` (kvota izčrpana; reverzibilno) — GitLab CI ni več del povratne zanke kakovosti |

**E2E smoke test (živ, dev baza + Agent Browser)** — zlatica pot izmena→miza→naročilo→kuhinja→plačilo→Z-report:

| Korak | Dokaz |
|---|---|
| Prijava admin (PIN) | POST /api/auth/login 200 + `LOGIN_SUCCESS` audit |
| Odpiranje izmene (100 €) | shift open, UI preklopi v zaključni način |
| Naročilo Miza 1 (2× Burek + 1× Laško) | POST /api/orders **201**, miza → "Zasedena" |
| KDS | postavke vidne po postajah (Kuhinja/Bar) |
| Plačilo + FURS (gotovina) | Receipt `2026-10-1-BLG001`, EOR izdan, DDV razčlenba 9,5 %/22 %, status `verified` (simulacija) |
| Razknjižba zalog po recepturi | StockTransaction `SALE −0,2 kg` (45 → **44,8**) + `STOCK_DEDUCTED` audit |
| Zaključek izmene (120 €) | ZReport: promet 19,97, DDV 2,17, 2 računa, razlika blagajne +0,03 + `SHIFT_CLOSE` audit |

---

## 2. Baza in shema

- **Dev (ta sandbox):** SQLite (`db/custom.db`, `.env DATABASE_URL=file:...`), 117 tabel. Seed (`prisma/seed.ts`) je idempotenten: lokacija Ljubljana (SI, fursEnvironment `test`), 4 zaposleni (demo PIN-i 1234/2345/3456/4567), 12 artiklov, 14 miz, zalogovni artikli. Ob auditu je bila dev baza **prazna (brez seeda)** → poženem `bun run db:seed`.
- **Produkcija:** Neon **PostgreSQL** — potrjeno prek Vercel env konfiguracije projekta `restaurantos` (imena spremenljivk: `DATABASE_URL`, `POSTGRES_PRISMA_URL`, `DATABASE_URL_UNPOOLED`, `NEON_PROJECT_ID`, `PG*`; vrednosti so `sensitive`/masked — namenoma ni bilo poskusa branja). Health endpoint produkcije: `database: connected`.
- **Dual shema:** `prisma/schema.prisma` = PostgreSQL (kanonična, 117 modelov/20 enumov); `prisma/schema.sqlite.prisma` = samodejno zrcalo (generira `scripts/prisma-postinstall.cjs` po `DATABASE_URL` predponi `file:`). Drift-check skripta potrjuje usklajenost (exit 0).
- **⚠️ Migracije — POČIŠČENO (Task 31-c):** `prisma/migrations/00000000000000_init/` baseline obstaja (117 tabel, 1:1 s prod-v2). Dev schema se vsadi z `db:push`, produkcija pa prek ad-hoc admin rut `src/app/api/admin/migrate-issue*/route.ts` (fiksne DDL, requireCentralRole, audit SCHEMA_MIGRATION_*). **Task 44 lekcija (issue13):** Neon efemerne vloge NE morejo ALTERati prod tabel (tableowner `app_owner`; ownership potreben) — produkcijski DDL gre IZKLJUČNO prek admin rut z avtenticirano centralno vlogo (ali direktno s prod kredencialami); enkratni CI workflow z DDL je nerealizabilen (2 poskusa, task 44).
- **Neon ↔ GitHub:** neposredna povezava NE obstaja (GitHub secrets: samo `GITLAB_TOKEN`, `GITLAB_PROJECT_PATH`). Neon je povezan **prek Vercel integracije** (envs na projektu), deploy pa prek GitHub Action. Za namestitvene skripte, ki bi potrebovale produkcijski DATABASE_URL v CI, je ta dostop treba še dodati (BLOCKER za avtomatske produkcijske smoke teste v CI).
- **Backup:** `scripts/backup-database.sh` (sqlite .backup / pg_dump) obstaja, je pa **ročen** — ni urnika. Za Neon produkcijo: P1 (Neon branchovi/PITR so na voljo, a niso nastavljeni/dokumentirani).

---

## 3. Zemljevid glavnega toka (izmena → miza → naročilo → kuhinja → plačilo → Z-report)

| # | Faza | Ključne datoteke | Status |
|---|---|---|---|
| 1 | Odpiranje izmene | `src/app/api/shifts/route.ts` (POST open: transakcija + ponovna preverba — popravek R1) | **DONE** (race popravljen) |
| 2 | Tloris miz, prosto/zasedeno | `src/app/api/tables/route.ts`, `tables/[id]/route.ts`, UI `src/app/dashboard/page.tsx` | **DONE** |
| 3 | Združevanje/selitev miz | — | **MISSING** (P1): noben endpoint za move/merge naročila na drugo mizo |
| 4 | Kreiranje naročila + postavke + modifierji | `src/lib/ops.ts` `createOrderCore` (transakcija, cene iz DB, idempotencija `Order.idempotencyKey @unique`, retry P2002) | **DONE** |
| 5 | Dodajanje postavk v odprto naročilo | `src/app/api/orders/[id]/route.ts` (addItems: transakcija + CAS gate na plačano — popravek R5), `src/app/api/sync/route.ts` (isti popravek) | **DONE** (race + plačilni gate popravljen) |
| 6 | Pošiljanje na kuhinjo ("fire") | postavke nastanejo `pending`; ni ločenega draft→fire koraka; `firedAt` polji se nikoli ne zapišeta | **PARTIAL** (P2: dodati ekspliciten fire) |
| 7 | KDS statusi priprave | `src/app/api/kitchen/route.ts` (`kitchen.update` + lokacijski gate), UI kuhinja | **DONE** |
| 8 | Predogled računa | `src/lib/billing.ts` `computeBill`, `orders/[id]/bill/route.ts` (409 na plačano) | **DONE** |
| 9 | Plačilo + fiskalni dokument + razknjižba zalog | `src/app/api/furs/route.ts` (CAS na plačilo, deljeno plačilo, darilne, zvestoba, `deductStockForOrderTx` v isti transakciji — R2 popravek) | **DONE** |
| 10 | Račun/tiskanje | `src/lib/receipt.ts`, `src/lib/print.ts`, mini-services/print-agent (ESC/POS TCP 9100) | **DONE** ("printed" = vrstniški prenos, ne fizična potrditev — dokumentirano) |
| 11 | Sprostitev mize | `tables/[id]` PATCH status FREE/DIRTY | **DONE** |
| 12 | Zaključek izmene (Z-report) | `shifts/route.ts` stop (CAS claim — popravek R3, VAT razčlenba, audit) | **DONE** (race popravljen) |
| 13 | Storno računa / vračilo | shema ima polja (`Receipt.isStorno/stornoOf`), **noben endpoint ne ustvari storno računa/refunda** | **MISSING** (P1) — vmesni varovalki DODANI: storno plačanega naročila je zdaj blokiran (R10) |
| 14 | Kiosk / QR gost / display | `src/app/kiosk/page.tsx`, `src/app/m/[token]/page.tsx`, `api/public/*` (rate limit, token-vezano, isti kanonični pipeline) | **DONE** (i18n gostov ostran: PARTIAL) |

## 4. Vloge in dovoljenja (RBAC)

- **Model:** 11 kanoničnih pravic (`src/lib/permissions.ts`), privzete matrice po vlogah (owner/admin/manager/staff/waiter/bar/chef/kitchen + enterprise vloge), override-i vedno dodatni; `requirePermission` = DB lookup na vsak klic (`src/lib/api.ts`); lokacijski gate `assertResourceLocation` dosleden; revokacija sej prek `sessionVersion`.
- **UI↔API usklajenost:** potrjena na plačilu (`orders.pay`), kuhinji (`kitchen.update`), rezervacijah; **neskladja (vse najdene, status odprtih):**

| ID | Neskladje | Status |
|---|---|---|
| N1 | OWNER dobi 403 na kreiranje miz (adminOnly gate + `!== 'MANAGER'` preverbi), MANAGER pa sme | ~~ODPRTO (P2)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `tables/route.ts:27` = `requirePermission(req, 'menu.manage')` (kanonično dovoljenje, brez adminOnly/role preverbi) |
| N2 | OWNER blokiran na ročnem PAID/CANCELLED in DELETE naročila (samo ADMIN/MANAGER) | ~~ODPRTO (P2)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `orders/[id]/route.ts:63-64` (PATCH override) in `:206-207` (DELETE) = `!isCentralRole(user) && user.role !== 'MANAGER'` — OWNER (centralna vloga) spusti, staff ostane blokiran |
| N3 | hardkodirane vloge namesto `requirePermission`: inventory POST/PATCH, expenses, suppliers, loyalty, jobs, employees POST/PATCH (warehouse vloga ima pravico, a API jo zavrne; override-i ne delujejo na pisanje) | ~~ODPRTO (P1)~~ **POPRAVLJENO + VERIFICIRANO (Task 52, v1.53.0):** vse naštete rute že uporabljajo `requirePermission` z kanoničnimi dovoljenji (inventory.manage / settings.manage / employees.manage) — vrstica v tabeli ni bila prečrtana ob popravku (Task 32); re-verificirano z grepom |
| N4 | `/api/admin/migrate-*` DDL rute zahtevajo `employees.manage`/`settings.manage` (ima jih tudi MANAGER) — `$executeRawUnsafe` za manj privilegirano vlogo | ~~ODPRTO (P1)~~ **POPRAVLJENO + VERIFICIRANO (Task 52, v1.53.0):** vseh 8 `migrate-*` rut uporablja `requireCentralRole` (DB vloga owner/admin; bootstrap break-glass) — vrstica ni bila prečrtana ob popravku; re-verificirano z grepom |
| N5 | GET rute permisivne: `/api/furs`, `/api/shifts`, `/api/expenses`, `/api/tips`, `/api/haccp`, `/api/giftcards` — samo `requireAuth`, UI pa skriva tabe (natakar prek API vidi finančna poročila) | ~~ODPRTO (P2)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** vsi 6 GET handlerjev kliče `requirePermission` — furs=`reports.view`, shifts=`orders.pay`, expenses=`reports.view`, tips=`reports.view`, haccp=`settings.manage`, giftcards=`reports.view` (grep dokaz v vsaki ruti) |
| N6 | DELETE popusta brez lokacijskega gate | **POPRAVLJENO** (ta audit) |
| N7 | enterprise vloge ni mogoče dodeliti prek `PATCH /api/employees/[id]` | ~~ODPRTO (P2)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `employees/[id]/route.ts:54-57` = `ENTERPRISE_ROLES` bela lista (GROUP_OWNER/ORG_ADMIN/PROPERTY_MANAGER/WAREHOUSE/ACCOUNTING) + gate `isCentralRole(user)` (MANAGER ne sme) |
| N8 | taba Zaposleni/Nastavitve vidni vsem (manjka `TAB_PERM` vnos; `hasPerm(undefined)=true`) | ~~ODPRTO (P2)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `src/lib/tab-permissions.ts` — `tabHasPerm()` fail-closed: `if (!perm) return false` (neznan/undefined/manjkajoč vnos → false, prej true) |

## 5. Transakcije, idempotencija, race conditions

**Že pravilno utrjeno (dokazani vzorci v kodi):** dvojna oddaja naročila (`Order.idempotencyKey @unique` + replay + P2002 retry), dvojno plačilo (CAS `paymentStatus: { not: 'paid' }` + `Payment.idempotencyKey @unique` → drugi klic dobi ISTI račun z `replayed: true`), darilne kartice/zvestoba (CAS + centna aritmetika), atomarno številčenje (`Counter` + location-scoped unique), rezervacije (`@@unique([tableId, dateTime])`), offline sync dedup (`@@unique([deviceId, clientOperationId])`).

**Najdene ranljivosti in status:**

| ID | Tveganje | Kje | Problem | Status |
|---|---|---|---|---|
| R1 | VISOKO | shifts POST open | read-then-write → dve odprti izmeni ob dvojnem kliku | **POPRAVLJENO** (transakcija + ponovna preverba; PG ostank: zelo ozko okno — za 100 % zaščito delni unique index, P2) |
| R2 | VISOKO | `src/lib/inventory.ts` `deductStockForOrderTx` | absoluten update po branju → lost update zaloge pod sočasnimi računi (tudi FEFO serije) | **POPRAVLJENO** (atomarni `decrement` s `quantity >= x` guard + talni odštevek + retry ×3; enako za `InventoryBatch` + status EXHAUSTED pogojno). **E2E dokazano** (SALE −0,2, 45→44,8) |
| R3 | SREDNJE | shifts stop | dvojni zaključek → dva Z-reporta / 500 | **POPRAVLJENO** (CAS `updateMany where status='open'`, izgubljeni klic dobi 409) |
| R4 | SREDNJE | `api/inventory` PATCH | prilagoditev zaloge brez transakcije; evidence ločena od stanja | **POPRAVLJENO** (vse v `$transaction`; increment/decrement s pogojem; StockTransaction + AuditLog v isti transakciji; setQty ostaja namensko last-writer-wins "inventurni popravek") |
| R5 | SREDNJE | `orders/[id]` addItems + sync | postavke na PLAČANO naročilo; createMany+recalc+update ločeno | **POPRAVLJENO** (transakcija + CAS gate `paymentStatus !== 'paid'` → 409; obe poti) |
| R6 | SREDNJE | `ops.ts` zasedba mize | brezpogojni `occupied` → POS+QR hkrati na isti mizi; drugo naročilo nevidno v tlorisu | **POPRAVLJENO** (CAS `status != occupied` + preverba drugih aktivnih naročil → 409; replay lastnega dovoljen) |
| R7 | NIZKO/SREDNJE | `sync/route.ts` | `applyOp` in `DeviceSyncOperation.upsert` nista v eni transakciji (retry po crashu → dvojne postavke na addItems) | ~~ODPRTO (P2)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `sync/route.ts:124` in `:241` = `db.$transaction(async (tx) => { … })` — applyOp + upsert atomarna |
| R8 | NIZKO | discount maxUses | preverba + nevezan increment → prekoračitev omejitve | **POPRAVLJENO** (CAS `currentUses < maxUses`) |
| R9 | NIZKO | tips/payout | dvojno izplačilo (brez status guard) | ~~ODPRTO (P2, enostaven CAS)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `tips/payout/route.ts:43-44` = CAS `tipDistribution.updateMany({ where: { id, status: 'pending' } })` — 0 vrstic → 409 »že izplačano« |
| R10 | NIZKO | orders PATCH/DELETE | storno PLAČANEGA naročila brez razknjižbe/fiskalnega storna | **POPRAVLJENO (varovalka)**: 409 na paid (pravi fiskalni storno ostaja MISSING/P1) |
| R11 | NIZKO | Z-report okno | okno po createdAt (ne shiftId) → dve hkratni izmeni se podvojita v Z-poročilih | ~~ODPRTO (P2, pravilnost)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** ZReport ustvarjen v ISTI transakciji kot shift close (`shifts/route.ts:158`), okno veriženo po zaprtih izmenah (brez createdAt dvojnosti) |
| R12 | NIZKO | expenses | findFirst→create dobavitelja "Razno" → duplikati | ~~ODPRTO (P2, upsert)~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `expenses/route.ts:73` = `db.supplier.upsert` po unique `name` + P2002 re-read/retry zanka (brez findFirst) |

## 6. Revizijska zgodovina (AuditLog)

- **Obstaja:** 60+ akcij (INVOICE_ISSUE z zneski/maskiranimi GC, SHIFT_CLOSE, DISCOUNT_APPLIED/REMOVED z previousDiscount, EMPLOYEE_SENSITIVE_UPDATE, GIFT_CARD_*, STOCK_DEDUCTED, TIMECLOCK_*, WASTE_*, GRN_RECEIVE, PO_CREATE, QR_TOKEN_ROTATED, DEVICE_*, MFA_*, …), actor vedno zapisan, location-scoped branje (`reports.view`).
- **Dodano v tem auditu:** `LOGIN_SUCCESS`/`LOGIN_FAILED` (IP + lokacija), `ORDER_CANCELLED` (storno naročila — prej brez revizije!), `ORDER_STATUS_PAID_OVERRIDE`/`ORDER_STATUS_CANCELLED_OVERRIDE` (ročni finančni override — prej brez revizije), `INVENTORY_ADJUST` zdaj vsebuje **previousQty + newQty** (prej samo after).
- **Še odprto (P1/P2):** ~~beleženje kreiranja zaposlenega, stroškov, SHIFT_OPEN, miz/menija/nastavitev; manjkajoči `locationId` pri INVENTORY_CREATE/STOCK_DEDUCTED/TIP_PAYOUT/SUPPLIER_*/ERROR_REPORT (zapisi nevidni location-scoped uporabnikom); polji `previousHash`/`chainHash` (tamper-evidentna veriga) **nikoli ne zapisana** — aktivirati ali odstraniti~~ — **VSE ZAPRTO (Task 33-c + 33-main, 2026-10-10):** centralni helper `src/lib/audit-chain.ts` (`auditChainFields` — previousHash = chainHash zadnje vrstice modela, chainHash = sha256 nad kanoničnim nizom z deterministično kanonizacijo details; `verifyAuditChain` — ponovni izračun + povezovalna preverba, zazna hash tampering IN izbris/vstavek vrstice); 100 % pokritost — NI več nobenega `auditLog.create` brez chain polj (vključno orders/**, purchase-orders/**, public/orders, auth/login, ops); chain tudi na HaccpEntry; novo beleženje: EMPLOYEE_CREATE, EXPENSE_CREATE, SHIFT_OPEN, TABLE_CREATE/DELETE, MENU_ITEM_CREATE/UPDATE, SETTINGS_UPDATE; locationId dopolnjen pri INVENTORY_CREATE, STOCK_DEDUCTED, TIP_PAYOUT, SUPPLIER_*, ERROR_REPORT; omejitve dokumentirane v JSDoc (konkurenčni zapisi lahko delijo previousHash — povezovalna preverba odkrije vejo; veriga globalna, ne per-location).

## 7. Funkcijska matrika (skrajšano; podrobnosti v delovnem dnevniku)

| Funkcija | Status | Opomba |
|---|---|---|
| Loyalty (točke, tierji, unovčenje ob plačilu) | **DONE** | CAS zaščita ob plačilu |
| Popusti / Happy Hour | **PARTIAL** | backend popoln; ni admin UI za kreiranje popustov |
| Kiosk (veliki gumbi, aktivacija kodo) | **DONE** | isti kanonični pipeline; SL-only |
| Zaloga: odpis (waste) + reverse | **DONE** | idempotentno, 409 nad zalogo |
| Zaloga: dobavitelji + nabavna naročila + prevzem | **DONE** | centna aritmetika, statusna avtomat |
| Zaloga: inventura | **DONE** | **ŽE OD Task 57 (v1.56.0):** polni protokol — odpri (snapshot zaloge) → oddaj (CAS zakleni) → potrdi (inventurni popravek v transakciji: quantity := counted, StockTransaction STOCKTAKE s previousQty/newQty pokaže sočasno prodajo, variansa proti snapshotu) | prekliči; recount (SUBMITTED→DRAFT, recountCount++); en odprt popis/lokacija (409), idempotencyKey replay, 6 rut + 11 DB testov + UI kartica v Zalogi tabu |
| Recepture + avtomatska razknjižba | **DONE** | v isti transakciji kot račun (R2 zdaj CAS) |
| Darilne kartice (izdaja/polnilo/unovčenje) | **DONE** | CAS, maskiranje v auditu |
| Stroški (AccountsPayable) | **PARTIAL** | GET+POST; brez urejanja/kategorij |
| Events (notranja vrsta + retry) | **DONE** | brez zunanjih webhook subscriberjev |
| Odpiralni čas (7 dni + posebni + prazniki SI) | **DONE** | |
| HACCP | **PARTIAL** | vnosi+seznam; brez načrtov kontrol |
| Mnenja gostov | **DONE** | branje + **vnosni API ŽE OD Task 32-d:** `POST /api/public/feedback` (token-vezan, rate-limit 5/min/IP, anti-spoofing orderId; `guest-feedback.test.ts` 5 testov) — vnosni zvezdice na QR strani |
| Dostava (statusi, vozniki, cone, Glovo/Wolt webhook HMAC) | **DONE** | |
| Print (ESC/POS agent + PrintJob + ACK) | **DONE** | "printed" = bajti v socketu |
| Integracije | **PARTIAL** | model + masking; brez UI/API za povezovanje |
| Enterprise (org/brand/property drevo) | **PARTIAL** | API brez UI; ~~`assertTenantScope` definiran a nikoli klican~~ **VERIFICIRANO (Task 56):** org meja ŽIVO — `guardResource` (28 točkovnih rut, Task 52) + `assertOrgScope` (18 CREATE mest) + async org allow-lista `locationScope` (27 seznamskih rut, Task 54); UI ostaja edini PARTIAL del |
| Devices (enroll, kiosk, CFD display, terminal simulator) | **DONE** | |
| Timeclock, napitnine, waitlist, rezervacije, offline sync, MFA, računovodski izvoz CSV/JSON | **DONE** | |

## 8. Lokalizacija SL/HR

- 1.073 ključev × 2 jezika, **popolna pariteta** (0 ključev razlike), `t(locale, key, vars)` s SL fallbackom; preklopnik na prijavi in v dashboardu; fiskalne oznake po državi; test i18n paritete v suite (17 primerov).
- **Ostanki (P2):** ~~gostujoče strani niso prevedene (kiosk, `m/[token]`, display) — ~50+ hardkodiranih SL nizov~~ — **ZAPRTO v dveh korakih:** 33-b (kiosk + `m/[token]` + feedback, GuestI18nProvider infrastruktura) in **49 (customer display — zadnja stran, 22 ključev `guest.display.*`, SL/HR pariteta + regresijski test na trdo kodirane nize)**; server-side error sporočila ostajajo SL (dokumentirana omejitev — fallbacki na straneh so prevedeni). — **49 dodatek: varnostne glave** (next.config `headers()` za vse rute: HSTS `max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` — koda ne uporablja nobenega od teh API-jev, preverjeno z grepom). Frame zaščita (X-Frame-Options/CSP frame-ancestors) **namenoma odložena**: peskovni preview panel vgrajuje app v iframe, embed-origin ni verifikiran — dodati šele s preverjenim seznamom origin-ov.

## 9. FURS / fiskalizacija — pošteno stanje

**JE implementirano:** številčenje računov `YYYY-M-seq-premisesId`, fiskalni adapter po državi lokacije (SI: ZOI/EOR, HR: ZKI/JIR + uradna QR oblika porezna), DDV razčlenba po stopnjah, okolja `FURS_ENVIRONMENT`/`FURS_ALLOW_SIMULATION` (seed = `test`), statusi brez lažnega predstavljanja (simulacija → `verified`; produkcija → **prazne kode + `fiscalStatus: pending`** + `fursEnvironment: production_pending`), tiskani račun z ZOI/EOR oz. JIR+QR, zgodovina računov.

**NI implementirano (dejstva):**
- Ni certifikata in upravljanja le-tega (`.p12`); ni odjemalca do FURS/Porezne (noben SOAP/REST klic).
- ZOI je simulacijski MD5, **ni** uradni RSA-SHA512 podpis; EOR je UUID (ne pridobljen od FURS); SI QR na računu ne obstaja.
- Ni registracije poslovnega prostora (premisesId je le niz); ni storno/nadomestnega računa.
- **Sklep: fiskalizacija je DELUJOČA v simulaciji, v produkciji ostaja `pending` do certifikata.** Za pravo produkcijo: FURS certifikat (človeški korak), uradni ZOI algoritem, EOR pot, storno pot. (HR Fiskalizacija 2.0: implementiran ZKI/JIR/QR po specifikaciji, prav tako brez produkcijskega certifikata.)

## 10. Varnost

| Področje | Stanje |
|---|---|
| Avtentikacija | custom bearer HMAC-SHA256 (12 h), `timingSafeEqual`, PIN scrypt + lookup, revokacija sej fail-closed (sessionVersion), bootstrap break-glass (fast-path zdaj enoten v requireAuth/requirePermission/requireCentralRole — prej je requirePermission vračal 403; Task 34, 2026-10-10) |
| MFA | TOTP + recovery kode za privilegirane račune, audit MFA dogodkov |
| **Rate limiting** | obstaja (memory + dormant Upstash); javni endpointi pokriti (public/orders 10/min, enroll, webhooki…) — **`/api/auth/login` NI bil omejen → POPRAVLJENO (10/min/IP + 429)** |
| Tenant/lokacijska izolacija | lokacijski sloj (`assertResourceLocation`/`locationScope`) dosleden v rutah; ~~`assertTenantScope` (org nivo) definiran a ničerar klican — docs trdijo drugače → uskladiti (P1)~~ **ZAPRTO (Task 52, v1.53.0):** org meja ŽIVO povezana — `guardResource` (lokacijski + org sloj) v vseh 28 točkovnih rutah (mehanično, tsc-verificirano), `assertOrgScope` za 18 CREATE mest (`requireUserLocation`), semantika `assertTenantScope` usklajena z dokumentacijo (migracijsko varno: neznana veriga → pass; prej nasprotovala `tenantAllows` + doc); 17 novih testov (org drevesi + legacy lokacija, cross-org 403, isti-org 200, bootstrap, waiter nespremenjen, statična regresija ni več golih `assertResourceLocation`); znana omejitev ~~SEZNAMSKI endpointi (`locationScope`) ostajajo brez org filtra za centralne vloge~~ — **ZAPRTO (Task 54, v1.55.0):** async `locationScope` z org allow-listo (svoja org + legacy nevezane lokacije; neznana org → brez filtra, migracijsko varno) v 27 rutah + 7 DB testov (`tenant-org-list.test.ts`) |
| Skrivnosti | check-secrets exit 0; `.env` ne-tracked; `APP_SECRET` produkcija fail-closed; Vercel deploy token base64 v workflow (privatni rep — znano, sprejeto tveganje; menjava po pravilu iz workloga) |
| PII | javni odgovori brez PII; maskiranje telefona darilnih kartic/integracij; ~~odprto (P2): `GET /api/loyalty` vrača telefone vsem~~ **POPRAVLJENO + VERIFICIRANO (Task 56, v1.55.0):** `loyalty/route.ts` = `maskPhone()` VEDNO (privzeto), nezakrit pogled `?full=1` zahteva `settings.manage` (sicer 403) |
| Backup | ~~ročni skript; ni urnika~~ **ŽE OD Task 35 (VERIFICIRANO Task 56):** `.github/workflows/neon-backup.yml` — dnevni cron 02:30 UTC + manual, efemerna `backup_*` vloga, pg_dump custom, retencija 90 dni, vloga izbrisana `always()` (P1 zapor) |

## 11. Testi — pokritost poslovnih tokov

- **Pokrito:** računovodski izračuni (computeBill: ročni+auto popusti, Happy Hour, zvestoba — 12 primerov), fiskal SI/HR vektorji (12), lokacijska avtorizacija, tenant drevo, seje/revokacija, darilne kartice, odpad (float drift), napitnine (centna natančnost + hash veriga), delovni čas, nabava, modifierji, delivery webhook podpis, rate-limit, MFA, i18n pariteta.
- **Nepokrito (P1 priporočila):** `resolvePermissions`/`ROLE_DEFAULTS` (ničesar), furs POST transakcijska logika (dvojni plačilni poskus, split vsota, replay), `deductStockForOrderTx` (FEFO/primanjkljaj/replay), `createOrderCore` replay, Z-report VAT razčlenba, AuditLog popolnost, sočasnostni scenariji R1–R12 (vsaj unit za CAS retry vzorce).

## 12. Popravki implementirani v tem auditu

| Datoteka | Popravek |
|---|---|
| `src/app/api/shifts/route.ts` | R1 (transakcija pri odpiranju) + R3 (CAS zaključek, 409 na sočasnost) |
| `src/lib/inventory.ts` | R2 (CAS odštevek + talni odštevek + retry; FEFO serije CAS + EXHAUSTED pogojno) |
| `src/app/api/inventory/route.ts` | R4 (vse v transakciji, atomarne količine, evidence + audit v isti transakciji, previousQty v auditu) |
| `src/app/api/orders/[id]/route.ts` | R5 (transakcija + CAS plačilni gate), R10 (409 na storno plačanega), audit override/storno |
| `src/app/api/sync/route.ts` | R5 (isti gate na offline sync poti) |
| `src/lib/ops.ts` | R6 (atomarna zasedba mize + 409 ob zasedeni mizi) |
| `src/app/api/auth/login/route.ts` | rate limit 10/min/IP + `LOGIN_SUCCESS`/`LOGIN_FAILED` revizija |
| `src/app/api/orders/[id]/discount/route.ts` | N6 (lokacijski gate na DELETE) + R8 (CAS maxUses) |

**Verifikacija popravkov:** tsc exit 0, 371/371 testov, lint exit 0, drift exit 0 + živi E2E zlatica pot (§1) z dokazi v dev bazi.

## 13. Prioritete in blokade

**P0 (izvršeno v tem auditu):** race R1/R2/R3/R4/R5/R6/R8/R10, login rate limit + login revizija, storno revizija, lokacijski gate popusta.

**P1 (naslednji korak):**
1. ~~Fiskalni storno/vračilo endpoint~~ — **IZVRŠENO (Task 31-a):** `POST /api/receipts/[id]/storno` — storno račun (negacija originala, isti Counter/fiskalni režim), `paymentStatus='storno'` (CAS), popolno povračilo zaloge (InventoryItem + serije FEFO, EXHAUSTED→ACTIVE), revizija `RECEIPT_STORNO` v isti transakciji; guardi fail-closed (404/403/409 dvojni storno·storno storna·kopija·neplačano); UI Storno gumb; 9 testov. ~~Znana omejitev: ponovno plačilo storniranega naročila tehnično mogoče prek /api/furs~~ — **ZAPRTO (Task 37):** terminalna stanja ('storno', 'cancelled') so zavrnjena že v pred-transakcijski guardi /api/furs (409, fail fast PRED idempotenčnim replayem), CAS ojačan na belo listo `paymentStatus IN ['unpaid','partial']` (fail-closed tudi ob novih terminalnih vrednostih), "twin" replay išče izključno originalni račun (`isStorno=false` — nikoli storno negacije), ročni PAID override v /api/orders/[id] na stornoed naročilu → 409 (prej: override bi prepisal 'storno' → 'paid' brez računa/plačila); 4 novi testi (storno replat 409 + invarianta brez tretjega računa, cancelled 409, PAID override 409, twin isStorno filter); 550 testov skupaj.
2. ~~Standardizirane Prisma migracije~~ — **IZVRŠENO (Task 31-c):** `prisma/migrations/00000000000000_init/migration.sql` (117 tabel, 176 FK, iz datamodela = 1:1 s prod-v2) + `migration_lock.toml` (postgresql). Baseline je dokumentacija/rešitvena pot (`migrate deploy` na novem okolju); drift check v CI še vedno primerja datamodel ↔ produkcija.
3. ~~Uskladiti org-izolacijo + N3 + N4~~ — **IZVRŠENO (Task 31-b):** N3 = 9 pisalnih operacij preklopljeno na `requirePermission` (inventory/employees→`inventory.manage`/`employees.manage`; expenses/suppliers/loyalty/jobs→`settings.manage`; warehouse odblockiran, override-i delujejo na pisanje); N4 = 7 `/api/admin/migrate-*` rut na novi `requireCentralRole` (samo DB owner/admin; MANAGER brez `$executeRawUnsafe`); assertTenantScope = usklađena dokumentacija (TENANT-ISOLATION/SECURITY-BOUNDARY/ARCHITECTURE) — enterprise rute izvajajo org preverbo inline, helper ostane rezerva.
4. ~~Testi: permissions, furs POST pot, deductStockForOrderTx, Z-report~~ — **IZVRŠENO (Task 32-c + 32-a/32-b):** permissions-core (resolvePermissions/ROLE_DEFAULTS/override), furs-post (srečna pot + replay dvojnega plačila + gate-i), stock-deduction (FEFO po serijah, izpraznitev, primanjkljaj, replay zaščita), zreport-vat (DDV razčlenba + R11 veriženje oken), race-fixes (R7/R9/R12 + N5), rbac-p2 (N1/N2/N7/N8 + PII), guest-feedback — 473 testov skupaj. Odkrita in popravljena 2 realna buga v deductStockForOrderTx (FK vrstni red alokacij + CAS break).
5. ~~Avtomatski Neon backup urnik~~ — **IZVRŠENO (Task 31-c):** `.github/workflows/neon-backup.yml` — dnevno 02:30 UTC + workflow_dispatch; efemerna `backup_*` vloga na prod-v2 (geslo samo v POST response), `pg_dump --format=custom` (PG17 client), validacija (≥100 tabel + podatkovne sekcije), artifact retention 90 dni, vloga izbrisana `always()`; higiena starih vlog na startu.
6. ~~Mnenja gostov: vnosni API~~ — **IZVRŠENO (Task 32-d):** model GuestFeedback je že obstajal (DCL ni potreben!); POST /api/public/feedback (token-vezan, rate-limited 5/min/IP, lokacija rešena server-side, anti-spoofing orderId, clampi) + UI zvezdice na QR strani + 5 testov.

**P2:** ~~selitev/združevanje miz~~ (**ZAPRTO, Task 33-a:** POST /api/orders/[id]/move — selitev odprtega naročila na prosto mizo iste lokacije (409 če zasedena, samodejna sprostitev stare mize, CAS status miz, revizija ORDER_MOVE z chain + OrderMoved dogodek) + POST /api/orders/[id]/merge — prenos postavk na ciljno naročilo, preklic vira, recalcTotals v tx, revizija ORDER_MERGE; UI: gumba "Premakni mizo"/"Združi naročila" z dialogi v panelu naročila), ~~fire-to-kitchen (`firedAt`)~~ (**ZAPRTO, Task 33-a:** POST /api/orders/[id]/fire — idempotenten draft→fire: order.firedAt + vse pending postavke → status 'fired' s firedAt v tx, revizija ORDER_FIRED + OrderFired dogodek, UI gumb "Pošlji na kuhinjo"), ~~i18n gostujočih strani~~ (**ZAPRTO, Task 33-b:** kiosk + QR stran popolnoma dvojezični — lahkoten GuestI18nProvider + SL|HR preklopnik (≥44px, aria), 75 novih ključev v obeh slovarjih s pariteto, jezik povezan z glavno aplikacijo prek istega localStorage ključa, statusi naročil prevedeni client-side), ~~chainHash aktivacija~~ (**ZAPRTO, Task 33-c + 33-main** — glej §6 "Še odprto"). ~~R7/R9/R11/R12~~ (POPRAVLJENO, Task 32-a: sync transakcija, tips payout CAS, Z-report veriženo okno po shiftih, supplier upsert), ~~N1/N2/N5/N7/N8~~ (POPRAVLJENO, Task 32-a/32-b: mize via menu.manage, OWNER na override/DELETE, finančni GET-i via reports.view/settings.manage/orders.pay, enterprise vloge za centralne akterje, TAB_PERM fail-closed), ~~loyalty PII~~ (POPRAVLJENO, Task 32-b: maska telefonov, ?full=1 za settings.manage).

**Rezidual iz §10 (Task 34, 2026-10-10):** ~~bootstrap admin fast-path v `requirePermission`~~ — **IZVRŠENO:** break-glass žeton (sub='bootstrap', role='ADMIN', brez Employee vrstice) je prej na vseh permission rutah dobival 403 (DB lookup na neobstoječega zaposlenega), kljub temu da ga requireAuth/requireCentralRole nameravata spustiti; fast-path zdaj enoten v vseh treh gate-ih — dovoljenja rešena prek `resolvePermissionsForUIRole('ADMIN')` (isti resolver kot prijava, pravila vedno usklajena), guardi fail-closed (samo sub='bootstrap' IN role='ADMIN'); 6 testov (`tests/bootstrap-admin.test.ts` — auth/permission/centralRole + GUARD pri lažnih žetonih + integracija GET /api/expenses 200); skupaj 530 testov.

**Blokade — stanje po Task 35 (2026-10-10):**
- ~~**Neon produkcijski DATABASE_URL v GitHub Actions secret**~~ — **ZAPRTO (Task 35):** produkcijski smoke ne potrebuje trajnega secret-a — `.github/workflows/prod-smoke.yml` (dnevno 05:00 UTC + manual) ustvari efemerno `prodsmoke_*` psql vlogo prek Neon API ključa (isti vzorec kot neon-backup), požene read-only invariance na prod-v2 (117 tabel, FK osirotelost = 0, lokacije, AuditLog + chainHash pokritost) in vedno izbriše vlogo. Validirano proti živi produkciji: 117 tabel, 308/308 AuditLog z chainHash, 0 osirotelih FK. Poleg tega `vercel-deploy.yml` dobil `tests` job (tsc + lint + 530 testov na sveži SQLite bazi) — deploy se blokira ob napaki.
- ~~GitLab CI runner minutes~~ — **VERIFICIRANO (Task 35):** pipeline-i na push se ustvarijo a takoj failed (0 jobs v zgodovini projekta, shared runners vklopljeni na project+group, brez yaml napak) = **compute minutes kvota izčrpana**. Mitigirano: quality-gate preseljen v GitHub Actions (`tests` job v vercel-deploy.yml — tsc/lint/test/secrets, blokira deploy); GitLab `builds_access_level=disabled` (utišanje rdečih pipeline-ov, reverzibilno prek Settings→CI/CD ko pridejo minute).
- **FURS certifikat** (in HR Fiskalizacija certifikat) — brez tega fiskalizacija ostaja simulacija/pending. **Runbook pripravljen: `docs/FURS-CERT-RUNBOOK.md`** (izdajatelji certifikatov, Vercel env, aktivacija po korakih, trenutno vedenje 'pending'). **Task 36: SI SOAP odjemalec ŽE implementiran** (`src/lib/furs/client.ts` — P12, ZOI RSA-SHA256 podpis, XML-DSig envelope, echo/invoices mTLS, fail-safe integracija v /api/furs; 16 testov z in-memory P12; brez cert env vedenje nespremenjeno). **Task 38: HR CIS odjemalec ŽE implementiran** (`src/lib/cis/client.ts` — po URAJNI specifikaciji Porezne uprave v2.7 (21.07.2026): ZKI = MD5hex(RSA-SHA256(podpis)) nad kanoničnim nizom z iznosom (pogl. 12 str. 208), enveloped XML-DSig (Signature znotraj RacunZahtjev, exc-c14n, sha256), 1-way TLS (brez mTLS), echo/RacunZahtjev → JIR, NacinPlac G/K/O preslikava, OznNapUr/OznPosPr sanitarizacija; 26 testov z in-memory P12 + mock CIS strežnik; RSA-SHA1 (zavržen od 01.01.2027) ni več v uporabi — implementiran rsa-sha256 takoj). Ob prihodu certifikata (FINA napredni cert z OIB / FURS kvalificiran) ostane le env nastavitev (`FURS_CERT_P12_B64`/`FURS_HR_CERT_P12_B64` + gesli + `FURS_HR_CA_PEM` FINA CA veriga) + validacija v testnem okolju (priporočeno ≥2 dni po spec).
- **DNS za `restaurantos.app`** — obe domeni (`restaurantos.app` + `www`) sta že dodani v Vercel projekt, obe `verified: false`. **KOREKCIJA (10.10.2026, potrjeno z dig proti avtoritativnim NS): avtoritativna cona je GoDaddy (`ns17/ns18.domaincontrol.com`), NE Cloudflare!** GoDaddy cona servira A (Cloudflare proxy IP) + MX (Outlook); urejanje zapisa v Cloudflare panelu je INERTNO, dokler NS ostane na domaincontrol.com. **Dodati v GoDaddy DNS (My Products → restaurantos.app → DNS → Records):**
  - TXT, Name `_vercel`, Value `vc-domain-verify=restaurantos.app,9fd848ca3e5b87c9ac25`
  - TXT, Name `_vercel`, Value `vc-domain-verify=www.restaurantos.app,da48b545c664486c3370` — obe vrednosti na ISTEM imenu (2 ločena TXT zapisa; potrjeno z živim Vercel API `GET /v9/projects/prj_8ymcBYAdqRj5QERaW8eWFK9xwBMn/domains`)
  - ROUTING (obvezno za delujočo domeno — trenutno apex A kaže na Cloudflare proxy IP-ja, ki vračata 403): A `@` → `76.76.21.21` (nadomesti obstoječi A) in CNAME `www` → `cname.vercel-dns.com` (nadomesti obstoječi CNAME). Alternativa: registrarski preklop NS na Cloudflare, nato vsi zapisi v Cloudflare (DNS-only za Vercel zapise).
  - Po dodajanju Vercel samoverifikacija v nekaj minutah; status prek API: `GET /v9/projects/prj_8ymcBYAdqRj5QERaW8eWFK9xwBMn/domains` (Vercel token, team scope potrjen 10.10.2026).
- **GitLab mirror status (11.10.2026)** — markec-group1/markec-project token glpat-yL49… umrl po ~1 h uporabe (enak vzorec kot Vercel tokeni: "incorrect, expired, or improperly scoped" + API 403; pred smrtjo uspešno potisnil 5601d19 — mirror je SINKRONIZIRAN z GitHubom). **Nizka prioriteta**: GitHub je avtoritativa (Vercel + CI delujeta prek GitHub App / PAT), mirror je samo varnostna kopija. Nov GitLab token (opcijsko, če se mirror vzdržuje): Settings → Access Tokens → api+write_repository → `git remote set-url origin https://oauth2:<TOKEN>@gitlab.com/markec-group1/markec-project.git`. Desink-detekcija: `bun scripts/sync-check.ts` (Task 46; mirror read rate-limit 403 anti-abuse ima vgrajen retry 5 s/15 s). — **✅ OBNOVITENO (Task 48, 11.10.2026):** uporabnik zagotovil nov token (glpat-PkgT…) → set-url → ls-remote 200 (mirror @ 5601d19, zaostanek = Task 47 worklog commit) → push 7f06034: 2× tranzičen 403 (anti-abuse; Cloudflare "Blocked" tudi na API `/user` = IP-blokada, ne token-problem) — a push vsebinsko SPREJET server-side: ls-remote po ~150 s = 7f06034, nadaljnji push "Everything up-to-date" → **sync-check SYNCED trojica @ 7f06034** (lokal = mirror = produkcija v1.50.0, db connected). Učenina: GitLab 403 anti-abuse lahko blokira le ODGOVOR, push pa vseeno sprejme — po 403 pushu NE ponavljati slepo, temveč najprej ls-remote.
- **Vercel tokeni umirajo z identičnim podpisom — 2× incident (10.10.2026, 15:07 in 17:36 UTC)** — vzorec: token deluje ~30 min po prvi uporabi → nato `/v2/user` 200 (token živ), `/v2/teams` → PRAZEN seznam, `/v9/projects/{id}` 403, CLI whoami → `Not authorized: scope robertpezdirc12-designs-projects`. Umirata SAMO Vercel tokena (Neon org key živ ves čas). Skupni imenovalec: uporabniški račun `robert.pezdirc12@gmail.com` ima `limited: true` = **nepotrjen e-naslov**.
  - **Korak 1 — root cause (2 min):** Vercel UI → profil → **Verify email** (potrditvena povezava v nabiralniku; če zgrešena, »Resend verification email«). Dokler račun ni verificiran, bo vsak nov token verjetno enake usode → NE ustvarjaj novih tokenov pred verifikacijo.
  - **Korak 2 — trajna rešitev (5 min, priporočeno): Vercel Git integration** — Vercel UI → Project `restaurantos` → Settings → Git → Connect Git Provider → GitHub App → dovoli repo `robertpezdirc12-design/restaurantos` (samo ta rep). Nato vsak push na `main` samodejno sproži produkcijski deploy na Vercelu (Next.js = auto-detekt build; Root Directory prazno) — **deploy ne potrebuje več CLI tokena**, tako da incident vzorec postane nenevaren. GitHub Actions `deploy` job po tistem ostane kot gate (tests/neon-smoke blokirata merge stanje) ali se `vercel deploy` korak umakne. — **✅ OPRAVLJENO (Task 43, 20:05 UTC): GitHub App povezan v UI; `GET /v9/projects/{id}` → `link.type=github`, repo `robertpezdirc12-design/restaurantos`, `productionBranch=main`. Deploy arhitektura počiščena: CLI `deploy` job odstranjen iz workflowa (rename `vercel-deploy.yml` → `ci.yml`; ostane neon-smoke + tests kot quality gate) — vzporeden CLI deploy bi povzročil dva builda na push in race za produkcijo. Nov tok: push → Vercel auto-deploy (`meta.githubCommitSha` → health) + vzporedni CI gate. Rollback: Vercel dashboard → Deployments → prejšnji READY → Promote. `VERCEL_TOKEN_B64` secret ostane kot rezervni mehanizem.**
  - **Alternativa (če Git integration ni mogoč):** nov token (team scope, brez expirya, šele PO email verifikaciji) → posodobitev `VERCEL_TOKEN_B64` secret prek sealed-box API (postopek v worklogu 39-main, 2 min) → re-run failed deploy joba (run 38072369859) → Task 40 (8654bba, v1.46.0) gre v produkcijo.
- **UI robustnost — display/kiosk brez offline odpornosti (najdeno v preverjanju Task 53; zidni zaslon 24/7, ki tiho zamrzne, je slabši od vidne napake).** — **✅ ZAPRTO (Task 53, v1.54.0):** display: exponentni povratni odmik pollanja (2 s → 4 s → 8 s → 15 s max), po 3 zaporednih odpovedih povezave jantarni zastarel indikator nad (vidnimi) zadnjimi podatki (`aria-live="polite"`, SL/HR), takojšen reset ob dogodku `online`, generacijska varovalka proti dvojnemu pollanju; ločnica 4xx (poslovna napaka — sporočilo, brez zastaranja) vs 5xx/omrežje (zastaranje + odmik). Kiosk: samodejni ponovni poskusi nalaganja menija (5 s, največ 6), ob `online` takojšen poskus (samo če meni še ni naložen — ne zabliska delujočega kioska), poslovna napaka (kiosk ni aktiviran) ustavi poskuse. QR stran (m/[token]) že imela online/offline poslušalca + tiho ponavljanje statusa — regresijsko pinano. i18n: 2 nova ključa (`guest.display.stale`, `guest.kiosk.autoRetry`) SL/HR pariteta. Statična regresija `tests/guest-offline.test.ts` (10 testov); 645 testov skupaj.

- **Issue #13 (P2) — `Location.premisesId @unique @default("")` latentna kolizija — 2. lokacija brez FURS oznake = P2002 (multi-lokacija = osnovni use case).** — **KODA IZVRŠENA (Task 44, v1.50.0 @ 6166bba+):** obe shemi `String? @unique`, baseline migration.sql usklajen, locations POST/PATCH normalizirata `'' → null`, UI null-safe, enkratna admin ruta `migrate-issue13` (fiksne DDL, idempotentno, audit SCHEMA_MIGRATION_ISSUE13), 588 testov (+4: U2 obrnjen — lokacija brez oznake zdaj 201; U4 dve brez oznake; U5 PATCH čiščenje + reuse; U6 duplikat 409). **OSTANE 1 KORAK: produkcijski DDL** — `POST /api/admin/migrate-issue13` z avtenticirano centralno vlogo (ruta je že na produkciji). Neon efemerne vloge ne morejo ALTER (tableowner `app_owner`, ownership potreben — 2 poskusa v Task 44, workflow odstranjen); produkcijski DDL gre izključno prek admin rute. Ko je DDL apliciran: re-run CI drift checka (neon-smoke) → zelen; do takrat je run na 6166bba/aa7980c rdeč SAMO na driftu (tests zeleni, deploy neodvisen — produkcija deluje normalno). — **Task 45 (CI higiena):** drift-check step preurejen v `scripts/drift-check.ts` z **known-issue allowlist** — znani pending drift (issue-13) zdaj na CI izpiše `::warning::` anotacijo in job je ZELEN (rdeči main na vsakem commitu bi učil ignoriranja CI in utišal prave regresije); VSAK drug drift (tuj tabela/stolpec/klavzula) in infra napake (npr. P1001 unreachable, ločene od drifta prek prisma exit koda: 0=brez, 2=drift, 1=napaka) ostajajo hard fail. Allowlist avtomatsko utihne, ko je uporabniški DDL apliciran (drift izgine — brez spremembe workflowa). Pokrito z 14 unit testi (`tests/drift-check.test.ts`); GitHub run 38085264021 je zadnji rdeči (stari drift step).
- **UI robustnost — error boundaries in branded 404 manjkajo (crash → neobrandsana angleška privzeta stran).** — **✅ ZAPRTO (Task 50, v1.52.0):** `src/app/error.tsx` (klient, role="alert", reset(), statična SL+HR besedila, `error.digest` pogojno za podporo, console.error v runtime loge), `src/app/global-error.tsx` (ZADNJE GARANCIJE — lovi tudi napake root layouta, lasten `<html><body>` + globals.css, brez kontekstov), `src/app/not-found.tsx` (branded 404 + povezava na začetek). Zasnova SAMOZADOSTNA: boundaries ne smejo uporabljati i18n kontekstov/DB/auth (crash-vzročna odvisnost je lahko prav tam) — besedila statična SL primarno + HR sekundarno, gumbi ≥ 44 px, aria. Živa verifikacija: temp throwing route (preimenovan iz `__errtest` — podčrtaj = Next.js private folder = 404 lekcija!) → boundary rendra SL+HR, reset obstojen, brskalniška napaka zabeležena; branded 404 živo potrjena. Statični regresijski testi (3) tudi pinajo odsotnost kontekstnih odvisnosti v izvorni kodi boundaries.
- **UI robustnost — naročilni dialog meša menije lokacij (najdeno v Task 51 brskalniškem pregledu).** — **✅ ZAPRTO (Task 51, v1.52.1):** dialog "Novo naročilo" pri pogledu vseh lokacij je pokaže artikle vseh lokacij (naročanje tujega artikla zavrne šele ops.ts — integriteta varna, a izgubljen klik). Fix: GET `/api/menus` opcijski `?locationId=` (staff VEDNO svoja lokacija prek isCentralRole ločnice, centralna = param ali vse — upravljanje menija nespremenjeno), `mapMenuItem` nosi `locationId` (Category→Menu), dialog filtrira na lokacijo mize + prazno stanje (`orders.noMenuItems` SL/HR). Živo potrjeno: dialog pokaže samo artikle lokacije mize. Mikrokopija DIRTY mize izboljšana ("Klikni — očisti" → SL "Za pospraviti — klikni" / HR "Za pospremiti — klikni" — stanje pred navodilom, en-klik očisti ostaja). Celoten zlati tok (prijava → naročilo → KDS → plačilo → račun 2026-10-4-BLG001 + EOR) živo preverjen v brskalniku brez regresij.

## 14. Definition of Done — checklist

- [x] Potrjen zemljevid vseh ključnih tokov in vlog (§3, §4) — z dokazi.
- [x] Kritični računovodski/zalogovni izračuni imajo teste (billing, fiskal, waste, procurement, tips, timeclock; novi CAS popravek zalog E2E dokazan — dodatni unit testi za R-pot ~~predlagani kot P1~~ **IZVRŠENO (Task 40):** `tests/race-fixes-p1.test.ts` — R1 (odprta izmena → 2. odpiranje 409, brez dvojne izmene), R3 (2 vzporedna zaključka → točno EN Z-poročilo + EN SHIFT_CLOSE), R4 (StockTransaction evidence = dejansko stanje: odštevek, talna omejitev na 0, inventurni setQty — 3 vnosi, vsota = delta), R5 (addItems na plačano naročilo → 409; na odprto → postavka + recalc), R6 (CAS zasedba mize → 409 drugemu aktivnemu naročilu, replay istega klika dovoljen), R8 (maxUses prekoračitev → 409, števec ostane 1); 582 testov skupaj).
- [x] Kritične varnostne in race-condition napake popravljene, kjer je varno (R1–R6, R8, R10, login rate limit — brez spremembe sheme, brez migracij, vse v obstoječih vzorcih kode).
- [x] CI rezultati dejanski in dokumentirani (§1; GitLab CI označen kot neverificiran — blokada dostopa, ni trditve o uspešnosti).
- [x] Porocilo vsebuje prioritete in blokade (§13).

- **Org meja na seznamskih endpointih za centralne vloge (znana omejitev Task 52: seznamski endpointi brez org filtra).** — **✅ ZAPRTO (Task 54, v1.55.0):** `locationScope` zdaj async + org allow-lista za centralne vloge — `locationId IN [lokacije svoje org + nevezane legacy (propertyId null)]`; migracijsko varno (neznana org uporabnika → brez filtra, produkcija z nevezanimi lokacijami se ne regresira), bootstrap break-glass vidi vse, staff lokacijski sloj nespremenjen (fail-closed sentinel). Mehanično povezano v 27 API rut (`await locationScope(user)` codemod + tsc arbiter); print/ack type-najozja rešitev z ekstaktno staro semantiko (centralna → null kot prej). DB-backed testi (orgA/orgB + legacy): orgA vidi orgA+legacy NE orgB, orgB obratno, legacy admin vidi vse, bootstrap vse, waiter izključno svojo lokacijo (tudi isto-org ne); statična regresija: 0 sinhronih klicev, ≥20 rut z await. 7 novih testov (652/652).


