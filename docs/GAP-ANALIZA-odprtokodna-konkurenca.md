# GAP-ANALIZA: odprtokodna konkurenca — TastyIgniter, QloApps, OrderRestro (2026-10-30)

Raziskava na zahtevo lastnika: *„analiziraj repoje, če so kje boljši ali če je
kaj pametnega za pobrat, kaj nam manjka"* — za tri repozitorije:

| Repo | Kaj je | Referenca v analizi |
|---|---|---|
| `tastyigniter/TastyIgniter` | MIT, PHP 8.3–8.5 / Laravel 13, veja `4.x` | klon @ `ebb91a3` (2026-10-17) |
| `QloApps/QloApps` | OSL v3, PHP / PrestaShop 1.6 fork — **hotel** rezervacije | klon @ `ef3dc5e` (2026-10-28) |
| `Raktim94/nodedr-restaurant-pos` | **AGPL v3**, Node 22 / pnpm / NestJS + Next.js + Prisma + Postgres — „OrderRestro" | klon @ `db981ec` (2026-10-30, izdaja 1.10.0) |

Metoda: plitvi kloni v peskovniku, branje README/FEATURE-CHECKLIST/ROADMAP/
ARCHITECTURE/licenc + lastna verifikacija trditev **proti naši kodi** (rg čez
`src/` + `prisma/schema.prisma` @ v1.198.0). Vsak kandidat spodaj je preverjen,
da pri nas OBSTAJA ali NE OBSTAJA — brez ugibanja.

