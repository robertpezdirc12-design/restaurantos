# GAP-ANALIZA: funkcije + dovoljenja po vlogah (OPS-4, 2026-10-12)

Raziskava na zahtevo lastnika: "zaslon sank, prodaja, natakar tablica, kuhinja, QR kode —
isci po spletu najboljše programe, kaj vse imajo, kaj nam manjka; kakšna dovoljenja ima
posamezni delavec (sank, natakar, kuhinja, čistilka…)".

Vir istraživanja: Toast, Lightspeed Restaurant, Loyverse, Square for Restaurants,
Quantic ("44 Restaurant POS Features"), Menumiz, POS Sector (SI, 4000+ uporabnikov),
GIS Prestige (POS Elektroncek, SI). Inventar lastnega sistema iz kode (repo @ 7c4a68a, v1.66.0).

---

## 1. KAJ RESTAURANTOS ŽE IMA (inventar iz kode @ v1.66.0)

### UI rute (5)
| Ruta | Funkcija |
|---|---|
| `/` | Prijava (e-pošta + PIN) + aktivacija naprave (kiosk/display) z 8-mestno kodo |
| `/dashboard` | Glavni POS — **26 zavihkov** (spodaj) |
| `/kiosk` | Samopostrežni terminal: meni → modifikatorji → košarica → številka naročila, samodejni reset |
| `/m/[token]` | **QR naročanje iz telefona gosta** (javno): meni mize, košarica, status naročila, mnenje |
| `/display` | Customer-facing display (CFD) — paring z 6-mestno kodo, prikaz računa v realnem času |

### 26 dashboard zavihkov
Pregled (KPI), Mize (cone + statusi + QR dialog), Naročila (dodajanje, fire, premik/združevanje miz),
Kuhinja (KDS: PENDING→PREPARING→READY + tisk kuhinjskega/bar lističa), Meni (cene, dostopnost,
postaja kitchen/bar, alergeni), Rezervacije (validacija odpiralnega časa), Računi (EOR/FURS,
storno, CSV + računovodski izvoz), Popusti (ročni + Happy Hour), Integracije (API ključi, dnevnik),
Zaloge (odštevanje ob naročilu), Izmene (X/Z poročila, blagajniške izmene), Delovni čas (clock-in/out),
HACCP (meritve + načrti), Stroški (AccountsPayable + kategorije), Zvestoba (točke, unovčenje),
Mnenja (ocene gostov iz QR), Dostava (Glovo/Wolt webhooki + cone), Napitnine (bazeni, delitve),
Nabava (dobavitelji → PO → prevzemi), Darilne kartice (izdaja/polnjenje/unovčenje kot plačilo),
Odpad (z reverse), Čakalna lista, Odpiralni čas (+posebni dnevi), Zaposleni ( vloge, PIN reset),
Nastavitve (lokacija, naprave, tiskalniki), Enterprise (Org→Brand→Property + DDL konzola).

### Kaj je pod plastjo (dokazano v kodi)
- **118 Prisma modelov**, 109 API rut, **offline vrsta za POS** (order.create/addItems/kitchen.status,
  brez plačil), Fiskalizacija **FURS (SI) + Fiskalizacija 2.0 (HR)**, MFA, tiskanje
  (browser/agent + print-agent mini servis + ack), dostava z HMAC webhooki, idempotentno QR
  naročanje (clientOperationId), rate-limit 10/min, audit trail (AuditLog + blockchain hash chain).
- **Schematsko PRIPRAVLJENO, UI NE obstaja**: Course (tečaji jedi), Table.posX/posY/shape
  (tloris), Reservation.reminderSent (SMS/e-mail opomniki), StaffShift + TimeOffRequest (urniki),
  PushSubscription (push obvestila), PrepStation.type **bar** + tip naprave `kds_bar` + bar tisk.

