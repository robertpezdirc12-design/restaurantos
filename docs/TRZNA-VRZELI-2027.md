# TRŽNE VRZELI 2027 — RestaurantOS (naslednik TRZNA-VRZELI-2026)

Naslednik `TRZNA-VRZELI-2026.md` (izčrpan: vse kodne vrzeli P0 1–3, P1 4–8,
P2 9a/10–15, P3 19–21 zaprte do v1.193.0; ne-kodna PCI SAQ-A dokumentacija
zaprta v v1.194.0). Ta dokument je **nova generacija kandidatov** — vsi so
izrecne opombe »odprta izboljšava / iskrena meja / ločena izdaja«, ki jih
prejšnji vali vodijo kot meje v worklogu in dokumentih, niso pa bile
prioritizirane kot izvedbeni seznam.

**Stalna omejitev lastnika: delo BREZ AI modelov — samo deterministične
skripte.** Kandidati so zato razdeljeni po tem, ali so izvedljivi čisto
koda brez AI in brez lastniške odločitve.

---

## 1. DELTA MATRIKA @ v1.194.0 (samo spremembe proti matriki 2026)

Konkurenčne trditve iz matrike 2026 (§3) ostajajo iz tistega pregleda; tu
samo vrstice, ki so se spremenile od takrat, in vrstica, ki je nova:

| Funkcija | 2026 stanje | Stanje @ v1.194.0 |
|---|---|---|
| Hiter »86« toggle na KDS | ✗ | ✓ (v1.83.0) |
| Handheld/tableside tok | ✗ | ✓ (v1.84.0) |
| Online plačilo (pay link) | ✗ | ✓ (v1.85.0) |
| EN jezik gostu | ✗ | ✓ (v1.86.0) |
| Split računa po gostih (LPT) | ✗ | ✓ (v1.185.0) |
| Labor forecast | ✗ | ✓ (v1.186.0) |
| Deterministični vpogledi | ✗ | ~ (v1.186.0 P2-9a: mrtvi artikli/restock/vrhovi/labor anomalije; LLM naracija izključena — delo brez AI) |
| Rojstnodnevni kupon | ✗ | ✓ (v1.187.0) |
| Waitlist SMS opomnik | ✗ | ✓ (v1.188.0) |
| Knjigovodski portal | ✗ | ✓ (v1.189.0) |
| Lastni portal za spletna naročila | ✗ | ✓ (v1.190.0) |
| Večjezičnost za goste (5 jezikov) | ~ | ✓ (SL/HR polna + EN/DE/IT gostovska, v1.191.0) |
| Payroll (doplačilne osnove) | ✗ | ✓ (v1.192.0 — minute; odstotki ostajajo biroju) |
| **Raven sedeža (seat-level)** | ✗ | **✓ (v1.193.0 — postavka nosi sedež, split izstavkov po sedežih; NOVA vrstica — Square pariteta)** |
| PCI DSS SAQ-A dokumentacija | ne v matriki | ✓ (v1.194.0, ne-kodna — SECURITY-BOUNDARY.md) |
| Javni rezervacijski widget | ✗ | ✓ (v1.110.0) |
| Loyalty kampanje/marketing | ✗ | ✓ (v1.126.0 + v1.187.0 kupon) |

**Preostali ~ / ✗ v matriki:** Integrirana kartična plačila ~ (terminal
brez PAN — produkcija čaka lastnikovo izbiro ponudnika), Fiskalizacija HR ~
(cert = uporabniški korak), Benchmarks ✗ (#16, mreža), Hotel PMS ✗ (#17,
mreža), AI vpogledi ~ (LLM izključen).

## 2. KANDIDATI 2027 — prioritiziran seznam

### A — čista koda, brez AI, brez lastniške odločitve (izvedljivo takoj)

