# PRODUCTION-HARDENING-REPORT (Issue #4)

Izvedba GitLab Issue #4: *P0/P1 — Production hardening: resource authorization, device security, integrations, tests & CI*.

Metoda po §18: **INVENTURA → P0 security → P0 testi → P1 CI → produkcijska verifikacija → poročilo**.
Inventura: 57 API rout / 95 handlerjev, 110 Prisma modelov, print-agent, CI, secrets (worklog.md, taski 4-a/4-b/4-c).

---

## A. FOUND

| Problem | Resnost | File | Endpoint | Impact |
|---|---|---|---|---|
| Offline sync = bypass cele avtorizacije (samo `requireAuth`, brez dovoljenj + lokacij) | 🔴 P0 | src/app/api/sync/route.ts | POST /api/sync | staff loc A dodaja artikle/spreminja KDS status na naročilih loc B |
| Plačilo tujega naročila + izdaja računa pod tujim taxId | 🔴 P0 | src/app/api/furs/route.ts | POST /api/furs | finančna manipulacija čez lokacije |
| Unovčenje točk tujega loyalty računa | 🔴 P0 | src/app/api/furs/route.ts:143 | POST /api/furs | kraja zvestobnih točk |
| JAVNO kovanje device tokenov (anon, poljubna lokacija) | 🔴 P0 | src/app/api/devices/route.ts | POST /api/devices | kdorkoli ustvari kiosk napravo |
| GET vrača POLNE device tokene vsem staff | 🔴 P0 | src/app/api/devices/route.ts | GET /api/devices | kraja credentials |
| POS modifier cene od clienta (`num(m.price)`) | 🔴 P0 | src/lib/ops.ts | POST /api/orders | manipulacija cen |
| Guest modifier relacija = NO-OP (`mods.find(x => x.id === m.id)`) | 🔴 P0 | src/lib/guest.ts | /api/public/orders | modifier kateregoli artikla kamorkoli; required/min/max niso uveljavljeni |
| QR token mintanje z običajnim requireAuth čez lokacije | 🔴 P0 | tables/[id]/qr/route.ts | GET/POST | naročilni tokeni tujih miz |
| tables/[id] PATCH brez permissiona in lokacije | 🔴 P0 | tables/[id]/route.ts | PATCH | vsak staff ureja katerokoli mizo |
| reservations PATCH brez permissiona in lokacije | 🔴 P0 | reservations/route.ts | PATCH | — |
| kitchen PATCH po client itemId brez lokacije | 🔴 P0 | kitchen/route.ts | PATCH | KDS status tujega naročila |
| Employee PATCH PIN reset čez lokacije | 🔴 P0 | employees/[id]/route.ts | PATCH | prevzem identitete zaposlenega |
| Reporti/audit/locations/stats/loyalty/inventory/delivery/recipes/employees/meni — globalni GET/PATCH | 🔴 P0 | 15+ datotek | večinoma GET | cross-location branje/vpisi |
| display pairing: `resolvePosRow` = zadnja POS GLOBALNO | 🔴 P0 | devices/display/route.ts | POST pair/push | pairing tuje lokacije |
| `createOrderCore`: tableId nevalidiran + findFirst() lokacijski fallback | 🔴 P0 | src/lib/ops.ts | orders/sync/webhook | naročilo loc A zasede mizo loc B |
| print-agent: `0.0.0.0:3031`, BREZ auth, poljuben host/port, brez payload limita | 🔴 P0 | mini-services/print-agent/index.ts | TCP | odprt TCP bridge / SSRF |
| APP_SECRET: hardkodiran dev fallback uporabljen v PRODUKCIJI (ni bil v Vercel env) | 🔴 KRITIČNO | src/lib/auth.ts | vsi žetoni | kovanje žetonov s znanim secretom |
| Rate limiterji: process-memory, delivery brez size cap | 🟠 P1 | guest.ts, delivery.ts | javni endpointi | limit × instance, neomejena rast |
| `integrations GET` vrača cel `config` | 🟠 P1 | integrations/route.ts | GET | možen secret leak staffu |
| sync GET vrne poljubno napravo; polja `kind`/`createdAt` ne obstajata (runtime undefined) | 🟠 P1 | sync/route.ts | GET | info leak + pokvarjena diagnostika |
| vercel-*.json git-tracked (env imena + encrypted blobs) | 🟠 P1 | repo root | — | secret hygiene |
| webhool cancel: `deliveryInfo.updateMany({ orderId })` — neobstoječe polje | 🟠 P1 | delivery/webhook/[provider] | POST | cancel pot NIHČ (runtime) |

## B. FIXED

Commit: glej git log (`issue-4` serija). Vsak fix ima `// Issue #4 §…` komentar.