### Trenutne vloge (13) + privzeta dovoljenja (11 kanoničnih)
Ključi: `orders.create, orders.pay, apply_discounts, kitchen.update, reservations.manage,
menu.manage, inventory.manage, reports.view, employees.manage, settings.manage, furs.issue`
(`src/lib/permissions.ts`). Overrides so vedno DODATNI (nikoli odvzem).

| Vloga (DB) | Privzeta dovoljenja |
|---|---|
| owner / admin / manager | VSA (11) |
| waiter / staff (legacy) | orders.create, orders.pay, apply_discounts, reservations.manage |
| bar | orders.create, apply_discounts, kitchen.update (vse postaje!) |
| kitchen / chef (legacy) | kitchen.update |
| warehouse | inventory.manage, reports.view |
| accounting | reports.view |
| group_owner / org_admin / property_manager | VSA (11) |
| **cleaner / čistilka** | **NE OBSTAJA** (ni vloge niti minimalnega seta) |

Uveljavljanje: `requirePermission` (fail-closed 403 na vsak klic, DB lookup), `requireCentralRole`
(admin/owner za DDL), UI gating zavihkov `tab-permissions.ts` (fail-closed), lokacijska izolacija
(tenant scope), session revocation prek sessionVersion.

---

## 2. KAJ IMAJO NAJBOLJŠI SISTEMI (raziskava)

