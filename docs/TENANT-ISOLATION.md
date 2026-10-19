# Tenant Isolation (issue #12 §1 + §8)

## Meja

```
Tenant/Organization → Brand → Property → Location → (RevenueCenter/Workstation/Device/User)
```

**Location je operativno sidro** in pripada točno eni organizaciji prek verige
`Location.propertyId → Property.brandId → Brand.organizationId`.
Vsi transakcijski podatki (Order, Payment, Receipt, Device, …) nosijo `locationId`
→ eno lokacijo = eno organizacijo. Tenant meja se torej izračuna iz lokacije —
ne vzdržujemo ločenega `tenant_id` na vsakem modelu (duplikat istega dejstva).

## Pravila (implementirano v1.35.0)

1. **Lokacijske vloge** (manager/staff/waiter/bar/chef/kitchen/warehouse/accounting):
   dostop IZKLJUČNO lastna lokacija — `assertResourceLocation` / `locationScope`
   (src/lib/api.ts, issue #4 §1). To po konstrukciji preprečuje cross-tenant.
2. **Enterprise vloge** (group_owner/org_admin/property_manager): preklok čez
   lokacije SAMO znotraj istega org/property — `enterpriseAllows`
   (src/lib/enterprise.ts, issue #11), fail-closed brez verige.
3. **Centralne vloge** (ADMIN/OWNER) — cross-location dostop je omejen z lokacijskim
   modelom; org meja pa je ŽIVO povezana v splošne API rute (v1.53.0, Task 52 —
   zaprto P1 iz audita: prej je bil `assertTenantScope` definiran a ničerar klican).
   - **Točkovne rute** (branje/posodabljanje/brisanje virov z lokacijo): `guardResource`
     (src/lib/tenant.ts) = `assertResourceLocation` (lokacijski sloj) + `assertOrgScope`
     (org sloj za centralne vloge) — povezano v vseh 28 točkovnih rutah (mehanična
     migracija, tsc-verificirana; statični regresijski test prepoveduje goli
     `assertResourceLocation` klic v src/app).
   - **CREATE rute**: `assertOrgScope(user, locationId)` tik za `requireUserLocation`
     (18 mest) — blokira kreiranje virov na lokaciji tuje org (forged locationId).
   - **PREMIK rute (v1.147.0, audit #8)**: `body.locationId` na obstoječem viru
     sme spremeniti lokacijo SAMO, če je overjeno **OBOJE** — vir (trenutna
     lokacija) IN cilj: `guardResource(user, cilj)` pred vpisom (vzorec
     `integrations/[id]`, issue #42 točki 3 in 4). Odklop na `locationId = null`
     je platform-level posest (`guardGlobalResource`): takšnih virov seznam
     `locationScope` ne pokaže nobeni organizacijsko vezani vlogi, kar pa seznam
     ne pokaže, sme tudi mutirati samo bootstrap admin. Pokrito:
     `employees/[id]` PATCH, `devices/[id]` PATCH. Zakaj je to varnostno in ne
     estetsko vprašanje: lokacija nosi dostop do podatkov (seje, poročila,
     zaloge), naprava pa nosi device žeton, premakniti pa jo je mogoče v tuj
     FURS poslovni prostor — javni `GET /api/auth/locations` (audit #9) je zato
     razkrival veljavne ciljne ID-je.
   - **Seznamski endpointi** (`locationScope`): **✅ org allow-lista ŽIVO (Task 54,
     v1.55.0)** — centralne vloge vidijo lokacije SVOJE organizacije + nevezane legacy
     (`propertyId null`, migracijsko varno — isti pravilnik kot assertTenantScope/
     assertOrgScope); neznana org uporabnika → brez filtra (produkcija z nevezanimi
     lokacijami se ne regresira), bootstrap break-glass vidi vse; staff lokacijski
     sloj nespremenjen. Async (`await locationScope(user)`) — povezano v 27 API rutah
     (tsc-verificirano); testi: `tests/tenant-org-list.test.ts` (orgA vidi orgA+legacy
     NE orgB, obratno; legacy admin brez filtra; bootstrap vse; waiter fail-closed).
   Semantika `assertTenantScope` (in `assertOrgScope`) — migracijsko varno, usklajeno
   z oglavjem tenant.ts in `tenantAllows`:
   - org uporabnika ≠ org vira (obe znani) → **403**;
   - org uporabnika ali vira neznana (legacy, nevezani podatki) → obstoječe
     lokacijsko vedenje (migracijsko varno — ne odrežemo produkcije; to pravilo
     je bilo v kodi POPRAVLJENO v1.53.0 — prej je `assertTenantScope` pri
     neznani uporabnikovi verigi vrnil 403 v nasprotju s tem dokumentom);
   - **bootstrap admin** (`sub='bootstrap'`) = break-glass za obnovo dostopa, gre
     skozi (izrecno odločitev, dokumentirana tudi v SECURITY-BOUNDARY.md).
4. **Kreiranje organizacij** = platformna operacija (SaaS onboarding): samo
   bootstrap (POST /api/enterprise `kind:'organization'`). Brand/property
   kreacija in link-location → samo znotraj organizacije uporabnika.
5. **GET /api/enterprise** vrne SAMO organizacijo uporabnika (prej: vse — zaprto
   uhajanje). Bootstrap vidi vse.

## Pokritost ostalih poti (inv. §0)

| Pot | Tenant varnost |
|---|---|
| Webhooki (Glovo/Wolt) | `Integration.locationId` vezava; naročilo nastane na lokaciji integracije; cancel cross-location → 403 + audit `DELIVERY_CANCEL_BLOCKED` (v1.32.0 D6) |
| Sync (/api/sync) | `requireAuth` + `user.loc` sidro; `assertResourceLocation` na order.addItems/kitchen.status; idempotencija `DeviceSyncOperation` |
| Javni QR/kiosk | lokacija/miza se rešita SERVER-SIDE iz qrToken/device žetona — client ID-ji niso zaupani (src/lib/guest.ts) |
| Export (/api/reports/export) | `locationScope` + relacijski scope (Check→Order, InventoryItem) |
| Device enroll | enkratna koda (8 mest, kratka veljavnost) + lokacijska vezava ob claim-u; revoke = `DeviceRegistry.revokedAt` |
| Print | `/api/print/*` zahteva žeton (requireAuth) |
| Darilne kartice (issue #26, v1.101.0) | Glede na operacijo: **POS lookup** (`/api/giftcards/lookup`) = org obseg (medposlovalnično unovčenje ISTE org dovoljeno; staff brez org dreva → lastna lokacija; centralna z neznano org → prazno/fail-closed; tuja org + legacy brez lokacije → enoten 404); **ledger/urejanje** (`/api/giftcards/[id]` GET/PATCH) = `giftcards.manage` + `guardResource` (staff = lastna lokacija, centralni = org); **polnjenje** (`topup`) = `orders.pay` + `guardResource` PRED idempotentnim replayem (ključ NI poverilnica); **unovčenje** (fiskalni tok) = kartica je instrument ORGANIZACIJE — `isCrossTenantLocations(order, kartica)` → cross-tenant 409. Legacy kartica brez `locationId` = fail-closed povsod (404/409), razen bootstrap break-glass. |

## Testi

- `tests/tenant.test.ts` — cross-org READ/WRITE DENY, forged org/location ID,
  legacy passthrough, hierarhična pravila ostanejo (regresijski guard).
- `tests/tenant-org.test.ts` (v1.53.0) — org meja ŽIVO: dve org drevesi + legacy
  lokacija; cross-org READ/WRITE/CREATE → 403, isti-org čez lokacije → 200,
  bootstrap break-glass, migracijsko varni scenariji (legacy lokacija/vir → pass),
  statična regresija (ni več golih `assertResourceLocation` klicev v src/app).
- `tests/enterprise.test.ts` — drevo + obseg (#11).
- `tests/tenant-org-list.test.ts` (v1.55.0) — org allow-lista na seznamskih
  endpointih (locationScope async): centralna vloga orgA vidi orgA + legacy, NE
  orgB (in obratno); legacy admin (org neznana) → brez filtra (migracijsko varno);
  bootstrap vse; waiter izključno svojo lokacijo; statična regresija (vsi
  `locationScope` klici v src/app/api so `await`, ≥ 20 rut).
- `tests/issue26-giftcard-tenant.test.ts` (v1.101.0) — darilne kartice: ledger
  pod `giftcards.manage` + org obsegom; PATCH/topup cross-tenant 403 brez
  spremembe salda; replay ključ iz tuje org ne obide avtorizacije; lookup
  medposlovalnično isti org OK / tuja org enoten 404; legacy kartica brez
  lokacije fail-closed; fiskalno unovčenje isti-org čez lokacije OK,
  cross-tenant 409.

## Znane meje (transparentno)

- Legacy lokacije brez `propertyId` NISO pod tenant mejo (org neznana) — varuje
  jih lokacijski sloj. Ko se povežejo v drevo (link-location), meja postane stroga.
- Per-tenant unikatni indeksi: trenutno globalni (npr. `Employee.email`,
  `Location.code`) — za SaaS z več orgi se naslavlja ob onboardingu (odprto v
  issue #5 kot enterprise control plane); ni blokator za trenutno topologijo.