| File | Fix | Test |
|---|---|---|
| src/lib/api.ts | + `assertResourceLocation` (fail-closed), `locationScope`, `requireUserLocation`, `isCentralRole` — enoten centralni authorization layer (§1) | tests/location-auth.test.ts (9) |
| src/lib/rate-limit.ts (NOVO) | skupni limiter: bounded 10k keys + LRU izrinitev + TTL sweep (§6) | tests/rate-limit.test.ts (4) |
| src/lib/modifiers.ts (NOVO) | čista validacija modifierjev: relacija artikel→skupina→modifier, required/minSelect/maxSelect, duplikati, cene iz DB (§5) | tests/modifiers.test.ts (9) |
| src/lib/guest.ts | resolveGuestItems → polna validacija + lokacijska vezava artiklov (Category→Menu.locationId); rate limit delegiran | tests/modifiers.test.ts |
| src/lib/ops.ts | POS cene opcij IZ DB, tableId mora pripadati lokaciji (v transakciji), striktna lokacija (findFirst fallback samo za webhook), artikel mora pripadati lokaciji | E2E |
| src/lib/auth.ts | APP_SECRET fail-closed v produkciji (env OBVEZEN), dev fallback samo lokalno (§15) | produkcijska verifikacija |
| devices/route.ts | GET: maskirani žetoni + locationScope; POST: auth + `employees.manage` + server-side lokacija + rate limit + audit (§2) | E2E |
| devices/enroll/route.ts (NOVO) | ENKRATNA vpisna koda: 8 števk, TTL 15 min, enkratna uporaba, rate limit 10/5min, audit (§2.2) | E2E |
| devices/[id] | location gate; revoke uniči tudi enrollment kodo (§2.1) | E2E |
| devices/display | `resolvePosRow` location-scoped (staff brez lokacije fail-closed); pairing koda ENKRATNA (po connectu se izbriše) (§3) | E2E |
| furs + furs/[id] | lokacijski gate na plačilo/branje; loyalty acc mora pripadati lokaciji; odgovor nosi `fursEnvironment` label (§1, §8) | E2E |
| sync | ISTA dovoljenja kot online poti + lokacijski gate v applyOp + striktna lokacija + GET scoping + popravljeni runtime bugi (§1) | E2E |
| orders + [id] + bill + discount | locationScope GET; gate na branje/spremembo/storno; prazni PATCH zavrnjeni; addItems vezani na lokacijo naročila (§1) | E2E |
| 25 preostalih rut (agent 6-a) | tables/qr, kitchen, reservations, employees, reports/financial+export, audit, locations/stats, loyalty, inventory, recipes, discounts, delivery(+zones), dashboard, haccp, shifts, guests/feedback, settings, integrations (masking), menus, expenses | tsc + lint |
| print-agent (§7) | privzeto 127.0.0.1; `PRINT_AGENT_TOKEN` (obvezen za LAN — fail-closed exit); host allowlist (privatna območja, 169.254 vedno zavrnjen); port allowlist 9100–9102; payload ≤ 64 KB; logi brez skrivnosti; honest `delivered-to-kernel` | smoke curl 403/413/401 |
| delivery/webhook | popravljen cancel where (relacija `Order`) | E2E |
| prisma/schema.prisma + mirror | DeviceRegistry: + enrollmentCode/enrollmentExpiresAt/enrollmentClaimedAt (§2.2) | check-schema-drift |
| .gitlab-ci.yml (NOVO, §12) | quality-gate: install → typecheck → lint → bun test → schema drift → secrets scan (MR + main) | CI pipeline |
| scripts/check-schema-drift.py (NOVO, §13) | model-drift check postgres↔sqlite | CI |
| scripts/check-secrets.sh (NOVO, §15) | scan žetonov v kodi (brez .md zgodovine) | CI |
| tests/ (NOVO, §11) | 33 unit testov (bun:test): modifiers 9, location-auth 9, rate-limit 4, billing 11 | `bun test` 33/33 |
| vercel-*.json | umaknjena iz git trackinga (.gitignore) | git status |
| UI (page.tsx, kiosk, dashboard-tabs) | aktivacija naprave z vpisno kodo; seznam naprav maskiran; DevicesCard → »Vpisna koda« tok | E2E |
| delivery/webhook (D6, v1.32.0) | naročila vezana na `Integration.locationId` + dovoljen sistemski fallback; cross-location cancel zavrnjen (403 + audit `DELIVERY_CANCEL_BLOCKED`) | tsc + revizija poti |
| auth.ts + api.ts (D4, v1.32.0) | session revokacija: žeton nosi `sv` (sessionVersion); `requireAuth`/`requirePermission` preverjata status + sv v DB (fail-closed); PIN reset IN deaktivacija povečata sessionVersion → takojšnja revokacija vseh žetonov | tests/session.test.ts (4) |