| Sistem | Ključne funkcije, ki jih izstopajo |
|---|---|
| **Toast** (USA, #1 za restavracije) | tableside ordering + **bill splitting** + **handheld payments**, KDS, marketing, payroll, "purpose-built" front-of-house |
| **Lightspeed Restaurant** | **Order Anywhere** (mobilno naročanje), **Tableside Payments**, KDS, Reservations + Pulse (angagement gostov), **Tasks** (checkliste), Tempo, Workforce & Payroll, Inventory, Accounting, AI insights; vertikale: Bar, Fine dining (**coursing**), QSR |
| **Loyverse** (najpopularnejši free) | POS na telefonu/tablici, **KDS**, customer display, **employee management z rolemi/pravicami**, inventory, loyalty, **work offline**, open tickets, item variants + modifiers, cash management, elektronski/printed računi, multi-store |
| **Square for Restaurants** | **vizualni floor plan** (custom layout), **table & seat management** (raven sedeža), tableside |
| **Quantic ("44 features")** | waitlist **s notifikacijami**, real-time wait times, … |
| **Menumiz** | menu + modifiers, **table plans + seat positions, coursing, split checks, handheld ordering** |
| **POS Sector (SI — lokalni benchmark, 4000+)** | backoffice, priloge, delo z mizami/naročili, **mobilno naročanje → KUHINJA in ŠANK direktno**, kuhinjski monitor, **normativi in kalo**, skladišče, fiskalni računi, analize/poročila, **poročila za knjigovodstvo**; vertikale: kavarna, pizzeria, nočni klub, beach bar… |
| **GIS Prestige (SI)** | digitalni cenik, **QR koda s spletnim cenikom + naročanje od mize** |

---

## 3. VRZELI — prioritiziran seznam

### P0 — neposredno po uporabnikovem vprašanju (odločilno za vsakdan)

| # | Manjka | Stanje v kodi | Trud |
|---|---|---|---|
| 1 | **Zaslon SANK (KDS-BAR)** — ločen zaslon samo za pijače: filter po postaji, zvočni alarm, časači, "BUMP ready". Podatkovna plast 100% pripravljena (PrepStation.type=bar, naprava kds_bar, bar tisk) — manjka SAMO UI/URL z filterm | schema ✓, UI ✗ | Mali |
| 2 | **Hitra prodaja (šank/direktna prodaja brez mize)** — en zaslon: tap artikle → plačaj → FURS račun. Toast/Square/Loyverse to imajo kot osnovni "quick sale" način | delno prek Naročila+Plačilo; ni enega toka | Srednji |
| 3 | **Natakarjeva tablica (handheld mode)** — mobilna vgrajena različica POS-a: Mize → naroči → pošlji v kuhinjo/šank → plačaj pri mizi; deluje na telefonu (PWA, install icon, offline vrsta že obstaja!). Toast/Lightspeed: Order Anywhere/Tableside | dashboard je responsive, ni PWA/handheld tokova | Srednji |
| 4 | **Kuhinja upgrade** — obstaja (KDS tab), ampak dodati: filtri postaj (kitchen/bar), časači + zvočni alarmi, sold-out toggle ("86 items") neposredno iz KDS, prep-time statistika | osnovno ✓ | Mali |
| 5 | **QR kode — dopolnitve** — QR naročanje ŽE deluje (m/[token]); manjka: (a) množični tisk QR listov za vse mize, (b) QR na računu (mnenje + loyalty), (c) kasneje QR samoplačilo (pay-at-table link) | a,c ✗, b delno | a=Mali |

### P1 — funkcije, ki jih imajo vsi vodilni, mi ne

| # | Manjka | Opomba |
|---|---|---|
| 6 | **Split bill (razdelitev računa)** — po gostih/postavkah/%"
| 7 | **Coursing (tečaji jedi)** — predjedi/glavne/sladice, pošiljanje po tečajih; Model Course + OrderItem.courseId + fire endpoint ŽE obstajajo — manjka UI |
| 8 | **Vizualni floor plan** — platno con/miz z drag&drop, statusi barvami; Table.posX/posY/shape v shemi |
| 9 | **SMS/e-mail potrdila rezervacij** — potrditev + opomnik; shema (reminderSent, ScheduledEmailLog) pripravljena, manjka ponudnik (Twilio/SendGrid/Resend) |
| 10 | **Urnik izmen** (StaffShift) + prošnje za dopust (TimeOffRequest) — modeli so, UI ni |
| 11 | **Push obvestila** (PushSubscription model je) — npr. KDS zvok + natakar dobi "naročilo ready" |
| 12 | **Seat management** — raven sedeža pri mizi (Square) |
| 13 | **Poročila za knjigovodstvo kot portal** — POS Sector to posebej prodaja; mi imamo CSV izvoz + JournalEntry; dodati read-only dostop za računovodstvo (vloga accounting že je) |
| 14 | **Menu engineering** — bestseleri, marže, mrtvi artikli (ime podatke že imamo) |

### P2 — konkurenčna prednost / kasneje

| # | Ideja |
|---|---|
| 15 | Loyalty kampanje + nivoji (točke že so), marketing e-pošta |
| 16 | AI napovedi (Lightspeed AI): obremenitev, naročanje zalog, menu suggestions — AIConversation model že v shemi |
| 17 | Normativi in kalo (yield) — RecipeItem je; POS Sector to poudarja |
| 18 | Spletni rezervacijski widget (javni URL) + integracija Google Business |
| 19 | Guest meni še v EN/DE/IT (gostujoče strani danes SL/HR) |
| 20 | Predavtorizacija kartic + terminal integracija (CloudPOS) |

---

## 4. DOVOLJENJA — PREDLOG MATRICE PO VLOGAH

### 4a. Razširitev kanoničnih dovoljenj (dodaj 8 novih — backwards compatible)

| Novi ključ | Kaj pokriva | Zakaj |
|---|---|---|
| `orders.void` | brisanje/storno postavk (z razlogom) | Toast/Lightspeed: samo manager; natakar mora prositi |
| `orders.discount` | uporaba popusta (upravljanje ostane `apply_discounts`) | ločitev "uporabi do 10%" vs "upravlja pravila" |
| `cash.manage` | odpiranje/zapiranje izmene, no-sale, predaja blagajne | danes je to ujet v `orders.pay` |
| `menu.availability` | samo toggle sold-out (86) — brez urejanja cen | kuhinja/sank morata lahko "odvzeti artikel", ne urejati menija |
| `haccp.execute` | izvajanje čistilnih checklist + merjenja (brez urejanja načrtov) | **čistilka** |
| `timeclock.manage` | urejanje/spopačanje izmen drugih | manager; lastni clock-in = default za vse |
| `delivery.manage` | dostava: sprejem/webhook statusi, cone | danes pod `orders.create` |
| `giftcards.manage` | izdaja/polnjenje darilnih kartic | danes pod `reports.view` (premalo!) |

PRAVILO ostaja: overrides = samo dodatna dovoljenja; za odvzem se uvaja vloga ali nova de facto
manjša vloga. `requirePermission` se razširi zgolj z novimi ključi — ničesar ne lomi.

### 4b. Privzeta matrica (predlog — vključno z NOVO vlogo cleaner)

| Vloga | orders.create | orders.pay | apply_discounts | orders.void | kitchen.update | menu.availability | menu.manage | reservations.manage | inventory.manage | reports.view | cash.manage | haccp.execute | timeclock.manage | employees.manage | settings.manage | furs.issue | delivery.manage | giftcards.manage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **owner/admin/manager** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **waiter (natakar)** | ✓ | ✓ | ✓ (do limita)¹ | ✗² | ✗ | ✓ | ✗ | ✓ | ✗ | osebni³ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **bar (sank)** | ✓ | ✓ (hitra prodaja) | ✓ (do limita)¹ | ✗² | ✓ (samo BAR postaja) | ✓ | ✗ | ✗ | ✗ | osebni³ | ✓ (svoja izmena) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **kitchen (kuhinja)** | ✗ | ✗ | ✗ | ✗ | ✓ (samo KITCHEN postaja) | ✓ (86) | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (meritve) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **cleaner (čistilka) — NOVO** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (checklist + meritve) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **warehouse (skladišče)** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **accounting** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (finančni) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

¹ Limit popusta: % zgornja meja na vlogo (npr. natakar ≤10%, nad tem zahteva managerjev PIN/odobritev — Toast pattern "manager approval").
² `orders.void` = zahteva managerja ali z razlogom + audit (VoidReason model že je).
³ "osebni vpogled" = samo svoja prodaja/izmena (potreben filter na API, ne nov ključ).

### 4c. Vedenje po zaslonih (kaj kdo VIDI)

| Zaslon | Natakar | Sank | Kuhinja | Čistilka |
|---|---|---|---|---|
| Tablica: Mize + naroči + plačaj | ✓ | — | — | — |
| Hitra prodaja (šank) | ✓ | ✓ | — | — |
| KDS-KUHINJA (filter kitchen) | — | — | ✓ | — |
| KDS-BAR (filter bar) | — | ✓ | — | — |
| HACCP checklist (izvedba) | — | — | meritve | ✓ |
| Delovni čas (lastni clock) | ✓ | ✓ | ✓ | ✓ |
| Vse ostalo (Pregled, poročila, zaposleni…) | — | — | — | — |

---

## 5. PRIPOROČENI VRSTNI RED IMPLEMENTACIJE

1. **Vloga cleaner + haccp.execute** (+ čistilni checklisti v HACCP tabu) — najmanj truda, direktno odgovori na vprašanje "čistilka".
2. **KDS upgrade + KDS-BAR** (filtri postaj, časači, zvok, sold-out) — podatki so, ostane UI.
3. **Hitra prodaja** tok (šank) — odpre prodajo na sanku brez mize.
4. **PWA + handheld mode za natakarja** (reuse offline vrste) — "natakar tablica".
5. **Split bill** (najpogosteje zahtevana funkcija v vseh primerjavah).
6. **Floor plan + coursing** (shema že je).
7. **Razširitev dovoljenj (4a) + manager approval za popuste/void.**
8. SMS/e-mail opomniki (potreben ponudnik + odobritev stroškov s strani lastnika).

Preverjanje konkurence ob zaključku faze: Toast (split+handheld), Lightspeed (KDS+Tasks),
Loyverse (offline+roles), POS Sector (mobilno → kuhinja+šank, normativi).