**Licenčni sklep (kaj sme „pobrat" kodo):** RestaurantOS je privatni repozitorij
brez OSS licence. OrderRestro je **AGPL v3** → njegove kode ne smemo vzeti (samo
ideje/vzorci). TastyIgniter je **MIT** → koda pravno dovoljena, a je PHP/Laravel
— platformsko neuporabna. QloApps je **OSL v3** (kopyleft) + hotel vertikala.
→ **Pobiramo vzorce in ideje, ne kode.**

---

## 1. Poštena primerjava (kje so oni boljši, kje mi)

### OrderRestro (nodedr) — najbližji arhitekturni bratranec

Ista tehnološka generacija (TypeScript strict, Next.js, Prisma, offline-naslovljen
POS, purpose-built gostinstvo). Njihov FEATURE-CHECKLIST je izjemno pošten
(shipped/planned po funkciji, „cross-referenced against the actual codebase").

**Kje je OrderRestro boljši (pošteno, preverjeno da pri nas NI):**

| Funkcija pri njih | Pri nas | Kandidat |
|---|---|---|
| Modul **Vzdrževanje opreme** (#16): register opreme, servisni razporedi, overdue zastavice | NI (rg „vzdrževanj/ equipment" — ni modula; HACCP pokriva samo higienske meritve) | **OSS-1** |
| Modul **Dokumenti** (#17): SOP-i, pogodbe, recepture + priponke (PDF/slike/Office) | DELNO (HACCP načrti + recepture/batch-preparations; splošni dokumenti s priponkami NI) | **OSS-2** |
| **Kampanje po kanalih** (#14): email (lastni SMTP) / SMS / WhatsApp z opt-out | DELNO (waitlist SMS opomnik v1.188.0 + push OPS11; kampanjni model z opt-out NI) | **OSS-7** |
| **Načrtovana poročila po e-pošti** (#13): 18 poročil + urni pošiljanji | DELNO (cron-daily, lot-alert, paylink-reconcile obstajajo; urni poročila na SMTP NI) | **OSS-8** |
| **Odprta API specifikacija** (#19): REST + Swagger | NI (API + ključi + dnevnik v Integracijah obstajajo; OpenAPI spec NI) | **OSS-5** |
| **MCP strežnik** (#19): osebni API ključi (identiteta uporabnika) za AI odjemalce, ločeno integration keys z izrecnimi dovoljenji | NI (dveh vrst ključev NI; imamo enoten API ključ + dnevnik) | **OSS-6** (razred B — glej spodaj) |
| **Čas mize** (elapsed) na tlorisu/mizah | ŽE IMAMO — v1.129.0 (Toast vzorec): zasedena ploščica nosi ⏱ minute od naročila + fazo + št. naročila + goste + znesek (dashboard page, `kdsMinutes(ao.createdAt)`); analiza v1.199.0 tu NISEN najdla (lažna vrzel, popravljeno @ v1.201.0) | ~~OSS-3~~ — ZAVRJEN kot lažna vrzel |
| **Hold/draft naročila** (zadrži nedokončano) | ~~NI~~ **IZVEDENO v1.204.0** (status hold + resume; CAS garde) | **OSS-4** |
| **Večregionalni davčni režimi** (GST/US/EU-VAT/Spain IVA, vključno/izključno cene) | NE-VELJA (mi smo SI/HR z DDV + fiskalizacijo — drugačen trg; naše fiskalne meje so globlje) | brez kandidata |
| **One-click pakiranje** (CasaOS/ZimaOS) + živi demo + case study | DELNO (lokalni autostart/backup skripte; NAS paket NI) | **OSS-13** |
| Zvočna potrditev plačila (UPI UX) | DELNO (push obstaja; zvočni signal NI) | **OSS-15** |

**Kje je RestaurantOS boljši (dokazi iz kode, brez trinkarij):**

| Področje | Mi @ v1.198.0 | OrderRestro 1.10.0 |
|---|---|---|
| **Delitev računa** | split po gostih LPT (v1.185.0), po izstavkih, **sedeži v celotnem toku** (v1.193.0+1.195.0), sedežni split izstavkov | „display-only equal-split calculator, not separate per-guest checks" (njihov checklist!) |
| **Fiskalizacija** | FURS (SI) + Fiskalizacija 2.0 / FINA (HR), EOR, DUR izvoz | NI (Indija: UPI QR) |
| **E-računi** | eSlog GL izvoz (B-1 = transport čaka lastnika) | NI |
| **HACCP** | meritve + načrti | NI |
| **Pravi offline POS** | offline vrsta z R2b1/R7 garancijami, `/api/sync` z clientOperationId idempotenco, urejanje postavk po fire | njihov ARCHITECTURE.md: *„NOT planning client-side offline … CRDTs"* — „offline-first" = single-location by construction |
| **Poštenost tiska** | print-agent ESC/POS cp852 TCP 9100 + **`sent ≠ printed`** + PrintJob evidence + DLE polling na runbook | „self-printing HTML receipt via browser dialog" + USB ESC/POS (njihova trditev brez evidence sloja) |
| **Audit** | AuditLog + **hash chain** (blockchain veriga) | audit log (brez verige) |
| **Kuponi/zvestoba** | kampanje + rojstnodnevni samodejni + ročni (v1.187.0) | *„Coupon codes — Planned. No coupon/promo model"* (njihov checklist!) |
| **Payroll globina** | minute + postavke + **noge doplačil po kolektivni pogodbi** (v1.192/1.197), izvoz shema /3 z iskrenimi praznimi polji | payroll iz ur + tip pool — pariteta, brez naših nog |
| **Jeziki gostov** | 5 (SL/HR polna, EN/DE/IT gostovska, DE Sie-forma) | 3 (EN/ES/FR) |
| **Testna globina** | **4026 pass / 195 datotek**, enota + integracija + E2E, pariteta i18n testi | 8 E2E spec datotek (jest) + unit; 79 Prisma modelov (mi 138) |
| **KDS postaje** | PrepStation CRUD + več postaj na artikel + expo zastavica (v1.112.0) | multi-station routing ✅ — pariteta |
| **MFA** | TOTP + **8 recovery kod (SHA-256, enkratna)** + step-up | 2FA z recovery — pariteta |
| **Rezervne kopije** | local-backup + offsite + BACKUP-RESTORE.md | backup/restore ✅ — pariteta |

### TastyIgniter — ekosistem in tržnica, ne operativna globina

- **Boljši:** ekosistem razširitev/tržnica + teme (glavna vrednost), zrela
  spletna naročila + rezervacije kot javni produkt, MIT, velika skupnost,
  prevedba prek Crowdin.
- **Kje zaostaja za nami:** ni payroll, ni fiskalizacije SI/HR, ni HACCP, ni
  kuhinjskih postaj/offline POS globine; Laravel monolit (druga platforma);
  veja 4.x je v prestrukturiranju (razširitve preseljene v composer pakete).
- **Kaj pobrat (ideja, ne koda):** vzorec **tržnice/razširitev** je C-razred
  (mreža/partnerji) — **OSS-12**; vzorec **tem po znamki** (Org→Brand→Property
  imamo) — **OSS-11** (B: oblikovna odločitev).

### QloApps — hotel vertikala (referenca za C-17)

- **Kaj je:** odprtokodni hotel rezervacijski sistem (PrestaShop 1.6 fork):
  sobe, rezervacije, housekeeping (`qlocleaner`), hotel poročila,
  **channel manager konektor** (`qlochannelmanagerconnector`), Google Hotel.
- **Ustreza:** kandidatu **C-17 Hotel PMS** iz TRZNA-VRZELI-2027 (Lightspeed
  vertikala Terme/hoteli SI/HR) — QloApps je brezplačen referenčni vir za
  bodočo vertikalo (vzorci: kanalni upravitelj, obsežnost po sobah, čiščenje).
- **Opozorilo:** PrestaShop 1.6 baza je starajoča (PHP), OSL v3 kopyleft —
  zgolj referenca, ne izhodišče za kodo.

---

## 2. Kandidati za NASLEDNJO generacijo (NE ponovno odpiranje zaključene 2027)

A-sklop 2027 je **IZČRPAN** (v1.195–1.198) in ostaja zaprt. Spodnji kandidati
so **za odobritev lastnika** (nova generacija, „OSS-x"), razvrščeni po isti
konvenciji kot TRZNA-VRZELI-2027. **Brez odobritve se nič od tega ne začne.**

| # | Kandidat | Izvor | Obseg | Razred |
|---|---|---|---|---|
| **OSS-1** | **Vzdrževanje opreme** — register naprav (pečice, hladilniki, klima), servisni razporedi, overdue zastavice, povezava s HACCP lokacijami | OrderRestro #16 | modeli + rute + UI kartica + i18n + testi; brez DDL na produkciji (DDL konzola vzorec v1.197.0) | A (čista koda) — **IZVEDENO @ v1.200.0**: tabeli Equipment + EquipmentMaintenancePlan, rute /api/equipment*, kartica Nastavitve → Operacija, DDL konzola `equipment-maintenance` čaka klik |
| **OSS-2** | **Dokumentni modul** — SOP-i, pogodbe, recepture s priponkami; obseg HACCP ostaja ločen | OrderRestro #17 | modeli + nalaganje datotek (lokalen disk/db blob — odločitev ob implementaciji) + UI + i18n | A (mali–srednji) — **IZVEDENO @ v1.203.0**: tabela Document (vsebina kot bytea V BAZI — produkcija read-only disk; budget 1 MB raw; mime allowlist brez SVG/HTML; prenos vedno attachment + nosniff), rute /api/documents* (branje = vse vloge z lokacijskim obsegom, pisanje = settings.manage), verzija +1 ob zamenjavi, kartica Nastavitve → Operacija, DDL konzola `documents` čaka klik |
| **OSS-3** | ~~**Čas mize**~~ — elapsed na tlorisu/mizah (koliko časa je gost na mizi) | OrderRestro planned | mali: izračun iz odprtega naročila, prikaz na kartici mize | **ZAVRJEN @ v1.201.0 — LAŽNA VRZEL**: ploščica mize že nosi ⏱ minute + fazo + št. naročila + goste + znesek (v1.129.0, Toast vzorec — `kdsMinutes(ao.createdAt)`); analiza v1.199.0 tega ni ulovila |
| **OSS-4** | **Hold/draft naročila** — zadrži nedokončano naročilo brez zaključka | OrderRestro planned | srednji: status hold + interakcija z offline vrsto (R2/R7 mora ostati garancija!) + revizija | A (srednji; previdno z R7) — **IZVEDENO @ v1.204.0**: čisti sloj `order-hold.ts` (canHoldOrder: samo open+unpaid+brez poslanih postavk — zadržano NIKOLI na KDS), ruti POST /api/orders/[id]/hold + /resume (CAS + revizija ORDER_HOLD/ORDER_RESUMED + dogodka), fire ruta s CAS-belolistnim firedAt zapisom (dirka hold↔fire = 409 + rollback), garda tečajev; VSE ostale poti fail-closed prek obstoječih belih list (ORDER_MUTABLE_STATUS / ORDER_ACTIVE_DB / ORDER_PAYABLE_STATUS ne poznajo 'hold'): urejanje, plačilo, paylink, premik, združitev, popust, preklic, void, offline sync addItems (operacija propade z 409, po nadaljevanju se ponovi — R7 garancija nedotaknjena); miza z zadržanim ostaja OCCUPIED (Issue #70 izpeljava) s besedilom »Zadržano«, klik ploščice → seznam zadržanih; 0 DDL (status je String) |
| **OSS-5** | **Odprta API specifikacija** — OpenAPI opis obstoječih javnih/integracijskih rut, statično datoteko + route za prenos | OrderRestro Swagger | statična spec + test na pokritost rut; brez nove odvisnosti | A (mali–srednji) — **IZVEDENO @ v1.201.0**: OpenAPI 3.0.3 opis vseh 14 javnih/integracijskih rut (19 handlerjev), disk↔spec pokritost v OBEH smerah uveljavljena s testi, ruta GET /api/openapi, kartica v Integracijah |
| **OSS-6** | **MCP strežnik** — osebni API ključi (identiteta uporabnika) za AI odjemalce, ločeno od integration ključev | OrderRestro | protokol, NE AI model — a ker obstaja za AI okoliša, **odločitev je lastnikova** glede pravila „brez AI" | **B** — @ v1.201.0 lastnik izrecno potrdil „ne vnašati AI modelov, samo skripte" → **OSTAJA ZUNAJ OBSEGA** |
| **OSS-7** | **Kampanje po kanalih** z opt-out (email/SMS/WhatsApp) | OrderRestro #14 | kampanjni model + opt-out = A del; transporti (SMTP/SMS/WhatsApp ponudniki) = B/C | A-del + B/C |
| **OSS-8** | **Urna poročila po e-pošti** | OrderRestro #13 | cron obstaja (cron-daily); transport = SMTP konfiguracija | B (SMTP = lastnik) |
| **OSS-9** | **Črtne kode/EAN pri nabavi** — EAN dobavitelja na artiklu, sken pri prevzemu | OrderRestro planned | mali: polje + vnos/sken; skener = tipkovnica (deterministično) | A (mali) |
| **OSS-10** | **Variante artiklov** (velikosti/nivoji) | OrderRestro planned | modifiers delno pokrijejo; potrebo potrditi z uporabo | A (za potrebo vprašaj uporabo) |
| **OSS-11** | **Teme po znamki** (akcentni barve/logotip per Brand) | TastyIgniter themes | Org→Brand→Property obstaja; oblikovna odločitev | B (oblikovna) |
| **OSS-12** | **Ekosistem razširitev/tržnica** | TastyIgniter marketplace | zahteva mrežo partnerjev | C (mreža) |
| **OSS-13** | **One-click pakiranje** (Docker/CasaOS za NAS lastnika) | OrderRestro | distribucija lokalne namestitve | A (mali, po odobritvi ciljne platforme) |
| **OSS-15** | **Zvočna potrditev plačila** (opozorilni ton ob potrjenem plačilu) | OrderRestro UPI UX | mali: zvočni signal na napravi osebja ob push | A (mali) — **IZVEDENO @ v1.201.0**: čist modul `audio-cue.ts` (dva naraščajoča tona E5→E6, WebAudio z injektiranimi odvisnostmi — 0 odvisnosti, 0 AI), nastavitev na napravo `ro_payment_cue`, klic ob potrjenem plačilu + toggle v plačilnem dialogu |

**Zavrnjeni kot vrzeli (poštena pariteta — imamo bolje ali enako):** večregionalni
davčni režimi (drugačen trg — mi imamo FURS/Fiskalizacija 2.0 + eSlog), split
plačila po gostih (oni: display-only), kuponi (oni: planned), pravi offline
(oni: izrecno ne načrtujejo CRDT offline), fiskalizacija, e-računi, HACCP,
barcode na POS s strani nodedr-pos (mi pošteno nimamo — zato OSS-9 pri nabavi,
kjer je SI uporaba realna: EAN dobaviteljev), recovery kode MFA (že imamo),
backup/restore (že imamo), multi-station KDS (že imamo, v1.112.0),
**čas mize / elapsed (že imamo od v1.129.0 — lažna vrzel vala v1.199.0,
popravljeno v1.201.0)**.

**Izven obsega (pravila):** XLSX izvozi (zahtevajo novo odvisnost — v nasprotju
z „brez novih odvisnosti"; CSV + window.print→PDF pokrivata potrebo pošteno);
koda iz AGPL repozitorijev (licenca).

---

## 3. Sklep

1. **Noben od treh repozitorijev ni „boljši" od RestaurantOS kot celota.**
   OrderRestro je najbližji bratranec in najresnejši od treh — v operativni
   globini (split, fiskalizacija, offline, audit veriga, testi) zaostaja; vpet
   pa ima 4 modula, ki jih mi NIMAMO (vzdrževanje opreme, dokumenti, kampanje,
   urna poročila) + odprto API orodjarno (Swagger, MCP). TastyIgniter je
   ekosistem/platforma za javna spletna naročila (druga igrišča). QloApps je
   hotel vertikala — referenca za C-17.
2. **Kaj pobrat:** VZORCE, ne kode (AGPL/MIT/OSL meje + platformski neskladje).
   Največ vrednosti: njihov javni pošten FEATURE-CHECKLIST žanr (mi ga imamo
   interno v worklogu/dokih — javna izdaja je odločitev lastnika, marketing
   vrednost dokazana pri njih), ter 5–6 konkretnih funkcij iz tabele OSS.
3. **Kaj nam manjka:** realne vrzeli so OSS-7/8 (kampanje/urna poročila — del
   B/C); **OSS-1 oprema (v1.200.0), OSS-5 OpenAPI + OSS-15 zvok plačila (v1.201.0),
   OSS-9 EAN pri nabavi (v1.202.0), OSS-2 dokumenti (v1.203.0), OSS-4 hold naročila
   (v1.204.0) so IZVEDENI**;
   OSS-3 čas mize je bila
   LAŽNA VRZEL (že od v1.129.0); OSS-6 MCP ostaja ZUNAJ OBSEGA po lastnikovem
   pravilu „brez AI modelov, samo skripte" (izrecno potrjeno v1.201.0); ostalo
   so mali izboljševalci (OSS-10/13). Vse čaka odobritev lastnika (nova
   generacija OSS-x).