| # | Kandidat | Izvor (izrecna opomba) | Obseg | Trud |
|---|---|---|---|---|
| **N-27-1** ✅ **ZAPRTO (v1.195.0)** | **Sedeži pri naročanju** — dodelitev sedeža že ob dodajanju postavke (aktivni sedež tok: natakar izbere sedež, dodane postavke ga nosijo), ne samo v plačilnem dialogu. Stolpec `OrderItem.seat` ŽE OBSTAJA (v1.193.0) → **brez DDL, brez SCHEMA_MIGRATIONS spremembe**; čisti sloj `seat-assignments.ts` + `parseSeatOption`; tokovi `PATCH /api/orders/[id] { addItems }` + `/api/sync` (offline); UI: aktivni sedež čipi v naročilnem toku (handheld, dashboard sheet); plačilni dialog (v1.193.0) že dela s sedeži — podatki so zdaj polni že pred splitom | v1.193.0 worklog MEJE: »sedeži se urejajo samo v plačilnem okviru (orders.pay) — Square jih ima tudi pri naročanju, to ostaja odprta izboljšava, ne vrzel« | backend + 2–3 klienti + i18n + testi | Mali–srednji |
| **N-27-2** ✅ **ZAPRTO (v1.196.0)** | **Kategorije stroškov** — poročilo po kategorijah + filter v knjigovodskem portalu. Jedro (DDL konzola + probe + raw CRUD + UI Stroškov) je obstajalo od v1.64/1.65 (Task 66/67 — runtime-gated: stolpec AccountsPayable.category je izven main schema do lastnikovega DDL klika, pisanje → 503); val v1.196.0 je dopolnil obseg N-27-2: čisti sloj `expenseCategoryBreakdown` (accounting-portal.ts), GET /api/expenses `?category=` filter (kandidatni idji prek raw, obseg VEDNO tipizirano — P0 disciplina; agregat sledi filtru; probe false → 503) + `categoryBreakdown` nad celotno periodo, UI portal karte (Select + klikovne vrstice razčlenitve) | task 64 (HACCP načrti): »stroški kategorije (nov STOLPEC na AccountsPayable) bi zastrupile ŽIVE produkcijske poizvedbe (P2022 do DDL) … ostajajo za kasneje« — vzorec DDL konzole je od takrat dokazan | DDL + rute + UI + poročilo | Srednji |
| **N-27-3** ✅ **ZAPRTO (v1.197.0)** | **Payroll konfigurabilne noge doplačil** — uporabnik vnese odstotke (noč/nedelja/praznik/nadure) po SVOJI kolektivni pogodbi; sistem izračuna ZNESKE iz že izvažanih minut (v1.192.0 osnove); izvoz shema payroll-export/3 z zneski ob minutah; izrecna meja ostaje: noga je uporabniški vhod, biro potrdi zakonitost — sistem NIKOLI ne trdi, da je noga »zakonska« | v1.192.0 iskrena meja: »odstotke doplačil potrdi biro (odvisni od kolektivne pogodbe/uredb, ne koda)« — konfiguracija pretvori mejo v uporabniški vhod, ne v trditev | konfiguracija + izračun + izvoz | Srednji |
| **N-27-4** | **ESLint react-hooks refaktor (73 mest)** — override `eslint-plugin-react-hooks` 7.0.1 → 7.1.1 (React Compiler pravila) po refaktorju 73 najdb | v1.154.0 OSV: »Refaktor 73 mest je ločena izdaja — pravila niso bila tiho izklopljena« | refaktor + override dvig | Srednji (tehnični dolg, ni funkcija) |

**Posodobitev v1.195.0 — N-27-1 ZAPRTO:** `addItems[i].seat` / `items[i].seat`
(opcionalni sedež 1..10, izpuščeno = brez — obstoječi klienti nespremenjeni);
čisti pomožnik `parseSeatOption` v `seat-assignments.ts` (ista disciplina kot
`parseSeatAssignments` — Number+isInteger, brez rounding); trije tokovi: POST
`/api/orders` (createOrderCore), PATCH `/api/orders/[id]` addItems (validacija
PRED transakcijo, 400 z razlogom — ne »Artikel ni na voljo«) in `/api/sync`
order.addItems (per-op napaka); UI aktivni sedež (čipi Brez/S1–S5) v handheld
in OPS-7 urejevalniku naročila; i18n `order.activeSeat`+`order.seatNone`
(SL/HR pariteta, 3588); tests/v195-order-seats.test.ts 14 testov. **BREZ DDL**
(stolpec že v1.193.0), SCHEMA_MIGRATIONS 32 ostaja. **Odprl pa je BONUS popravek
(čista najdba, nič seje niso testirale uspešne poti):** sync `order.addItems`
je bilo hardkodirano v `db.$transaction` KLJUB temu, da applyOp prihaja že
znotraj interaktivne transakcije (applyOp(tx,…)) — na Postgresu notranja
transakcija vzame drugo povezavo iz poola (deluje, atomično krhko: notranji
commit + zunanji rollback = postavke brez claima, točno kar R7 preprečuje);
na SQLite mrtva zveza → 5 s timeout. Zdaj truplo teče na prejetem clientu —
claim in postavke rollbackajo SKUPAJ. Naslednja prioriteta: N-27-2 → N-27-3
→ N-27-4.