## C. VERIFIED

- **typecheck**: `tsc --noEmit` → **0 napak** (prej: 23 pre-existing, tudi runtime bugi — vsi popravljeni)
- **lint**: `eslint .` → **0 napak**
- **unit**: `bun test` → **37 pass / 0 fail** (33 + 4 session revokacija, v1.32.0)
- **schema drift**: 110/110 modelov usklajenih
- **secrets scan**: 0 najdb v kodi
- **build/deploy**: Vercel (glej DEPLOYMENT-STATUS zapis) — produkcija po deployu verificirana prek agent-browser (prijava, POS tok, mize, E2E happy path)
- **CI**: GitLab quality-gate definiran; obvezuje MR-je (runner/secrets se doda ob prvem zagonu — glej D)

## D. REMAINING (dejavno odprto)

1. **Polno distribuiran rate limit** — trenutno bounded per-process (združljivo z Vercel deploymentom, limit × instance). Poln shared state zahteva Redis/Upstash — ko se uvede, zamenjaj samo `src/lib/rate-limit.ts` notranjost.
2. **Integration/E2E testi v CI** — 37 unit testov pokriva čisto logiko (modifiers/auth/rate-limit/billing/session); DB-integration testi zahtevajo test DB runner v CI (dodati ob prvem CI zagonu: `DATABASE_URL` secret + sqlite seeded copy).
3. **Build step v CI** — potrebuje `DATABASE_URL` v GitLab CI variables (build ne sme zahtevati DB dostopa v prerender — zaenkrat izpuščen, dokumentiran v .gitlab-ci.yml).
4. **print-agent delivery proof** — TCP uspeh = `delivered-to-kernel` (printerski ACK ni izpelan iz ESC/POS odgovorov); realni tiskalnik lahko kljub ok:true ne natisne papirja. Realna integracija zahteva printer status callback.
5. **monitoring/errors** GET ostaja centralno-diagnostičen (by design).

> Zaprti v v1.32.0:
> - **D4 session revokacija** — žeton nosi `sv` (sessionVersion); vse requireAuth + requirePermission rute preverjajo status + sv v DB (fail-closed); PIN reset IN deaktivacija povečata sessionVersion → takojšnja revokacija. Učinek deploya: žetoni izdani prej so preklicani → enkratna ponovna prijava vseh uporabnikov.
> - **D6 webhook lokacijska izolacija** — naročila/preklici vezani na `Integration.locationId`; cross-location cancel 403 + audit `DELIVERY_CANCEL_BLOCKED`. Hkrati popravljen P0 regresija iz ca67270: webhook je klical createOrderCore z locationId:null BREZ allowFirstLocationFallback → ustvarjanje delivery naročil je od hardeninga dalje vračalo 422 »Ni lokacije«.

## E. PRODUCTION BLOCKERS

**BLOCKER**
- *(rešeno v tej seriji)* APP_SECRET bil manjkajoč v Vercel env → nastavljen (production+preview) PRED deployom; vse obstoječe seje so s tem razveljavljene (uporabniki se ponovno prijavijo — pričakovano).

**HIGH**
- **Rotacija Vercel `vcp_` deploy tokena** + Neon gesla + `NEXTAUTH_SECRET` (tudi glej DEPLOYMENT-STATUS.md → nujni koraki; token je krožil v klepetu/dokumentaciji).
- **GitHub PAT mrtav** (401) → GitLab↔GitHub mirror trenutno deluje samo prek obstoječega Actions crona z GL tokenom; za push-mirror s našega GitLaba potreben nov GitHub token (Classic, scope `repo`).
- **v1.32.0 deploy:** žetoni izdani prej so fail-closed preklicani (D4) → vsi uporabniki se enkrat ponovno prijavijo (pričakovano, kot ob APP_SECRET rotaciji).

**MEDIUM**
- **PIN_LOOKUP_SALT rotacija** — zahteva USKLJENO ponastavitev vseh 8 zaposlenih PIN-ov (en obrok: rotiraj salt + vsi nastavijo nov PIN).
- **GitLab CI secrets** — ob prvem zagonu pipeline dodati `DATABASE_URL` za build step (oz. pustiti build izven gate-a do ureditve prerenderja).

**LOW**
- Rate limit tuning per endpoint po realnem prometu.
- `DeviceRegistry.deviceId` v plaintextu — hash-basis shranjevanje tokenov (zahteva migracijo vseh naprav = ponovni enrollment).
- posodobiti vercel-deployments.json snapshot (zastarel).

---

* DONE pomeni: dokazano delujoč IN ustrezno avtoriziran end-to-end tok. Model/endpoint/UI sam po sebi NI dokaz (issue #4 §17).