**Posodobitev v1.196.0 — N-27-2 ZAPRTO:** kategorije stroškov so dobile poročilo in
filter v knjigovodskem portalu. Čisti sloj `expenseCategoryBreakdown` (skupanje,
r2, sort total desc + ime sl, '' → 'OSTALO' — isti legacy fallback kot GET vrstica);
GET `/api/expenses` ?category= filter — kandidatni idji prek raw SQL (stolpec je
izven main schema), obseg VEDNO prek tipizirane poizvedbe (lokacijski/org scope v
Prisma rokah — P0), agregat sledi filtru, probe false → 503 (ne tiho ignoriranje);
`categoryBreakdown` odgovora je nad CELO periodo (neodvisno od filtra — navigacija);
UI portal karte: Select kategorije + klikovne vrstice razčlenitve (max-h-44 scroll).
V1.189.0 pini ostanejo (brez kategorije odgovor nespremenjen). **Iskrena meja (Faza
C'):** preselitev stolpca v main schema.prisma (tipizirano branje) ostane PREPUŠČENA
lastnikovem DDL kliku na produkciji (raw + probe so »enaka varna vrata« — Task 67) —
to je B-razred, ne koda. Naslednja prioriteta: N-27-3 → N-27-4.

**Posodobitev v1.197.0 — N-27-3 ZAPRTO:** noge doplačil so postale UPORABNIŠKI vhod.
NOVA tabela `PayrollSurchargeRate` (ena vrstica na lokacijo `@@unique(locationId)`,
NULL = privzete noge; Decimal(5,2) noč/nedelja/praznik/nadure; skalarna vezava brez
FK — PrepLabel/PayrollPeriod konvencija) + register SCHEMA_MIGRATIONS 32→33 + DDL
ruta `/api/admin/migrate-payroll-surcharge-rates` + drift allowlist vnos. Čisti sloj
`payroll-rates.ts` (0 DB uvozov): `parseSurchargeRates` (vsa štiri polja OBVEZNA —
manjkajoče polje je napaka, NE tiha nula; 0..100, ≤ 2 decimali), centna aritmetika
v stotinkah odstotka (pctPct) — zaokrožitev ENA (`Math.round`) na skupino, vse vmesne
produkte celoštevilčni; nadure po POVPREČNI urni postavki obdobja (Σ grossCents×60/
Σ netMinutes — prag je oseben, ne po delovnem mestu). `surchargeBasisRows` sprejme
5. argument `rates?` — brez njega oblika NESPREMENJENA (polja odsotna — stare klice
stabilni); vnos BREZ posnetka postavke prispeva 0 zneska (plačilna osnova nastane
šele ob postavki — nič ne izmišljujemo). Izvoz **shema payroll-export/3**: kolone
NocEur/NedeljaEur/PraznikEur/NadureEur VEDNO prisotne (stabilna oblika za birove
uvoze), vrednost = '' kadar noge ne obstajajo (izvoz NIKOLI ne trdi 0 € za
neizračunan znesek) + noga izvoza zapiše uporabljene noge (uporabniški vhod;
zakonitost potrdi biro); noge so del contentHasha (sprememba noge = nov izvoz,
identical false). GET/PUT `/api/payroll/surcharge-rates` (employees.manage; lookup
lokacija → privzete NULL; audit PAYROLL_SURCHARGE_RATES_UPDATED; do DDL → 503);
detail/izvoz degradirata graceful (minute brez zneskov, surchargeRates null). UI:
Collapsible kartica »Noge doplačil« (izbira lokacije + 4 polja + Shrani; migrBox do
DDL) + kolona »Doplačilo (€)« v pregledu osnov (samo kadar so noge nastavljene).
i18n `payr.rates.*` (15) + `mig.payrollSurchargeRates.desc` (SL/HR pariteta, 3606).
TESTI: tests/v197-payroll-surcharge-rates.test.ts. **Iskrena meja (ostaja):** noga
je uporabniški vhod — biro potrdi zakonitost; Faza C' (produkcija čaka lastnikov
DDL klik). Naslednja prioriteta: N-27-4.

### B — lastniške odločitve (koda je pripravljena ali ni koda)

| # | Kandidat | Stanje |
|---|---|---|
| B-1 | **P2-11 transport e-poti/PEPPOL** — izbira ponudnika; eSlog GL izvoz koda zaključena (v1.125.0→v1.149.0) | čaka lastnika |
| B-2 | **Fiskalizacija 2.0 (FINA HR) certifikat** — priprava koda ✓ | čaka lastnika |
| B-3 | **PCI SAQ-A vprašalnik + AOC + kvartalni ASV sken** — tehnična drža dokumentirana v1.194.0 (SECURITY-BOUNDARY.md); polnjenje = upravni postopek pri ponudniku kartičnega sprejema | čaka lastnika |
| B-4 | **Neon baza v mirovanju** — `/api/health` javlja `degraded` zaradi baze, ne kode | čaka lastnika |
| B-5 | **Buildkite integracija** — dvosmerna sinhronizacija GitLab↔GitHub + CI quality gate javljata `failure` na pushih; lokalne ničle in zelen Vercel pomenita, da integracija ne preverja te kode — odpravi ali uredi | čaka lastnika |
| B-6 | **GitLab žeton zrcala** — rotacija | čaka lastnika |
| B-7 | **Preklic GitHub žetona iz klepeta** — STALNA točka vsake seje | čaka lastnika |

### C — mreža/partnerji (ni izvedljivo lokalno)

| # | Kandidat | Opomba |
|---|---|---|
| C-16 | Benchmarks (anonimizirana primerjava med lokacijami) | zahteva mrežo uporabnikov |
| C-17 | Hotel PMS integracija | Lightspeed vertical (Terme/hoteli SI/HR) |
| C-18 | Bolt Food webhook | regionalni agregator, poleg Glovo/Wolt |

### D — izključeno (stalno, po lastnikovem navodilu)

| # | Kandidat | Razlog |
|---|---|---|
| D-9b | LLM naracija nad strukturiranimi vpogledi (P2-9b) | lastnik dela BREZ AI modelov; deterministični P2-9a (v1.186.0) ostaja dovolj |

## 3. REGULATIVA 2027 — ostanki iz 2026 pregleda

| Področje | Stanje | Korak |
|---|---|---|
| ZDPSI-A (novela, UL 14/26) | izjava/podatki o dostopnosti plačilnih funkcij — **[nepreverjeno v uradnem besedilu]** | meriti šele, ko je prebrano uradno besedilo pravilnika |
| ViDA | harmonizacija do 2030–2035 | B2B IZVOZ koda ✓ (blokada = B-1) |
| NIS2 / GDPR | higiena/rezerva | redni pregled |
| PCI DSS v4.0 | SAQ-A drža dokumentirana (v1.194.0) | B-3 upravni postopek |

## 4. Sklep

RestaurantOS @ v1.194.0 je **presegel matriko 2026**: vse vrzeli dokumenta
zaprite, pariteta z vodilnimi v vseh ne-mrežnih razredih, vodstvo v
fiskalizaciji SI/HR, HACCP, menu engineeringu, audit verigi, večjezičnosti
(5 jezikov) in lastništvu kode. Generacija 2027 je generacija **poliranja
in globine** (sedeži v celotnem toku, analitika stroškov, uporabniške noge
doplačil) — ne lovljenja matrike. Vsak val ostaja: brez AI, brez novih
odvisnosti, brez tihih odpovedi, z revizijo in testi.
