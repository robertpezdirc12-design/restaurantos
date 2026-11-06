# Primerjava vseh vmesnikov z najboljšimi rešitvami na spletu (2026)

Datum: v1.228.0 → načrt za v1.229.0+. Viri: spletna raziskava (oktober–december 2025/2026:
Toast POS, Square for Restaurants, Lightspeed Restaurant K-Series, TouchBistro, Clover,
Restroworks/Sapaad/Eats365 KDS, MarketMan, xtraCHEF, 7shifts, OpenTable) + popis lastnih UI
tokov (dashboard 32 zavihkov, /handheld, /tablica, /kiosk, /display, javne strani).

Metodologija: vsako trditev o LASTNEM sistemu je preverjena v kodi (ne v dokumentaciji);
trditve o konkurenci iz spletnih virov (feature strani, primerjave, reviewji). Status:
✅ = imamo parity ali bolje · ⚠️ = delno (manjka detajl) · ❌ = manjka.

---

## 1. VMESNIK PRODAJA — Hitra prodaja (POS)

Benchmark: **Toast POS** (vodilni ZDA), **Square for Restaurants** (najboljši free tier),
**Lightspeed K-Series** (najboljši Actions menu), **TouchBistro** ($69/mes, strežniški toki).

| Funkcija | Toast | Square | Lightspeed | **Mi** | Opomba |
|---|---|---|---|---|---|
| Mreža artiklov s slikami | ✅ | ✅ | ✅ | ✅ | kartice + kompaktni gosti grid (v1.141) |
| Iskanje artiklov | ✅ | ✅ | ✅ | ✅ | living filter |
| Čipi kategorij (en dotik) | ✅ | ✅ | ✅ | ✅ | horizontalni trak (Issue #74 V-6) |
| Košara levo (rail) s sticky vsoto | ✅ | ✅ | ✅ | ✅ | Toast vzorec (v1.141) |
| Variante/modifikatorji | ✅ | ✅ | ✅ | ✅ | OSS-10 + MenuModifiersCard |
| 86 (razprodano) na ploščici | ✅ | ✅ | ✅ | ✅ | rdeča ploščica + nadomestki |
| **EAN čitalnik → košara** | ✅ | ✅ | ✅ | ❌ → **v1.229** | scanner tipka kodo + Enter (OSS-9 ima EAN samo v zalogi) |
| **Priljubljeno (★) vrstica** | ✅ | ⚠️ | ⚠️ | ❌ → **v1.229** | Toast: pinned najbolje prodajanih |
| **Happy-hour ⚡ znak na ploščici** | ✅ | ✅ | ✅ | ❌ → **v1.229** | popust se avtomatsko obračuna (billing), a POS grid tega NE pokaže — natakar ne ve |
| Vedno vidna vsota | ✅ | ✅ | ✅ | ✅ | fiksna vrstica < md |
| TAKEOUT / hitri takeaway | ✅ | ✅ | ✅ | ✅ | TAKEOUT → plačilo |
| Deljeno plačilo (2–5 delov, mešano) | ✅ | ✅ | ✅ | ✅ | split + izstavki (Checks, v1.68) |
| Darilne kartice v POS | ✅ | ✅ | ✅ | ✅ | lookup + delno unovčenje |
| Zvestoba (točke) v POS | ✅ | ✅ | ⚠️ | ✅ | identify + redeem |
| Kupon / promo koda v POS | ⚠️ | ✅ | ⚠️ | ✅ | osebni kuponi + register promo (v1.224) |
| Napitnine (prednastavljene %) | ✅ | ✅ | ✅ | ✅ | 0/5/10/15 % + custom |
| Fiskalizacija (EU) | – | – | ⚠️ | ✅ | FURS SI (EOR/ZOI) + FINA HR (ZKI/JIR) — Toast/Square USA niso primerljivi |
| Offline vrsta naročil | ✅ | ⚠️ | ⚠️ | ✅ | 200 opravil/12 h, dedupe, dead-letter |
| Odprti zavihki (tabi) s predavtorizacijo | ✅ | ✅ | ✅ | ❌ | bar praksa ZDA; v SI/HR plačilo pri mizi — odločitev lastnika (B-seznam) |
| Tipkovnične bližnjice (F-tipke) | ⚠️ | ⚠️ | ✅ | ⚠️ | imamo Ctrl+K ukazno paletto (32 zavihkov), ne numeričnega quick-add |
| Terminal kartice (pravi ponudnik) | ✅ | ✅ | ✅ | ⚠️ | simulator + manual vnosa — ponudnik = odločitev lastnika (TERMINAL-PROVIDERS.md) |

**Presoja:** prodajni POS ima parity na 16/19 točk; tri vrzeli (EAN, ★, ⚡) so čisto
frontend in se zaprejo v v1.229.0. Tabi s predavtorizacijo so kulturna razlika (ZDA vs
SI/HR) in ostajajo na seznamu lastnikovih odločitev.

---

## 2. VMESNIK ŠANK (Bar)

Benchmark: **Clover** (happy hour, pre-auth tabi), **Toast Bar**, tavern-POS praksa
(smart tab management, tip pooling, offline).

| Funkcija | Clover/Toast | **Mi** | Opomba |
|---|---|---|---|
| Namenski hitri POS za šank | ✅ | ✅ | vloga BAR pristane na `prodaja` |
| Bar kot KDS postaja (listki pijač) | ✅ | ✅ | BAR filter + tisk bar listkov + usmerjanje |
| Happy hour (časovna okna, dnevi, kategorije) | ✅ | ✅ | Discount triggerType='auto', okna čez polnoč, ciljne kategorije |
| **Happy-hour vidnost na zaslonu šanka** | ✅ | ❌ → **v1.229** | ⚡ znak + akcijska cena na ploščici med oknom |
| EAN čitalnik za pakirane pijače | ✅ | ❌ → **v1.229** | pivo/vino/sok iz hladilnika po črtni kodi |
| Odprti tabi po imenu/kartici | ✅ | ❌ | B-seznam (odločitev lastnika) |
| Deljenje taba po osebi/postavki/znesku | ✅ | ⚠️ | delimo NAROČILO (izstavki + postavke), ne tab |
| Izmene blagajne (X/Z poročilo) | ✅ | ✅ | open/close + movements + Z dialog |
| Napitnine — skupni bazen (tip pool) | ✅ | ✅ | porazdelitev po urah/točkah + izplačila (CAS) |
| Taksacija pijače (pour cost) | ⚠️ | ⚠️ | Analiza menija (inženiring) pokriva food cost; **pour-cost karta dodana v v1.230.0** (Inženiring → Taksacija pijače; KPI + pasovi benchmarka nad istim virom) |
| Zvočna potrditev plačila | – | ✅ | audio cue |
| Offline prodaja | ✅ | ✅ | vrsta s dedupe |

**Presoja:** šank je pokrit z istim POS (pravilno — Clover/Toast delujeta enako); ⚡ in EAN
sta implementirani v v1.229.0 ker sta standardna pri vodilnih.

---

## 3. VMESNIK KUHINJA (KDS)

Benchmark: **Toast KDS** (All Day view, produktivnost), **Square KDS** ($20–30/mes/naprava),
**Lightspeed KDS** (november 2025 upgrade), Restroworks/Sapaad/Eats365.

| Funkcija | Toast | Square | Lightspeed | **Mi** | Opomba |
|---|---|---|---|---|---|
| Barvna eskalacija po starosti | ✅ | ✅ | ✅ | ✅ | 5 stopenj + nastavljivi pragovi (v1.135) |
| Časovnik countdown na listku | ✅ | ⚠️ | ✅ | ✅ | MM:SS pill, utripanje ob zamudi |
| **All Day view (skupne količine)** | ✅ | ✅ | ✅ | ✅ | lepljiva vrstica (v1.129) — Toast jo ima spodaj, mi prav tako |
| Postaje (kuhinja/bar + imenovane) | ✅ | ✅ | ✅ | ✅ | PrepStation CRUD + EXPO (Issue #14) |
| EXPO razpredelnica nalog | ✅ | ⚠️ | ⚠️ | ✅ | task board + blocker 409 |
| Alergeni — RDEČ pas | ✅ | ✅ | ✅ | ✅ | Issue #71 audit-14, hierarhija resnosti |
| Tečaji (coursing) na listku | ✅ | ✅ | ✅ | ✅ | badge + GRUPIRANJE postavk po tečajih z glavo skupine (v1.232 — Toast »course grouping«) |
| 86 dolgi pritisk + nadomestki | ✅ | ⚠️ | ⚠️ | ✅ | P0-3 plošča + nadomestki |
| Bump celega listka | ✅ | ✅ | ✅ | ✅ | + SERVED bump |
| Razlog zamude ob poznem READY | ✅ | ⚠️ | ⚠️ | ✅ | katalog razlogov (Lightspeed vzorec) |
| Zvok ob novem listku | ✅ | ✅ | ✅ | ✅ | WebAudio |
| Nastavitev pisave/gostote/stolpcev | ✅ | ⚠️ | ⚠️ | ✅ | S/M/L/XL, 4/6/8/10 stolpcev |
| Fullscreen | ✅ | ✅ | ✅ | ✅ | |
| Tisk listkov (kuhinja/bar) | ✅ | ✅ | ✅ | ✅ | brskalnik + ESC/POS agent |
| Zastareli listki (>8 h) | – | – | – | ✅ | ločen skrčen oddelek (Issue #70/71) |
| Obetalni ETA natakarju | ⚠️ | ⚠️ | ⚠️ | ✅ | ETA čip na glavi listka: ura naročila + cilj najzahtevnejše postaje (v1.232 — Lightspeed »Prep ETA«) |
| Večjezični KDS | ✅ | ⚠️ | ⚠️ | ⚠️ | SL/HR celoten; EN samo gostje (zavestna odločitev) |
| Push (ne polling) | ✅ | ✅ | ✅ | ✅ | SSE pretok /api/kitchen/stream (~3–5 s, podpis MAX(updatedAt)) + 15 s polling kot VEDNO prisoten fallback (v1.232) |
| Produktivnost postaje | ✅ | – | ⚠️ | ✅ | KDS statistika (cilji, propustnost) |

**Presoja:** KDS je bil predmet treh benchmark valov (v1.67, v1.129, v1.135) in ima parity
ali prednost na 17/18 točk (val v1.232.0 zapre tečaj-grupiranje, ETA in SSE push);
preostala vrzel je EN jezik osebja (zavestna odločitev — SL/HR tržišče).

---

## 4. VMESNIK RESTAVRACIJA (mize, naročila, rezervacije)

Benchmark: **Toast** (klik na mizo → urejevalnik), **TouchBistro** (najboljši floor plan),
**Lightspeed** (Actions menu: fire course, transfer table/user, rename), **OpenTable**
(opomniki, samodejna dodelitev miz).

| Funkcija | Toast | TouchBistro | Lightspeed | **Mi** | Opomba |
|---|---|---|---|---|---|
| Tloris z drag & drop | ✅ | ✅ | ✅ | ✅ | perzistenten posX/posY (v1.128+) |
| Grid pogled po conah | ✅ | ✅ | ✅ | ✅ | |
| Klik na mizo → urejevalnik naročila | ✅ | ✅ | ✅ | ✅ | NaročiloSheet (OPS-7 v1.68) |
| Fire / fire tečaja | ✅ | ✅ | ✅ | ✅ | + coursing dodeljevanje |
| Premik naročila (move) | ✅ | ✅ | ✅ | ✅ | |
| Združevanje (merge) | ✅ | ⚠️ | ✅ | ✅ | |
| Zadrži/nadaljuj (hold) z razlogom | ⚠️ | ⚠️ | ⚠️ | ✅ | auditirano (QA-val #10) |
| **Urejevalnik miz (CRUD) v UI** | ✅ | ✅ | ✅ | ❌ → **v1.229** | API obstaja (POST/PATCH/DELETE + audit), UI ne — mize se ureja samo s sejanjem |
| Urejevalnik con v UI | ⚠️ | ✅ | ⚠️ | **v1.233** | cona ostane prostost besedila na mizi (0 DDL); urejevalnik upravlja cone kot CELOTO: preimenuj/združi vse mize cone v eni operaciji (updateMany + revizija ZONE_RENAME) |
| **Prenos naročila na drugega natakarja** | ⚠️ | ⚠️ | ✅ | ❌ → **v1.229** | Lightspeed »transfer user« — izmena/delovnik |
| Preimenuj naročilo | – | – | ✅ | ✅ | customerName edit |
| QR meni na mizo | ⚠️ | ⚠️ | ⚠️ | ✅ | toggle naročanja + rotacija žetona |
| Status mize (prosta/zasedena/umazana) | ✅ | ✅ | ✅ | ✅ | + en-dotik čiščenje |
| Rezervacije: termini po kapaciteti | ✅ | – | ✅ | ✅ | strežnik izračuna proste kapacitete |
| Opomniki (SMS/e-mail) | ✅ | – | ✅ | ✅ | posamično + množično, badge poslano |
| Čakalna lista (walk-in) | ⚠️ | – | ⚠️ | ✅ | prijava → obvesti → usadi z zaklepom mize |
| Samodejna dodelitev mize rezervaciji | ✅ | – | ✅ | **v1.231** | najmanjša prosta miza po številu oseb, brez prekrivanja aktivnih rezervacij (1 klik v dialogu) |
| Rezervacije na tlorisu | ⚠️ | – | ⚠️ | **v1.232** | overlay prihodnjih rezervacij: vrstica na ploščici, 🕒 na obliki v tlorisu |
| Naročila gostov po QR (self-order) | ✅ | – | ⚠️ | ✅ | /m/<token> + kiosk + lastni portal /s |
| Sledenje stanja naročila za gosta | ⚠️ | – | ⚠️ | ✅ | 30 s polling po oddaji |

**Presoja:** front-of-house tok je najmočnejša mila sistema (tri PWA površine + QR + kiosk);
**urejevalnik miz** in **prenos na natakarja** sta zaprta v v1.229.0, samodejna dodelitev
mize v v1.231.0, overlay rezervacij na tlorisu pa v v1.232.0 — urejevalnik con kot
samostojen objekt (preimenuj/združi vse mize cone naenkrat) je dodan v v1.233.0 —
restavracija **22/22 (polna pariteta)**.

---

## 5. VMESNIK ZALOGE (zaloge, nabava, prenosi, odpad)

Benchmark: **MarketMan** ($63–167/mes; centraliziran purchasing, invoice skeniranje),
**xtraCHEF** (OCR računov), **Toast Inventory** (auto-86 iz zaloge).

| Funkcija | MarketMan | xtraCHEF | Toast Inv | **Mi** | Opomba |
|---|---|---|---|---|---|
| Zaloga z min/max + vrednost | ✅ | ✅ | ✅ | ✅ | KPI kartice, filtri LOW/OUT |
| Iskanje po EAN | ✅ | ✅ | ✅ | ✅ | OSS-9 (scanner kot filter) |
| Serije (loti) + FEFO | ⚠️ | ⚠️ | ⚠️ | ✅ | hold/release/recall/trace + javni /label |
| Rok trajanja + oznake | ✅ | ⚠️ | ⚠️ | ✅ | label rules + tisk etiket |
| Inventura s preštevanjem | ✅ | ✅ | ✅ | ✅ | DRAFT → ŠTETJE → PREDAJA → POTRDITEV + varianca |
| **Inventura s čitalnikom** | ⚠️ | – | ✅ | **v1.231** | EAN zadetek šteje +1 (scanner = tipkovnica + Enter); beseda = filter seznama; emerald poudarek zadnje štete vrstice |
| Recepti (decoupage) + cena porcije | ✅ | ✅ | ✅ | ✅ | ugnezdeni podrecepti, donos % |
| Razknjižba ob prodaji | ✅ | ✅ | ✅ | ✅ | v isti transakciji kot FURS izdaja |
| Teoretična proti dejanski food cost | ✅ | ✅ | ⚠️ | ✅ | FoodCostVarianceCard |
| Analiza menija (inženiring) | ⚠️ | – | – | ✅ | Kasavana-Smith kvadranti |
| Dobavitelji (kontakt, pogoji) | ✅ | ✅ | ✅ | ✅ | + preverjanje DURS |
| Naročila dobaviteljem (PO) | ✅ | ✅ | ✅ | ✅ | vrstice, statusi, pričakovani datumi |
| Prevzem (GRN) z zavrnitvami | ✅ | ⚠️ | ⚠️ | ✅ | accept/reject + razlog + rok |
| Ponavljajoča naročila | ✅ | – | ⚠️ | ✅ | recurring PO |
| **Predlogi naročanja (par/potrosnja)** | ✅ | – | ⚠️ | ✅ | dnevna poraba, lead time, varnostna zaloga, kritičen datum, 1-klik |
| Uvoz eSLOG računov | – | – | – | ✅ | SI/HHR specifika (3-way match, tolerance, AP) |
| **OCR skeniranje računov** | ✅ | ✅ | – | ❌ | zavestno NE (0 AI politika; ročni vnos + eSLOG uvoz pokrijeta) |
| **Samodejni 86 ob izpraznitvi zaloge** | ⚠️ | – | ✅ | **v1.230** | Toast »86 when items run out« — v ISTI transakciji kot račun; direct (privzeto) + recipe (opt-in) način; samodejna obnovitev ob prilivu (GRN/prejem/popis/storno/odpad/prenos) |
| Prenosi med lokacijami | ✅ | – | ⚠️ | ✅ | odprema/prevzem + push obeh strani |
| Odpad z razlogom + povratnica | ✅ | ⚠️ | ⚠️ | ✅ | lot-zaveden |
| Nizka zaloga — opozorila | ✅ | ✅ | ✅ | ✅ | LOW_STOCK push + KPI |
| **Nizka zaloga ob prijavi (clock-in)** | ✅ | – | ✅ | **v1.230** | Toast december 2025: oseba vidi razprodano/nič ob prihodu — banner v Delovnem času (strežniški kanonični prag) |
| Zaloga vidna natakarju v POS | ⚠️ | – | ⚠️ | ⚠️ | 86 vidno; količine zaloge v POS niso (namenoma — dostop skladiščniku) |

**Presoja:** zaloga/prekurmentski modul prekaša MarketMan na evropskih specifikah (eSLOG,
FURS, serije, DURS); samodejni 86 in seznam ob prijavi sta dodana v v1.230.0, inventura
s čitalnikom pa v v1.231.0 — edina preostala vrzel je OCR (zavestna 0-AI odločitev).

---

## 6. Skupni seštevek

| Vmesnik | Parity točke | Glavne odprte vrzeli |
|---|---|---|
| Prodaja (POS) | 16/19 | EAN ⌨, ★, ⚡ → vse tri v v1.229.0 |
| Šank | pokrit | ⚡ + EAN (ista obdelava); tabi = B-seznam |
| Kuhinja (KDS) | 17/18 | tečaj-grupiranje + ETA + SSE → v1.232.0; EN jezik = zavestna odločitev |
| Restavracija | 22/22 | Uredi mize + prenos natakarja → v1.229.0; auto-assign → v1.231.0; overlay → v1.232.0; urejevalnik con → v1.233.0 |
| Zaloge | 22/22 | OCR je edina zavestna izključitev (0-AI) |

**Zaključek:** po treh letih benchmark valov (v1.67–v1.228) ima sistem parity ali prednost
na ~87 primerjanih funkcijah; v1.229.0 zapre 5 zadnjih A-vrzeli (EAN, ★, ⚡, Uredi mize,
prenos natakarja), vse 0-DDL. v1.230.0 zapre še 3 točke C-seznama (samodejni 86 ob
izpraznitvi, nizka zaloga ob prijavi, pour-cost karta). v1.231.0 doda inventuro s
čitalnikom (zaloge 22/22 — funkcionalno poln parity, OCR ostaja zavestna 0-AI
izključitev) in samodejno dodelitev mize rezervaciji (restavracija 20/22). v1.232.0
zadene zadnje tri funkcionalne vrzeli KDS (grupiranje po tečajih, ETA obljuba, SSE
pretok s polling fallbackom — kuhinja 17/18) in overlay rezervacij na tlorisu
(restavracija 21/22). Preostanek so odločitve lastnika (tabi, terminal, PEPPOL, EN
jezik osebja) ter urejevalnik con kot samostojen objekt.

---

## 7. Val v1.229.0 — implementirane izboljšave (ta dokument je načrt + dokaz)

1. **POS: EAN čitalnik → košara** — Enter v iskalnem polju z digitalno kodo →
   `GET /api/menus?ean=` → dodaj v košaro (scanner = tipkovnica + Enter).
2. **POS: Priljubljeno (★)** — zvezdica na karticah, ★ čip pred kategorijami,
   persist `ro_sale_favs` (localStorage, per naprava).
3. **POS: Happy-hour ⚡** — med aktivnim oknom auto-popusta ploščica pokaže ⚡ in
   akcijsko ceno (prikaz; kanonični obračun ostaja v billing.ts).
4. **Mize: Uredi mize (CRUD)** — dialog: dodaj/uredi/izbriši mizo (številka, sedeži,
   cona), PATCH razširjen za number/seats (menu.manage + unique 409 + audit),
   brisanje blokirano ob aktivnem naročilu.
5. **Naročila: prenos na natakarja** — PATCH employeeId (orders.create + aktivno
   naročilo + lokacijski gate + audit ORDER_TRANSFER), izbira v NaročiloSheetu.

## 8. Val v1.230.0 — zaprte točke s C-seznama

1. **Samodejni 86 ob izpraznitvi zaloge** — `src/lib/auto-86.ts`; razknjižba, ki sprazni
   zalogo, v isti transakciji kot račun označi odvisne artikle razprodane (direct privzeto /
   recipe opt-in); samodejna obnovitev ob prilivu na vseh 6 poteh (GRN, prejem, popis,
   storno, reverzija odpada, prenos); reviziji MENU_ITEM_AUTO_86 / MENU_ITEM_AUTO_RESTORE.
2. **Nizka zaloga ob prijavi (clock-in)** — Toast dec 2025: banner v Delovnem času s
   seznamom razprodanih/nizkih artiklov lokacije (strežniški kanonični prag).
3. **Taksacija pijače (pour cost)** — PourCostCard v Inženiringu: KPI pour cost % pijač,
   pasovi benchmarka (do 20 % / 20–28 % / nad 28 %), tabela vseh kategorij — čista
   frontend agregacija /api/menu-engineering.

## 9. Val v1.231.0 — inventura s čitalnikom + samodejna dodelitev mize + P4 popravek

1. **Inventura s čitalnikom (§5 → 22/22)** — Toast Inventory »count by scan«: skener =
   tipkovnica (koda + Enter). Točen EAN zadetek (normalizeEan obeh strani) šteje +1 na
   vrstici popisa (vsak sken = ena enota; utežni artikli ostanejo ročni), toast potrdi
   »✓ ime: n«, vrstica dobi 1,6 s emerald poudarek; artikel zunaj snapshot-a (dodan po
   odprtju popisa) → jasno opozorilo. Vse ostalo (prosta beseda) = filter seznama za
   ročno štetje — iskanje artikla med 200+ vrsticami. Samo v DRAFT (po oddaji zaklenjeno).
   0 novih backend poti — StItemRow.inventoryItemId je bil že v API odgovoru, klient ga
   je le deklariral.
2. **Samodejna dodelitev mize rezervaciji (§4 → 20/22)** — OpenTable/Toast vzorec: gumb
   »Dodeli« v rezervacijskem dialogu izbere NAJMANJŠO mizo, ki ustreza številu oseb in
   se ne prekriva z aktivno rezervacijo (CONFIRMED/SEATED/COMPLETED zavirajo,
   CANCELLED/NO_SHOW ne; okno = datum + trajanje). Klient ima vse podatke že naložene
   (mize + rezervacije z tableId/duration) — 0 novih backend poti; unikat
   @@unique([tableId, dateTime]) na strežniku ostaja varnost. Mize v izbirniku zdaj
   kažejo tudi število sedežev.
3. **P4 popravek (QA-val #10)** — vnos »Blagajna ob zaključku«: minus (−10 → tiho 10,
   razlika 20 €) in nesmisel (»1.2.3« → NaN → tiho 0) nista več tiho sprejeta. Poskus
   minusa pokaže opozorilo ob polju; pred oddajo vrednost validira klient (toast + ne
   pošlje) in strežnik (parseDrawerCash, nespremenjeno).

## 10. Val v1.232.0 — rezervacije na tlorisu + KDS tečaji/ETA/SSE (zadnji funkcionalni C-seznam)

1. **Rezervacije na tlorisu (§4 → 21/22)** — Toast/TouchBistro »reservations on floor
   plan«: naslednja prihajajoča POTRJENA rezervacija po mizi (status CONFIRMED, termin ≥
   zdaj, najzgodnejša). Ploščica mreže nosi vrstico »🕒 19:30 · 4× Ime«, zasedena miza
   (fiksna višina h-32) kompakt znak v nogi; oblika mize v tlorisu 🕒 + uro, ime gosta
   v tooltipu/aria. Čista klient agregacija (reservations.tableId obstaja od OPS-8) —
   0 novih backend poti; vlogam brez reservations.manage overlay iskreno izostane.
2. **KDS grupiranje po tečajih (§3)** — Toast/Square »course grouping«: postavke
   istega tečaja pod eno glavo (številka + ime + 🔥 če poslano); breztečajne postavke
   naprej v obstoječem vrstnem redu; listek brez tečajev = ENA skupina brez glave =
   identičen flat seznam (ničelna regresija). Nova čista knjižnica src/lib/kds-courses.ts
   (groupKdsItemsByCourse — sirota courseId dobe pošteno glavo, ne izgine); GET
   /api/kitchen vrača ADITIVNO polje courses (sort po številki; 0 DDL — Course tabela
   obstaja od OPS-7).
3. **KDS ETA obljuba (§3)** — Lightspeed »Prep ETA«: čip »Predvideno HH:MM« v glavi
   listka = ura naročila + cilj najzahtevnejše postaje (kdsTargetOf — ISTI vir kot prag
   zamude). Brez cilja postaje ETA iskreno izostane; zamujena obljuba postane rdeča.
4. **KDS SSE pretok (§3 »Push (ne polling)«)** — GET /api/kitchen/stream
   (text/event-stream, prag kitchen.update, lokacijski obseg): podpis =
   MAX(updatedAt) aktivnih naročil + postavk + postajnih nalog, tik 3 s; dogodek
   changed → klient takoj load('hot') (dušenje 2,5 s). Tok se po 55 s sam zapre
   (serverless varnost) in EventSource sam poveže nazaj (retry 5 s); polling 15 s
   ostaja VEDNO prisoten fallback. LIVE oznaka v glavi KDS samo ob živi povezavi.
   Povezava se odpre samo na zavihku kuhinja in samo vlogam, ki zavihek vidijo
   (tabHasPerm — brez 403 kroga).
5. **P2 popravek (NaročiloSheet)** — Select tečaja je pošiljal courseNumber kot
   courseId (404 »Tečaj ne obstaja«; deloval je samo »nov tečaj«); vrednost opcije je
   zdaj ID. **P3 popravek** — mirror množičnega opomnika je primerjal maločrkovni DB
   status, klient pa nosi UI obliko → števec kandidatov v potrditvenem dialogu je bil
   vedno 0.

---

## 11. Sveža raziskava (oktober 2026) + Val v1.233.0 — BENCHMARK VAL 5

Po zaprtju prvotnega C-seznama (v1.229–v1.232) je sledila NOVA spletna raziskava
(oktober 2026: Toast julij 2026, Square april 2026, Lightspeed november 2025 + april
2026, TouchBistro, 2026 buyer guide-i). Ugotovitev: dokument je bil točen do v1.232.0;
novo odkrite točke so razdeljene v »že imamo« (raziskovalec jih ni poznal) in tri
DEJANSKE nove funkcije, zaprte v tem valu.

**Že imamo (raziskava jih ni poznala — potrebne dopolnitve dokumenta):**
- Integracije dostave (Wolt + Glovo: webhook, samodejni sprejem, cone) — 2026 buyer
  criterion »delivery marketplace« ✔ ( obstaja od prej, vmesnik Dostava).
- Scan-to-pay na računu (gost plača po telefonu: /pay/<token> + Stripe) — Square
  marec 2025 ✔ (obstaja).
- Dnevni povzetek prodaje po e-pošti (sendDailyDigest v cron/daily) — Square
  november 2025 ✔ (obstaja).

**Nove točke tega vala (v1.233.0):**

1. **UREJEVALNIK CON (§4 → 22/22)** — Toast/TouchBistro upravljajo cone kot
   samostojen objekt. Nova ruta POST /api/tables/zones (menu.manage,
   requireUserLocation + assertOrgScope, updateMany vseh miz cone, revizija
   ZONE_RENAME s { from, to, count }); dialog v Mize: vrstica po coni (ime, število
   miz, seznam), PREIMENUJ (prosto besedilo) in ZDRUŽI (izbira ciljne cone) — obe
   dejanji sta isti operaciji na strežniku. 0 DDL (cona ostane besedilo na mizi).
2. **UČINKOVITOST NATAKARJEV (Lightspeed november 2025 »staff performance
   insights« / Toast »server scorecards«)** — nova čista knjižnica
   src/lib/staff-performance.ts (agregacija plačanih naročil po employeeId: število
   naročil, prihodek, povprečno naročilo, napitnine, delež; naročila brez natakarja
   ostanejo v lastni iskreni vrstici) + GET /api/reports/staff-performance
   (reports.sales, clamp 1–90 dni, lokacijski obseg kot sales-by-hour) +
   StaffPerformanceCard v Analitiki (obdobje 7/30/90, delež-pas, skupna vrstica).
3. **KDS VRSTA — Toast julij 2026 »Start Queue«** — pasivni predogled naročil, katerih
   postavke (v izbrani vedi) so ŠE VSE PENDING (brez požiga): trak nad aktivnimi
   listki s čipi (miza/tip, količina, starost po istem viru barvnih razredov).
   Iskreno izostane, ko je vrsta prazna; listki ostanejo v glavni vrsti (ničelna
   regresija). 0 novih backend poti (viewKitchen že nosi vse).

**Zavestne izključitve novega C-seznama (načrt v1.234+ po odločitvi lastnika):**
- Časovni meniji (Square april 2026: zajtrk/kosila samodejno po okviru) — pot
- Zibanje miz/rezervacij (Lightspeed april 2026 »table pacing«) — manjša
- Google Reviews po obisku (Lightspeed november 2025) — marketinška povezava
- Avtomatsko razporejanje obremenitve po postajah (Toast julij 2026) — hevristika
  AI-lika; usmerjanje po postajah + EXPO + vrsta že pokrivajo operativno potrebo
- Offline KDS (Toast »whole operation offline«) — KDS ima SSE + 15 s polling
  fallback; polni offline pomnilnik listkov je ločena investicija
- SSE potisk menijev na POS (Lightspeed »faster menu updates«) — POS ima 15 s
  operativni polling

**Sklep:** v1.233.0 zapre zadnjo vrzel prvotnega dokumenta (restavracija 22/22 —
VSEH pet vmesnikov ima polno funkcionalno pariteto) in tri najmočnejše točke
novejših objav konkurence (urejevalnik con, učinkovitost osebja, Start Queue);
preostanek novega C-seznama so zavestne odločitve/načrti, ne vrzeli.

---

## 12. Raziskava november 2026 — POLISH val v1.235.0 (zagate vodilnih + prazna stanja)

Ko so funkcionalne vrzeli zaprte (vsi ≥ 87 točk), je naslednja fronta POLISH —
detajli, ki jih uporabniki opazijo šele, ko jih ni. Dva vira:

**A) Square skupnost, avgust 2026 — »Major Flow Flaws« (natakar v baru z velikim
obsegom):** štiri konkretne pritožbe nad VODEČIM izdelkom, vsaka preverjena pri nas:

| Pritožba nad Square | Kako ima to RestaurantOS |
|---|---|
| (1) Zaslon plačila brez izhoda — »THERE IS NO WAY TO BACK OUT!« (napaka tipa/rezultat spremembe misli = reset aplikacije) | Dialog plačila je standardni Radix Dialog: X (44 px) + Escape + »Zapri« v stopalu delujeta na VSAKEM koraku; po izdaji računa ostane »Natisni« + »Zapri« — nikoli zagata |
| (2) Količinski gumb na sredini ZGORAJ — izven dosega palca | Količine so ob EACH vrstici košare (−/+ 40×40 px), plačilni gumb fiksno SPODAJ (desktop sticky / mobilno fiksna vrstica) — vzorec Toast |
| (3) Modifikatorji kot ena dolga drsna stran — obvezne izpade, brez avto-nadaljevanja | Dialog variant pokaže VSE skupine naenkrat (čipi, ne spustni seznami), potrditev omogočena ŠELE ko ima vsaka obvezna skupina izbiro — ni strani za izgubiti |
| (4) Premik posamezne postavke med izstavki nemogoč — samo cela kartica | Razdeli račun → potrditvena polja PO POSTAVKAH → izbrane postavke postanejo nov izstavek (Checks, v1.68); + po gostih/po sedežih |

**NAŠA lastna najdba istega razreda (popravljena v tem valu):** plačilni dialog
z odprtim razdelilnikom je bil izmeren 1019 px na zaslonu 720 px — DialogContent
NI imel ne max-višine ne drsenja, stopalo z glavnim gumbom je bilo 299 px POD
zaslonom (ista zagata kot Square #1, le iz drugega vzroka). Popravek:
`max-h-[calc(100dvh-2rem)] overflow-y-auto` na Dialog + AlertDialog (globalno,
vse diagrame).

**B) Iskrena prazna stanja (Toast onboarding vzorec):** Rezervacije (V-24) in
KDS (»kuhinja čista«) sta vzorec že imeli; Mize in Naročila GA NISVA:

- **Mize** — lokacija z 0 mizami je prej pokazala gol prazen prostor (mreža) oz.
  prazno platno (tloris). Zdaj: ikona + »Ta lokacija še nima miz.« + namig +
  CTA »Dodaj prvo mizo« (odpre urejevalnik miz; menu.manage) — brez pravice
  pošteno pove, kdo mize ureja. Tloris nosi isto sporočilo z usmeritvijo na
  mrežni pogled (brez CTA — platno ima vlečne geste).
- **Naročila** — filter brez zadetkov (zastarel filter ali mirna lokacija) je
  prej pustil gol prostor. Zdaj: ikona + kontekstno sporočilo — pri VSA
  pove, od kod naročila prihajajo; pri specifičnem filtru pove KATERO stanje
  je prazno in ponudi preklop filtra.

**Toast junij 2026 — nove točke, ocenjene pri nas:**
- »Scheduled Menu Stock Updates« (razporedi 86/obnovitev po urniku — dnevna
  ponudba pripravljena ob odprtju): NOVA zavestna izključitev — sorodna
  časovnim menijem (§11), odločitev lastnika; operativno potrebo pokrijeta
  samodejni 86 ob izpraznitvi (v1.230) + nizka zaloga ob prijavi (v1.230).
- Urejanje naročil tržnic (MPF) neposredno na POS: imamo — NaročiloSheet
  ureja vsako naročilo vključno z dostavnimi (Wolt/Glovo).
- Webhook dostop (sep 2025): imamo — Wolt + Glovo webhook + samodejni sprejem.

**Sklep §12:** vodilni izdelki zalogijo na detajlih, ki jih mi nismo — izhodi
iz vseh stanj, količine v dosegu palca, modifikatorji brez drsenja, premik
postavk med izstavki. V tem valu smo zaprli še lastno zagato istega razreda
(drsenje dialogov) in dve zadnji prazni stanji osnovnih pogledov.

---

## 13. Raziskava december 2026 — POLISH val 2 v1.236.0 (KDS: Flash Changes + preklicane postavke)

Tretji polish vir: **Toast KDS platform guide + skupnost (avgust/oktober 2026)**
in **Lightspeed K-Series »What's new« (marec–maj 2026)**. Dve točki sta bili
pravi vrzeli istega razreda kot §12 (detajl, ki ga kuharja moti vsak dan):

### A) Toast KDS »Flash Changes« — utrip ob NOVEM ali SPREMENJENEM listku

**Kako ima Toast:** platform guide zapisuje dve ločeni signalizaciji:
(1) »A flash animation to indicate a ticket is new or was changed« — ob steni
10 listkov kuhar takoj vidi, KATERI listek je pravkar priletel oz. se je
spremenil (drugi krog pijač na isti mizi); (2) »sound alerts for new tickets,
ready orders, item changes, and voided items« — vsak dogodek ima svoj zvok.
Oktober 2026 so dodali še »recently fulfilled tickets stop flashing« — utrip
je časovno omejen, ne utripa večno. Skupnost (avgust 2026) potrdjuje, da je
nastavitev vikend-volumnu kritična.

**Kako ima RestaurantOS (v1.236.0):** prej smo imeli SAMO zvok ob porastu
števca čakajočih postavk — brez vizualnega signala in brez ločevanja
dogodkov. Nova implementacija:

- **Diferencialni pogon** (`src/app/dashboard/page.tsx`, učinek nad
  `viewKitchen`): posnetek id-jev listkov + postavk + preklicov v refu;
  ob vsakem SSE pretoku (`/api/kitchen/stream`, v1.232) ali 15 s polling
  primerjamo IDENTITETO (id-ji), ne števcev → `newTickets` / `newItems` /
  `newVoids`. Prvi odčitek in preklop postaje sta IZHODIŠČE (brez lažnega
  utripanja).
- **Nov listek** — utripajoči oranžni obroč okrog kartice (prazen prekrivni
  `span` z `ring-4 ring-orange-400/80 animate-pulse`,
  `data-region="kds-flash-ring"` — vsebina listka NE utripa, ostane berljiva)
  + značka **NOVO** v glavi (`kds-flash-new`).
- **Dodane postavke na obstoječem listku** — značka **+n** v glavi
  (`kds.newItems`, `{n}` interpolacija) + vsaka nova vrstica dobi oranžni rob
  in ozadje (`border-orange-400 bg-orange-50 ring-2`) + utripajoči čip
  `+ NOVO` ob imenu (`kds-item-new`) — kuhar vidi KAJ je novega, ne samo
  da se je »nekaj« spremenilo.
- **Zvočni toni** (`kdsBeep(freq, ms, delay)`, WebAudio): nov listek 880 Hz
  (obstoječi znak), sprememba 660 Hz dvojni, preklic 392 Hz trojni — en
  dogodek = en ton (prednost preklic > nov > sprememba).
- **Zatritev** po 10,5 s (`setTimeout` počisti vse tri mape) — Toast oktober
  2026 vzorec »stop flashing«.
- Poimenovane postaje (task board, Issue #14) ostajajo na števcu nalog —
  ničelna regresija.

### B) Preklicane postavke OSTANEJO vidne (Toast: prečrtane + alarm)

**Kako ima Toast:** voided item ne izgine s KDS — ostane na listku PREČRTAN
in sproži zvok, da kuhinja, ki je morda že strt delo, ve, da naj USTANE.
Brez tega se postavka izgubi tiho in kuhar pripravi obrok, ki ga nihče ne
čaka (odpad hrane + zamuda naslednjih listkov).

**Kako ima RestaurantOS (v1.236.0):** prej je strežniški filter
`voided: false` v `GET /api/kitchen` (`src/app/api/kitchen/route.ts`)
preklicano postavko TIHO izločil — kuhinja ni vedela nič. Nova implementacija:

- **API** (`src/app/api/kitchen/route.ts`): druga poizvedba poizveduje
  nedavno preklicane postavke (`voided: true`, status še vedno AKTIVEN,
  `updatedAt >= zdaj − 30 min` — okno `KDS_VOID_WINDOW_MS`, take 200) z
  razlogom iz kataloga (`VoidReason` → `voidReasonName`). Odgovor nosi
  ADITIVNO polje `voidedItems` na vsakem listku vrste (`queueWithVoids`) —
  odjemalci, ki ga ne poznajo, ga mirno ignorirajo. Postajni filter (KDS
  naprava BAR) obdrži listek tudi, ko so vse postavne preklicane
  (`o.items.length > 0 || o.voidedItems.length > 0`).
- **Klient** (`src/app/dashboard/page.tsx`, `renderKdsTicket`): oddelek
  `data-region="kds-ticket-voided"` (role=status — informacija, ne alarm;
  rdeči pas ostaja rezerviran za alergene) na dnu listka: prečrtana vrstica
  (`line-through`) + ikona Ban + značka PREKLICANO + razlog (če je iz
  kataloga); NOV preklic utripa rdeče 10 s (`kdsFlash.voids`) + 392 Hz
  trojni ton. Postavni filter BAR ne kaže kuhinjskih preklicov.
- **Vrsta obdrži listek z SAMO preklicanimi postavkami** (`kdsQueue`
  filter razširjen na `voidedItems`) — »vse preklicano« je vidno, ne izgine.
- Izločene iz VSEH štetij (All Day, ETA, pragovi zamude, bump) — čista
  informacija, nič regresije.

### C) Druge točke raziskave december 2026 (ocena)

- **Lightspeed marec 2026 — digitalni checklisti odpiranja/zapiranja**
  (opening/closing duties): NOVA zavestna izključitev / načrt — HACCP dnevne
  kontrole (`/api/haccp`) pokrivajo živilsko-varnostni del; poln modul
  checklistov (predloge + dnevni vnosi + potrditve) je ločena investicija
  (potrebna shema oz. konfiguracijsko shranjevanje) — odločitev lastnika.
- **Toast januar 2026 — Optimized Drive-Thru Mode** (preskoči nepotrebne
  vpive, predogled listkov): ZDA QSR praksa; naš TAKEOUT tok je že 1-dotik
  (grid → košara → TAKEOUT → plačilo) — vrzel ni.
- **Toast januar 2026 — Centralized Notification Log**: imamo — zvonček
  push obvestil (v1.70) + dnevnik napak v Nadzoru.
- **Square 2026 — real-time statusni indikatorji tlorisa** (»servers and
  managers can track dining room flow at a glance«): imamo — statusne barve
  miz (prosta/zasedena/umazana) + overlay rezervacij (v1.232) + števci v
  glavi zavihka Mize.
- **Lightspeed maj 2026 — automatic table assignments**: imamo (v1.231).

**Sklep §13:** dve zadnji KDS vrzeli polish razreda sta zaprti — utrip ob
spremembi (Toast »Flash Changes«) in viden preklic (prečrtana vrstica z
razlogom). Kuhinja zdaj za vsak dogodek dobi PRAVI signal: kaj je novo,
kaj je dodano, kaj je preklicano — po zvoku LOČLJIVO, po videzu v 10 s
zaglavljenem. Preostanek raziskave so zavestne izključitve/načrti
(checklisti = odločitev lastnika).

---

## 14. Raziskava december 2026 / januar 2027 — POLISH val 3 v1.237.0 (KDS: modifikatorji vidni)

Viri: Toast product updates (avgust 2026 »KDS now supports horizontal modifier
display mode« + oktober 2026 »chimes only for changed tickets in Horizontal
modifier display mode« + support ›Advanced Modifier Configuration‹ september
2026), Square KDS vodnik 2026 (»It makes modifiers visible … modifiers like
›no onions‹ are why kitchens stop guessing«), Square Kiosk oktober 2026
(21,5-palčni zaslon, večji fonti — AI/glasovno naročanje je izven obsega
pravila »brez AI«), Lightspeed marec 2026 (»special requests, dietary
restrictions and other specific notes to the kitchen instantly«).

### A) Izbrane opcije postavke NA KDS LISTKU (Toast »horizontal modifier display mode«)

**Kako ima Toast:** vsaka postavka na listku nosi svoje izbrane opcije
(velikost pijače, dodatek, »brez čebule«) — v VERTICAL načinu vsaka opcija
dobi svojo vrstico, v HORIZONTAL načinu (nov avgust 2026) pa vse izbrane
opcije tečejo v ENI vrstici pod imenom artikla: prihranek vertikalnega
prostora = več listkov na zaslonu hkrati (oktober 2026 je način pripeljal
še ločene zvončke za spremenjene listke). Square KDS vodnik imenuje
vidnost modifikatorjev kot eno od treh temeljnih nalog KDS: naročilo brez
opcij je naročilo, ki ga kuhinja ugiba. Lightspeed marec 2026 posebne
zahteve/dietne opombe pošilja na kuhinjo takoj.

**Kako ima RestaurantOS (v1.237.0):** opcije so v bazi obstajale od OSS-10
(v1.209.0 — `OrderItemModifier` vrstice s posnetkom imena/cene ob nastanku
naročila; POS izbira variante v `src/app/dashboard/page.tsx` dialog
`variantPick` → `posVariantItemsPayload` → `createOrderCore` validira cene
iz DB in zapize vrstice), a jih je `GET /api/kitchen` NOSIL BREZ relacije —
KDS zaslon in tiskani listki s KDS gumbov so pokazali SAMO ime artikla.
Popravek:

- **API** (`src/app/api/kitchen/route.ts`): include
  `OrderItemModifier: { select: { name: true } }` v glavni poizvedbi vrste
  IN v poizvedbi preklicanih postavk — preslikavo opravi obstoječi
  `mapOrderItem` (`src/lib/map.ts`, polje `modifiers` je bilo aditivno od
  v1.209.0; vrsta brez opcij pošlje `[]`). Tudi PREKLICANA postavka nosi
  svoje opcije — kuhar ve, KATERA velikost/varianta ne gre ve v pripravo.
- **Klient** (`src/app/dashboard/page.tsx`, `renderKdsTicket`): ena
  horizontalna vrstica `data-region="kds-item-modifiers"` pod imenom
  postavke (Toast horizontal mode — `text-xs sm:text-sm font-semibold
  text-stone-600`, imena ločena s »·«, `break-words` za dolge sezname,
  `title` s celotnim seznamom; sr-only predpona `kds.itemOptions` za bralce
  zaslonov). Prazno = brez vrstice — nič regresije gostote (Issue #69).
  Preklicana vrstica nosi opcije prečrtano (`kds-voided-modifiers`).
- **Tiskani listki** (`printKitchenTicket` → `buildKitchenTicketLines`,
  `src/lib/devices/print.ts`): vrstice `+ opcija` so obstajale od v1.209.0,
  a je vhod `it.modifiers ?? []` s KDS poti vedno padel v prazno — ZDAJ,
  ko API nosi relacijo, tiskamo prave opcije BREZ spremembe tiskalnega
  sloja (prosti popravilni učinek include).
- **SSE svežina** (`src/app/api/kitchen/stream`): brez spremembe — tok
  nosi le podpis svežine, klient ob `changed` ponovno naloži celo vrsto
  (opcije pridejo z njo).

### B) Druge točke raziskave (ocena)

- **Square Kiosk oktober 2026** (21,5-palčni zaslon, večji fonti, hitrejše
  nalaganje menija, »picture-based categories«): naše obroke/kiosk teče na
  gostujočem `/kiosk` s slikami kategorij od v1.141 — večji zaslon je
  hardver, ne funkcija; AI/glasovno naročanje je ZAVESTNA izključitev
  (pravilo projekta »0 AI«).
- **Lightspeed marec 2026 — posebne zahteve takoj na kuhinjo**: imamo —
  opomba postavke (`note`, ℹ na KDS + `opomba:` na tiskanem listu) +
  izrecno alergensko opozorilo (rdeči pas, Issue #7).
- **Toast oktober 2026 — chimes only for changed tickets**: pokrito z
  v1.236.0 (diferencialni pogon — zvok SAMO ob novem/spremembi/preklicu,
  ne ob vsakem loadu).

**Sklep §14:** zadnja tiha vrzela KDS poteče — izbrane opcije postavke so
zdaj vidne na vseh treh poteh (zaslon vrste, preklicana vrstica, tiskani
listek), pri čemer so podatki obstajali od v1.209.0 (vrzel je bila čisto
v include + rendru). Kuhinja ne ugiba več, ali je »Pizza« mala ali velika,
z ali brez čebule.

## 15. Raziskava januar 2027 — DENARNI VAL v1.238.0 (finančna celovitost POS/plačil/nabave)

Metoda: poglobljen QA pregled LOGIKE (ne videza) vseh petih vmesnikov s tremi
vzporednimi raziskavami — POS/plačila, zaloge/nabava, restavracija/KDS — z
iskanjem vrsti resničnih hroščev: race pogoji, izgubljen denar, napačni
izračuni, tiha preslikava stanj. Izid: 4 najdbe razreda P0 (denar/podatki),
5 razreda P1 — vse implementirane v tem valu (0 DDL, 0 odvisnosti, 0 AI).

### A) Postavka dodana na razdeljen račun MORA pristati na izstavku (P0)

**Kako imajo najboljši:** Toast in Square — vsaka postavka na naročilu z
izstavki (checks) ima VEDNO dodeljen izstavek; dodajanje pijače na razdeljen
račun pristane na izbranem (ali privzetem odprtem) checku. »Check-less«
postavka na split naročilu pri vodilnih ne obstaja — ker pomeni postreženo
hrano, ki je nihče ne zaračuna.

**Kako je bilo pri nas (najdba):** `PATCH addItems` (src/app/api/orders/[id]/route.ts)
je ustvaril vrstice BREZ `checkId` potem, ko je natakar že razdelil račun
(POST /api/orders/[id]/checks). Posledica v treh korakih: (1) GET /checks je
siroto POKAZAL pod izstavkom #1 (`it.checkId ? … : checks[0]` — UI laže),
(2) jedro plačila (src/lib/furs/issue.ts `scopeItems` po `checkId`) jo je
IZPUSTILO — gost je plačal vse izstavke, pijača pa nikoli ni bila zaračunana
(niti na računu niti v razknjižbi zaloge `deductStockForOrderTx(onlyItemIds)`).

**Popravek v1.238.0:** znotraj transakcije addItems se preberejo izstavki
naročila; če obstajajo, NOVE vrstice dobijo `checkId` prvega neplačanega
izstavka (`openChecks.find(c => c.paymentStatus !== 'paid') ?? openChecks[0]`).
Naročila brez izstavkov: obnašanje nespremenjeno (`checkId: null`).

### B) Napitnina pri kartičnem plačilu gre NA TERMINAL (P0)

**Kako imajo najboljši:** Toast/Square — tip je vedno del zneska, poslanega
na terminal (`tendered = amount + tip`); posnet `Payment.tipAmount` mora
ustrezati fizično pobranemu denarju.

**Kako je bilo pri nas:** dashboard POS je terminalu naročil bremenitev
SAMO `due` (src/app/dashboard/page.tsx `processTerminalPayment(due)`), tip
pa poslal ločeno v `body.tip` → račun `totalWithTip = total + tip`,
`Payment.tipAmount = tip`, dnevni bazen napitnin (api/tips) pa je tisto
napitnino izplačal osebju — denar, ki ga terminal NIKOLI ni pobral.
Handheld (src/app/handheld/page.tsx `payTotal = totalDue + tipEur`) je bil
referenčna implementacija — isti produkt, dve vedenji.

**Popravek v1.238.0:** klasična pot — `processTerminalPayment(r2v(due + tip))`;
deljena pot — prvi kartični/mobilni del nosi `p.amount + tip` (enkrat;
`tipOnTerminal` zastavica), strežniku pa se dele pošljejo nespremenjene
(vsota delov ostane = znesek računa; tip gre ločeno v body.tip).

### C) Odprti balance — QR plačilne povezave v plačilnem dialogu (P0)

**Kako imajo najboljši:** Toast/Square — plačilni dialog VEDNO prikazuje
»open balance« (skupaj − že pobrano) in terminal dobi samo odprti znesek.

**Kako je bilo pri nas:** strežniški zaključek je QR deleže upošteval
(src/lib/furs/issue.ts `legacyAmount = total − redeem − linkPaidTotal`), a
predogled računa (GET /api/orders/[id]/bill) tega NI vrnil — dashboard je
izračunal `due = bill.totalDue − redeem` in terminal naročil bremenitev
CELEGA zneska. Gost s 60 € računom, kjer je 30 € že plačal prek QR, je bil
kartično obremenjen za 60 € (skupaj 90 €) — knjige so bile »v redu«, denar
pa izginil v poravnavo terminala.

**Popravek v1.238.0:** bill API vrača `linkPaidTotal` (vsota `PayLink
status='paid', receiptId=null`); dashboard `due = totalDue − redeem −
linkPaidTotal`; dialog kaže vrstico »Prek QR povezave že pobrano«
(data-region payment-link-paid, i18n payment.linkPaid SL/HR); limit unovčenja
zvestobe se prav tako računa na odprtem balanci (bill + issue.ts — prej bi
unovčenje nad odprtim balance padlo na 400 ob zaključku).

### D) Happy Hour okno v časovnem pasu lokacije (P1)

**Kako imajo najboljši:** Toast/Square/Lightspeed — promocije se ovrednotijo
v coni lokacije restavracije, ne strežnika.

**Kako je bilo pri nas:** `isHappyActive` je uporabil `now.getHours()` — na
Vercelu/Railway (UTC) se je HH 17–19 pozimi dejansko aktiviral 18–20 in
poleti 19–21 lokalno; ploščice v POS (brskalnikov čas gostilne) so kazale ⚡
uro prej kot račun. Fiskalno-številčenje je imelo pravi pripomoček
(`src/lib/fiscal-time.ts localParts`) že od v1.143.0 — HH ga ni uporabljal.

**Popravek v1.238.0:** `computeBill` dobi `tz` (Location.timezone); ura/dan
okna se bereta prek `localParts(now, tz)` (neveljavna cona → Ljubljana, ne
strežnik); klicalca (bill route + issue.ts) posljeta cono lokacije.

### E) Združevanje naročil: denar in popust ne smejo ostati na preklicanem viru (P0)

**Kako imajo najboljši:** Toast/Square — prenos/merge prenaša plačila in
popuste skupaj s postavkami; če jih ne more ohraniti (že zajeto plačilo), ga
ZAVRNE.

**Kako je bilo pri nas:** merge je varoval SAMO `checkId` postavke — a QR
plačilne povezave poravnajo delež BREZ Checka (`PayLink.status='paid'`,
`order.paymentStatus='partial'`). Tak vir je šel skozi merge: postavke so se
prestavile, vir preklical (denar ujet na njem, brez računa → vračilo ni
mogoče), cilj pa nosil POLNO vrednost — gost plača dvakrat. Ročni popust
(Order.discount €) je prav tako ostal na preklicanem viru.

**Popravek v1.238.0:** vir z `paymentStatus !== 'unpaid'`, s plačano povezavo
ali z ročnim popustom → 409 z iskrenim razlogom (zunaj IN znotraj transakcije
— CAS disciplina v1.145.0).

### F) Tip naročila — strict enum na strežniku (P1)

**Kako imajo najboljši:** Square/Toast — dining-option je strogi enum;
strežnik neznano vrednost ZAVRNE, ne pa tiho preslika.

**Kako je bilo pri nas:** hitra prodaja (šank) je pošiljala `type: 'TAKEOUT'`
(tipkarska — preslikava `TYPE_TO_DB` pozna `TAKEAWAY`) → VSA hitra prodaja
tiho pristala kot `dine-in` brez mize → poročila po kanalih (sales-by-hour,
food-cost) so lažala od prvega dne.

**Popravek v1.238.0:** dashboard pošlje `TAKEAWAY`; POST /api/orders neznano
vrednost zavrne z 400 (bela lista DINE_IN/TAKEAWAY/DELIVERY, velike/male
črke normalizirane).

### G) Storno enega izstavka — žig računa na odjemu zaloge (P0)

**Kako imajo najboljši:** MarketMan/Toast — refund/storno deluje per preglej
računa; povrne se SAMO tisto, kar je ta račun odnesel.

**Kako je bilo pri nas:** storno je povrnil zalogo po `orderId + type='SALE'`
— na naročilu z dvema izstavkoma (2 računa) je storno ENEGA povrnilo odjeme
OBEMA (zaloga napihnjena za porabljeno in plačano), celotno naročilo pa je
postalo `storno`, čeprav je drugi račun ostal veljaven.

**Popravek v1.238.0:** razknjižba ob izdaji računa zapiše žig
(`StockTransaction.supplierDoc = receiptNumber` — isti vzorec referenc
dokumentov kot transferNumber pri prenosih). Storno na več-računskem
naročilu: žig obstaja → vrača SAMO odjeme tega računa, naročilo OSTANE
'paid' (ostali izstavki so veljavni — Toast: refund ne razplača celote);
žiga ni (računi pred v1.238.0) → 409 z iskrenim razlogom (ročni popravek
zaloge) — tiha korupcija zaloge ni več možna. Eno-računska naročila:
obnašanje nespremenjeno (nazaj-kompatibilno).

### H) Nabava: statusni prehodi so CAS + zavrnjeno NI incoming (P1)

**Kako imajo najboljši:** MarketMan/PO sistemi — statusni prehodi dokumentov
so vedno `UPDATE … WHERE status = :expected`; pričakovana dobava =
naročeno − prejeto − ZAVRNIHENO.

**Kako je bilo pri nas:** (1) PATCH statusa nabavnega naročila je pisal
BREZPOGONO — preklic na zastarelem branem je prepiSal 'received' (dobava
fizično na zalogi, GRN + AP osnutek obstajajo), approve pa oživil preklicano.
Prejemna ruta je imela to varovalo že od prej — PATCH je ni zrcalil.
(2) Predlogi naročil so `remaining = ordered − received` — 5 zavrnjenih
kosov (poškodovano, razlog zapisan) je štelo kot prihajajoče in sistem je
tiho podnaročil.

**Popravek v1.238.0:** PATCH je CAS (`updateMany where status = prebrano`,
count=0 → 409 »osvežite seznam«); predlogi `remaining = max(0, ordered −
received − rejected)`.

### I) Druge najdbe raziskave (ocena — načrt za naslednje vale)

- **Z-poročilo izmene po vrsticah Payment** (P1): 'mixed' računi (gotovina +
  kartica) padajo v »drugo«, gotovinski deli manjkajo v pričakovani gotovini
  predala → lažni primanjkljaj ob zaključku izmene. Načrt: agregacija po
  Payment vrsticah (kot že X/Z izvoz reports/export).
- **Storno ne negira napitnine v dnevnom bazenu** (P1): Payment.tipAmount
  ostane pozitiven ob stornu računa. Načrt: negativna vrstica + poštevna
  poizvedba bazena.
- **Natisnjen račun izstavka pokaže vse postavke naročila** (P1): račun nima
  posnetka postavk izstavka. Načrt: snapshot itemIds ob izdaji.
- **Void postavke na že plačanem izstavku** (P1): brez vračila. Načrt: 409 z
  usmeritvijo na storno.
- **Rezervacije — strežniški prekrivni pogoj terminov** (P1): unique velja
  samo za identičen časovni žig; dve rezervaciji 19:00/20:00 isto mizo gresta
  skozi. Načrt: intervalsOverlap (isti motor kot widget).
- **NO_SHOW/CANCELLED ne sprostita mize** (P1) + **usaditev čakalne vrste
  lahko povozita rezervirano mizo** (P1) + **PATCH mize brez strežniške
  varovale** (P1): načrt skupnega helperja `assertTableClaimable`.
- **QR naročilo gosta brez push + brez požiga** (P1): pristane kot osnutek,
  ki ga nihče ne posreduje kuhinji. Načrt: pushEvent + auto-fire.
- **EAN unikat per lokacija** (P1), **receptura brez lokacijske varovalke**
  (P1), **serije pri odpadu/inventuri** (P1), **varianca inventure proti
  neto gibanjem** (P1), **pour cost pokritost** (P1): založni val.

**Sklep §15:** denar ima v sistemu eno pot — terminalse bremenitev, knjige
in fizični predal se pri vodilnih nikoli ne razidejo. Ta val zapira štiri
P0 vrzeli, kjer so se lahko (addItems sirota, tip brez terminala, QR dvojna
bremenitev, merge ujet denar, storno napihnjena zaloga), in postavlja
strogo disciplino (CAS, strict enum, žig dokumenta) tam, kjer so jo vodilni
imeli že od nekdaj.

---

## 16. Raziskava januar 2027 — RAČUNSKA CELICA v1.239.0 (izmene/posnetek/void)

Nadaljevanje denarnega vala (§15 I, B-načrti). Tri vzporedne raziskave kode so
potrdile štiri vrzeli RAČUNSKE celice — vsaka primerjana z vodilnimi izdelki.

### A) Z-poročilo izmene — mešana plačila po VRSTICAH Payment (P1)

**Kako imajo najboljši (Square/Toast):** način plačila je lastnost DELA plačila,
ne računa. Split tender (4 € gotovina + 7,50 € kartica na enem računu) je
standard; Z-poročilo in pričakovana gotovina predala štejeta gotovinski del
kot gotovino. Toastovo Z-poročilo ima stolpce po tenderjih, ne po »vrsti računa«.

**Kako ima RestaurantOS (v1.239.0):** `src/lib/furs/issue.ts` je delom plačila
(POST /api/furs `parts`) ŽE ustvarjal po vrstico Payment (`tx.payment.create`
z `type` + `amount`, ~vrstica 703), a je Receipt nosil eno samo izgubno oznako
`paymentMethod: 'mixed'` (~vrstica 449) — zaključek izmene
(`src/app/api/shifts/route.ts` ~307–312) je tak račun v celoti metal v »drugo«,
gotovinski del pa IZPADAL iz `expectedCash = startingCash + cash + netMovements`
→ namišljena razlika predala ob zaključku (lažni presežek, sproži flow
razloga/odobritve). Popravek: skupni motor `src/lib/shift-payment-buckets.ts`
(iste vrstice Payment kot X/Z izvoz `reports/export` section=zz, ki je to delal
pravilno) zdaj poganja VSA štiri mesta — zaključek izmene (override vedrov v
transakciji), PRE-TX preview variance (~190), živi pregled premikov
(`shifts/movements/route.ts` liveCashSales) in dnevni e-mail (~550). Legacy
storno računi (brez negacijskih vrstic) dobijo ročno korekcijo po obsegu
(Receipt.checkId sicer vsi izstavki naročila); okna brez vrstic Payment
padajo na staro logiko po računih (nazaj-kompatibilno).

### B) Storno ne negira napitnine v dnevnom bazenu (P1)

**Kako imajo najboljši (Toast):** refund negira VSAK del plačila po izvirnem
načinu — dnevni bazen napitnin vidi original in negacijo, neto je 0. Denar,
vračen gostu, ne more ostati v bazenu za izplačilo.

**Kako ima RestaurantOS (v1.239.0):** storno ruta
(`src/app/api/receipts/[id]/storno/route.ts`) je negirala SAMO Receipt
(subtotal/total/tip ~166–178) — Payment vrstice so ostale pozitivne za vedno
(edini `payment.create` v kodi bila izdaja), bazen napitnin
(`src/app/api/tips/route.ts` dayPayments, filter `tipAmount > 0`) je po stornu
računal napitnino, ki je bila vračena. Popravek: storno v ISTI transakciji
ustvari zrcalne negacijske vrstice (isti checkId/tip/prejemnik, negiran
amount/tipAmount, status completed — vse obstoječe agregacije se natočijo
same); filter bazena `tipAmount: { not: 0 }`; obseg negacije po fail-closed
lestvici: per-check (Receipt.checkId) → celotno plačilo (vsi izstavki
naročila) → legacy multi-check brez checkId = izpuščeno + iskreno v auditu
(okno v1.238.0→v1.239.0; zaloge/fiskal pravilni, ročni popravek vodstva).
Zaprti (hash-verižni) bazeni ostanejo nespremenjeni — remediacija je
revidiran ročni popravek, ne tiha mutacija.

### C) Natisnjen račun izstavka pokaže VSE postavke naročila (P1)

**Kako imajo najboljši (Toast/Square):** račun je POSNETEK trenutka izdaje —
ponatisk prikaže točno tisto, kar je gost dobil ob izdaji; kasnejše spremembe
naročila (dodajanje, premik, preklic) ne spreminjajo podobe izdanega
fiskalnega dokumenta.

**Kako ima RestaurantOS (v1.239.0):** izdaja po izstavku
(`src/lib/furs/issue.ts` ~213–239) je pravilno obračunala SAMO postavke
izstavka (DDV, zneski, zaloga), a Receipt NI shranil, KATERE postavke — branje
za ponatisk (`src/app/api/furs/[id]/route.ts` ~49) je izpeljalo vrstice iz
ŽIVEGA naročila (`Order.OrderItem` brez filtra checkId): račun izstavka #1 je
pri ponatisku pokazal postavke VSEH izstavkov (Σ vrstic > receipt.total),
dodajanje po delnem plačilu pa bi povečalo seznam. Popravek: nova aditivna
stoplca `Receipt.checkId` (mehka referenca, precedens `stornoOf`) +
`Receipt.itemsJson` (posnetek [{id,name,qty,price,vatRate,vatAmount,amount}],
precedens `KotDocument.itemsJson`) — zapis ob izdaji (~638), prenos na storno
račun, branje s prednostjo posnetka + nazaj-kompatibilnim padalom na žive
postavke za legacy račune (itemsJson='[]').

### D) Void postavke na že plačanem izstavku brez vračila (P1)

**Kako imajo najboljši (Toast):** izdani fiskalni račun se spremeni SAMO s
fiskalnim stornom — preklic postavke na plačenem delu naročila ni ponujen
(409 z usmeritvijo na storno); refund ne razplača celotnega naročila
(odprti izstavki živijo naprej).

**Kako ima RestaurantOS (v1.239.0):** varovala preklica
(`src/app/api/orders/[id]/void/route.ts` ~108) so bila ORDER-level — delno
plačano naročilo ('partial': izstavek #1 plačan, #2 odprt) je pustilo preklic
postavke PLAČANEGA izstavka skozi brez vračila (Σ izstavkov > Order.total,
R1 poroča višje kot je zaračunano interno, zaloga ostane odjeta) — hkrati je
bil storno za to naročilo 409 (zahteva 'paid'): osebje ujeto v past,
edina pot je bila korupcija. Popravek: pre-bran + race-safe preverba znotraj
transakcije (Check.paymentStatus === 'paid' → 409 »uporabite fiskalni
storno«); per-check storno na 'partial' naročilu ODPRT (račun z checkId +
izstavek plačan; naročilo ostane 'partial' — Toast semantika); UI gumb
skrit za checkPaid postavke (mapOrderItem aditivno izpostavi checkId +
checkPaid; orderInclude nosi relacijo Check).

### E) Druge najdbe raziskave (ocena — naslednji valovi)

- **Rezervacije — strežniški prekrivni pogoj terminov** (P1): @@unique
  ([tableId, dateTime]) zavrne samo identičen žig; 19:00 (120 min) in 20:00
  isto mizo gresta skozi. Načrt: intervalsOverlap (že v
  `src/lib/reservation-slots.ts:124`) v POST /api/reservations z zaklepom.
- **NO_SHOW/CANCELLED ne sprostita mize + usaditev čakalne vrste lahko
  povozita rezervirano mizo + PATCH mize brez varovale** (P1): skupni helper
  `assertTableClaimable` za waitlist-seat, tables PATCH in prehode rezervacij.
- **QR naročilo gosta brez push + brez požiga** (P1): pristane open/pending —
  legacy KDS vrsta ga pokaže (~3–15 s), a postajne deske NE (StationTask nastane
  ob fire) in firedAt ostane null (ETA statistika laže). Načrt: pushEvent
  ORDER_NEW v public/orders + auto-fire za vire qr/kiosk (izpelja skupni
  helper iz fire rute); tablica submitCreate enako.
- **EAN unikat per lokacija, receptura brez lokacijske varovalke, serije pri
  odpadu/inventuri, varianca inventure proti neto gibanjem, pour cost
  pokritost** (P1): založni val.

**Sklep §16:** račun je pogodba z gostom IN z davčno upravo — njegova vsebina
posnetek trenutka izdaje (C), njegovo plačilo deli po vrsticah (A), njegova
negacija zrcali vse dele (B), njegova neprekljivost pa je pogojena s
plačilnim stanjem IZSTAVKA, ne naročila (D). Vodilni imajo to disciplino
vgrajeno; ta val jo prinaša v vseh štirih legah — z eno aditivno DDL
(checkId + itemsJson) in brez novih odvisnosti.

### F) HOTFIX v1.239.1 — DDL pot računske celice (orodje, 0 spremembe vedenja)

Val v1.239.0 je dodal 1 aditivno DDL (Receipt.checkId + itemsJson), a ZABIL
vpis v KNOWN_DRIFTS allowlist (vsak prejšnji DDL val ga je dodal — vzorec
coupons-waitlist hotfix v1.219.1). neon-smoke drift vrata so po pushu izmerila
2 nepričakovana stavka (CI run 41596980960 @ c0f8b13) → CI rdeč, Vercel
deploy blokiran. POPRAVEK po istem precedensu: (1) NOVA admin ruta
`/api/admin/migrate-receipt-snapshot` — idempotentna (probe PRED vsakim
stolpcem; PG JSONB / SQLite TEXT dialekt za itemsJson), audit
SCHEMA_MIGRATION_RECEIPT_SNAPSHOT, requireCentralRole; (2) register
SCHEMA_MIGRATIONS +1 (receipt-snapshot, probe oba stolpca) + migracijska
konzola HANDLERS +1; (3) KNOWN_DRIFTS +1 (isReceiptSnapshotStatement —
strogo enosmernen ADD, DROP ostane hard fail); (4) i18n +1 ključ
(mig.receiptSnapshot.desc) 3859 → 3860. VROČA POT (razlika od večine pending
valov): izdaja računa (src/lib/furs/issue.ts) piše oba stolpca ob VSAKEM
fiskalnem računu — korak apliciramo TAKOJ po deployu (vzorec issue31-36/38),
sicer izdaja na produkciji pada na P2022.

### G) REZERVACIJSKA CELICA v1.240.0 — miza ima eno resnico (B-načrta 1+2 iz §16 E)

Trije klicatelji so vsak po svoje odločali, ali je miza "prosta" — in vsak
je gledal le del resnice. Val združi vse v enem varovalcu:

- **A · STREŽNIŠKI prekrivni pogoj terminov** (POST /api/reservations):
  @@unique([tableId, dateTime]) je zavrnil SAMO identičen žig — 19:00
  (120 min) in 20:00 na isti mizi sta obe uspeli; UI (autoAssignTable) je
  prekrivanje znal preskočiti, strežnik pa ne ("pomoč pri izbiri, ne
  obveza"). Zdaj: findTableReservationConflict preveri prekrivanje
  intervalov [start, start+duration) ∩ obstoječa DEJAVNA rezervacija
  (confirmed/seated/completed zavirajo — usklajeno z UI; cancelled/no_show
  ne) ZNOTRAJ transakcije pod zaklepom lockReservationCapacity (UPSERT na
  Counter, vzorec javnega widgeta v1.158.0 — serializira interni + javni
  POST na lokaciji). 409 nosi ime gosta in termin ("Miza 12 ima v tem času
  rezervacijo: Ana, 19:00–21:00.") — natakar vidi, KDO drži mizo, ne samo
  da je "zasedena". P2002 ostaja zadnja obramba za identičen žig.
- **B · assertTableClaimable** (src/lib/table-claim.ts, NOVA čista lib):
  skupni varovalec zasedenosti mize s tremi plastmi — fizična
  (Table.status occupied), rezervacijska (DEJAVNA rezervacija, ki se
  prekriva z oknom zahteve [at, at+durationMin)) in pripadnost (lokacija).
  Okno = standardni obrat mize (CLAIM_WINDOW_MIN = 120, isti vir kot
  PUBLIC_RESERVATION_DURATION_MIN): gost, ki danes seda, drži mizo eno jed
  — rezervacija, ki se začne znotraj tega okna, je konflikt.
  excludeReservationId izključi lastno (SEATED na lastni rezervaciji,
  usaditev waitlist vnosa, povezanega z rezervacijo).
- **C · usaditev čakalne vrste ne povozita rezervacije** (PATCH
  /api/waitlist → seated): prej je bil pogoj SAMO Table.status ===
  'occupied' — miza z rezervacijo, ki se začne čez 30 min, je bila
  "prosta". Zdaj: claim preverba ZNOTRAJ transakcije + lockReservationCapacity
  (nova rezervacija ne more "prileteti" med preverbo in zaklepom) +
  excludeReservationId za WaitlistEntry.reservationId.
- **D · prehodi rezervacij upravljajo mizo** (PATCH /api/reservations):
  SEATED z mizo jo zaklene (pogojno, v isti transakciji kot sprememba
  statusa — vzorec usaditve) + actualArrival se izpolni ob prvem usajanju
  (semantika modela, prej nikoli nezapolnjena). NO_SHOW/CANCELLED/
  COMPLETED varno sprostijo: 'reserved' → 'available' vedno; 'occupied'
  LE brez aktivnega naročila in brez novejše usaditve čakalne vrste (ista
  varovala kot releaseTable v1.162.0 — ne rušimo tujega gosta). Prej noben
  terminalni status ni sprostil ničesar — miza je ostala "rezervirana"
  za vedno. Reviziji: RESERVATION_SEATED_TABLE_LOCKED,
  RESERVATION_TABLE_RELEASED.
- **E · tables PATCH varovalec ročne zasedbe**: prehod na 'occupied' prek
  te rute (ročno) ne sme TIHO povoziti mize z dejavno rezervacijo v oknu —
  409 z overrideRequired: true in razlago; izrecen preglas (force: true,
  vzorec allowOutsideHours) + revizija TABLE_OCCUPIED_OVERRIDE. Natakarjeva
  PRAVILNA pot za gosta z rezervacijo je gumb Usajeno na rezervaciji;
  ročni 'occupied' je izredno popravljanje stanja. Prehod occupied →
  occupied je idempotenten no-op in gre čez brez varovalca.

0 DDL, 0 odvisnosti, 0 novih i18n ključev (sporočila so strežniška SL).
Testi: tests/v240-reservation-cell.test.ts (27: A1–A6 overlap, B1–B7
claim enota, C1–C3 waitlist seat, D1–D6 prehodi, E1–E4 tables PATCH,
Ž1–Ž3 registri). Industrijska referenca: OpenTable (vodilni) drži mizo
kot vir resnice — vsi prehodi (rezervacija, usaditev, ročni popravki)
potekajo SKOZI eno tabelo zasedenosti; Toast "table status" ločuje
fizično stanje od rezervacijskega okna. Ta val prinaša isto disciplino:
en varovalec, trije klicatelji, ena resnica.

**Sklep §16 G:** miza ni tabelica s statusom — je vir, ki ga delijo
rezervacije, čakalna vrsta in naročila. Vsak, ki hoče mizo "zasedeti",
gre čez isti varovalec; vsak, ki jo izpusti, to stori varno (brez rušenja
tujega gosta) in revidirano.

### H) QR PUSH + AVTO-POŽIG v1.241.0 (točka 3 iz §16 E)

Najdba §16 E: QR/kiosk naročilo gosta je pristalo TIHO — in ostalo tiho.
ORDER_NEW push (ki ga POS ruta pošilja od OPS-7) javna pot NI; postajne
deske naročila NISO videle (StationTask nastane šele ob požigu); firedAt
je ostal null (ETA/starost statistika na postajni deski je lagala). In
najhuje: tablica — gumb obljublja »Pošlji v pripravo« (tlb.send),
implementacija pa postavk ni nikoli poslala v pripravo; naročila so
visela v pending, dokler natakar ni ročno poslal iz dashboarda.

- **A · SKUPNI HELPER fireOrderCore** (src/lib/order-fire.ts, NOVA čista
  lib): poslovno jedro požiga je dobesedno izpeljano iz fire rute (P2
  audit §57) — ista transakcija, ista varovala, ista idempotenca — samo
  brez HTTP plasti. Avtorizacija in tenant obseg sta odgovornost
  klicatelja (javna pot reši lokacijo strežniško iz žetona; POS pot ima
  requireUserLocation/assertOrgScope; fire ruta guardResource). Pravila
  nespremenjena: terminalno → 409, hold → 409 (OSS-4), CAS prevzem
  firedAt (ORDER_MUTABLE_STATUS) → dirka hold↔fire 409 + rollback,
  zajem postavk PRED updateMany (posnetek za StationTask usmerjanje,
  issue #14), courseId (OPS-7 coursing), revizija + dogodek OrderFired.
  POPRAVEK hkrati: OrderError iz transakcije (tečaj brez pending
  postavk) je v stari ruti ušel kot 500 — napake helperja zdaj nosijo
  HTTP status (FireOrderError), ruta jih preslika.
- **B · javna pot (POST /api/public/orders)**: ORDER_NEW push osebju ob
  novem naročilu (isti vzorec kot POS + javni portal — fail-soft matrica,
  base tarče bar/kitchen/chef) + AVTO-POŽIG: gost pri QR mizi s pošiljanjem
  košarice že izrazi »daj v pripravo«. Toast/Square: self-order kanal gre
  naravnost v kuhinjo. NEGLEJ replaya (helper je idempotenten — pokrije
  retry po fail-soft odpovedi); FAIL-SOFT: naročilo obstaja, pending je
  varno stanje — napaka požiga ne sme porušiti gostovega odgovora.
  Odgovor gostu nosi fired: boolean.
- **C · POS autoFire zastavica (POST /api/orders)**: eksplicitna
  zastavica klicatelja — tablica submitCreate jo pošlje (gumb končno drži
  obljubo), dashboard/handheld je NE (coursing kontrola ostane pri
  natakarju). Isti dovoljenji kontekst kot ročni fire (orders.create) —
  ni novih pravic. Odgovor vsebuje firedCount, order je svež PO požigu.
- **D · offline vrsta**: tablica brez mreže → order.create op z autoFire →
  sync applyOp požge PO createOrderCore (koren, brez gnezdenja TX).
  FAIL-SOFT: operacija je aplicirana, napaka požiga ne sme označiti sync
  operacije 'failed' in sprožiti replay dvojnika.
- **E · ročna pot nespremenjena**: fire ruta je refaktorirana na helper
  (isto vedenje, ORDER_FIRE push ostane v ruti — avto-fire ga namenoma
  izpusti, ker je ORDER_NEW push ravno odšel za isto naročilo).

0 DDL, 0 odvisnosti, 0 novih i18n ključev (3860 — tlb.send že obstaja!).
Testi: tests/v241-qr-autofire.test.ts (21: A1–A6 helper enota, B1–B5
javna QR/kiosk pot, C1–C3 POS autoFire, D1–D2 offline vrsta, E1–E2 ročna
pot, Ž1–Ž3 registri). Industrijska referenca: Toast/Square self-order
kanal (QR/kiosk) gre naravnost v kuhinjo brez posrednega koraka; ročni
vir (natakar) obdrži coursing kontrolo. Pravilo vodilnih: EN požig na
naročilo, ENA resnica o tem, kdaj je naročilo šlo v pripravo (firedAt),
NE glede na to, kdo ga je poslal.

**Sklep §16 H:** požig ni korak, ki si ga lasti natakar — je ODGOVOR na
izražen namen naročnika. Gost pri QR mizi je namen izrazil s pošiljanjem
košarice; natakar v tablici s pritiskom gumba; samo dashboard/handheld
natakarja lahko namen še odloži (coursing, hold). En helper, štirje
klicatelji, ena resnica o firedAt.

### I) ZALOŽNI VAL v1.242.0 — zaloga ima eno resnico (zadnja točka §16 E)

Zadnja nerazvrščena točka raziskave §16 E (P1): EAN unikat per lokacija,
receptura brez lokacijske varovala, serije pri odpadu/inventuri, varianca
inventure proti neto gibanjem, pour cost pokritost. Pet vrzeli — vsaka
primerjana z vodilnimi (Marketman/Toast inventory discipline).

- **A · EAN UNIKAT PER LOKACIJA** (inventory route): duplikat kode
  dobavitelja se je preverjal GLOBALNO — sestrska lokacija ni smela vpisati
  kode, ki jo že ima druga lokacija ISTEGA Dobavitelja za ISTI fizični
  artikel. Zdaj: resolveEanForWrite prejme locationId — duplikat znotraj
  lokacije artikla (POST: tenant-preverjena lokacija; PATCH: item.locationId;
  null lokacija = svoj obseg, konsistentno locationScope). Ista koda na dveh
  lokacijah je dovoljena — skener pri prevzemu vedno pade v kontekst prejema.
- **B · RECEPTURA LOKACIJSKA VAROVALA** (recipes POST): receptura jedi je
  vezana na lokacijo (MenuItem → Category → Menu), njene sestavine pa so
  fizična zaloga TE lokacije — razknjižba ob prodaji (deductStockForOrderTx)
  odšteje TOČNO referencirane vrstice. Prej je lahko receptura Ljubljanske
  jedi vsebovala Mariborski artikel: prodaja v Ljubljani je odštevala
  Mariborsko zalogo, strošek jedi je računal po tuji ceni, tuj org pa je
  dobil referenco na svoj artikel. Zdaj: tuja lokacija → 409 z imeni
  sestavin; legacy artikli brez lokacije (null) ostanejo dovoljeni. GET
  dobi locationMismatch zastavico per vrstica (obstoječe vrstice so vidne,
  ne izginejo tiho).
- **C · SERIJE PRI ODPADU** (waste + NOVA lib src/lib/batch-allocate.ts):
  FEFO razporeditev po serijah je živela SAMO v prodajni poti — odpad je
  odšteval agregat, serije so ostajale stale: quantityRemaining je kazal
  fantomsko zalogo, FEFO je rezerviral serije, ki jih fizično ni več,
  sledljivost lot-a pa je imela luknjo natanko pri odpadu (pokvarjena
  pošiljka — tam, kjer je HACCP sledljivost najpomembnejša). Zdaj: NOV
  skupni motor allocateBatchesTx (FEFO ali izrecna serija — cela količina
  iz ene lot-a ali jasna napaka 404/409; CAS dekrement po seriji z retry,
  EXHAUSTED flip, pre-DDL degradacija) + writeBatchAllocations (FK-varni
  vrstni red) + restoreBatchAllocations. Waste POST: neobvezni batchId
  (odpoklic/karantena zahtevata vedenje, iz katerega lot-a je blago šlo);
  brez njega FEFO; untracked ostanek IZRECNO v note (vrzel vidna — vzorec
  Issue #52). Reverzija vrača ISTIM serijam ISTE količine (EXHAUSTED→ACTIVE
  ko lot spet zaživi; blokirani loti obdržijo status — vračilo ne
  razveljavlja zadržanja). GET odpada nosi allocations z lot številkami.
  Prodajna pot NI dotaknjena (bit-za-bit preizkušena).
- **D · INVENTURA — VARIANCA PROTI NETO GIBANJEM + REBALANCA SERIJ**
  (stocktakes approve + [id]): (1) prej je bila varianceQuantity = counted −
  expected, kjer je expected = snapshot ob odprtju — popis, odprt ob 8:00 in
  odobren ob 14:00, je vsa gibanja med tem (prodaja, prejemi, odpad) štel
  kot »manjko« števca. Zdaj: pre-pass znotraj TX sešteje neto gibanja od
  odprtja (PRED zapisom lastnih popravkov); varianceQuantity := counted −
  (expected + neto gibanja) — NEPOJASNJENA razlika, ne časovna posledica
  (Marketman/Toast inventory variance semantika). Odgovor nosi per-vrstični
  dokaz; [id] GET izračuna še varianceVsSnapshotQty (oba števca shranjena).
  (2) inventurni popravek je nastavil SAMO agregat — serije so ostale
  stale. Zdaj: manjko se odstrani iz uporabnih lot-ov FEFO (alokacije
  vezane na STOCKTAKE tx — serijski ledger ne obljublja zaloge, ki je ni);
  presežek ne ustvarja fantomskih serij; blokirane serije se ne tikajo
  (hold/release je izrecna odločitev). [id] GET: vrstice nosijo batches
  (lot, rok, ostanek) — kontekst števca.
- **E · POUR COST POKRITOST** (food-cost): teoretični food cost je zanesljiv
  natanko toliko, kolikor receptur dejansko obstaja — poročilo je vedelo
  ŠTETI jedi brez recepture, ne pa povedati, kolikšen delež PRODAJE je
  pokrit. Zdaj: kpi.recipeCoveragePct + coveredSalesValue/uncoveredSalesValue
  (vrednostni delež neto prodaje jedi Z recepturo; Toast »recipe coverage«
  kartica — pokritost < ~90 % pomeni podcenjen teoretični food cost),
  dataQuality.soldWithoutRecipeRevenue, CSV vrstica. Ni prodaje → null.

0 DDL (vse v aplikačni plasti + obstoječi ledger StockBatchAllocation), 0
odvisnosti, 0 novih i18n ključev (3860 — sporočila so strežniška SL).
Testi: tests/v242-zalozni-val.test.ts (A1–A4 EAN, B1–B4 receptura,
C1–C6 odpad serije, D1–D6 inventura, E1–E3 pokritost, Ž1–Ž3 registri).
Industrijska referenca: Marketman/Toast — inventura je trenutek resnice:
števci štejejo agregat, sistem primerja proti teoretičnemu stanju
(snapshot + dokumentirana gibanja), razlika je odgovornost upravljavca;
serije (lot tracking) so vezane na VSAKO gibanje zaloge, ne samo prodajo.

**Sklep §16 I:** zaloga ima dve plasti (agregat za odločanje, serije za
sledljivost) in eno resnico — vsaka pot, ki odšteje ali vrne količino
(prodaja, odpad, inventura, reverzija), piše OBE plasti + alokacijski
ledger. Koda dobavitelja je lokalna, receptura je lokalna, inventurna
variansa je nepojasnjena razlika — in zanesljivost food-costa je izrecna
metrika (pokritost), ne skrita predpostavka.

## 17. Raziskava november 2026 — POVRAČILNA CELICA v1.243.0 (instrumenti ob stornu)

Nadaljevanje računske celice (§16). Spomnitveno pravilo v16 B je bilo
»refund negira VSAK del plačila po izvirnem načinu« — implementacija je
negirala RAČUNOVODSKI sloj (zrcalne Payment vrstice: bazen napitnin,
Z-poročilo, izvoz), a denar ob plačilu ni živel SAMO v računovodstvu:
gost, ki je plačal z darilno kartico, točkami ali kuponom, je ta
sredstva ODVZEL iz instrumenta — storno pa instrumenta ni vrnil.
Pet najdb, vse izmerjene v kodi (ne ugibanje):

### A) Darilna kartica ob stornu (P1)

**Kako imajo najboljši (Toast/Square):** refund vrača sredstva na
IZVIRNI instrument — del plačila z darilno kartico se ob povračilu
vrne NA KARTICO (ne v gotovino, ne v nič); kartica je družina tenderjev,
ki nosi svoj saldo.

**Kako ima RestaurantOS (v1.242.0):** unovčenje ob plačilu je odbilo
saldo kartice (centno-natančni CAS v transakciji izdaje +
GiftCardTransaction type='redeem', podpisan −), storno pa je negiral
SAMO Payment vrstico — saldo kartice je ostal odbit za vedno. Gost, ki
je vrnil blago, je IZGUBIL vrednost na kartici (računovodstvo kaže
neto 0, instrument pa je laže prazen). Popravek: storno v ISTI
transakciji povrne saldo (isti centno-natančni CAS vzorec kot odjem —
 branje svežega salda, enakostni pogoj, zapis) + GiftCardTransaction
type='refund' (pozitiven predznak po konvenciji gcTxSign — prvi pisec
tega tipa; ledžer invarianta »vsota podpisanih zneskov = saldo« ostane).
Izbrisana kartica (FK SetNull na Payment) → fail-open z iskreno opombo
v reviziji (računovodski sloj je kljub temu pravilen; ročni popravek
vodstva) — tiho tišina NI možna.

### B) Unovčene točke zvestobe ob stornu (P1)

**Kako imajo najboljši (Toast loyalty):** refund vrača unovčene točke
na račun gosta — točke so denar gosta, ne prihodek gostilne.

**Kako ima RestaurantOS (v1.242.0):** odjem je znižal pointsBalance
(CAS `pointsBalance >= redeemPoints`) + zrcalno vrstico
LoyaltyTransaction type='redeem' (points −), storno točk NI vrnil —
plačilo s točkami je bilo nepovratno tudi ob popolnem povračilu.
Popravek: povračilo pointsBalance (atomarni increment) + zrcalna
vrstica (points +, monetaryValue negirana — vsota para = 0);
lifetimePoints se NE vrača, ker ga odjem ni dotaknil.

### C) Zaslužene točke ob stornu (P1)

**Kako imajo najboljši (Toast/Square):** točke se zaslužijo za
PREVZETO blago — refund zaslužek negira (točke za vrnjeno blago so dolg,
ki se pokrije z naslednjimi obiski; saldo lahko pade pod 0).

**Kako ima RestaurantOS (v1.242.0):** earn ob plačilu je povečal
pointsBalance + lifetimePoints + tier (tierForPoints), storno zaslužka
NI negiral — gost je obdržal točke za VRNJENO blago (inflacija točk:
zloraba »kupi → točke → vrni« je bila dobičkonosna). Popravek: negacija
vseh treh (balance, lifetime, tier na novem doživetju) + zrcalna
negativna vrstica earn. Saldo lahko pade NEGATIVNO — unovčenje blokira
pogoj `pointsBalance >= redeemPoints`, standard praksa. Ročne
prilagoditve (vrstice brez checkId) niso dotaknjene — negacija ve SAMO
zaslužek plačila.

### D) Kupon ob stornu (P1)

**Kako imajo najboljši (Toast):** promo koda, porabljena na računu,
ki je bil refundiran, se vrne gostu (re-issue) — popust, ki ni bil
izkoriščen, pripada gostu naprej.

**Kako ima RestaurantOS (v1.242.0):** odkup kupona je status
'redeemed' za vedno (order veže, orderId zapisan) — ob polnem povračilu
naročila je kupon ostal porabljen, čeprav popusta gost nikoli ni
izkoristil (blago se je vrnilo). Popravek: ob POLNEM povračilu
(naročilo nima več ŽIVEGA originalnega računa — brat račun, ki je bil
že storniran sam, NI živ; in ni odprtih izstavkov) se kupon vrne v
'issued' (redeemedAt/orderId čiščenje — kupon je prost za naslednje
naročilo; opomba nosi številko storna). Delni storno (živi bratje /
odprti izstavki) kupona NE vrača — preostali računi še nosijo vrednost
popusta. Register/adhoc popust se NE vrača (dokumentirana odločitev
#45 — kvota je porabila svojo izdajo; kupon je gostova lastnina,
register je promocija gostilne). Revizija COUPON_REISSUED ločeno od
RECEIPT_STORNO (pregledna sled po instrumentu).

### E) Sledljivost zrcalnih Payment vrstic (P2)

Zrcalne negacijske vrstice so bile brez identifikacije instrumenta
(giftCardId / loyaltyAccountId / loyaltyPointsUsed) — vrstica
»−10 € giftcard« ni povedala, KATERO kartico je povrnila (št. kartice
se je dalo izpeljati le še iz originala). Popravek: zrcalo nosi
identifikacijo instrumenta (zneski ostanejo negirani; loyaltyPointsUsed
je count tega dela plačila, kot na originalu).

0 DDL · 0 odvisnosti · 0 novih i18n ključev (sporočila so strežniška
slovenščina, ne ključi). Testi: tests/v243-povracilna-celica.test.ts
(A1–A4 darilna kartica, B1–B2 unovčene točke, C1–C3 zaslužene točke,
D1–D4 kupon, E1 sledljivost, Ž1–Ž4 registri). Industrijska referenca:
Toast/Square refunds — »refund returns funds to the original tender«;
točke in kuponi so pri njih denar gosta z lastnim ledžerjem, ne le
oznaka na računu.

**Sklep §17:** povračilo ima DVA sloja — računovodstvo (Payment
vrstice, napitnine, Z-poročilo; to je naredila že §16 B) in VREDNOST
(sredstva, ki so ob plačilu prešla iz instrumenta gosta na gostilno).
Vsak instrument, ki je bil ob plačilu OBREMENJEN (kartica, točke,
kupon), mora biti ob povračilu RAZBREMENJEN — v isti transakciji, z
zrcalno vrstico v svojem ledžerju in z revizijo. Vrnjeno blago ne
zasluži točk; porabljen kupon ob povračilu ni porabljen; kartica brez
povračila je lažno prazna. Instrument, ki ga ni mogoče povrniti
(izbrisan), pade na iskreno opombo — nikoli na tiho tišino.

## 18. Raziskava november 2026 — RITEM VAL v1.244.0 (pacing, tloris, KDS zaklep)

Metoda: sveža raziskava objav vodilnih — Toast Spring Release 2026 in
Fall Release 2026 (pos.toasttab.com/innovation-hub) + Lightspeed
Restaurant (K-Series) »What's new« marec/april/november 2026 — z
vsako trditvijo izmerjeno v lastni kodi (ne ugibanje). Štiri ugotovitve:
ena P1 (kapaciteta) + tri P2 (vidljivost/varnost). 0 DDL (konfiguracija
v Integration vrstici, vzorec auto86 v1.230.0 — a PER LOKACIJA).

### A) Ritem prihodov — interna pot brez kapacitetnega varovala (P1)

**Kako imajo najboljši (Lightspeed, april 2026):** Tempo — servisni
pacing dashboard; »Arrival Pacing« — »Max guests arriving within 30
minutes« + omejitve veljajo SAMO online ALI tudi na internih POS/Back
Office rezervacijah. Toast table management ima pacing kontrole od
zmeraj. Kuhinja ima konično propustnost — sistem, ki dovoli naskok
(5× party of 8 v istem polurnem oknu prek telefona), jo preobremeni.

**Kako je bilo pri nas (v1.243.0, izmerjeno):** javni widget ima STROGO
terminsko politiko (maxCoversPerSlot na mreži slotMinutes + leadMinutes
+ maxAdvanceDays — v1.110.0), interna pot (POST /api/reservations —
telefon/walk-in iz dashboarda) pa je šla čez ODPIRALNI ČAS + zasedenost
mize (§16 G v1.240.0) — nikoli čez število gostov na časovno okno.
Telefonska rezervacija je lahko povzročila naskok, ki ga widget ne bi
pustil.

**Popravek v1.244.0:** skupni strežniški varovalec
`src/lib/reservation-pacing.ts` — assertArrivalPacing: fiksna okna
(epoch mreža, privzeto 30 min), štejejo se confirmed+seated z dateTime
ZNOTRAJ okna (isti statusna množica kot activeReservationsFor), preverjeno
ZNOTRAJ transakcije pod zaklepom lockReservationCapacity (serializacija
interni + javni POST — isti vzorec kot findTableReservationConflict).
Konfiguracija: Integration vrstica `resv-pacing-config` per lokacija
({ enabled, windowMin 10–120, maxGuests 1–500 }) — brez vrstice =
IZKLOP (obstoječe lokacije nespremenjene). Interna pot: 409
ARRIVAL_PACING { overrideRequired, currentGuests, maxGuests, okno } →
UI ponudi izrecen preglas (confirm → forcePacing — isti potek kot
OUTSIDE_OPENING_HOURS) → revizija RESERVATION_PACING_OVERRIDE. Javna
pot: enak varovalec, brez preglasa (gost izbere drug termin).
GET/PUT /api/reservations/pacing (reservations.manage + orgScope) +
revizija RESERVATION_PACING_CONFIG; nastavitvena kartica v zavihku
Nastavitve (ReservationPacingCard).

### B) Pričakovani gostje čez dan (P2)

**Kako imajo najboljši (Lightspeed, april 2026):** »start each shift
with a clear overview of expected covers to support better planning and
preparation« — dnevni povzetek pričakovanih gostov za načrtovanje.

**Kako je bilo pri nas:** zavihek Rezervacije je pokazal SAMO seznam
(kartice po gostih) — skupnega povzetka pokritosti po urah ni bilo;
kuhinja/oddaja nista videla naskoka, preden se je zgodil.

**Popravek:** čista agregacija coversByWindow (ista 30-min mreža kot
varovalo — ena resnica o »oknu prihodov«) nad že naloženimi
rezervacijami (CONFIRMED+SEATED izbranega dne) → kartica
»Pričakovani gosti« nad seznamom: skupaj gostov + rezervacij + poližki
po oknih (12:00 · 8×). Iskreno prazno stanje (resv.coversEmpty).

### C) Tloris — strežniška značka na mizi (P2)

**Kako imajo najboljši (Lightspeed, november 2026):** moderniziran
tloris z »server ownership badges« in živimi metrikami (status, covers,
seated times) — ekipa vidi, ČIGAVA je miza.

**Kako je bilo pri nas (v1.243.0):** ploščica mize (mreža) je že nosila
znesek, št. naročila, goste in ⏱ trajanje (v1.129) — a NE natakarja;
tloris (plan) pa samo številko + znesek. Naročilo VE nosi employeeId,
ploščica pa ga ni nikoli pokazala.

**Popravek:** GET /api/tables razširi include z relacijo natakarja;
mapTable.activeOrder dobi aditivni waiterName + openedAt. Mrežna
ploščica: vrstica 👤 ime natakarja (title z aria); tloris: znak z
inicialkama (AN) na obliki mize. Prazno ime (naročilo brez natakarja)
→ iskreno nič, ne »?«.

### D) KDS zaklep zaslona — view-only (P2)

**Kako imajo najboljši (Lightspeed, november 2026):** »Lock prep
station displays to avoid accidental bumps« — view-only preklop na
kuhinjski postaji; bump ostane expediterju.

**Kako je bilo pri nas:** vsak dotik KDS vrstice je pomenil napredek
(priprava/pripravljeno) — pomotičen bum piha v smeri strežnika (isto
pot kot namerni). Plošča postaje je bila vedno aktivna.

**Popravek:** preklop »Zaklep zaslona« v glavi KDS (ro_kds_view_only,
per naprava — localStorage, privzeto izklopljen): vrstice postanejo
NEDEJAVNE (render inert), gumb izdaje onemogočen, jantarna značka
»Samo ogled« na plošči postaje. Čisto prezentacijska plast — strežnik
ostaja avtoritativa (PATCH /api/kitchen pot je nespremenjena; to je
zaščita pred pomotami, ne pred zlorabo).

0 DDL · 0 odvisnosti · 17 novih i18n ključev v vsakem slovarju
(3860 → 3877; resv.pacing* + resv.covers* + kds.viewOnly* +
tables.seatedFor/waiterAria — pariteta SL/HR ohranjena). Testi:
tests/v244-ritem-val.test.ts (A1–A10 konfiguracija + interna pot,
B1–B2 javna pot, C1 tloris značka, D1–D3 čiste funkcije, Ž1–Ž5
registri). Industrijska referenca: Lightspeed Tempo/Arrival Pacing
(april 2026), Lightspeed »Lock prep station displays« + »server
ownership badges« (november 2026), Toast table management pacing.

**Sklep §18:** rezervacija ni samo zasedenost mize — je PRETOK gostov
skozi kuhinjo. Ta pretok ima tri plasti vidljivosti: varovalo (koliko
gostov sme priti na okno — preglasi le vodja z revizijo), povzetek
(koliko jih pride — pred smeno) in tloris (čigava je miza — med
obratom). Četrta plast je varnost produkcije: zaslon, ki ne more
pomotično izdati jedi. Naslednji val po načrtu: sveža raziskava ali
P2 ostanki (kombinacije miz za velike družbe — Lightspeed november
2026; digitalni checklisti — Lightspeed Tasks marec 2026).

## 19. Raziskava november 2026 — KOMBINACIJSKI VAL v1.245.0 (velike družbe + walk-in rezerva)

Nadaljevanje §18 (»naslednji val: kombinacije miz — Lightspeed november
2026«). Vir: Lightspeed »What's New: November 2026« — »Optimize dining room
capacity and seat larger groups effortlessly«: »Automatic table combinations
let you seamlessly welcome larger parties« + »choose specific bookable
tables to preserve space for walk-ins during busy shifts«. Toast/OpenTable
imata table joining že leta. Dve ugotovitvi, izmerjeni v kodi.

### A) Družba, večja od največje mize — brez odgovora (P1)

**Kako imajo najboljši:** Lightspeed — pod »Table combinations« se
definirajo mize, ki se rezervirajo SKUPAJ; gost/osebje dobi enotno
»Miza 5+6«. Toast — table joining na tlorisu; OpenTable — kombinirane
mize kot prvorazredni objekt pri dodelitvi.

**Kako je bilo pri nas (v1.244.0, izmerjeno):** največja miza 6 sedežev →
autoAssignTable za 8 oseb vrne »Ni prostih miz za 8 oseb«; dialog ponudi
samo enojne mize; telefonski odgovor je bil »nimate mize za 10«. Rezervacija
je nosila EN tableId (FK) — kombinacije ni bilo KAM zapisati, niti
varovala, ki bi blokirala več miz hkrati.

**Popravek v1.245.0:** trije sloji:
1. **Registr** (0 DDL): Integration vrstica `table-combos-config` per
   lokacija — [{ id, tableIds }] (2–5 miz); kartica v Nastavitvah
   (ReservationCombosCard, settings.manage); GET/PUT /api/tables/combos z
   validacijo (ista lokacija, ≤ 20 kombinacij) + revizijo
   TABLE_COMBOS_CONFIG. Zamujene kombinacije (izbrisana miza) se pri
   branju tiho izpustijo — self-healing.
2. **Nosilec** (1 aditivni DDL po dokumentirani poti mig konzole — vzorec
   receipt-snapshot v1.239.1): `Reservation.comboTableIds`
   ',id1,id2,' (VSE mize vključno s primarno; prazno = enostavna —
   obstoječe vrstice nespremenjene). Vroča pot: Prisma bere stolpec pri
   vsakem branju Reservation → korak apliciramo takoj po deployu.
3. **Guardi**: findTableReservationConflict dobi
   `OR [{ tableId }, { comboTableIds contains ',id,' }]` — miza je
   zasedena tudi kot ČLANICA. assertTableClaimable podeduje (usaditev
   čakalne vrste + tables PATCH avtomatično spoštujeta kombinacije).
   POST preveri konflikt PER ČLANICA pod lockReservationCapacity;
   SEATED zaklene VSE članice; CANCELLED/NO_SHOW/COMPLETED varno sprosti
   VSE (occupied LE brez aktivnega naročila — ne rušimo tujega gosta).

**UI:** dialog Nova rezervacija ponudi 🔗 kombinacije (vrednost
'combo:<id>' → tableIds ob oddaji); autoAssignTable teče skozi čisti
seatCandidatesForParty (družba 8 → Miza 5+6, če je to najmanjše ujemanje);
kartica rezervacije nosi 🔗 Mize 5+6; tloris overlay prihajajoče
rezervacije na VSEH članicah.

### B) Spletna kapaciteta = fizična (walk-in brez rezerve) (P2)

**Kako imajo najboljši (Lightspeed, november 2026):** »choose specific
bookable tables to preserve space for walk-ins during busy shifts« —
deli fizičnih mest ostanejo izven spletnih rezervacij.

**Kako je bilo pri nas:** publicSlotsForDate je štela VSE mize
(tableSeatsFor = aggregate celotne lokacije) — gostje na spletu so lahko
zasedli vsako mizo; ob polni knjigi ni bilo nič za walk-in.

**Popravek:** Integration vrstica `resv-bookable-config`
{ excludedTableIds } per lokacija (isti vzorec kot pacing/kombinacije —
0 DDL); onlineSeatsFor = fizični MINUS izključene — plošča terminov IN
javni POST štejeta samo rezervabilne. Interna telefonska pot NI omejena
(samo spletna plast — Lightspeed ponuja oba obsega, »online only« je
varnejši privzetek). Kartica: jantarni checkboxi per miza
(TABLE_BOOKABLE_CONFIG revizija).

DDL: 1 aditivni stolpec (Reservation.comboTableIds) prek mig konzole —
admin ruta /api/admin/migrate-reservation-combo + KNOWN_DRIFTS
reservation-combo (strogo enosmernen ADD matcher). 0 odvisnosti · 12 novih
i18n ključev v vsakem slovarju (3877 → 3889; pariteta SL/HR). Testi:
tests/v245-kombinacijski-val.test.ts (A1–A12 kombinacije end-to-end,
B1–B2 walk-in rezerva, Ž1–Ž6 registri vključno drift matcher).

**Sklep §19:** miza ni več meja družbe — registrirana kombinacija (5+6)
je rezervabilna kot enota, blokira vse članice v vseh treh varovalih
(POST, čakalna vrsta, ročna zasedba), se ob prihodu zaklene in ob odhodu
sprosti CELA. Spletna kapaciteta pa spoštuje walk-in rezervo: gostje
vidijo terminove zmogljivosti, ne fizičnih mest. Naslednji val: digitalni
checklisti (Lightspeed Tasks marec 2026), saved report views (april 2026)
ali sveža raziskava.

## 20. Raziskava november 2026 — OPERATIVNI VAL v1.246.0 (digitalni checklisti)

Nadaljevanje §19 (»naslednji val: digitalni checklisti — Lightspeed Tasks
marec 2026«). Vir: Lightspeed »What's New: March 2026« — »Lightspeed Tasks
is the in-built digital task management tool. Replace paper lists with
digital checklists, assign tasks, track progress and see who completed
what—all in one place«; nastavitev »Repeats: Daily, Weekly, Every two
weeks, Every four weeks, Monthly, Every three months, Every six months«;
odzivni tipi »photo, text, count, signature, or temperature«; Toast
(Opening/Closing Checklist FOH/bar/kitchen — papirna predloga brez
sledenja). Dve ugotovitvi, izmerjeni v kodi.

### A) Odpiralni seznam = 15 ločenih HACCP načrtov (P1)

**Kako imajo najboljši (Lightspeed, marec 2026):** en CHECKLIST = N
nalog; osebje odšticka postavko po postavki, sistem si zapiše KDO in
KDAJ (»track progress and see who completed what«), po zadnji postavki
je seznam zaključen. Pogostosti: dnevno / tedensko / vsaka 2 tedna /
vsaka 4 tedna / mesečno / vsaka 3 meseca / vsakih 6 mesecev + startni
datum (»Select the first day you need the checklist to be completed«).

**Kako je bilo pri nas (v1.245.0, izmerjeno):** HaccpPlan je ENA kontrola
(ena meritve ali ena potrditev) — `steps: string[]` so le informativno
besedilo brez odštickanja. Odpiralni seznam s 15 postavkami (luči, POS,
žepnina, rezervacije …) bi zahteval 15 načrtov, vsakega posebej izvedenega;
kategorije so živilsko-varnostne (temperature/cleaning/delivery/cooling/
training) — »zakleni vhodna vrata« vanje ne sodi; pogostosti so samo
daily/weekly/monthly brez startnega datuma. Papirna alternativa: list ob
šanku, ki ga nihče ne arhivira.

**Popravek v1.246.0:** trije sloji (vzorec §19):
1. **Registr predlog** (0 DDL): Integration vrstica `ops-checklists-config`
   per lokacija — [{ id, name, category (opening/closing/cleaning/
   maintenance/security/other), repeat (daily/weekly/biweekly/every4weeks/
   monthly/quarterly/semiannual), weekday, monthDay, anchorDate (prvi dan
   obveznosti + faza za večtedenske), dueTime, active, items: [{ id, label,
   response (check|count|text) }] }]. Kartica z urejevalnikom v zavihku
   Opravila (settings.manage); GET/PUT /api/checklists/templates z
   validacijo + Issue #96 fallback + revizijo CHECKLIST_TEMPLATES_CONFIG.
2. **Nosilec izvedb** (1 aditivni DDL po dokumentirani poti mig konzole):
   nova tabela `ChecklistRun` — ena vrstica na pojavitev (occurrenceKey
   `${templateId}|YYYY-MM-DD`, @@unique [locationId, templateId,
   occurrenceKey]); `itemResults` Json nosi PO POSTAVKI { kind, value,
   at, byId, byName } (Lightspeed »who completed what«); stanje open/
   completed strežnik izpelje iz pokritosti postavk. Posnetek imena
   predloge (templateName) — zgodovina preživi preimenovanje/izbris.
3. **Plošča + motor**: čist lib ops-checklists.ts (0 DB uvozov) — terminski
   motor nadaljuje haccp-ops vzorec (LokalniDatum po pasu lokacije,
   DST-varno), razširjen na biweekly/every4weeks (faza = dnevi od
   anchorDate), quarterly/semiannual (meseci od anchor meseca) in
   anchorDate (brez terminov pred prvim dnem). Plošča terminov: zapadlo /
   v teku / zaključeno (+ delna pokritost n/N), dnevi brez izvedbe so
   vidni kot zapadli (ista poštenost kot HACCP plošča).

**UI:** nov zavihek »Opravila« (skupina Osebje, dostop vsem
avtenticiranim — odpiralni seznam izpolni kdor odpira, ne samo vodstvo):
kartice dnevnih seznamov s progresom, odštickanje postavk (check →
potrditev, count → številka, text → opomba), pod vsako postavko KDO+KDAJ,
zaključeni seznam nosi ime izvajalca; urejevalnik predlog za vodstvo.
Pravice: izvedba = prijava (isti prag kot delovnica), predloge =
settings.manage strežniško.

### B) Odzivni tipi — iskrena meja (P2, zavestno ZUNAJ tega vala)

**Kako imajo najboljši:** Lightspeed odzivni tipi »photo, text, count,
signature, or temperature« — dokaz z videzom.

**Kako je pri nas:** check/count/text pokrije operativno jedro
(odštickaj / preštej / zapiši opombo); temperature je HACCP-jev dom
(meritve s pragi tam ŽE obstajajo — ne podvajamo). Foto podpis bi zahteval
nalaganje datotek (Documents infra tehta BLOB v bazi) — zavestno čaka
lastniško odločitev o shrambi medijev, ne tiho. Revizijska sled: vsak
odziv piše revizijo CHECKLIST_RUN_ITEM (kdo, postavka, vrednost).

DDL: 1 aditivna tabela (ChecklistRun) prek mig konzole — admin ruta
/api/admin/migrate-checklist-runs + KNOWN_DRIFTS checklist-runs (strogo
enosmerner CREATE matcher). 0 odvisnosti · 47 novih i18n ključev v vsakem
slovarju (3889 → 3936; pariteta SL/HR). Testi: tests/v246-operativni-val
.test.ts (A1–A12 predloge+validacija, B1–B10 terminski motor vseh sedmih
pogostosti+anchor, C1–C6 plošča stanj, D1–D6 izvedbe+avtomatski zaključek,
E1–E2 DDL gate, Ž1–Ž6 registri).

**Sklep §20:** papirni odpiralni seznam ob šanku je zamenjan z digitalno
ploščo — predloga z vsako odštickljivo postavko, termin po pasu lokacije,
izvajalec+čas na vsaki postavki, zgodovina pojavitev z zapadlimi dnevi.
HACCP ostane merilni register (pragi, odstopanja, verifikacija), Opravila
pa so operativni dnevni ritem. Naslednji val: saved report views
(Lightspeed april 2026) ali sveža raziskava.

## 21. Raziskava april 2026 — POGLEDI VAL v1.247.0 (shranjeni pogledi poročil)

Nadaljevanje §20 (»naslednji val: saved report views — Lightspeed april
2026«). Vir: Lightspeed »What's New: April 2026« — »saved report views:
customize your reports and save them for quick access«; Toast/Square
ekvivalent: priljubljeni poročilni pogledi v analitiki. Ena izmerjena
ugotovitev, dve odločitvi.

### A) Mesečni izvoz je vsak mesec ISTA ročna naloga (P1)

**Kako imamo mi (merjeno v kodi):** AccountingExportCard zahteva ob vsakem
zagonu ŠTIRI ročne izbire — sekcija (summary/dnevnik/ddv/zz), Od, Do,
format (CSV/JSON). Knjigovodski izvoz vsak 1. v mesecu in tedenski X/Z sta
identični nalogi z istim štirikrožnim ritomom; food-cost varianca (v1.106.0)
vsak teden enako. Odložena datoteka je cilj, ne pot do nje.

**Kako imajo najboljši (Lightspeed, april 2026):** poročilo prilagodiš
enkrat, pogled shraniš z imenom, naslednjič en klik.

**Zdaj (v1.247.0):** kartica »Shranjeni pogledi poročil« na zavihku Računi
(gating reports.sales — kdor sme poganjati izvoz, sme imeti pogled): nov
pogled (ime + poročilo [računovodski izvoz | food-cost varianca] + sekcija +
format + obdobje) → vrstica z zadetkom + obsegom → gumb »Zaženi« prenese
datoteko. Brisanje s potrditvijo; vrstica je Integration registr
(0 DDL — vzorec resv-pacing v1.244.0 / table-combos v1.245.0 /
ops-checklists v1.246.0), GET/PUT /api/reports/views s strogo validacijo
(≤ 20 pogledov, enumi poročila/sekcije/formata/obdobja, custom datumi
from ≤ to) + revizija REPORT_VIEWS_CONFIG.

### B) RELATIVNA obdobja — pogled, ki ne zastara (P1, izpeljano)

Fiksna datuma shranjenega pogleda sta naslednji mesec mrtva (»november«
je decembra neuporaben). Zato pogled nosi PREDLOG obdobja, ki se ob vsakem
zagonu reši SVEŽE iz čistega jedra `resolveReportRange` (lokalni koledar,
NI UTC — zvečer CET bi toISOString zamaknil na včerajšnji dan):
today/yesterday/thisWeek/lastWeek/thisMonth/lastMonth/last7/last30/last90/
ytd + custom (izjema). Semantika poštenosti: tekoči teden/mesec/leto se
končajo z DANES (devet praznih dni v datoteki je laž), zaključena obdobja
(prejšnji teden/mesec, včeraj) pokrijejo celoto; tedni so ISO
(ponedeljek–nedelja, slovenska konvencija); last7/30/90 so vključujoča
okna (danes + 6/29/89). Vsaka vrstica pokazuje DANES rešen obseg
(»Zagon: 2026-11-01 – 2026-11-04«) — uporabnik vidi, kaj bo poteženo,
preden klikne.

### C) SKUPNI registr per lokacija, ne per oseba (P2, zavestna odločitev)

Lightspeedovi pogledi so osebni. Naša lokacija: gostilna z 2–3 poročevalci
si deli delo — ko je Ana na dopustu, poteže Borut isti mesečni izvoz.
Iskrena meja: per-uporabniška lastnina bi zahtevala DDL (Integration nima
zaposlenega); skupna knjižnica je 0 DDL in poštena za ekipo. Pravice
reports.sales (isti lastnik kot /api/reports/export) — zagon poteče klient
prek obstoječih GET rut, zato vsa strežniška varovala (pravice, location
scope) ostanejo nespremenjena.

**Sklep §21:** pogosto poročilo je definirano enkrat, poteženo z enim
klikom, obdobje pa se reši sveže ob vsakem zagonu — datoteka, ki jo
knjigovodja čaka, ni več štirikrožni ritual. Naslednji val: sveža
raziskava (maj/junij 2027 objave) ali globlje rezanje po B-načrtu.

## 22. Raziskava maj/junij 2026 — STREŽNI VAL v1.248.0 (dodelitve, opombe, povzetki opravil)

Viri: Lightspeed »What's New: May 2026 — Faster menu updates, easier
bookings, automatic table assignments« in »What's New: June 2026 — Service
insights, promotions, task summary emails« (k-series-support.lightspeedhq.
com, prebrano 4. 11. 2026). Metodologija nespremenjena: vsako točko najprej
IZMERIMO proti kodi (vzorec §11–§21) — kar že imamo, zapišemo kot imamo;
kar manjka, ocenimo po razredu (A koda / B odločitev / C mreža).

### A) Samodejna dodelitev mize spletnim rezervacijam (P1)

Lightspeed maj 2026: »automatic table assignments that assign a suitable
table to a new online booking based on guest count. On the POS, staff can
simply accept, change or skip the suggestion. There's no setup required.«

Izmerjeno: v1.231.0 je prinesla avtododelitev kot GUMB v internem
rezervacijskem dialogu (autoAssignTable → seatCandidatesForParty — najmanjša
ustrezna miza ali registrirana kombinacija, brez prekrivanja z AKTIVNIMI
rezervacijami). JAVNA pot (/api/public/reservations, widget) pa ustvari
rezervacijo BREZ mize — notes: 'Spletna rezervacija', tableId: null. Vsako
jutro osebje ročno razdeljuje mize spletnim gostom.

Popravek: STREŽNIŠKA dodelitev v javni poti — po zaklepu kapacitete
(lockReservationCapacity) in opravljenih validacijah (termin, kapaciteta,
pacing) isti čisti kandidatni motor izbere mizo: enojne mize + registrirane
kombinacije, sedežev ≥ oseb, najmanjša zmaga, izključene walk-in mize
(resv-bookable-config) ne sodelujejo, prekrivanje štejemo proti vsem
AKTIVNIM rezervacijam dneva (CONFIRMED/SEATED/COMPLETED zavirajo — isti
CLAIM_BLOCKING_STATUSES kot v1.240.0). Nobena miza ne ustreza → rezervacija
ustvarjena BREZ mize (iskrena rezerva — osebje dodeli ročno, kot pri
Lightspeed »skip«); avtododelitev je POMOČ, ne obveza (v1.231 načelo).
Revizija GUEST_RESERVATION_CREATED nosi dodeljeno mizo; dashboard že prikazuje
tableId v rezervacijski vrstici — sprememba/odvzem sta obstoječi interakciji.

### B) Prednastavljene opombe za kuhinjo (P1)

Lightspeed maj 2026 (»preset notes«): »Create reusable notes in the Back Office to save time,
reduce errors and keep kitchen instructions consistent. You can also reorder
notes and choose whether they print on the order ticket, plus staff can still
add ad-hoc notes at POS.«

Izmerjeno: CELA cev obstaja razen vnosa — createOrderCore sprejema
`note` per postavka (OrderItem.notes), KDS listek kaže »ℹ opomba«, postajni
nalogi nosijo opombo v detailu, kuhinjski/bar list tiska »opomba: …«, POS
urejevalnik pokaže opombo pošiljanja. A v košaricah (novo naročilo mize,
hitra prodaja, urejevalnik) NI vnosa opombe — edina pot je bila QR gost
(specialRequests naročila, ne postavke). Registr prednastavljenih opomb ne
obstaja nikjer.

Popravek v dveh plasteh: (1) REGISTR — Integration vrstica
`preset-notes-config` per lokacija (0 DDL, vzorec ops-checklists) z
validacijo (≤ 20 opomb, oznaka ≤ 60, vrstni red, aktiven/streljalna
zastavica ne — enostavno: id/label/sortOrder) + GET/PUT /api/preset-notes
(branje = vsa prijavljena osebja, pisanje = menu.manage — kuhinjska navodila
so domeno upravitelja menija, kot pri Lightspeed Back Office > Menu >
Production instructions) + revizija PRESET_NOTES_CONFIG + kartica v zavihku
Meni poleg Skupin opcij. (2) POS VNOS — skupni dialog po vzorcu variantPick
(mode cart/sale/sheet): čipi prednastavljenih opomb (večizbirno) + prosto
besedilo; sestavljena opomba = izbrane oznake + besedilo, shranjena per
vrstica košarice; ob oddaji gre v items[].note (obstoječa validacija —
dolžina omejena strežniško pri zapisu). ISKRENA MEJA (zavestno preprosteje
kot Lightspeed): ena opomba per vrstica, ki gre VEDNO na KDS in na tisk —
per-note stikalo tiska je Back Office niansa, ki bi zahtevala shranjevanje
zastavice skupaj z besedilom na postavki; naša opomba je ena resnica, ki jo
kuhinja vidi povsod (KDS zaslon + listek), kar je prav tisto, kar
»keep kitchen instructions consistent« zahteva.

### C) Povzetki opravil po e-pošti + končni datumi razporedov (P1)

Lightspeed junij 2026: »Stay on top of operational compliance with new daily
and weekly Tasks summary emails … checklist completion rates by location« in
»Create recurring tasks on a bi-weekly, monthly, quarterly, bi-annual, or
yearly basis, add optional end dates, and preview upcoming due dates.«

Izmerjeno: v1.246.0 je prinesla VSEH sedem pogostosti (daily/weekly/
biweekly/every4weeks/monthly/quarterly/semiannual) + anchorDate — pogostosti
iz junij 2026 objave smo pokrili PRED raziskavo (raziskava marec 2026 je
navajala »daily/weekly/monthly«, junij dodal ostale). MANJKA: (a) končni
datum predloge (sezsonski seznam — »terasa poleti« bi moral nehateti
samodejno), (b) dnevni/tedenski povzetek izpolnjenosti po e-pošti — digest
(v1.206.0) ima sekcije top artiklov/urno/zapadle obveznosti, ne opravil.

Popravek: (a) validUntil na predlogi (datum ključ YYYY-MM-DD; motor
checklistOccurrenceForDate po njem ne vrne termina; urejevalnik + stroga
validacija + defenzivno branje — neveljaven zapis se bere kot null, ne
izpusti predloge); (b) sekcija »Opravila« v dnevnem digestu (aditivna —
absent/empty → brez sekcije, izhod za stare vnose byte-identičen, vzorec
hourlyBuckets v1.206.0): za vsako AKTIVNO predlogo s terminom v dnevu
digesta vrstica » ime — pokritost n/N oz. ZAKLJUČENO«, po lokacijah; (c)
TEDENSKI povzetek (ponedelki — isti cron, lasten reportType TASK_WEEKLY +
ScheduledEmailLog varovalka že_poslano): izpolnjenost po predlogah za
prejšnji ISO teden (pojavitve × zaključki × povprečna pokritost). Prejemniki
= obstoječi SMTP profil digesta (emailReportRecipients cc) — Lightspeedov
izbor prejemnikov per lokacija je nadgradnja, ki bi zahtevala DDL
(EmployeeIntegration želenih prejemnikov); pošteno zapisano kot meja.

### D) Druge točke raziskave maj/junij 2026 (ocena — naslednji valovi)

- **Popravek cene postavke na POS** (junij, P2): »Authorized staff can now
  override an item's price directly on the POS during an active order.«
  Denarna pot — FURS račun nosi ceno, vsak poseg zahteva pravico + revizijo +
  žig na izstavku. Zavestno ODLOŽENO v lastni val (R-numera denarne celice,
  vzorec §15/§16 discipline), ne tiho.
- **Tempo service insights** (junij, P2): »tables with the most empty time
  and orders with the longest service gaps« — deterministična izpeljava iz
  obstoječih podatkov (Order.createdAt→paidAt po mizah); kandidat za
  analitični val.
- **Full Profile Discount** (junij, P2/B): »menu-wide discounts in Order
  Anywhere … percentage discount across an entire menu« — cenovna strategija
  javne površine (mi imamo kupone gostov); odločitev o cenovni politiki je
  lastnikova (B), mehanika pa bi šla čez obstoječi coupons/display-promos.
- **Resend gift card email** (maj, B): pri nas darilna kartica NIMA e-poštne
  dostave (izdaja osebja na pultu) — resend predpostavlja tok, ki ga ni;
  uvajanje e-dostave kartic je ločena (B) odločitev.
- **Reprint orders** (maj, P2): ponatis kuhinjskega/bar lista obstaja
  (buildKitchenTicketLines + printKitchenTicket na postajah); Lightspeedova
  razširitev na ZAPRTA naročila + izbira produkcijskih središč je kandidat
  za KDS val.
- **Reserve with Google** (maj, C-mreža): rezervacije čez Google Search/Maps
  zahtevajo partnerstvo Google Business — zunaj lokalne izvedljivosti
  (enak razred kot OSS-12).
- **Prostobesedilni alergeni** (maj, B-zavestno): naš katalog je uradni EU
  seznam (issue #7 »allergen truth« — kode, ne svobodno besedilo); Lightspeed
  dopušča free-text. Naša rigoroznost je ZAVESTNA odločitev (katalog =
  zavezljiva, strojno berljiva resnica), ne vrzel.
- **KDS zoom listkov** (junij, P3): gostota compact/normal že obstaja
  (ro_kds_density, issue #69); zvezna skala je kozmetika.
- **Order Anywhere Menu Upsells** (maj — ŽE IMAMO): kiosk-upsell (»Dodaj še«)
  pokriva priporočilo top artiklov; Lightspeedov prag 150 naročil/21 dni je
  njihova hevristika za samodejni izbor — naš UpsellCard ima ročni izbor
  (menu.manage), ki je iskrenejši za malo gostilno.

**Sklep §22:** spletna rezervacija prispe z mizo, kuhinja dobi dosledne
opombe iz enega registra, vodja pa zjutraj v pošti vidi, kateri seznami so
zaključeni — trije ročni rituali iz vsakdanjega obrata so odstranjeni, vsi
trije nad obstoječimi motorji (kandidati miz, cev opomb, ChecklistRun),
0 DDL, 0 novih odvisnosti. Naslednji val: cena postavke na POS (denarna
celica nadaljevanje), Tempo insights ali sveža raziskava (julij–november
2026 objave).

## 23. Raziskava maj/junij 2026 — CENOVNI VAL v1.249.0 (sprememba cene postavke na POS)

Odložena točka §22 D, izvedena kot lastni denarni val (disciplina §15/§16:
R-numera denarne celice). Lightspeed junij 2026: »Authorized staff can now
override an item's price directly on the POS during an active order.«

### A) Izmera pred valom

**Kako ima RestaurantOS (v1.248.0):** `OrderItem.price` je ŽE posnetek po
vrstici (zapisan ob nastanku: `MenuItem.price` + doplačila opcij, ops.ts),
račun (Receipt.itemsJson posnetek v1.239.0 §16 C) in `computeBill` bereta
ravno njega — torej cev obstaja, manjka SAMO pooblaščena sprememba cene
neplačane postavke. Doslej: vodja je moral artikel preklicati (void) in
zagnati novega s »pravilno« ceno — dve potezi, dve reviziji, naročilo pa je
izgubilo zveznost (postavka je šla na konec vrste, sedež/tečaj sta padla).
Alternativna pot je bil popust na nivoju naročila — ampak popust je ODMIK od
cenašnika, ne sprememba cene postavke (knjigovodstvo vidi drugačen dokument).

**Kako imajo najboljši (Toast/Square):** override cene je pooblaščena poteza
na odprtem checku — zahteva pravico + razlog, piše se v revizijsko sled in na
račun; plačanega dela checka se ne dotika (refund = fiskalna pot).

### B) Denarna disciplina (vzorec void Issue #5/#39, brez izumiranja)

- **PRAVICA**: nov kanonični ključ `orders.priceOverride` (permissions.ts —
  0 DDL, Json stolpec overrides). Vodstvo (manager/property_manager) ga dobi
  privzeto (isto hierarhijo kot `orders.void`), natakarju ga lastnik podeli
  prek override-a. NE FULL-only: podelitev je lastnikova odločitev
  (gostilna, kjer vodja zaupa natakarjem pri dnevni ceni rib, to želi).
- **RAZLOG OBVEZEN VEDNO** (3–200 znakov, prosta besedila — katalog
  VoidReason je domena preklica): denarni poseg brez utemeljitve ne obstaja.
  Strožje od preklica, kjer je obveznost politika `excRequireReasonVoid`.
- **TABU** (iste 409 kot void v1.239.0 §16 D): plačano/stornirano naročilo;
  postavka na PLAČANEM izstavku delno plačanega naročila (pre-bran +
  race-safe znotraj TX — izdani račun se spreminja samo s fiskalnim stornom);
  preklicana postavka; ista cena (400 — no-op poseg ne smrdi po sledi).
- **DDV v isti transakciji**: cena je končna z DDV (Naloga #6) →
  `vatAmount = vatFromGross(novaCena × qty, stopnja)` se zapiše skupaj s
  ceno; `recalcOrderTotals` bere shranjeni DDV (brez tega bi Order.tax tiha
  zaostal). Totals se zapišejo pod optimistic-concurrency CAS (prejšnji
  subtotal/tax/total v where — sočasen addItems/void/popust → rollback +
  retry ≤ 3).
- **REVIZIJA**: `ORDER_ITEM_PRICE_OVERRIDE` v verigi (writeAudit PO commitu —
  oldPrice/newPrice/delta/qty/razlog/izvajalec + previousOverride, če je bila
  vrstica že preganjena); poročilo finančnih izjem dobi vrsto
  `price_override` (|delta| vrstice — lahko tudi navzgor).
- **ISKRENA MEJA**: prag odobritve NI vključen — `excVoidApprovalAmountCents`
  je specifičen za preklic, nov prag pa bi zahteval stolpec (= DDL, kliki so
  porabljeni). Pooblastilo JE dovoljenje, ki ga podeljuje lastnik.

### C) Oznaka na vrstici + žig na računu (0 DDL)

`OrderItem.modifiersJson` je OD NASTANKA mrtva shramba (ops.ts vedno zapiše
'[]', posnetek opcij živi v OrderItemModifier vrsticah — dokumentirano v
item-variants.ts). Od tega vala nosi METAPODATKE VRSTICE:
`{"priceOverride":{from,to,at,by}}` (ime polja zgodovinsko — preimenovanje
bi bilo DDL; komentar v obeh shemah). Branje je defenzivno
(parsePriceOverrideMeta — neveljavno → null, self-healing), pisanje strogo
(validirana ruta). UI: ✱ na vrstici urejevalnika naročila s tooltipom
(prejšnja cena + kdo). RAČUN: posnetek Receipt.itemsJson ob izdaji nosi
ADITIVNI ključ `priceOverride: {from, to}` samo za preganjene postavke
(nepreganjene vrstice in vsi legacy računi ostanejo byte-identični); branje
/api/furs/[id] ga posreduje naprej (žig POSNETKA — termični tisk cene ne
spreminja: natisnjena cena JE preganjena, sled kdo/zakaj je v reviziji).

### D) UI (NaročiloSheet — isto mesto kot preklic)

Gumb 💰 (Coins) na vrstici obstoječe postavke z ISTIMI tremi varovali kot
preklic (`hasPerm('orders.priceOverride')` + naročilo ni plačano + postavka
ni na plačanem izstavku §16 D) → dialog (trenutna cena readonly, nova cena
inputMode decimal — vejica ALI pika, razlog obvezen) → POST
/api/orders/[id]/price-override → toast »Cena spremenjena: X € → Y €« +
osvežen naročilo. Gumb je videti tudi na naročilih v statusu sent/prepared
(kuhinja že dela — cena je plačilna, ne produkcijska spremenljivka).

**Sklep §23:** cena postavke na POS je zdaj ena pooblaščena poteza z razlogom
— nad istim oklepom kot preklic (pravica, 409 na plačenem, CAS transakcija,
revizija v verigi), z DDV preračunanim v isti transakciji in žigom na
posnetku računa. 0 DDL (mrtva shramba modifiersJson + aditivni ključ v
itemsJson), 0 novih odvisnosti. Naslednji val: Tempo insights (junij P2 —
deterministična izpeljava iz Order.createdAt→paidAt po mizah), sveža
raziskava julij–november 2026 ali B-odločitve lastnika.

## 24. Raziskava november 2026 — TEMPO VAL v1.250.0 (tempo vpogledi: prazni čas miz + servisne luknje)

Odložena točka §22 D in sklep §23 (»naslednji val: Tempo insights —
deterministična izpeljava iz Order.createdAt→paidAt po mizah«). Lightspeed
junij 2026 Tempo »service insights«: »tables with the most empty time and
orders with the longest service gaps« — dve merili, obe čisto bralna, obe
nad ŽE OBSTOJEČIMI časovnimi žigi (0 DDL, 0 novih odvisnosti).

### A) Izmera pred valom

**Kako ima RestaurantOS (v1.249.0):** KDS statistike (v1.76/1.77) merijo
POSTAVKO/POSTAJO — prepMin = firedAt→readyAt po artiklu in postaji, z
toplotno mrežo po polurnah. A vodja, ki odloča o TLORISU in pokritosti
dvorane, nima odgovorov na dve PRAVO vprašanji gostilne: katera miza stoji
prazna med odprtimi urami (kapaciteta, ki ne zasluži), in katera naročila
so čakala najdlje, da je bilo VSE krožnikov zunaj (celotna strežba, ne
posamezen listek). Podatki so bili tam od nekdaj — Order.createdAt/paidAt/
cancelledAt + OrderItem.firedAt/readyAt + OpeningHours/SpecialOpeningDay —
manjkal je samo pogled.

**Kako imajo najboljši (Lightspeed Tempo, junij 2026):** servisni vpogledi
»tables with the most empty time and orders with the longest service gaps«
— dining room efficiency iz obstoječih podatkov, brez novih vnosov osebja.

### B) Prazni čas miz (dvorana)

- **ODPRTE URE = merilo praznega:** spani tedenskih vrstic + posebnih dni
  lokacije (prednost lastne vrstice pred org null — isti padec kot
  rezervacijski widget), v LOKALNEM pasu lokacije (Location.timezone,
  prazna → Europe/Ljubljana), DST-varno (dvostopenjski ugib — pomladni
  prehod 01:00–05:00 traja 3 h, jesenski 5 h). ODMIK KOSILA ni odprta ura
  (dan z odmikom da DVA spana; gost, ki sedi čez odmik, ne naredi mizo
  »nezasedeno«, ampak odmik se NE ŠTEJE v odprte ure — prazno čez odmik ne
  obstaja). Vsi spani prirezani na okno [since, now].
- **ZESEDENOST = fizična resnica:** UNIJA intervalov naročil na mizi
  (prekrivanja se ne seštevajo dvakrat — zaporedna naročila istega večera).
  Plačano: createdAt→paidAt · preklicano: createdAt→cancelledAt (tudi
  preklic je BLOKIRAL mizo — prihodek 0, čas pa je šel) · odprto:
  createdAt→meja okna (gostje še sedijo). Naročila brez mize (dostava/ponos)
  v tem delu ne sodelujejo — mize ne zasedejo.
- **VRSTICA PO MIZI:** serviceMin, occupiedMin, emptyMin = max(0,
  serviceMin − occupiedMin), utilization = min(1, occupied/service),
  orders (plačana + odprta — preklicana se ne štejejo kot strežena),
  avgTurnMin (povprečen obrat PLAČANIH), revenue (plačana). Razvrščeno
  padajoče po praznem — MIZA, KI JE NISO NIKOLI ODPRLI, JE NAJPRAZNEJŠA
  (registr vseh miz obsega, tudi nikoli uporabljenih). Miza brez odprtih ur
  ostane v seznamu s serviceMin 0 (iskreno, ne tiho skrita).

### C) Servisne luknje (naročila)

- **Disciplina plačanih** (ista kot staff-performance/sales-by-hour):
  naročila z paidAt ≥ since — poročilo je za PREGLED preteklosti; živo
  dogajanje pokriva KDS plošča.
- **ŠTIRI METRIKE po naročilu:** vnos→pošiljanje (min firedAt − createdAt —
  zamuda, preden kuhinja sploh vidi naročilo), prvi krožnik (min readyAt —
  prvi dokaz strežbe), CELOTNA strežba (max readyAt − createdAt — prava
  luknja: kdaj je imel gost VSE), obrat mize (paidAt − createdAt).
  Preklicane postavke ne štejejo; negativni čas (urona nesreča) se prižge
  na 0 (vzorec kds-stats prepMinutes).
- **ISKRENA MEJA unknownReady:** plačano naročilo brez katere koli
  pripravljene postavke (ročno plačano, brez KDS poti) NI tiho zlito v
  mediane — šteje se ločeno; mediana teče po IZMERJENIH vrednostih vsake
  metrike posebej. Top 10 padajoče po celotni strežbi, izenačena → nižja
  številka naročila naprej (stabilno).

### D) Implementacija (enaka arhitektura kot staff-performance)

- **ČISTA PLAST src/lib/tempo-insights.ts (0 uvozov):** vzorci → vrstice +
  statistike, testabilno brez baze (vzorec sales-by-hour/staff-performance).
  Časovni pas je samoizrojena ista tehnika kot haccp-ops (Intl, DST-varno)
  — uvoz od tam bi v čisto plast vpleten db graf; ~30 vrstic izrojenega
  časa, dokumentiranega in pokritega s testi (oba DST prehoda 2026).
- **KONVENCIJA dayOfWeek (lekcija iz žive produkcije):** OpeningRows
  nosijo 0 = nedeljo … 6 = soboto (getUTCDay; isti izraz kot
  reservation-slots weekdayOf, oznake oh.day0 = »Nedelja« … oh.day6 =
  »Sobota«, demo seed 0–6, produkcija edini odprt dan dayOfWeek 0).
  Prva rešitev je napačno uporabila ISO 1–7: na demo podatkih (vsi dnevi
  odprti) je hrošč tiho pojedel le nedeljo (72 h namesto 84 h — nevidno),
  na produkciji pa izpraznil VSE spane (pon–sob zaprto, nedelja = vrstica
  0, ki ISO iskanje nikoli ne najde) → iskreno stanje »ni odprtih ur« ob
  odprti nedelji. Ujeto šele na živem E2E produkcije (dev suita zelena —
  lastni testi so sejali ISO vrstice; A/B identičnost tega ne more ujeti).
  Popravek: localWeekday vrne getUTCDay nespremenjen + testi sejejo
  kanonske vrstice (A3/A4 nedelja 0, DB seed 0–6, A7 0–6).
- **RUTA GET /api/reports/tempo?days=7:** reports.sales + locationScope
  (centralne vloge = cela organizacija — mize nosijo ime lokacije v
  oklepaju, osebje = lastna). take-varovala 500/1000/5000/50000/200000.
- **UI TempoInsightsCard** (Analitika → Pregled, tik za učinkovitostjo
  natakarjev, gating reports.sales, lazy fetch): tabela miz s trakom
  zasedenosti (emerald ≥ 60 %, amber ≥ 25 %, rose pod) + top naročja z
  vsemi štirimi metrikami + štiri statistične kartice (mediana celotne
  strežbe, mediana obrata, izmerjeno naročil, brez žiga priprave) + CSV
  izvoz + iskrena prazna stanja (ni miz / ni odprtih ur / ni naročil /
  nobeno naročilo nima žiga). Dopolnilo KDS statistikam (postavka/postaja
  → miza/naročilo end-to-end), ne podvajanje.
- **i18n:** +26 ključev tempo.* v vsakem slovarju (4002 → 4028; pariteta
  SL/HR ohranjena, EN/DE/IT gostujoči nedotaknjeni).

**Sklep §24:** vodja zdaj vidi, katera miza stoji prazna med odprtimi urami
in katera naročila so čakala najdlje do popolne strežbe — dve merili
Lightspeed Tempa, izpeljani deterministično iz obstoječih časovnih žigov
(odpiralne ure v lokalnem pasu z DST-robno pretvorbo, unija zasedenosti,
mediane po izmerjenih), 0 DDL, 0 novih odvisnosti. Naslednji val: sveža
raziskava julij–november 2026 (Toast Fall 2026 objave), Full Profile
Discount (B — cenovna politika lastnika) ali B-odločitve (WhatsApp
transport, OSS-8 SMTP) po »nadaljuj«.

## 25. Raziskava november 2026 — ČRTNA KODA RAČUNA v1.251.0 (skeniranje računa za vračila/storno)

Sklep §24 je napovedal svežo raziskavo julij–november 2026 (Toast Fall 2026
objave); B-odločitve (WhatsApp transport, OSS-8 SMTP, Full Profile Discount)
čakajo lastnika in niso avtonomne. Spletna raziskava november 2026 (Toast,
Lightspeed, Square, TouchBistro, trendi) je izmerila naslednje.

### A) Izmerja raziskave (julij–november 2026)

**Toast (januar–oktober 2026):**
- **ČRTNA KODA RAČUNA** (30. 1. 2026,
  »Look up checks by scanning the receipt barcode« —
  »now available to all Toast POS locations«): gost
  prinese račun nazaj (vračilo/storno, tip, poizvedba), osebje skenira
  črtno kodo z računa in dokument se odpre — »streamline order lookups
  for returns, exchanges, or pay-at-the-counter service models without
  searching manually«. SPREJETO v tem valu — naše stanje: seznam zadnjih
  100 računov z ročnim brskanjem, storno potrebuje izvirni račun, EAN
  skenerska infrastruktura (v1.229) pa Obstaja SAMO za zalogo.
- Toast Fall 2026 (oktober): Toast IQ Team, Seamless Checkout (shrani
  plačilno sredstvo ob rezervaciji — ponudnik plačil = B-odločitev),
  SMS Marketing (transport = B-odločitev), glasovni vnos naročil (0-AI
  politika lastnika — zavestno NE).
- Februar 2026: POS Break Enhancements, Receipt Barcode Lookup (zgoraj).

**Lightspeed (marec–maj 2026):**
- Marec: Table pacing — pokrito (Tempo vpogledi v1.250, §24 + priliv
  ritma prihodov v1.244, §18 A). Digitalni checklisti — pokrito
  (v1.246, §20: predloge + plošča + dodeljevanje + sledenje).
- Maj: automatic table assignments (rezervaciji se miza dodeli
  samodejno) — kandidat prihodnjega vala (algoritem nad obstoječima
  Table + Reservation, 0 DDL); »Turn Google searches into guest
  bookings« (zunanja integracija = B-odločitev); Tailor allergens —
  pokrito (alergenski katalog + pregled potrditev, Issue #7).
- KDS 2.0 — pokrito (vsa tri generacije našega KDS + ETA + tečaji).

**Square (2026):** nested modifiers (Zahteva DDL hierarhijo — odloženo),
kiosk hitrejše nalaganje/slike kategorij (naš /kiosk ima slike),
heatmaps shranjevanje (pokrito: shranjeni pogledi poročil v1.247, §21),
SSO (B-odločitev).

**Trendi 2026:** AI vpogledi/napovedi (0-AI politika — zavestno NE),
KDS namesto papirnatih listkov (pokrito), brezkontaktna plačila
(povezave QR — pokrito, v1.238 §15).

**Presoja:** edina čisto tehnična vrzel, ki jo lahko zapremo avtonomno
(0 DDL, 0 odvisnosti, 0 AI, 0 B-odločitev) in prinaša takojšnjo vrednost
vsakodnevnemu toku vračil, je Toast črtna koda računa.

### B) Odločitev o vsebini kode

Vsebina črtne kode = **receiptNumber** (npr. »2026-11-42-BLG001«):
- je ŽE natisnjena človeku berljivo na računu (vrstica »Račun št.«) —
  ročni vnos ob poškodovani kodi/brez skenerja je enostavno prepisovanje
  iste vrste (Toast ista vzorec: »scan the barcode … or enter manually«);
- je unikatna per lokacija (@@unique([locationId, receiptNumber])) —
  skeniranje teče v uporabnikovem lokacijskem obsegu (enako seznamu);
- stara shema »R-YYYY-NNNNN« se najde z ročnim vnosom (ujemanje po
  nizu) — starejši računi ostanejo dosegljivi;
- alternativa (receipt id, 25-mestni cuid) je daljša za tisk na 80 mm
  in NEberljiva za ročni vnos — zavrnjena.

### C) Implementacija

- **ČISTI SLOJ src/lib/barcode.ts (0 uvozov, 0 odvisnosti):**
  Code128-B enkodirnik — tabela 107 vzorcev širin (start B 104, podatki
  ASCII−32, kontrolna vsota mod 103, stop 106 s 13 moduli), kanonski
  testni vektor »ABC«; normalizeReceiptScan (trim + presledki ven,
  velikost OHRANJENA — premises je lahko mešan), receiptScanVariants
  ([kot-je, velike, male] za eno poizvedbo IN); varovalo 48 znakov;
  quiet zone 10 modulov (spec minimum).
- **NATISNJEN RAČUN (src/lib/receipt.ts):** SVG črtna koda Code128
  receiptNumber pod fiskalnim blokom (ZOI/EOR ali ZKI/JIR), ŠE pred
  nogo — inline `<rect>` črte (0 odvisnosti), bela podlaga s tihimi
  prostori, napis številke pod kodo, max 68 mm na 76 mm vsebini.
  Neenkodirljiva številka (znak izven ASCII 32–126) kodo TIHO izpusti —
  tisk računa NIKOLI ne sme pasti (§18 print disciplina). Velja za SL
  in HR izpis enako.
- **RUTA GET /api/furs/lookup?code=:** reports.sales (IDENTIČNO seznamu
  /api/furs GET, N5 revizija §4 — vpogled, ne izdaja), await
  locationScope(user) (centralne vloge = cela organizacija → odgovor je
  SEZNAM zadetkov, ker je lahko ista številka na več lokacijah);
  normalizacija + variante velikosti v ENEM IN; prazno/krajše od 4 = 400
  (prag EAN v1.229); take 50 varovalo; preslikava ista kot seznam
  (tableName, orderNumber, isStorno, stornoOf).
- **UI (zavihek Računi, tik nad seznamom):** kartica »Najdi račun po
  črtni kodi« — mono vnosno polje + gumb; Enter = iskanje (skener je
  tipkovnica, keyboard wedge, ista paradigma kao EAN čitalnik v1.229);
  zadetki kot vrstice z emerald obrobo (ponatis + storno akciji isti
  kot seznam); iskrena prazna stanja (ni zadetka; več zadetkov z
  opombo); gating reports.sales.
- **i18n:** +6 ključev rcpt.scan* v vsakem slovarju (4028 → 4034;
  pariteta SL/HR ohranjena, EN/DE/IT gostujoči nedotaknjeni).

**Sklep §25:** vračilo/storno po fizično prinesenem računu je zdaj en
skener ali en vnos — enaka vzorec Toast januar 2026, izpeljan čisto iz
obstoječih podatkov (receiptNumber + locationScope), 0 DDL, 0 novih
odvisnosti, 0 AI. Naslednji val: avtomatska dodelitev miz rezervacijam
(Lightspeed maj 2026 — algoritem nad obstoječima modeloma, kandidat),
sveža raziskava pomlad 2027 ali B-odločitve lastnika po »nadaljuj«.

---

## 26. Raziskava november 2026 — AVTODODELITEV INTERNE POTI v1.252.0 (samodejna dodelitev mize rezervaciji ob ustvarjanju)

Sklep §25 je izmeril kandidata: Lightspeed maj 2026 »automatic table
assignments« — rezervaciji se miza dodeli SAMODEJNO. Ta val zapre zadnjo
vrzel te funkcije: NOTRANJO pot (telefon/walk-in).

### A) Izmerja pred valom

- **v1.231.0 (§9 točka 2):** gumb »Dodeli« v internem dialogu — KLIJENTSKA
  sugestija (najmanjša ustrezna miza, brez prekrivanja); osebje mora
  klikniti, predlog se šele takrat zapiše v obrazec.
- **v1.248.0 (§22 A):** strežniška avtododelitev SAMO za javni widget
  (/api/public/reservations) — spletni gost dobi mizo samodejno.
- **vrzel:** interna pot (POST /api/reservations — telefon, walk-in,
  vpis strežnika) ob ustvarjanju BREZ izbrane mize pusti rezervacijo
  BREZ mize; osebje jo nato dodeljuje ročno (gumb/tloris). Lightspeed
  maj 2026: »rezervaciji se miza dodeli samodejno« — brez človekovega
  klika.

### B) Odločitev

- Avtododelitev steče STREŽNIŠKO v POST /api/reservations, ko miza NI
  izrecno izbrana (noben tableId, nobena kombinacija) in ni izrecnega
  izklopa (skipAutoAssign — vzorec allowOutsideHours/forcePacing:
  privzeto VKLOP, izklop je zavedna odločitev osebja).
- Izbira teče skozi ISTI čisti sloj table-autoassign kot javna pot
  (ena resnica: najmanjša ustrezna miza ali registrirana kombinacija,
  sedeži naraščajoče + 'sl' tie-break; izključene walk-in mize
  ne sodelujejo; sosednji termini se lahko usedeta na isto mizo).
- Razlika proti javni poti: trajanje je SPREMENLJIVO (interna pot
  15–600 min po body.duration, javna fiksno 120) — okno zasedenosti
  se računa z dejanskim trajanjem.
- Znotraj obstoječe transakcije ZA lockReservationCapacity — sočasni
  ustvarjanji ne moreta dobiti iste mize (vzorec javne poti).
- Nobena miza ne ustreza → rezervacija BREZ mize + iskren toast
  (Lightspeed »skip« — dodelitev je pomoč, ne obveza).
- Izrecna izbira VEDNO zmaga (explicit > auto > brez).

### C) Implementacija

- **NALAGALCA autoassignPickForWindow (src/lib/table-combos.ts):**
  naloži mize + kombinacije + izključene mize + zasedene rezervacije
  dneva (±24 h, isti blokirajoči statusi confirmed/seated/completed
  kot javna pot) in vrne izbor — čisti sloj table-autoassign ostane
  0 uvozov, testi in ruta delijo isto resnico.
- **RUTA POST /api/reservations:** avtododelitev v transakciji;
  odgovor +autoAssignedTable (label | null, aditivno — API integratorji
  vidijo, da miza ni bila človeška izbira); revizijska sled
  RESERVATION_AUTOASSIGNED (fire-and-forget .catch — revizija NI
  kritična pot); P2002 pod avtododelitvijo se iz 500 prevede v pošten
  409.
- **UI (dialog Nova rezervacija):** potrditveno polje »Samodejno
  dodeli prosto mizo« (privzeto vklopljeno) pod izbirnikom mize; po
  shrani toast »Miza X je dodeljena samodejno.« ali iskreno
  »Proste mize ni bilo mogoče najti — rezervacija je brez mize.«.
- **i18n:** +4 ključi resv.autoServer* v vsakem slovarju (4034 → 4038;
  pariteta SL/HR ohranjena, EN/DE/IT gostujoči nedotaknjeni).
- 0 DDL, 0 novih odvisnosti, 0 AI.

**Sklep §26:** rezervacija po telefonu zdaj dobi mizo v isti meri kot
spletna (v1.248) — brez dodatnega klika osebja, z izrecno možnostjo
izklopa in izrecno izbiro, ki vedno zmaga. Lightspeed maj 2026
»automatic table assignments« je pokrit na obeh ustvarjalnih poteh.
Naslednji val: sveža raziskava pomlad 2027 (Toast/Lightspeed/Square
objave) ali B-odločitve lastnika po »nadaljuj«.

---

## 27. Raziskava november 2026 (nadaljevanje) — ODPRTI RAČUNI V POROČILU v1.253.0 (Square oktober 2026)

Sklep §26 je napovedal svežo raziskavo; uporabnik je rekel »nadaljuj« brez
B-odločitev → raziskava je stekla takoj (splet, november 2026), ne čez zimo.

### A) Izmerja (spletna raziskava + lastno stanje)

- **Square 22. 10. 2026 (Release notes Vol 15, v 7.30):** »See open checks
  in the Sales report on Point of Sale — The report counts sales on checks
  that haven't closed yet alongside completed sales. Open checks are
  included by default, and a banner on the report says so. … To show only
  completed sales, turn off the Open Checks filter.« »Why it matters:
  Sales on open checks are part of the day's business before anyone
  settles them.« Ostali octobrski kvadrati: SSO = B-odločitev (znano),
  nested modifiers = DDL odloženo, kartični pribitki = US-pravno (za
  SL/HR neuporabno), stran košarice = kozmetika.
- **Lightspeed november 2026 (»What's New: AI, POS, KDS, and more«):**
  AI Pulse = 0-AI politika NE; zaklep KDS postaje = POKRITO v1.244 §18 D;
  strežniške značke + ure sedenja na tlorisu = POKRITO v1.244 §18 C;
  panning/pinch-zoom = ergonomika dotika nad istimi podatki (ni vrzeli
  podatkov); opombe/alergeni na artiklu = POKRITO (allergenWarning
  v1.104 Issue #7 na KDS/žig + notes v podrobnosti naloge); rezervacijske
  kapacitete (odstotek/rezervabilne mize/samo-online) = POKRITO
  (maxCoversPerSlot v1.110 + pacing v1.244 §18 A + izključene walk-in
  mize v table-autoassign + ločena javna/interna pot); Google bookings =
  B; belgijski boni = N/A.
- **Toast oktober 2026:** Hotels Payments (limited release) = N/A za
  gostilniški jedro; Retail POS Mode = N/A.
- **Lastno stanje:** X/Z poslovno poročilo (v1.73.0, OPS-8 val 3,
  Lightspeed Business Report vzorec) šteje SAMO fiskalizirane Receipt
  vrstice (createdAt v obdobju). Odprta naročila (mize s saddle-bag
  gosti: status open/sent/prepared/pending/hold, paidAt null,
  cancelledAt null) niso nikjer v dnevnem prometu — vodja, ki medmenjadi
  pogleda »kakšen je danes promet«, vidi le poravnane račune, denarja na
  mizah pa ne. Točno to vrača Square: prodaja na odprtih računih je
  že del današnjega poslovanja, še preden jih kdo poravna.

### B) Odločitev

- **Odprti račun** = Order z `paidAt: null`, `cancelledAt: null` in
  `status NOT IN ['paid','cancelled']` (difenzivno: pokrije
  open/sent/prepared/pending/hold — vse kar ni zaprto ali preklicano),
  ustvarjen v istem oknu [from, to] kot računi, v istem lokacijskem
  obsegu (locScope — centralne vloge = cela organizacija).
- **Privzeto VKLJUČENO** (Square: »included by default«): nov query
  parameter `open` na /api/reports/export?section=zz — vse razen
  »0«/»false« pomeni vključitev; `open=0` = samo poravnano (Square:
  »turn off the Open Checks filter«).
- **Računovodska disciplina:** OBSTOJEČA polja poročila (grossSales,
  netSales, vatTotal, vatByRate, paymentsByMethod, covers …) ostanejo
  IZKLJUČNO poravnana (računi) — ni drsenja pomena za knjigovodje in
  obstoječe porabnike. Odprti računi so ADITIVNI, jasno ločen blok:
  `openChecks { included, count, gross, net, vat, rows[] }` +
  pripomočni skupaj `grossWithOpen` / `netWithOpen` (bruto/neto skupaj
  z odprtimi — Square »alongside completed sales«).
- **Banner** (Square: »a banner on the report says so«): v predogledu
  jantrobno poudarjen blok z napisom, da so odprti računi vključeni;
  CSV nosi vrstico `Vkljuceni v dnevni promet;DA`.
- **Iskrenost:** count je pošten (nezrezan agregat _count), vrstica
  seznama UI pa je rezana na 50 najstarejših z opombo »… in še N«;
  prazno stanje je vidno prazno (0 računov = izrecna vrstica, ne tišina).

### C) Implementacija

- **ČISTI SLOJ src/lib/xz-report.ts:** aditivni vhod `openChecks` v
  buildXzReport (defenzivno normaliziran: count ≥ 0 celo, zneski r2,
  rows max 50) + aditivni izhod `openChecks` blok + `grossWithOpen` /
  `netWithOpen`. Brez vhoda = included:false, ničle, skupaj = osnova
  (nazajzdružno prijazno za obstoječe klice).
- **RUTA /api/reports/export?section=zz:** parameter `open` (privzeto
  vklopljen); ob vklopu DVE poizvedbi ( isti lokacijski obseg kot
  računi): agregat `_count + _sum(total, subtotal, tax)` (poštena
  številka) + `findMany take 50` (starejši najprej) z relacijo Table
  (number) za oznako mize; preslikava v vrstice { orderNumber,
  tableNumber, type, total, createdAt }. CSV: nov blok ODPRTI RACUNI
  (število, bruto, neto, DDV, skupaj z odprtimi) oz. `IZKLOPLJENO`
  vrstica; JSON: aditivna polja.
- **UI (Računovodstvo → Izvoz, sekcija X/Z):** preklop »Vključi odprte
  račune« (privzeto vklopljen) ob gumbu Predogled — pošlje `open=1|0` na
  predogled IN izvoz; predogledni dialog: jantrobni banner + blok
  (število, bruto, neto, DDV) + poudarjena Skupaj z odprtimi (bruto in
  neto) + seznam odprtih računov (miza/brez mize, vrsta, znesek,
  starost odprtja; max višina z drsenjem; »… in še N«); iskreno prazno
  stanje.
- **i18n:** +14 ključev acct.xzOpen* v vsakem slovarju (4038 → 4052;
  pariteta SL/HR ohranjena, EN/DE/IT gostujoči nedotaknjeni).
- 0 DDL (branje obstoječih Order/Table), 0 novih odvisnosti, 0 AI.

**Sklep §27:** dnevni promet v X/Z poročilu zdaj pokaže tudi denar, ki
še sedi na mizah — privzeto, z banerjem in z možnostjo izklopa (Square
oktober 2026 »See open checks in the Sales report«), brez drsenja
pomena obstoječih računovodskih polj. Naslednji val: sveža raziskava
pomlad 2027 (Toast/Lightspeed/Square objave) ali B-odločitve lastnika po
»nadaljuj«.

## 28. Raziskava november 2026 (nadaljevanje 2) — REAL-TIME CHECK VIEW v1.254.0 (Square Vol 15, zamujena postavka)

Sklep §27 je napovedal svežo raziskavo ali B-odločitve; uporabnik je
rekel »nadaljuj« brez B-odločitev → raziskava je stekla takoj
(4. 11. 2026, agent-browser po mestih objav).

### A) Izmere (spletna raziskava + lastno stanje)

- **Square Vol 15 (22. 10. 2026, v 7.30)** — ŠEST postavk; §27 jih je
  ocenil PET (SSO = B, nested modifiers = DDL odloženo, kartični
  pribitki = US-pravno, stran košarice = kozmetika, odprti računi =
  v1.253.0). **ZAMUJENA postavka:** »Edit items with the check in view
  on Point of Sale« (**Real-Time Check View**) — preverjeno 4. 11. 2026:
  besedna zveza ni nikoli ocenjena (rg po PRIMERJAVI in worklogu brez
  zadetkov). Square: »Item details open next to the check, and the check
  updates with each choice as staff edit. Edits save automatically. A
  tap on a check item opens its details, and a long press opens bulk
  edit mode. Sellers choose which item detail sections appear: notes,
  fulfillment methods, taxes, discounts, and service charges.« Zakaj
  pomembno (Square): »Item edits show up on the check, which is where
  staff confirm them. Showing the check next to item details, with only
  the sections a business uses, lets staff edit and confirm without
  switching screens.« Vol 16 (november 2026) še ni objavljen (objavni
  ritem ~2× mesečno; release-notes vozlišče je na /us/en/release-notes).
- **Lightspeed (4. 11. 2026):** §27 (november 2026 »What's New: AI, POS,
  KDS, and more«) je ocenil vse postavke in ni odkril odprtih vrzeli;
  novih objav po oceni ni (naslednji »What's New« čez zimo).
- **Toast (4. 11. 2026):** stran za Cloudflare zidom (glava ne preide —
  vrtanje v past bi potekalo čez urni prag); oktober 2026 je §27 ocenil
  (Hotels Payments = N/A za gostilniško jedro, Retail POS Mode = N/A).
- **Lastno stanje:** TRI košarice POS (novo naročilo / hitra prodaja /
  urejevalnik naročila NaročiloSheet) imajo račun in meni v istem
  pogledu, VENDAR vsa ŠTIRI urejevalna dialoga odprejo max-w-sm modal,
  ki račun PREKRIJE: izbira variante (OSS-10 v1.210.0), opomba vrstice
  (§22 B v1.248.0), sprememba cene (§23 v1.249.0), preklic postavke
  (Issue #5). Osebje ureja »na slepo« — račun se posodobi šele po
  Potrdi. Vrstice košaric niso tapljive (samo 7×7 ℹ ikona odpre
  opombo). Točno to vrača Square: potrditev urejanja je NA RAČUNU,
  urejevalec pa ga trenutno prekrije.

### B) Odločitev

- **Presnamemo esenco:** živi predogled računa ZRAVEN urejevalca, ki se
  posodablja z VSAKO izbiro (Square: »the check updates with each
  choice as staff edit«), + tap na vrstico košarice odpre njene
  podrobnosti (»A tap on a check item opens its details«).
- **Nova čista lib `src/lib/live-check.ts`** (0 uvozov iz db/api):
  vrstica `LiveCheckLine { key, name, qty, unitPrice, note?, pending?,
  voided?, prevPrice? }`, `buildLiveCheck` (defenzivna normalizacija:
  qty ≥ 0 celo, cene r2 ≥ 0, opombe trim, podvojeni ključ — prvi zmaga,
  kap 30 z iskrenim »… in še N«, prečrtane IZPUŠČENE iz skupaj),
  `cartPreviewLines` (preslikava vseh treh košaric; manjkajoči artikel
  preskočen — predogled ne laže o 0,00 €), `orderPreviewLines`
  (obstoječe postavke NaročiloSheeta, modifiers v imenu, voided ven),
  `variantPendingLine` (živa pending vrstica iz trenutnih izbir:
  ime z opcijami + cena z doplačilom, qty 1), `withLineUpdate` (čist
  patch note/cena/preklic na ENO vrstico — pending obroba) in
  `parsePriceInput` ('12,50' → 12,5; smeti → null — predogled pokaže
  trenutno ceno, ne laže).
- **Plošča `src/components/live-check-aside.tsx`:** naslov + značka
  »v živo«, vrstice (pending → jantarna obroba + značka »urejanje«;
  voided → prečrtana; prevPrice → prečrtana prejšnja vsota vrstice;
  opomba → ℹ pod vrstico), skupaj (r2) in namig »Spremembe se vidijo
  takoj; zapis ob potrditvi.« Prazno stanje je vidno prazno (izrecna
  vrstica, ne tišina). Max višina z drsenjem.
- **Štirje dialogi** dobijo dvostolpčno postavitev
  (`sm:grid-cols-[0.95fr_1.05fr]`, mobilno plošča NAD urejevalcem —
  isti DOM): variant (pending vrstica živo iz izbir), note (vrstica v
  urejanju nosi ŽIVO sestavljeno opombo — čipi + besedilo med
  tipkanjem), price (prej → novo živo iz tipkanja, skupaj sledi),
  void (vrstica prečrtana, »Skupaj po preklicu«).
- **Tap na vrstico = podrobnosti:** vseh šest mest (navadna + variantna
  vrstica × tri košarice; SaleCartLineName pokriva namizni in mobilni
  tir) — cela vrstica je gumb (min-h-11, 44px+ tarča), ki odpre
  obstoječi dialog opombe; ℹ ikona ostane (dvojna pot). Obstoječe
  (poslane) postavke v NaročiloSheetu NISO tapljive — njihova opomba
  je že pri kuhinji, urejanje ne obstaja (iskrena meja, ne lažljivi
  gumb).
- **Samodejno shranjevanje ostaja na Potrdi** (naša dialoga imata
  Prekliči — sprememba je vidna v predogledu živo, zapis pa šele ob
  potrditvi; Square auto-save je mehanika njihove modal-less zasnove).
  Dolgi pritisk/množično urejanje in konfiguracija sekcij so zavestno
  ZUNAJ (Square-specifična ergonomika njihove razporeditve; naši
  dialogi imajo po eno sekcijo).
- **i18n:** +10 ključev `lcv.*` v vsakem slovarju (4053 → 4063;
  pariteta SL/HR ohranjena, EN/DE/IT gostujoči nedotaknjeni).
- 0 DDL (samo branje stanja košaric v klientu), 0 novih odvisnosti,
  0 AI.

### C) Implementacija

- **Lib** kot v odločitvi B (popolnoma čist sloj; testi A1–E4 v
  tests/v254-realtime-check.test.ts: normalizacija smeti, kap s pošteno
  vsoto, voided izpuščene, preslikave košaric/naročila, pending
  varianta, patchi, parse cene).
- **Page:** izpeljani modeli `variantAsideModel` / `noteAsideModel` /
  `priceAsideModel` / `voidAsideModel` (useMemo iz stanja — preračun ob
  vsaki spremembi) + `posCartOf` (izbira stanja po načinu cart/sale/
  sheet); štirje dialogi prestrukturirani v grid z LiveCheckAside
  (data-region `lcv-aside-variant|note|price|void`); šest mest tapa na
  vrstico (openNotePick z ustreznim ključem in imenom; aria-label iz
  posn.add/posn.edit z vsebino opombe).
- **Plošča:** ScrollArea max-h-48, jantarna pending obroba, prečrtane
  vrstice, ℹ opombe, iskren »… in še {n}«, skupaj r2, namig o zapisu ob
  potrditvi.
- **Testi:** 21 primerov (A1a–d, A2a–d, B1–3, C1–2, D1–3, E1–4, Ž1–5);
  Ž3 dokazuje montažo (štirje regioni, 4× grid razred, 6× openNotePick
  iz vrstic) in 0 DDL (lib brez db uvoza, schema brez LiveCheck).

**Sklep §28:** vsako urejanje postavke na POS zdaj pokaže račun zraven
sebe — živo, z vsako izbiro (varianta, opomba, cena, preklic), z
jantarno obrobo na vrstici v urejanju in pošteno vsoto — in tap na
vrstico košarice odpre njene podrobnosti (Square oktober 2026 »Real-Time
Check View«), brez drsenja discipline zapisovanja (vrata ostajajo
Potrdi + strežniške validacije + revizije). Naslednji val: Square Vol 16
(november 2026, pričakovana objava sredi meseca), Lightspeed/Toast
zimske objave ali B-odločitve lastnika po »nadaljuj«.

## 29. Raziskava november 2026 (nadaljevanje 3) — CONFIRMATION BANNER v1.255.0 (Lightspeed hub)

Sklep §28 je napovedal Vol 16 / zimske objave / B-odločitve; uporabnik
je rekel »nadaljuj« brez B-odločitev → sveža raziskava je stekla takoj
(5. 11. 2026, agent-browser po mestih objav).

### A) Izmere (spletna raziskava + lastno stanje)

- **Square (5. 11. 2026):** release-notes vozlišče še vedno nosi Vol 15
  (22. 10. 2026) kot najnovejšo objavo — Vol 16 (objavni ritem ~2×
  mesečno, ~14 dni) bi bil pričakovan šele okrog 5.–12. 11. in ob
  4:30 ET zjutraj še ni bil objavljen. Nič novega za oceno.
- **Toast (5. 11. 2026):** stran še vedno za Cloudflare zidom
  (»Just a moment…« — glava ne preide); oktober 2026 je §27 ocenil
  (Hotels Payments = N/A, Retail POS Mode = N/A). Zaprto do zime.
- **Lightspeed hub (5. 11. 2026):** poleg mesečnih blog objav (»What's
  New: AI, POS, KDS, and more« — november ocenjen v §27) obstaja
  tekoča stran »What's New in Lightspeed Restaurant« (K-Series Back
  Office) s SEDEMJIMI postavkami, ki jih §27 NI videl (ocenil je blog,
  ne hub). Ocena vseh sedmih:
  1. **Receipt printing configurations** (»Virtual merchant receipt« —
     izbira, ali se po plačilu natisne tudi izvod za gostilno) = N/A
     za naš tržni prostor: FURS račun je EN fiskalni izdelek (EOR/QR
     na izročku za gosta); kartično potrdilo živi na terminalu, ne v
     POS. Uvajanje »kuharske kopije« bi bila izmišljotina brez zakonske
     podlage v SI/HR.
  2. Quicker access to local support contact = kozmetika (mi SMO
     podpora; About/System kartica že obstaja).
  3. New label printer (Epson L90) = hardware matrika (naprave, ki je
     nimamo, ne moremo preizkusiti; HARDWARE-MATRIX ostaja resnica).
  4. Customizable Order List view = odloženo: naše naročilne kartice
     že imajo identiteto (Issue #74: številka/ura/natakar), strnjenje
     (Issue #71 audit-23: 3 postavke + »＋ N ostalih«) in statusne
     filtre; prilagoditev stolpcev je luksuz brez izmerjene vrzeli.
  5. **Order view confirmation banner** = **VRZEL** (edina postavka z
     izmerjeno luknjo v naši kodi — spodaj). Lightspeed: »The order view
     now has a confirmation banner at the top of the screen when a task
     is complete. Every discount added, sequence completed or course
     fired will be clear — so staff can manage their shifts with confidence.«
  6. Search options by SKUs = DDL: MenuItem nima polja za kodo/SKU
     (rg po kodi: zadetki so le lažni prijemi slovenskih besed);
     dodajanje polja = migracija = ZAVESTNO ODLOŽENO (0-DDL pravilo,
     produkcija je porabila DDL klike).
  7. Adyen payment terminal signatures = N/A (Adyen + ameriški
     kreditni spori; mi nimamo Adyen poti).
- **Lastno stanje (izmere po kodi):** pet dejanj v NaročiloSheetu in
  plačilnem dialogu uspe TIHO — pošiljanje dodatka obstoječemu
  naročilu (`sendSheetItems`), streljanje vseh pending postavk
  (`fireSheetAll`), streljanje posameznega tečaja (`fireCourse`),
  dodelitev postavke h tečaju (`assignCourse`) in ročni popust pod
  pragom (`applyManualDiscount`, direktna pot). Vseh pet ima toast
  SAMO na napako; uspeh ne pokaže NIČ. (Sorodna dejanja, ki ŽE
  potrjujejo: fireOrder s kartice — toast mmv.fireDone; kupon —
  cp.applied; prenos — sheet.transferred; zadržanje/nadaljevanje —
  holdDone/resumeDone. Kuhinjsko SERVED iz vrste KDS ima lastni
  povratni odziv — izstop iz vrste.) Lightspeedova teza zadene
  točno: osebje v izmeni »upravlja s prepričanjem« samo takrat, ko
  dejanje POTRDJENO pristane.

### B) Odločitev

- **Presnamemo esenco:** emerald pas na VRHU poglede, kjer se dejanje
  zgodi (NaročiloSheet pod glavo, plačilni dialog pod glavo), ki
  potrdi DOKONČANO dejanje: kljukica + naslov + detail (število
  postavk / tečaj št. + ime / popust z imenom in zneskom) + ura
  potrditve. Banner je ČISTI POVRATNI odziv po strežniškem uspehu —
  nič se ne zapisuje ob prikazu (avtoriteta ostaja API + validacije +
  revizije; enaka disciplina kot §28: predogled ne piše).
- **Nova čista lib `src/lib/confirm-banner.ts`** (0 uvozov iz db/api):
  pet builderjev (`fireAllBanner` — count ≥ 0 celo iz strežniškega
  firedCount; `fireCourseBanner`/`courseAssignBanner` — courseNumber
  ≥ 1 + ime trim/kap 60, brez obeh → gol naslov brez lažljive ničle;
  `addItemsBanner` — število novih vrstic navadne + variantne;
  `discountBanner` — ime + znesek r2, znesek v detail vedno s vejico)
  + `bannerTitleKey`/`bannerDetailParams`/`hasBannerDetail` (cb.*
  preslikava) + `CONFIRM_BANNER_MS = 6000`. Nov banner vedno ZAMENJA
  starega (eno mesto resnice — zastoj vrst ni zaščitni znak POS).
- **Komponenta `src/components/confirm-banner.tsx`:** `role="status"`
  + `aria-live="polite"` (bralnik zaslonov OZNANI uspeh), avto-odpad
  po 6 s (časovnik se ponastavi ob zamenjavi — hitra zaporedna
  dejanja vsako dobejo polnih 6 s), ročni gumb Zapri 44 px (h-11
  w-11), ura HH:MM:SS, brez bannerja se ne izriše NIČ (brez praznega
  okvirja).
- **Pet mest v page:** sendSheetItems → banner po uspehu (število
  vrstic), fireSheetAll → banner s firedCount iz strežniškega
  odgovora, fireCourse → identiteta tečaja iz znanega stanja pred
  osvežitvijo, assignCourse → novi tečaj nosi številko iz odgovora,
  obstoječi iz znanega stanja, applyManualDiscount (direktna pot) →
  banner z imenom popusta in zneskom iz OSVEŽENEGA računa
  (bill.manualDiscount — banner pokažekar ta popust). Čiščenje:
  zaprtje sheet/plačila počisti banner; nov plačilni pogled začne
  čist. Dejanja, ki ŽE imajo toaste (fireOrder, kupon, prenos,
  hold/resume, exc.done), ostajajo NETAKNJENA — val zapira samo
  izmerjene TIHE uspehe.
- **i18n:** +11 ključev `cb.*` v vsakem slovarju (4063 → 4074;
  pariteta SL/HR ohranjena, EN/DE/IT gostujoči nedotaknjeni).
- 0 DDL (čisti klientni povratni odziv), 0 novih odvisnosti, 0 AI.

### C) Implementacija

- **Lib** kot v odločitvi B (defenzivni builderji; testi A1–B3 v
  tests/v255-confirmation-banner.test.ts: normalizacija števk/r2/trim,
  kap 60, izpuščeni znesek 0, gol banner brez identitete, vejica v
  znesku).
- **Komponenta:** useEffect časovnik na banner identiteti (zamenjava
  ponastavi), lucide CheckCircle2/X, emerald paleta (border-emerald-200
  bg-emerald-50 — uspeh ima barvo, ne ovire).
- **Page:** stanje sheetBanner/payBanner; pet dejanj postavi banner PO
  uspehu; ConfirmBannerView v obeh dialogih (data-region
  confirm-banner-sheet | confirm-banner-payment); openPayment in oba
  onOpenChange čistita.
- **Testi:** 21 primerov (A1a–b, A2a–d, A3a–b, A4a, A5a–c, B1–3,
  Ž1–Ž5); Ž3 dokazuje montažo (5 klicev setSheet/PayBanner iz
  dejanj, oba regiona, 3× čiščenje payBanner, aria-live + 44 px +
  avto-odpad v komponenti) in 0 DDL (lib brez db uvoza, schema brez
  ConfirmBanner).

**Sklep §29:** vsako od petih doslej TIHIH dejanj v urejevalniku
naročila in plačilnem pogledu zdaj potrdi emerald pas na vrhu pogleda
— s kljukico, številom, identiteto tečaja ali zneskom popusta in uro
(Lightspeed november 2026 »Order view confirmation banner«), z
avto-odpadom 6 s in dostopnostjo aria-live, brez drsenja discipline
zapisovanja (banner ne piše — zapis teče po starih vratih: strežnik +
validacije + revizije). Naslednji val: Square Vol 16 (pričakovana
objava sredi novembra 2026 — tedaj sveža ocena), Toast/Lightspeed
zimske objave ali B-odločitve lastnika po »nadaljuj«.

## 30. Raziskava november 2026 (nadaljevanje 4) — PONATIS LISTKOV ZAPRTIH NAROČIL v1.256.0 (Lightspeed »Reprint orders«)

Nadaljevanje sklepa §29 in kandidata §22 D. Square Vol 16 po novi
oceni še ni objavljen (zimski cikel) — tok izbere ZAKLJUČEN kandidat
z evidence liste prejšnjih raziskav.

### A) Izmere (zabeleženo maj 2026 + lastno stanje)

- **Lightspeed maj 2026** (§22 D, P2): »Reprint orders — reprint
  kitchen tickets for CLOSED orders, with a selection of production
  centers«. Ponatis listka ni več omejen na odprta naročila na KDS
  plošči; vodja lahko rekonstruira listek ŽE PLAČANEGA naročila in
  izbere, katero produkcijsko središče (kuhinja/bar/vse) zanima.
- **Lastno stanje (izmera v valovanju):** ponatis kuhinjskega/bar
  lista obstaja SAMO na KDS zavihku (printKitchenTicket +
  buildKitchenTicketLines, station filter KITCHEN|BAR) — torej samo
  za naročila, ki so NA plošči (open/sent/prepared). Plačano naročilo
  zaposli tab »Računi«, kjer sta na voljo Print (fiskalni račun prek
  /api/furs/[id]) in Storno — listka NI mogoče ponatisniti. Račun
  nosi orderId (povezava nazaj na naročilo + postavke z žigi
  statusov), a poti ni.
- **Realni scenarij (Square/Toast forum pritožbe, vzorec »lost
  ticket«):** gost po plačilu razpravlja, da jed ni nikoli prispela;
  kuhinja pravi, da listka ni dobila; vodja potrebuje DOKAZ, kaj je
  bilo poslano v produkcijo — račun pokaže ZMERE, listek pa POT
  produkcije. Brez ponatisa zaprtih naročil je edina možnost
  ročno prepisovanje iz spomina.
- **Odkritje ob meri:** ponatis, ki je VIZUALNO ENAK izvirniku, je
  goljufivi dokaz (kdor koli natisne »zgodovinski« listek in ga
  podtakne kot izvirnik). Lightspeed ponatise OZNAČI. Naša pot
  mora nositi glavo »PONATIS« + kdo + kdaj + izvirni čas naročila.

### B) Odločitev

VAL Ž5 — zapre kandidata §22 D (P2) nad obstoječimi motorji:

1. **Vstopna točka = račun** (tab »Računi«, gating reports.sales —
   lastnik zaprte površine, enak prag kot seznam, CSV izvoz in
   skeniranje §25). Gumb »Ponatis listkov« na VRSTICI računa
   (seznam + rezultati skeniranja) samo, če račun nosi orderId.
2. **Izbira produkcijskega središča** v dialogu: Kuhinja / Bar /
   Vse — vsako s številom postavk (odgovor mora biti INFORMATIVEN,
   ne ugibanje). Dialog naloži naročilo prek obstoječega
   GET /api/orders/[id] (requireAuth + lokacijska vrata že živita).
3. **Nova ruta** POST /api/orders/[id]/reprint-ticket
   body { station: 'KITCHEN' | 'BAR' | 'ALL' }:
   - dovoljenje `reports.sales` ALI `kitchen.update` (površina je
     računi, a produkcija je lastnik listka — vodja kuhinje sme
     rekonstruirati svoj dokument; blagajna/čistilka ne),
   - lokacijska vrata (guardResource) + validacija station,
   - revizija ORDER_TICKET_REPRINT (auditLog — kdo, kdaj, kateri
     listek, katero središče, koliko postavk) — listek zaprtega
     naročila je DOKUMENT v sporu, vsak ponatis mora biti sledljiv,
   - odgovor: sveže naročilo (za tisk po klientu).
4. **Tisk** po obstoječi cevi: buildKitchenTicketLines + printLines
   (naprava ALI simulator — enako kot KDS ponatis). Razširitev
   builderja: neobvezen reprint kontekst { by } → glava
   »=== PONATIS · KUHINJSKI LIST ===«, vrstica »Ponatis: <by> · <čas>«
   in IZVIRNI čas naročila (order.createdAt, ki ga je builder prej
   ignoriral). Brez konteksta je izhod NEspremenjen (backwards
   kompatibilen — KDS pot pinta obstoječe obnašanje).
5. **Iskrenost postavk:** ponatis nosi SAMO produkcijo, ki je
   nastala — preklicane/umaknjene postavke (status cancelled/voided)
   se IZPUSTIJO (lib helper filterTicketItems; kuhinja jih nikoli ni
   dobila, ponatis ne laže o produkciji).
6. 0 DDL (auditLog je obstoječa revizijska miza), 0 novih
   odvisnosti, 0 AI. HR prevodi (Dodatak vzorec — dvojezičnost
   površine).

### C) Implementacija

- **Lib** (src/lib/devices/print.ts): buildKitchenTicketLines
  neobvezni tretji argument reprint { by } (glava PONATIS, vrstica
  ponatisnika + ure, izvirni čas naročila pod številko) +
  izvozani filterTicketItems (izpust voided/cancelled) — testi A1–A5.
- **API** (src/app/api/orders/[id]/reprint-ticket/route.ts):
  requireAnyPermission [reports.sales, kitchen.update], guardResource,
  station validacija, writeAudit ORDER_TICKET_REPRINT (entityType
  Order, details: station/orderNumber/itemCount/by), odgovor
  ok({ order }) — testi B1–B3 (struktura + vrata + revizija).
- **Page** (dashboard/page.tsx): stanje reprintTarget (ReceiptT) /
  reprintOrder (OrderT) / reprintStation; gumb na vrstici računa
  (seznam receiptsInRange + rezultati rcptScanResults) kadar
  r.orderId; dialog s tremi izbirami središča s števci postavk
  (filterTicketItems + station), potrditev → POST → tisk → toast
  (simulator sporočili obstoječa print.sim*); 44 px dotik, aria,
  data-region reprint-ticket-dialog.
- **i18n:** rcpt.reprint* ključi (sl + hr).
- **Testi:** tests/v256-ponatis-listkov.test.ts — A čisti sloj
  (builder + filter), B ruta (struktura vrata + revizija), Ž montaža
  (gumbi na obeh površinah, dialog, POST klic, tisk po uspehu) in
  0 DDL dokaz.

**Sklep §30:** zaprto naročilo (račun) ni več slepa ulica za
produkcijo — ob sporu vodja ponatisne kuhinjski/bar/celoten listek z
izbiro središča in živim številom postavk (Lightspeed maj 2026
»Reprint orders — closed orders, selection of production centers«),
tiskovni dokument nosi VIDNO oznako PONATIS + ponatisnika + uro +
IZVIRNI čas naročila (goljufivi dokaz nemogoč), strežnik pa vsak
ponatis zabeleži v revizijsko sled (ORDER_TICKET_REPRINT — kdo, kdaj,
katero središče, koliko postavk). Iskrenost filterTicketItems:
preklicane/umaknjene postavke se ne natisnejo — ponatis ne laže o
produkciji, ki je nastala. 0 DDL, 0 novih odvisnosti. Naslednji val:
Square Vol 16 (objava pričakovana sredi novembra 2026 — tedaj sveža
ocena), Toast/Lightspeed zimske objave ali B-odločitve lastnika po
»nadaljuj«.

## 31. Raziskava november 2026 (nadaljevanje 5) — STRAN KOŠARE v1.257.0 (Square Vol 15 »Choose the cart's side«)

Sveža raziskava po zaključku §30: prebrane vse tri nove Square
objave (Vol 12 · 10. 9. 2026, Vol 13 · 24. 9. 2026, Vol 15 ·
22. 10. 2026 — »Vol 16« zimskega cikla še ni na spletišču).
Tok izbere postavko iz NAJNOVEJŠE objave, ki jo naš model nosi
brez DDL.

### A) Izmere (spletna raziskava + lastno stanje)

- **Square Vol 15 (22. 10. 2026, v7.30) — 6 postavk:**
  - *Single sign-on (Okta/Entra ID, OIDC)* — podjetniška
    identiteta; naš POS je lokalni z lastnim avtorizacijskim
    motorjem (vpisna koda + pravice), OIDC ponudnika zunaj
    izvedljivosti. IZHOD.
  - *Kartični doplatek na računih* — ZDA-only (državne omejitve);
    v SI/HR je doplačilo kartice pravno občutljivo (ES direktiva o
    stroških plačil). IZHOD.
  - *Edit items with the check in view* — ŽE ZAPRTO §28 (v1.254.0).
    Pod-postavka »izbira razdelkov podrobnosti« (skrij opombe/
    davke/popuste) je premium nastavitev naših že vitkih dialogov
    (opomba/varianta/cena/preklic — vsak že pravilno ovratničen).
    Nizka dodana vrednost za malo gostilno.
  - *Nest modifier sets* (»choosing a side salad brings up dressing
    options just for that salad«, do tri ravni) — prava vrzel,
    a zahteva `Modifier.subModifierGroupId` + starševsko vez na
    `OrderItemModifier` = DDL. ZAVESTNO ODLOŽENO kot B-načrt za
    lastnikov DDL okvir (evidence: ta odstavek).
  - *Choose the cart's side of the checkout screen* — **IZBRANO**.
  - *See open checks in the Sales report* — ŽE ZAPRTO §27 (v1.253.0).
- **Square Vol 13 (24. 9. 2026) — ocena:** Apple Business Connect
  (mrežna integracija, IZHOD); revenue centers (Premium — naše cone
  tlorisa + produkcijska središča so bližina, poročilska val
  srednje velikosti, kandidat za kasneje); dark mode Retail (imamo);
  **KDS osnuti listki** (»preview tickets as items are rung in« —
  dotika ŽIVE KDS cevi, srednje velika, kandidat); KDS stolpci 4–10
  (imamo gostoto compact/normal, štetje stolpcev je kozmetika);
  enake vsote POS/nadzorna plošča (ena pot že — poročila so isti
  motor); samodejni storitvni dodatek (ZDA/Kanada; v SI dodatek za
  storitev določa lastnik z odločbo, ne avtomat — IZHOD); prednaročila
  razprodanih (reset čas = DDL na MenuItem, ODLOŽENO).
- **Square Vol 12 (10. 9. 2026) — ocena:** prenovljena mreža
  blagajne + Live Cart (pokrito v1.127/128/141 — čipi, levi rail,
  živi števec); QR dine-in zavihki čez kroge (naš QR tok je
  eno-naročilo-na-pojav; zavihki = B odločitev o toku); **nevvezani
  povratki** (»refund a card with no original sale« — FURS: storno
  mora nositi povezavo na izvirni račun, samostojno izplačilo ni
  fiskalni dokument → v SI pravno IZHOD); vlečenje listkov v zaporedje
  na KDS (ročna sekvenca — srednje, kandidat); predizbira variante +
  preskok prilagoditve per artikel (DDL na MenuItem, ODLOŽENO);
  zaporedje modifikatorjev na tisku (P3); razvrstitev po sedežih na
  tisku (imamo sedeže v1.193 — tiskalna podrobnost P3); pametni
  upsells kioska brez nastavitve (imamo ROČNI izbor — iskreneje za
  malo gostilno, §22 D).
- **Lastno stanje (izmera v valovanju):** košara prodaje ima
  ZAPISANO ZGODOVINO STRANI — v1.127 desna košara (Square), v1.128
  popravljena vidnost (≥md + fiksna mobilna vrstica), v1.141
  KOŠARA LEVO (Toast »left rail«: »natakarjevo oko ostaja na mreži«).
  Razprava levo/desno je torej NAIŠČENA v naši lastni kodi — vsak
  benchmark je rekel nekaj drugega. Square Vol 15 razreši spor tako,
  kot ga razrešujejo najboljši: **ne odloči sistem, odloči naprava**
  — »placing the cart on the left gives right-handed staff easier
  access to the item grid, while placing it on the right does the
  same for left-handed staff«. Nastavitev je per-naprava (pri nas
  vzorec `ro_sale_view`/`ro_sale_favs` — localStorage), površina
  prodaja (handheld/kiosk sta mobilna brez stranske košare).

### B) Odločitev

VAL Ž2 — stran košare na prodaji, nad obstoječimi motorji:

1. **Stanje** `saleCartSide: 'left' | 'right'`, privzeto `'left'`
   (ohranja v1.141 status quo — noben obstoječ uporabnik ne dobi
   presenetljivo zrcaljene plošče), persist `ro_sale_cart_side`
   per-naprava (isti vzorec kot ro_sale_view: queueMicrotask restore,
   validacija vrednosti, tiha odpoved v zasebnem načinu).
2. **Preklop**: segmentirana kontrola ob KARTICE/KOMPAKTNO v glavi
   prodaje — ikoni PanelLeft/PanelRight, 44 px dotik, aria-pressed,
   dvojezični naslovi (gumb z ikono samo na ozkih zaslonih, z
   besedilom od lg — enako kot zgornji preklop gostote).
3. **Postavitev**: levo = sedanje `md:grid-cols-[17rem_minmax(0,1fr)]`
   (+ lg 21rem) z mrežo `md:order-2` in košaro `md:order-1`; desno =
   zrcaljena predloga `md:grid-cols-[minmax(0,1fr)_17rem]` (+ lg)
   s PREZENJENIMA vrstnima redoma (Tailwind razredi statično v
   viru — obe veji izbrane). Mobilna (<md) postavitev NEODVISNA:
   aside je `hidden md:block`, fiksna vrstica + list ostajata.
4. **Revizija?** NE — bralna, per-naprava, brez denarne posledice
   (kost košare je videz, ne pravica). Enaka odločitev kot
   ro_sale_view/ro_sale_favs (0 revizij, 0 strežnika).
5. 0 DDL, 0 novih odvisnosti, 0 strežniških sprememb. HR prevodi.

### C) Implementacija

- **Page** (src/app/dashboard/page.tsx): stanje + persist
  ro_sale_cart_side; segmentirana kontrola (data-region
  sale-cart-side) v glavi prodaje ob preklopu gostote; pogojni
  razredi predloge mreže + order-1/order-2 zrcaljenje.
- **i18n:** sale.cartSide (skupina) + polna aria opisa
  sale.cartSideLeft/sale.cartSideRight + kratki oznaki gumba
  sale.cartSideLeftShort/sale.cartSideRightShort (sl + hr).
- **Testi:** tests/v257-stran-kosare.test.ts — A montaža vira
  (persist + validacija + preklop + aria + obe postavitveni veji),
  Ž registri (verzija, i18n pariteta 4093/4093, dokumenta §31 +
  AUDIT, 0 DDL dokaz, mobilna neodvisnost, worklog).

## 32. Raziskava november 2026 (nadaljevanje 6) — KDS OSNUTNI LISTKI v1.258.0 (Square Vol 13 »draft tickets«)

Zaključek §31 je iz Vol 12/13 ocene pustil tri kandidate
(osnuti listki, ročna sekvenca vlečenja, revenue centers).
Tok izbere OSNUTNE LISTKE: najnovejša nezaprta vrzel, ki jo
model nosi BREZ DDL in brez strežniških sprememb.

### A) Izmere (spletna raziskava + lastno stanje)

- **Square Vol 13 (24. 9. 2026) — KDS draft tickets:** »preview
  tickets as items are rung in« — listek se na kuhinjskem zaslonu
  pokaže ŽE MED VNAŠANJEM postavk (pred pošiljanjem), jasno
  označen kot osnutek. Kuhinja vidi, kaj prihaja (predpriprava,
  razporeditev zmogljivosti), a VE, da uradno še ni bila prosena
  kuhati.
- **Lastno stanje (izmera v valovanju):**
  - KDS vrsta ŽE nosi pending postavke (`ITEM_ACTIVE_DB` vključuje
    `pending`) — odprto naročilo se izriše kot NAVADEN listek v
    aktivni vrsti. Vrsta v1.233.0 (»Start queue«, Toast julij 2026)
    doda pas pilul (miza · kos · starost) nad vrsto — pasiven
    predogled obremenitve.
  - **Vrzel 1 — neločljivost:** listek brez enega samega požiga je
    na prvi pogled ENAK živemu listku: statusna pilula ODPRTO je
    vizualno enaka POSLANO (obe nevtralni kamn). Kuhar ob steni ne
    more hitro presoditi »to še ni poslano k nam«.
  - **Vrzel 2 — napačen časovnik:** odbrojevalni čas + ETA + rdeča
    eskalacija starosti tečeta od `order.createdAt` TUDI za
    nedotaknjene osnutke — listek postane »ZAMUDA« rdeč, medtem ko
    natakar še vnosa postavke. Lažni alarm na steni.
  - **Vrzel 3 — samo pilule:** VRSTA pas pokaže mizo in količino,
    ne pa postavk, opcij in alergenov — kuhinja ne more
    predpripravljati (Square prav to omogoča: polni predogled).
  - Mešani listki (del požganih, del pending) so ŽIVI listki s
    PENDING čipi na postavkah — pravilno in nespremenjeno.
- **Zavrnjene alternative tega vala:** ročna sekvenca vlečenja
  listkov (Vol 12) zahteva DELJENO stanje vrstnega reda med
  zasloni kuhinje → strežniško stanje brez obstoječega nosilca
  (StationTask.sequence je per-postavka požiga, ne per-listek) —
  tveganje DDL; revenue centers = poročilski val srednje-velike
  ločljivosti (bližina: cone tlorisa + produkcijska središča),
  kandidat za poznejši val.

### B) Odločitev

VAL Ž4 — osnutki listkov na KDS, nad obstoječimi motorji:

1. **Osnutek** (isti predikat kot VRSTA v1.233.0, per pogled
   postaje): vse ne-voided postavke listka v tej vedi so PENDING.
2. **OSNUTKI oddelek** namesto golega VRSTA pasa: zložljiv
   (privzeto ZLOŽEN = sedanje pilule, ničelna regresija gostote;
   `kds-start-queue` regija ostane), razpenjanje razkrije POLNE
   osnutek listke (Square predogled). Osnutki IZPadejo iz
   aktivne vrste — »Aktivna izmena« šteje samo kuhanje, kar je
   iskreneje; natančno kot ZASTARELO zložljiv oddelek z
   števcem in 44 px preklopom.
3. **Osnutek listek** (draft način): amber črtkan obroč + bledlo,
   značka OSNUTEK namesto statusne pilule, BREZ odbrojevalnika
   in BREZ ETA (kuhinja še ni dobila obljube — pasivna starost
   »V vnašanju: X min«, brez rdeče eskalacije tudi na postavkah),
   tiskanje ostane (predpriprava), bump-CELEGA-listka SKRIT
   (»vse pripravljeno« na nečem, kar ni bilo poslano, je vektor
   pomote); posamezne postavke ostanej tap-karte (kuhar LAHKO
   začne zgodaj — izrecno dejanje, listek organično zapusti
   osnutke, ko prva postavka zapusti PENDING).
4. **Organic promocija:** požig iz POS (ali zgodnji začetek
   kuharja) prestavi listek iz OSNUTKOV v aktivno vrsto v istem
   izrisu — predikati se računajo ob vsakem renderju, brez
   dodatnega stanja.
5. **Prazno stanje** »kuhinja čista« upošteva samo ne-osnutke —
   če so na zidu samo osnutki, je kuhinja iskreno čista.
6. **Revizija?** NE — bralna vizualna plast, 0 denarne
   posledice, 0 strežniških sprememb (vrsta ŽE nosi pending
   postavke in SSE podpis že udari ob vsaki spremembi postavke).
   Enaka odločitev kot §31 B4.
7. 0 DDL, 0 novih odvisnosti, 0 strežniških sprememb. HR prevodi.

### C) Implementacija

- **Page** (src/app/dashboard/page.tsx): stanje `kdsDraftsOpen`
  (privzeto false, vzorec kdsStaleOpen); OSNUTKI oddelek
  (data-region kds-drafts, aria-expanded/controls, števec);
  `renderKdsTicket(o, draft)` — draft veja (obroč, značka,
  pasivna starost, brez odbrojevalnika/ETA/bump); kdsActive in
  prazno stanje izločita osnutke; pilule ostanejo v zloženem
  stanju (kds-start-queue).
- **i18n:** kds.draftSection, kds.draftSectionHint,
  kds.draftBadge, kds.draftHint, kds.draftWaiting,
  kds.draftAge (sl + hr, 4093 → 4099).
- **Testi:** tests/v258-kds-osnutki.test.ts — A montaža vira
  (oddelek + preklop + draft veja + izločitve + pilule
  ohranjene), Ž registri (verzija, i18n pariteta 4099/4099,
  dokumenta §32 + AUDIT, 0 DDL dokaz, 0 strežniških sprememb,
  worklog).

## 33. Raziskava november 2026 (nadaljevanje 7) — VEDNO VIDNO NAROČILO NA MOBILNIH POVRŠINAH v1.259.0 (Lightspeed »slide-out menu layer«)

### A) Izmere (spletna raziskava + lastno stanje)

- **Lightspeed K-Series What's New november 2026 — »Keep active
  orders visible while browsing menus«:** »A new slide-out menu
  layer on handheld POS devices. The menu opens over the active
  order tab, allowing staff to pull up or collapse the view to
  check added items while browsing, reducing screen toggling and
  speeding up service during busy shifts.« Natakar na ročnem
  terminalu med brskanjem menija vidi stanje naročila BREZ
  preklapljanja zaslonov.
- **Lastno stanje (izmera v valovanju):** obe mobilni površini
  (handheld `/handheld` ORDER pogled + tablica `/tablica` listek)
  postavita OBSTOJEČE postavke naročila v isti drseči vsebnik
  kot meni — drseči seznam obstoječih postavk je NAD iskalnikom,
  potem pa pridejo kategorije in mreža artiklov. Ko natakar
  drsi po meniju (glavna dejavnost pogleda), obstoječe postavke
  ODPADEJO iz pogleda — »did I already ring in a Bograč?« terja
  vrnitev na vrh (drsanje nazaj) ali preklop zaslona. Točno
  vrzel, ki jo Lightspeed zapira s slide-out plastjo. Košarica
  NOVIH postavk je sicer že lepljiva na dnu (conca palca), a
  obstoječe (poslane) postavke niso vidne nikjer med brskanjem.
- **Ocena drugih novosti istega članka (november 2026):** zaklep
  KDS zaslonov — ŽE ZAPRTO v1.244.0 (§18 B, ista referenca);
  prenova tlorisa (strežniške značke — ŽE §18 C, časi/zneski/
  gostje na ploščicah — ŽE v1.129/232, panning/pinch-zoom so
  gesto tabletne aplikacije, naš tloris je namenjen miški);
  oznake alergenov/opomb na posamezni postavki — ŽE pokrito
  (opomba + rdeče alergensko opozorilo na postavki, Issue #7,
  viden na KDS + tisku); AI klepet v Pulse aplikaciji — zunanj
  LLM v produkciji gospodinjskega POS-a je arhitekturna odločitev
  višje ravni (B-načrt, ne ta val); rezervacijske kapacitete +
  kombinacije miz (Lightspeed Reservations) — rezervacijski val
  z DDL tveganjem (združevanje miz), ODLOŽENO.
- **Toast (oktober 2026):** Grid KDS (nova izkušnja za hitre
  lokale — večja prenova izgleda KDS) in »KDS load balancing«
  (prevzemanje listkov med identičnimi postajami zahteva DELJENO
  stanje med zasloni → strežniško stanje, tveganje DDL) — oba
  ocenjena kot kasnejša kandidata; Square Vol 16 po novi oceni
  ŠE ni objavljen (zimski cikel).

### B) Odločitev

VAL Ž3 — vedno vidno naročilo na obeh mobilnih površinah, nad
obstoječimi motorji:

1. **Vrstica naročila (zložljiva, LEPILJIVA):** obstoječi drseči
   seznam postavk se prenese v ZLOŽLJIVO sekcijo, pripeto na vrh
   drsečega območja menija (`sticky top-0`) — med brskanjem
   OSTAJE vidna ena vrstica povzetka, razpenjanje razkrije poln
   seznam. To je naš prevod Lightspeed slide-out plasti: povzetek
   naročila je vedno v pogledu, podrobnosti en dotik stran.
2. **Zložena vrstica (44 px):** števec postavk + znesek naročila
   + NAJBOLJ RELEVANTNA faza (priprava: »N v pripravi« amber /
   pripravljeno: »N pripravljenih« emerald — nič med PENDING in
   SERVED) + puščica. Edina resnica so obstoječi podatki
   (`openOrder`/`activeItems`) — nič ni izračunanega dvakrat.
3. **Razprta sekvenca:** poln seznam z obstoječimi statusnimi
   pilulami (handheld) oz. cenovnimi vrsticami (tablica),
   `max-h` z lastnim drsanjem — meni OSTAJE pod plastjo, ne
   izgine (Lightspeed: »menu opens over the active order tab«).
   Zloži se z istim 44 px dotikom. Prazno naročilo in nov listek
   (brez odprtega naročila) vrstice NE nosijo — stanje ostane
   iskreno (prazen seznam ostane kot prej, izven plasti).
4. **Stanje:** prehodno pomnilniško stanje per obisk (enako
   `noteOpen`) — BREZ persist; to je trenutna plast brskanja, ne
   nastavitev naprave. Privzeto ZLOŽENO ( povzetek je novi
   status quo — popoln seznam je bil prej viden le do prvega
   drsenja).
5. **Dostopnost:** `aria-expanded`/`aria-controls`, 44 px dotik,
   `ChevronDown` rotacija, `data-region` oznake (hh-order-bar,
   tlb-order-bar) po vzorcu ostalih regij.
6. **Revizija?** NE — bralna vizualna plast, 0 denarne
   posledice, 0 strežniških sprememb (naročila in mize se ŽE
   nalagajo na obe površini). Enaka odločitev kot §32 B6.
7. 0 DDL, 0 novih odvisnosti, 0 strežniških sprememb. HR
   prevodi. Kiosk izvzet (samo-naročanje gosta, eno naročilo na
   sejo — vrstica nima pomena).

### C) Implementacija

- **Handheld** (src/app/handheld/page.tsx): stanje
  `orderBarOpen` (privzeto false); ORDER pogled — obstoječi
  seznam postavk `activeItems` se izrise ZNOTRAJ zložljive
  lepljive sekcije (data-region hh-order-bar; gumb-po-celotni
  širini povzetek + razprta veja z max-h-64 overflow-y-auto);
  povzetek: števec + znesek + faza (priprava/pripravljeno)
  + puščica; statusne pilule postavk nespremenjene.
- **Tablica** (src/app/tablica/page.tsx): isto stanje
  `orderBarOpen`; obstoječi seznam v listku (Sheet) preide v
  enako zložljivo lepljivo sekcijo (data-region tlb-order-bar,
  max-h-56); vrstice brez statusnih pilul (status quo te
  površine — hiter način).
- **i18n:** hh.orderBar ({n} na računu), hh.orderBarPrep
  ({n} v pripravi), hh.orderBarReady ({n} pripravljenih),
  hh.orderBarAria, tlb.orderBar, tlb.orderBarAria
  (sl + hr, 4099 → 4105).
- **Testi:** tests/v259-handheld-vedno-vidno.test.ts — A montaža
  vira (obeh površin: lepljivost, zloženi povzetek, razpenjanje,
  izločitve praznega/novega naročila), Ž registri (verzija,
  i18n pariteta 4105/4105, dokumenta §33 + AUDIT, 0 DDL dokaz,
  0 strežniških sprememb, worklog).

## 34. Raziskava november 2026 (nadaljevanje 8) — PRIHODKOVNI CENTRI v1.260.0 (Square Vol 13 »revenue centers«)

### A) Izmere (spletna raziskava + lastno stanje)

- **Square Vol 13 (september 24, 2026) — »Create revenue centers
  to group and compare sales«:** »A revenue center is one part of a
  business — a bar, a patio, or a delivery channel. Sellers assign
  devices, floor plan sections, and channels to each, so orders are
  counted in the right place automatically. Grouping the Sales
  summary report by revenue center then shows how each area
  performed.« Vrednost: »When every part of a business feeds one
  sales total, there's no way to tell which areas are carrying the
  day and which are dragging it down. Revenue centers give each
  area its own line in reporting, so staffing and menu decisions
  rest on real numbers.« Dostop pri Square: Premium naročnina +
  dovoljenje Manage revenue centers; selitev posameznega naročila
  v drug center prek Order Manager.
- **Sveža raziskava november 2026 (stanje ob valu):** Square Vol 16
  ŠE NI objavljen (zadnji vnos release notes stran je oktober 22 =
  Vol 15, že obdelan v §27/§28/§31); tweet napoveduje prihodnjo
  objavo »Allergy and dietary preferences by seat« — ni izmerljiv
  benchmark, dokler ni objavljen. Toast Fall 2026 (oktober 6) =
  Toast IQ AI agenti (urniki/SEO/recenzije/ponudbe) — zunanj LLM v
  produkciji gospodinjskega POS-a ostaja arhitekturna odločitev
  višje ravni (B-načrt, isto kot §33). Lightspeed K-Series What's
  New november 2026 obdelan v §33. ⇒ IZBRAN odloženi kandidat
  v1.258.0: »revenue centers (kasnejši val)«.
- **Lastno stanje (izmere po kodi):** RevenueCenter model OBSTAJA
  (id/name/code/isActive/sortOrder/locationId/propertyId; relacije
  MenuItem/Order/Table/Property) a brez CRUD poti, brez UI forme,
  brez seederja — uporablja ga SAMO enterprise drevo za štetje
  (ent.rcCount). Order.revenueCenterId in Table.revenueCenterId se
  NIKOLI ne nastavita (0 zadetkov v src/). Poročila ne grupirajo
  po NIČEMER prostorskem/kanalnem: X/Z in summary po dnevih/DDV/
  plačilih, sales-by-hour po urah, tempo PO POSAMEZNI mizi, edina
  groupBy v poročilih sta vatRate in zaposleni. Hkrati pa:
  Table.area je ŽE cona z urejevalnikom (preimenuj/združi +
  ZONE_RENAME revizija, v1.233.0 §4) in demo vrednostmi (Glavna
  dvorana/Bar/Šank/Terasa/VIP loža), Order.type je ŽE kanal
  (DINE_IN/TAKEAWAY/DELIVERY, strogo validiran od v1.238.0 §15).
  Vrzel: lastnik vidi EN sam skupni promet — katera cona nosi dan
  in katera vleče navzdol NI odgovorljivo iz nobenega poročila.

### B) Odločitev

VAL Ž4 — prihodkovni centri kot IZPELJAVA OB BRANJU (0 DDL):

1. **Center = cona mize ali kanal naročila, izpeljano ob branju:**
   DINE_IN z mizo → cona mize (Table.area); TAKEAWAY → kanal
   ODNES; DELIVERY → kanal DOSTAVA. To je ista avtomatika, ki jo
   obljavlja Square (»orders are counted in the right place
   automatically«) — cona mize JE vezava na odsek tlorisa, vrsta
   naročila JE kanal. Odpovedana alternativa (poštena navedba):
   upravna plast po Square vzorcu (CRUD centrov + dodelitev
   odsekov/naprav + selitev posameznega naročila v Order Manager)
   — zavrnjena ZA TA VAL: prinesla bi admin UI + selitveno
   logiko + praznino za vso obstoječo zgodovino (Order.
   revenueCenterId se ne piše); izpeljava deluje nad VSO
   zgodovino DANES. POMEMBNO: preimenovanje/združitev cone
   (ZONE_RENAME) združi tudi pretekle naročila pod novo ime —
   enako obnašanje kot pogled miz po conah; sprejemljivo (cone se
   preimenujejo redko, združitev je želena posledica).
2. **Kartica v zavihku Računi** (dom poročila o prodaji — portal +
   X/Z + seznam računov), NE v X/Z samoživo: X/Z je fiskalni
   zaključek, grupiranje po centru je poslovni vpogled (B-načrt:
   vključitev v zz, če lastnik izrecno želi). Obdobje NADZORUJE
   zavihek (iste from/to kot portal in seznam — Issue #94 vzorec);
   kartica nima lastnih datumov.
3. **Vrstice:** naročil (števec), bruto, neto (bruto − DDV),
   napitnine, povprečni račun, delež neto z deležno vrstico.
   Vrstni red po neto padajoče (»who is carrying the day«); cone
   pred kanali; PRAZNE cone/kanali ostanejo vidne (mrtvo območje
   je informacija — Square izrise vse centre). DINE_IN brez mize
   (robni primer, naj ne bi nastal) → »Brez mize«, SAMO če ni
   prazen.
4. **Strežnik:** GET /api/reports/revenue-centers?from&to —
   requirePermission reports.sales + locationScope (Issue #4 §1)
   + samo PLAČANA naročila (paidAt v oknu — isti diskont kot
   financial/sales-by-hour; performance = realizirana prodaja);
   groupBy type+tableId (stolpca na Order, brez joina) + preslikava
   miza→cona. READ-ONLY: 0 mutacij, 0 revizij (bralno poročilo,
   enaka odločitev kot §32 B6). Zajem con = distinct Table.area.
5. **Dostopnost/oblika:** data-region oznake (revenue-centers-card,
   rc-row, rc-total-row, rc-window, rc-empty, rc-error, rc-skeleton),
   aria-label osveževanja, sr-only delež, tabular-nums, odzivni
   stolpci (bruto/povprečje skriti <sm, napitnine <md), kanala
   pozivata OBSTOJEČA order.type.TAKEAWAY/DELIVERY ključa (en vir
   resnice — 0 duplikatov prevodov).
6. **Izločitve:** kiosk izvzet (izrazito prevzemno — se šteje v
   kanal po vrsti naročila), QR meni pa DIHNE z mizo v cono (isto
   kot pogled miz). Enterprise RevenueCenter drevo NI dotaknjeno
   (števec ostaja; polna sinteza enterprise-centrov z izpeljanimi
   conami = kasnejši kandidat, če bo potrebna večlokacijska
   primerjava).
7. 0 DDL (modeli/stolpci predhodno obstajajo in ostajajo
   neizkoriščeni), 0 novih odvisnosti, 0 strežniških sprememb
   obstoječih poti (SAMO nova read-only ruta). HR prevodi
   (rc.* ×16, 4105 → 4121).

### C) Implementacija

- **Strežnik** (src/app/api/reports/revenue-centers/route.ts): from/
  to (privzeto danes, enak pars vzorec kot export), scope
  locationScope, groupBy ['type','tableId'] _sum total/tax/tip +
  _count nad paymentStatus='paid' ∧ paidAt ∈ [from, to]; preslikava
  miza→cona prek findMany tabel; zagotovljene vrstice za VSE cone
  (distinct area) + oba kanala; neto = total − tax; delež =
  neto/skupno neto (0,1 % natančnost); razvrstitev neto ↓ → vrsta
  (cone/kanali) → ime; skupna vrstica (totals). Odgovor: { from,
  to, rows[{key, kind: zone|takeaway|delivery|none, label,
  orders, gross, net, tips, avgCheck, share}], totals }.
- **UI** (src/components/tabs/revenue-centers-card.tsx, montaža v
  dashboard/page.tsx racuni zavihek takoj za portalom, gating
  reports.sales): tabela s stolpci Center (ime + značka cona/
  kanal) · Naročil · Bruto (≥sm) · Neto · Napitnine (≥md) ·
  Povpr. račun (≥sm) · Delež (vrstica: cona emerald, kanal amber,
  brez mize stone); okno obdobja v glavi; osveži gumb; skeleton/
  napaka/prazno stanje; izvoz v bodočih valovih po potrebi.
- **i18n:** rc.title, rc.desc, rc.zone, rc.channel, rc.none,
  rc.colCenter, rc.colOrders, rc.colGross, rc.colNet, rc.colTips,
  rc.colAvg, rc.colShare, rc.total, rc.empty, rc.loadErr,
  rc.ariaShare (sl + hr, 4105 → 4121; kanala odnes/dostava iz
  order.type.*).
- **Testi:** tests/v260-prihodkovni-centri.test.ts — A strežnik/
  kartica montaža vira (izpeljava cona/kanal, paid filter, pravice,
  from/to validacija, data-regioni, deležne vrstice, izločitve),
  Ž registri (verzija 1.260.0 + compose, i18n pariteta 4121/4121,
  dokumenta §34 + AUDIT, 0 DDL dokaz, read-only dokaz, worklog).

## 35. Raziskava november 2026 (nadaljevanje 9) — SEDEŽI NA KUHINJSKEM LISTKU v1.261.0 (Square Vol 12 »razvrstitev po sedežih na tisku«)

### A) Izmere (spletna raziskava + lastno stanje)

- **Zaključek §34 je pustil prazen A-razred:** Square Vol 16
  ŠE NI objavljen (zimski cikel, pričakovana objava sredi novembra
  2026 — tedaj sveža ocena); Lightspeed K-Series november 2026 je
  obdelan v §33; Toast oktober 2026 ima samo dva kandidata — KDS
  load balancing zahteva DELJENO stanje med zasloni (DDL tveganje,
  zavrnjeno §32/§33), Grid KDS pa je »večja prenova izgleda KDS«
  za hitre lokale (QSR) brez izmerljivega javnega vira podrobnosti
  (poskus merjenja 5. 11. 2026: natanko-dovoljen iskalni izraz
  »Grid KDS« 0 javnih zadetkov; pos.toasttab.com/last-updates za
  Cloudflare preverbo) — implementacija po ugibanju bi kršila
  načelo izmer, ne ugiban. Ostane ODLOŽEN.
- **Sveža raziskava (stanje 5. 11. 2026):** Square release notes
  spletišče nedosegljivo za merjenje (prazen odgovor); Bing/DDG
  vračata sabotažne rezultate — izhodišče ostajajo LASTNE izmere
  §31 (vsi trije voli 12/13/15 so bili takrat prebrani v celoti).
  ⇒ IZBRAN zadnji neizvedeni Vol 12 P3: »razvrstitev po sedežih
  na tisku« (ocena §31: »imamo sedeže v1.193 — tiskalna
  podrobnost P3«).
- **Lastno stanje (izmere po kodi):** OrderItem.seat obstaja od
  v1.193.0 (P3 #20; Int?, 1..10, ničen = brez dodelitve), pisanje
  pa teče iz TREH tokov — aktivni sedež pri naročanju (N-27-1,
  v1.195.0: handheld + urejevalnik), ročna dodelitev v plačilnem
  dialogu (PATCH /seats + razdelitev izstavkov po sedežih) in
  offline vrsta (/api/sync). A je sedež VIDEN samo v plačilnem
  dialogu: buildKitchenTicketLines (print.ts) polja sploh ne
  pozna (0 zadetkov »seat« v datoteki), KDS vrstica postavke
  prav tako ne. Kuhinja — površina, kjer sedež nosi NAJVEČ
  informacije (»gost na sedežu 3 ima alergijo na lešnike«) —
  ne vidi, kateri sedež je kaj naročil, ne na zaslonu, ne na
  tisku. Vrzel: podatki obstajajo, produkcija jih ne dobi.

### B) Odločitev

VAL Ž6 — sedeži na kuhinjskem listku (0 DDL, 0 novih rut):

1. **Grupiranje na listku je POŠTENO do zgodovine:** SAMO če je
   v (že strežniško filtriranem) nizu ≥ 2 RAZLIČNIH sedežev,
   listek dobi odseke `── SEDEŽ N ──` (naraščajoče; Square:
   »tickets print items grouped by seat«). Pri 0–1 sedežu je
   izhod BYTE-IDENTIČEN prejšnjemu — večina listkov nima
   sedežev, ničelna regresija. Postavke BREZ sedeža sledijo za
   odseki BREZ glave (neizpostavljeno ≠ sklep; lažna glava
   »brez sedeža« bi zvenela kot trditev).
2. **KDS zaslon dobi čip sedeža** na vrstici postavke (isto
   valovanje, isti vir resnice): stone čip »Sedež N« SAMO ko
   seat ≠ null, ob postaji, pred alergenskimi čipi; ključ
   `payment.seatsAssign` re-uporabljen iz plačilnega dialoga —
   0 duplikatov prevodov (vzorec order.type.* iz §34).
3. **Serializacija:** mapOrderItem aditivno izpostavi seat
   (?? null) — skalarno polje teče z obstoječimi include brez
   spremembe poizvedb; OrderItemT (dashboard) dobi `seat?`.
   Obe tiskalni mesti (KDS plošča + §30 ponatis) preslikata
   sedež v builder; ponatis zaprtega naročila s sedeži TUDI
   rekonstruira odseke (dokument v sporu nosi isto resnico).
4. **Station filter ostaja nad grupiranjem** (bar list skupine
   šteje SAMO bar postavke — sedeži se štejejo znotraj že
   filtriranega niza) in Št. artiklov šteje vse filtrirane
   postavke neodvisno od odsekov.
5. **0 DDL** (OrderItem.seat od v1.193.0), 0 novih odvisnosti,
   0 strežniških sprememb poti (samo aditivna serializacija),
   0 mutacij/revizij (bralna plast). Tiskalna besedila so SL
   literali po konvenciji (Miza/Natakar/opomba) — 0 novih
   i18n ključev; števci 4121 nespremenjeni.

### C) Implementacija

- **Lib** (src/lib/devices/print.ts): tip postave + `seat?`;
  seatOf (finite number → številka, sicer null); distinctSeats
  ≥ 2 → groupBySeat (Map sedež→postavke, naraščajoče, brez
  sedeža na konec brez glave); emitItem izvleče obstoječe telo
  postavke (opcije/alergeni/opomba nedotaknjene znotraj odsekov);
  ≤ 1 sedež → izvirna zanka (byte-identično).
- **Serializacija** (src/lib/map.ts): mapOrderItem + seat
  (`?? null`, komentar §35).
- **UI** (src/app/dashboard/page.tsx): OrderItemT + `seat?`;
  printKitchenTicket + confirmReprint preslikata `seat: it.seat
  ?? null`; KDS čip (data-region kds-seat-chip) pogojno na
  seat ≠ null.
- **Testi:** tests/v261-sedezni-listki.test.ts — Č1 čisti sloj
  (brez sedežev = byte-identično, en sedež = brez glav, ≥ 2 =
  odseki naraščajoče + brez sedeža na koncu, station filter +
  grupiranje skupaj, opcije/alergeni znotraj odsekov, ponatis +
  sedeži sooplastična, Št. artiklov vse), Č2 serializacija
  (seat null-safe), Ž montaža + registri (obe mesti preslikata,
  čip pogojen, 0 DDL dokaz, verzija 1.261.0, dokument §35,
  AUDIT 0 ključev, worklog Task ID).

## 36. Raziskava november 2026 (nadaljevanje 10) — ZAPOREDJE MODIFIKATORJEV NA TISKU v1.262.0 (Square Vol 12 »zaporedje modifikatorjev na tisku«)

### A) Izmere (evidence §31 + lastno stanje)

- **Sklep §35 je A-razred pustil praznega do naslednjih objav**
  (Square Vol 16 pričakovan sredi novembra 2026; Toast Grid KDS
  brez izmerljivega vira; KDS load balancing = DDL). Sveža
  raziskava istega dne (5. 11. 2026, dokumentirana v §35: Square
  release notes nedosegljivo, izhodišče lastne izmere) velja TUDI
  za ta val — med obema valu NI minilo merjenja. ⇒ IZBRAN
  zadnji neizvedeni Vol 12 P3 iz ocene §31: »zaporedje
  modifikatorjev na tisku« (ocena §31: enostavno P3 tiskalne
  plasti — sestrski kandidat »razvrstitev po sedežih« je zaprl
  §35).
- **Lastno stanje (izmere po kodi):** `OrderItemModifier` hrani
  `sortOrder`, a se PIŠE kot `idx` — vrstni red NATAKARJEVIH
  klikov (oba pisalca: createOrderCore ops.ts, PATCH dodajanje
  postavk orders/[id]); bralcev vrstičnega `sortOrder` NI
  (mrtvo polje ob branju — edini bralni `sortOrder` v sistemu je
  na MENU plasti: /api/modifier-groups). Tiskalni listek
  (print.ts emitItem → `+ ime`), KDS vrstica postavke in
  urejevalnik naročila izrisujejo opcije v VRSTNEM REDU VNOSA
  vrstic = vrstni red klikov. Hkrati kanonski vrstni red MENIJA
  OBSTAJA in je TAKO, kot ga natakar vidi v variantnem dialogu:
  skupine po `ModifierGroup.sortOrder` (ime pri izenačitvi),
  znotraj skupine po `Modifier.sortOrder` (ime pri izenačitvi) —
  natanko to urejanje vrača /api/modifier-groups (orderBy
  [sortOrder, name] na obeh ravneh), ki ga dialog prikaže.
  POSLEDICA (izmerjena vrzel): ISTA jed natisne »+ slanina /
  + 0,5 L« ali »+ 0,5 L / + slanina« glede na to, kaj je
  natakar prej kliknil — velikost, ki jo dialog pokaže PRVO, je
  na listku včasih ZADNJA; kuhar skenira nedosledne listke.
- **Odloženi kandidati ostajajo pošteno odloženi:** ročna
  sekvenca vlečenja na KDS (§31/§32: deljeno stanje brez
  nosilca → DDL), gnezdene skupine opcij (§31: DDL), predizbira
  variante per artikel (§31: DDL na MenuItem), Toast Grid KDS
  (§35: brez vira), load balancing (DDL), Toast IQ (zunanji LLM,
  B-načrt), Square »Allergy and dietary preferences by seat«
  (tweet §34 — neobjavljeno, brez izmere).

### B) Odločitev

VAL Ž7 — zaporedje modifikatorjev na tisku kot KANONSKI
POSNETEK OB PISANJU (0 DDL, 0 novih rut, 0 novih odvisnosti):

1. **Vrstni red postane del posnetka vrstice.** OrderItemModifier
   ŽE je posnetek (name/price/groupName se zamrznejo ob
   naročilu — kasnejša sprememba menija NE spreminja zgodovine,
   dokazano v1.209/210 OSS-10). Vrstni red ureditve gre v ISTO
   zamrznitev: ob pisanju se izbrani modifierji uredijo po
   MENIJSKEM vrstnem redu (groupSort, groupName, modSort, ime —
   točno dialogovo urejanje iz /api/modifier-groups) in `sortOrder`
   vrstice postane kanonska pozicija (prej: pozicija klika).
   Polje `sortOrder` nima bralcev — prepis pomena ob pisanju je
   aditiven.
2. **Ena točka kanonizacije pokrije VSE vire:** čista funkcija
   `orderModifiersForSnapshot()` v modifiers.ts; pokličeta jo
   OBA pisalca (createOrderCore — POS + offline sync + QR/kiosk
   + spletni portal, ki vsi tečejo skoznjo; PATCH dodajanje
   postavk). Validacija (validateItemModifiers) ostaja VALIDATOR
   — njeno odločanje se ne meša s politiko urejanja.
3. **Bralna plast (map.ts mapOrderItem): stabilna ureditev po
   vrstičnem `sortOrder`** (manjkajoč izbor → ?? 0 → stabilno =
   vhodni red). Nove vrstice: kanonsko. Stare vrstice: sortOrder
   = vrstni red klikov = vrstni red vnosa → izhod ENAK
   prejšnjemu (ničelna regresija zgodovine — ponatis zaprtega
   naročila ostane TAKO, kot je bil izvirni listek). Select
   `sortOrder: true` se DODA na 5 vključitvenih mest, ki napajajo
   serializacijo (ops orderInclude, kitchen ×3, orders/[id]) —
   eksplicitna invarianta namesto zanašanja na nedokumentiran
   vrstni red SQLite brez ORDER BY (relacijski include brez
   orderBy je po specifikaciji NEDOLGOČEN).
4. **Poročilske površine izven merjene vrzeli** (shifts,
   daily-email, dashboard top-liste) ostajajo nedotaknjene —
   vrzel je LISTEK (print + KDS + urejevalnik); obseg P3 ne
   zateče v poročila.
5. **0 DDL** (vsa polja obstajajo: OrderItemModifier.sortOrder /
   ModifierGroup.sortOrder / Modifier.sortOrder), 0 novih
   odvisnosti, 0 sprememb poti, 0 UI sprememb (listek in KDS
   že izrisujeta `modifiers[]` — spremeni se VSEBINA vrstnega
   reda, ne izris), 0 i18n ključev (števci 4121 nespremenjeni;
   čisti strežniški val).

### C) Implementacija

- **Lib** (src/lib/modifiers.ts): ResolvedModifierOut aditivno
  `groupSort`/`modSort` (iz DB: ModifierGroup.sortOrder /
  Modifier.sortOrder — chosen vrstice že nosijo include
  ModifierGroup; defenzivno Number.isFinite → 0); ModifierRow
  aditivno sortOrder/groupSort; nova čista funkcija
  orderModifiersForSnapshot(resolved) — stabilna ureditev po
  (groupSort, groupName, modSort, name); prazna/v enem
  elementu → ista referenčna vsebina.
- **Pisalci:** ops.ts (createOrderCore: resolved → urejanje →
  vrstice; sortOrder = kanonska pozicija) +
  orders/[id]/route.ts (PATCH dodajanje: enako pred map).
- **Bralci** (src/lib/map.ts): mapOrderItem uredi vrstice po
  (sortOrder ?? 0) stabilno PRED map v imena; 5 vključitvenih
  mest dobi `sortOrder: true` v select.
- **Registri:** PRIMERJAVA §36 (ta odstavek) + AUDIT
  POSODOBITEV v1.262.0 (0 ključev); verzija 1.261.0 →
  1.262.0 (version.ts + compose + pini testov s klasifikacijo
  zadetkov).
- **Testi:** tests/v262-zaporedje-modifikatorjev.test.ts —
  Č1 čisti sloj (prazno/en element, ureditev po skupinah,
  znotraj skupine, izenačitve po imenu na obeh ravneh,
  stabilnost ob enakih ključih, defenzivno NaN/undefined,
  permutacijska neodvisnost), Č2 serializacija (mapOrderItem
  ureja po vrstičnem sortOrder, manjkajoč izbor → stabilno
  vhodno, duplikatni ključi stabilno), Ž montaža + registri
  (oba pisalca pokličeta urejanje, 5 select mest, 0 DDL dokaz,
  verzija 1.262.0, dokument §36, AUDIT 0 ključev, worklog
  Task ID).

## 37. Raziskava november 2026 (nadaljevanje 11) — SKRIVANJE NIČELNIH POSTAVK NA RAČUNU v1.263.0 (Square Vol 16 »Hide $0 items from printed customer receipts«)

Sveža raziskava 6. 11. 2026 (dan po zaključku §36): release-notes
vozlišče nosi NOVO objavo — **Square Vol 16 | 5. 11. 2026 | v7.32**
»Draggable ticket reordering, Expo course firing, faster account
switching, and more« (objavljeno PO zadnji raziskavi 5. 11. zjutraj
ob 4:30 ET — zadetek v pričakovano okno 5.–12. 11.). Devet postavk,
ocena vseh; tok izbere postavko, ki jo naš model nosi z najmanjšim
obsegom in natančno izmerljivo semantiko.

### A) Izmere (spletna raziskava + lastno stanje)

- **Square Vol 16 (5. 11. 2026, v7.32) — 9 postavk, ocena:**
  - *Draggable ticket reordering on KDS* (Prep + Expo zasloni,
    vrstni red »Manual« per naprava, sekvenca se shrani in sinhronizira
    na druge KDS naprave iste lokacije z istim načinom) — PRAVA vrzel,
    a zahteva DELJENO stanje vrstnega reda listkov med zasloni →
    nosilec, ki ga Order nima (ticketSequence) = DDL + vlečenje +
    sinhronizacija. SREDNJE-VELIKO; odkljukano za naslednji val (danes
    izmerjena semantika: per-naprava način Manual/Default je vzorec
    localStorage saleCartSide §31, deljena sekvenca pa strežniški
    stolpec).
  - *Fire held courses from an Expo KDS* (tap glave tečaja na Expo
    KDS → odštevanje → drugi tap prekliče; nastavitev per lokacija
    »Allow Firing from Expo KDS«) — naša koda ŽE ima: skupno jedro
    `fireOrderCore` + `POST /api/orders/[id]/fire {courseId}` (OSS-7
    coursing) + KDS glave tečajev (`groupKdsItemsByCourse`,
    kds-course-group regija od §32 obdobja). Vrzel: požig tečaja teče
    SAMO iz POS urejevalnika (fireCourse v NaročiloSheet), KDS glava
    je pasiven napis; pravice: fire zahteva orders.create (natakar),
    KDS nosi kitchen.update (kuhinja) — požig s KDS je ODLOČITEV o
    pristojnosti (ekspeditor je vloga kuhinje pri Square, pri nas
    natakarja). SREDNJE; kandidat naslednjega vala (danes izmerjena
    semantika: countdown-potrditev + per-lokacija nastavitev).
  - *Switch faster between Square accounts* — podjetniška
    multi-account identiteta; naš POS je eno-najemniški z vpisno kodo.
    IZHOD.
  - *Sync reservations, guests, and checks with Resy Powered by Tock*
    — zunanja integracija (C-razred mreža/partnerji, US, Premium).
    IZHOD.
  - *Accept bank payments on Payment Links* — ACH/Plaid, US-only;
    ponudnik plačil = B-odločitev. IZHOD.
  - *Set item option colors from the item page* — maloprodajna barvna
    paleta opcij; naši modifikatorji so restavratorski (velikost/
    dodatek/stopnja) brez barvnih opcij. IZHOD (brez izmere — model
    nosilca sploh ne obstaja in ni vrzel za gostilno).
  - *Split pooled tips by points assigned to each role* — naše stanje:
    `/api/tips` ŽE podpira `method=hours|equal|points` z vnosom
    točk PER OSEBA (methodWeights points veja, POST body `points`) —
    MATEMATIKA točkovne delitve je IZVEDENA. Preostala delta: Square
    dodeli točke VLOGI (enkrat nastavljeno, član sledi svoji vlogi),
    pri nas se točke vnesejo per oseba per dan. Iskrena ocena: jedro
    pokrito, delta je priročnostna predpolnitev (role → točke) —
    kandidat NIZKE prioritetе, ne vrzel.
  - *Hide $0 items from printed customer receipts* — **IZBRANO** (spodaj).
  - *Treasury Tipped Occupation Code* — zvezni davčni obrazci ZDA.
    IZHOD.
- **Square »Hide $0 items« — izmerjena semantika (dobesedno):** »Sellers
  choose whether items added at $0, like a complimentary basket of
  bread or a glass of water, print on customer receipts. Printed
  receipts list $0 items unless a seller turns this off. **Paid items,
  items discounted or comped to $0, and $0 items with a paid modifier
  still print.** Kitchen tickets, merchant copies, transaction records,
  reports, exports, and email and text receipts include $0 items either
  way.« Nastavitev je RAČUNOVODSKA (Account & Settings > Payments >
  Receipts) — nad poslovanjem, ne per naprava.
- **Lastno stanje (izmere po kodi):** posnetek računa (itemsJson,
  v1.239.0 §16 C) nosi `amount = unitPrice × quantity`, kjer je
  unitPrice = OrderItem.price = ZAMRZNJENA menijska cena + vsota cen
  opcij (ops.ts: `price: price + modsTotal`) — popusti so LOČENO
  (skupna vrstica popusta, vatBreakdownAfterDiscount). POSLEDICA
  (vse tri Square izjeme so pri nas AVTOMATSKE): jed dodana po ceni 0
  brez plačanih opcij → amount 0 (edini kandidat za skrivanje); jed
  zplačano opcijo (npr. voda 0 + sirup 0,50) → price 0,50 → PIŠE;
  jed z dinarskim popustom do 0 → price ostane > 0, popust v skupni
  vrstici → PIŠE; jed s §23 spremembo cene from → to 0 → priceOverride
  žig prisoten → POSED natakarja (comp) → PIŠE. Storno (predznak −1):
  amount 0 ostane 0 v obeh smereh — filter je simetričen (zrcalo
  istega dokumenta). Voided postavke na računu NIKOLI niso bile
  (filtrirane pred posnetkom) — pred-postavka, ne vrzel.
  IZRIS: buildReceiptHTML izriše VSE d.items brez pogoja; ESC-POS
  agent pot v printInvoice preslika r.items 1:1. Kuhanjski listki
  (buildKitchenTicketLines) niso dotaknjeni — pravilno po Square.
- **Odloženi kandidati Vol 16 (pošteno naštet):** draggable ticket
  reordering (deljena sekvenca → DDL + vlečenje; naslednji kandidat,
  semantika dana zgoraj), Expo fire held courses (pristojnostne
  pravice + countdown + per-lokacija nastavitev; KDS glave tečajev
  že obstajajo), tips by ROLE points (jedro pokrito, delta =
  predpolnitev per vloga), ostali IZHOD (zunaj/integracija/ZDA).

### B) Odločitev

VAL Ž8 — skrivanje ničelnih postavk na natisnjenem računu, kot
PRIKAZOVNA plast nad popolnim posnetkom (1 aditivna DDL stolpec,
politika-vzorec exception-policy):

1. **Posnetek ostane POPOLN.** itemsJson je transakcijski zapis
   (Square: »transaction records … include $0 items either way«) —
   filter ŽIVI SAMO v izrisu odjemalskega računa (browser HTML +
   ESC-POS agent), ne v bazi, ne v API odgovoru postavk.
2. **Edini predikat skrivanja: `amount === 0 && brez priceOverride`.**
   »Dodano po 0« = menijska cena 0, brez plačanih opcij (price
   vsebuje opcije), brez §23 posega. Vse tri Square izjeme (plačano /
   popust-do-0 / plačana opcija na 0-postavki) + naša četrta
   (priceOverride-do-0 = comp natakarja) so AVTOMATSKO izpisane —
   matematika posnetka jih že nosi. Defenzivno: ne-končni amount
   (NaN/undefined) NIKOLI ni skrit (kar ne znamo izmeriti, izpišemo).
3. **Prag vseh skritih → izpis vseh.** Če bi filter poštenil CEL
   seznam (izjemen rob: račun s SAMO ničelnimi postavkami), izris
   pade na poln seznam — natisnjen fiskalni dokument NIKOLI ne sme
   imeti prazne tabele postavk.
4. **Zastavica teče z RAČUNOM, ne z nastavitvami odjemalca.**
   `/api/furs/[id]` odgovor nosi aditivni `hideZeroItems` (prebrano iz
   politike) — vsak tiskalni klic (POS, ponatis, seznam računov) ga
   dobi, neodvisno od pravic (nauk §30/§31: nastavitveno stanje
   dashboarda se naloži samo z settings.manage — tisk ni sme biti
   pogojen na njega).
5. **Nastavitev: RestaurantSettings.hideZeroReceiptItems BOOLEAN
   DEFAULT FALSE** — globalna poslovna nastavitev (Square jo ima na
   računu, ne per naprava). Politika-vzorec (exception-policy/ap-
   tolerance/cash-policy precedens): stolpec IZVEN main sheme do
   produkcijskega DDL klika (P2022 zastrupitev), raw dostop + probe
   (60 s TTL), graceful: do DDL → false → računi byte-identični
   sedanjim; pisanje → 503 s potjo konszole. Dev (SQLite mirror)
   dobi stolpec z db:push.
6. **Pravice pisanja: settings.manage, NE central-only.** Razlika
   proti POLICY_COLUMNS (tolerance/izjeme/blagajna = DENARNA politika,
   Issue #72 C3): to je PRIKAZOVNA preferenca računa, ista družina
   kot receiptFooter (EDITABLE, settings.manage). Pošteno zapisano
   odločitev.
7. **1 aditivna DDL** (BOOLEAN NOT NULL DEFAULT FALSE na obeh
   dialektih), 0 novih odvisnosti, 0 strežniških sprememb poti.
   UI: preklop v Nastavitvah ob receiptFooter, do DDL onemogočen z
   opombo (migrBox vzorec v1.197); ESC-POS pot uporabi SKUPNI čisti
   pomočnik (receiptDisplayItems) — ena resnica obeh tiskalnih ciljev.

### C) Implementacija

- **Čisti sloj** (src/lib/receipt.ts): ReceiptItemT dobi aditivni
  `priceOverride?: unknown` (strukturno — API ga že nosi na vrsticah);
  ReceiptDetailT dobi aditivni `hideZeroItems?: boolean`; NOVA čista
  fn `isZeroAddedReceiptItem(it)` (Number.isFinite(amount) &&
  amount === 0 && !priceOverride) + `receiptDisplayItems(d)` (filter
  samo ob d.hideZeroItems; prazen izhod → poln seznam — prag točke 3);
  buildReceiptHTML izrisuje receiptDisplayItems(d) namesto d.items.
- **Politika** (src/lib/receipt-display-policy.ts, NOVA — 0 uvozov
  razen db/prisma-missing, vzorec exception-policy):
  RECEIPT_DISPLAY_POLICY_COLUMNS = ['hideZeroReceiptItems'];
  receiptDisplayPolicyAvailable() + resetReceiptDisplayPolicyProbe();
  receiptDisplayPolicy() → { hideZeroItems }; writeReceiptDisplayPolicy
  (raw UPDATE, pre-DDL → napaka 503 s potjo konzole).
- **API**: furs/[id] — odgovor nosi `hideZeroItems` iz politike +
  legacy izpeljava (brez posnetka) dodaja priceOverride iz
  modifiersJson (parsePriceOverrideMeta) — oblika vrstic IZENAČENA s
  posnetkom; settings GET (settings.manage veja) +
  receiptDisplayPolicy/receiptDisplayPolicyDdlActive, PUT sprejme
  hideZeroReceiptItems (validacija boolean → writeReceiptDisplayPolicy,
  503 pre-DDL) — ne v POLICY_COLUMNS (točka B6).
- **UI**: nastavitve-tab — preklop (Switch) v razdelku računa ob
  receiptFooter, disabled + opomba do DDL (prop receiptPolicyDdlActive);
  SettingsT + hideZeroReceiptItems; dashboard load preslika politiko
  v stanje; printInvoice ESC-POS pot → receiptDisplayItems(r).
- **DDL infrastruktura**: mirror schema.sqlite.prisma + stolpec;
  /api/admin/migrate-receipt-display-policy (idempotentno, IF NOT
  EXISTS, obeh dialektov BOOLEAN, requireCentralRole, audit
  SCHEMA_MIGRATION_RECEIPT_DISPLAY_POLICY); register
  SCHEMA_MIGRATIONS 40 → 41 (id receipt-display-policy, probe
  columnExists); konzola HANDLERS +1; KNOWN_DRIFTS +1
  (isReceiptDisplayPolicyStatement — strogo ADD/DROP COLUMN samo
  tega stolpca, dvosmerno kot exception-policy).
- **i18n:** set.hideZeroItems + set.hideZeroItemsDesc +
  set.hideZeroItemsDdl + mig.receiptDisplayPolicy.desc (SL + HR,
  4121 → 4125).
- **Testi:** tests/v263-skritje-nicelnih-postavk.test.ts — Č1 čisti
  sloj (0-dodano skrito, popust-do-0 piše, opcija-na-0 piše,
  priceOverride-do-0 piše, NaN/undefined defenzivno piše, qty > 1 po
  ceni 0, storno −0 simetrično, filter izklopljen = ista vsebina,
  prag vseh skritih → poln seznam), Č2 izris + montaža (HTML brez
  vrstice 0-postavke ob vklopu, z vrstico ob izklopu; ESC-OS pot
  uporablja receiptDisplayItems; furs/[id] nosi zastavico; PUT
  validacija; UI preklop + DDL opomba), Ž registri (verzija 1.263.0,
  DDL stavek, register 41, drift matcher, konzola, mirror stolpec,
  i18n pariteta 4125/4125, dokument §37, AUDIT, worklog Task ID).

## 38. Raziskava november 2026 (nadaljevanje 12) — ROČNO ZAPOREDJE LISTKOV NA KDS v1.264.0 (Square Vol 16 »Draggable ticket reordering on KDS«)

Prvi odkljukani kandidat §37 (»naslednji kandidat, semantika dana
zgoraj«) — prvi SREDNJE-VELIK val od §32: nosilec, ki ga Order nima
(ticketSequence) = DDL + vlečenje + sinhronizacija. Vse izmere so bile
dane že v §37 (raziskava 6. 11.); tok jih pretvori v implementacijo.

### A) Izmere (§37 semantika + lastno stanje po kodni preverbi)

- **Square Vol 16 dobesedno (izmerjeno §37):** vlečenje listkov na
  Prep + Expo zaslonih; vrstni red »Manual« je način PER NAPRAVA
  (naprava izbere Manual/Default); sekvenca se SHRANI in sinhronizira
  na druge KDS naprave ISTIH lokacij z istim načinom Manual.
- **Lastno stanje (izmere po kodi):**
  - Glavni KDS (zavihek Kuhinja, legacy ALL/KITCHEN/BAR) izrisuje
    LINEARNO VRSTO listkov: osnutki (zložljiv oddelek, §32) →
    »Aktivna izmena« (`kdsActiveLive`, server vrstni red createdAt
    ASC; Issue #70 §2 zastareli na konec) → zastareli (zložljiv
    oddelek). Vrstni red je STROGO izpeljan (stale, createdAt) —
    ročnih mest ni in nosilca zanje ni.
  - `Order` nima stolpca zaporedja (izmerjeno po prisma/schema.prisma)
    → 1 aditivni DDL (vzorec seat/§37 exception-policy disciplina:
    mirror DA, main NE do produkcijskega DDL klika, raw + probe).
  - Per-naprava nastavitev ima domači vzorec: Issue #74 V-3/V-8/V-9
    (ro_kds_view, ro_kds_font_size, ro_kds_view_only — localStorage,
    hidracija v mikrotaski, SSR privzeto) — Manual/Default preklop
    je ISTA družina (ro_kds_ticket_order).
  - Vlečenje ima domači vzorec: tloris miz (OPS-4 v1.67) — pointer
    events (ročaj → dragIdRef → move → drop → optimistično stanje +
    PATCH persist). HTML5 draggable je izločen NAMERNO: na tablicah
    (primarni KDS naprave) touch ne sproži native DnD.
  - SSE pretok (v1.236) dviguje podpis na MAX(updatedAt) treh tabel;
    reorder bo namerno podpisa NE dvignil (raw UPDATE ne piše
    updatedAt) — listkova VSEBINA se ni spremenila, utrip »NOV«
    (kdsFlash) bi bil lažni alarm. Sinhronizacija: 15 s poll (isti
    ritem kot vsa KDS stanja pred SSE).
  - KdsStationBoard (poimenovane postaje, Issue #14) sortira skupine
    po oldest firedAt — FIFO požiga je NJIHOVA disciplina (prepara
    tok), ne linearna vrsta; vlečenje tam ostaja IZVEN tega vala
    (iskrena meja, ne tiha odločitev).

### B) Odločitev (Ž9)

VAL Ž9 — ročno zaporedje listkov na GLAVNEM KDS seznamu kot
PREZENTACIJSKA plast nad strežniškim vrstnim redom (1 aditivna DDL
stolpec, exception-policy disciplina):

1. **Nosilec: `Order.ticketSequence INTEGER NULL`** — ničen = listka
   ni ročno razvrstil (novi listki padejo na konec po createdAt;
   Square isto: obstoječa razvrstitev ostane, novi prihajajo za
   njo). Sekvenca je GLOBALNA per lokacija (Square: »syncs to other
   KDS devices of the same location«) — ne per postaja, ne per
   naprava.
2. **Način vrstnega reda je PER NAPRAVA** (ro_kds_ticket_order:
   'default' | 'manual', privzeto 'default' — Issue #74 družina).
   Default = sedanji izpeljani vrstni red (byte-identična zgodovina);
   Manual = sekvenca ASC, NULL na konec po createdAt. Naprave z
   Default načinom sekvence IGNORIRAJO (Square: sync velja samo za
   naprave »with the same mode«).
3. **Vrstni red velja SAMO na »Aktivni izmeni«.** Osnutki (§32) so
   prihodnji tok, zastareli (Issue #70 §2) so revizijska veja —
   oba oddelka obdržita svoj obstoječi red (stale-last sort ostane
   najbolj zunanja disciplina aktivne množice).
4. **Polna zamenjava sekvence ob vsakem vlečenju** (POST
   {orderIds: [...]} — celoten novi vrstni red aktivnih listkov, kar
   jih naprava vidi): podani dobi 0..n−1, AKTIVNI listki iste
   lokacije IZVEN seznama padejo ZA podane po obstoječem redu
   (filtrirana BAR naprava premakne svoj listek na vrh, ne pa da
   ponesreči preusmeri kuhinjske vrste) — sekvenca ostane ena
   globalna resnica. Izginuli (plačani/preklicani) listki pustijo
   luknje — asc sort jih preskoči, naslednje vlečenje zgosti.
5. **Dve interakciji, isti rezultat** (POŠTENO do naprav): ROČAJ
   (GripVertical v glavi listka) — pointer vlečenje po tloris
   vzorcu (miška + dotik); tipki ↑/↓ v glavi — premik za eno mesto
   (tipkovnica + dotik alternativa, a11y). HTML5 draggable NE
   (touch ne deluje). Oba pota pošljeta ISTI PATCH.
6. **Pravice: kitchen.update** (ista pravica kot vsi PATCH /api/kitchen
   dejanji — naprava kuhinje). Zaklep zaslona (viewOnly, §18 B)
   blokira tudi vlečenje — dosledno z bumpi. Pre-DDL: vlečenje/
   tipke onemogočene z nasvetom s potjo konzole (vzorec v1.197
   migrBox / §37 nastavitve-tab), način preklop je vedno na voljo
   (lokalna preferenca brez strežniškega pisanja).
7. **SSE podpis se NE dvigne ob reorderju** (iskrena meja, točka A):
   sinhronizacija teče po 15 s pollu; reorder ni vsebinska sprememba
   listka in ne sme utripati »NOV« na drugih napravah.
8. **1 aditivna DDL** (INTEGER NULL na Order, brez defaulta), 0 novih
   odvisnosti, 0 novih rut (reorder je veja obstoječega PATCH
   /api/kitchen), 0 novih UI datotek (dashboard obstoječi KDS).

### C) Implementacija

- **Čisti sloj** (src/lib/kds-ticket-order.ts, NOVA — 0 uvozov):
  `applyManualTicketOrder(orders, seqOf, createdAtOf)` (stabilna
  ureditev: Number.isFinite sekvenca ASC → izpeljani vrstni red;
  NULL/NaN/undefined na konec po createdAt — defenzivno kot §36);
  `parseReorderPayload(body)` (array string id-jev, prazna → napaka,
  duplikat → napaka; čista validacija brez db).
- **DB sloj** (src/lib/kds-ticket-sequence.ts, NOVA — vzorec
  receipt-display-policy): probe `kdsTicketSequenceAvailable()` +
  `resetKdsTicketSequenceProbe()` (60 s TTL, isMissingSchemaError);
  `readTicketSequences(orderIds)` (raw SELECT, pre-DDL → {} graceful);
  `writeTicketSequences(entries)` (raw UPDATE v interaktivni
  transakciji, pre-DDL → napaka s potjo konzole; STROGO id + celo
  število ≥ 0 ali NULL — brez SQL interpolacije vrednosti).
- **DDL**: mirror schema.sqlite.prisma + `ticketSequence Int?` (dev
  db:push); main schema NE (P2022 disciplina do DDL klika);
  /api/admin/migrate-kds-ticket-sequence (idempotentno, IF NOT
  EXISTS, obeh dialektov INTEGER, requireCentralRole, audit
  SCHEMA_MIGRATION_KDS_TICKET_SEQUENCE); register
  SCHEMA_MIGRATIONS 41 → 42 (id kds-ticket-sequence, probe
  columnExists('Order', 'ticketSequence')); konzola HANDLERS +1;
  KNOWN_DRIFTS +1 (isKdsTicketSequenceStatement — dvosmerno strogo
  SAMO Order.ticketSequence).
- **API**: GET /api/kitchen — po mapped queue ADITIVNI
  `ticketSequences: Record<string, number>` (samo definirane, iz raw
  za queue id-je) + `ticketSequenceDdlActive: boolean` (probe);
  PATCH /api/kitchen — nova veja `reorder: string[]`: kitchen.update
  (nadzorna plast PATCH), validacija (parseReorderPayload + vsi
  obstoječi + lokacija scope + status v ORDER_ACTIVE_DB), transakcija
  writeTicketSequences (0..n−1 podani, NE-podani aktivni NULL za
  njimi), audit KDS_TICKET_REORDER (counts + before/after podpis),
  pre-DDL → 503 s potjo konzole; SSE changed se NE objavi (točka B7).
- **UI** (dashboard KDS): OrderT + `ticketSequence?: number | null`;
  stanje ro_kds_ticket_order (default/manual, hidracija mikrotaska —
  Issue #74 vzorec) + kdsSequences/kdsSeqDdlActive iz GET; preklop
  Default/Manual v KDS orodni vrstici (ob pogledih, aria-pressed);
  kdsActiveLive manualno sortiran (samo kadar manual && neprazna
  sekvenca mapa); ROČAJ pointer-drag (dragIdRef vzorec tlorisa,
  drop indeks iz rect-ov vrstnih listkov, indikator vrstice, optimo
  + PATCH) + tipki ↑/↓ (isti PATCH, disabled na robovih); disabled:
  viewOnly ali !kdsSeqDdlActive (nasvet kds.reorderPending).
- **i18n:** kds.orderModeDefault/Manual/Title, kds.dragHandle,
  kds.moveUp/Down, kds.reorderPending + mig.kdsTicketSequence.desc
  (SL + HR, 4125 → 4133).
- **Testi:** tests/v264-rocno-zaporedje-listkov.test.ts — Č1 čisti
  sloj (sekvenca ASC, NULL konec po createdAt, NaN/undefined
  defenzivno, stabilnost izenačenih, prazna sekvenca = ista
  vsebina/vrstni red, payload prazna/duplikat/ne-string/tuj tip),
  Č2 API + DDL (GET polji pre-DDL, PATCH validacija + pravice +
  503 pre-DDL, DDL stavek + register 42 + konzola handler, mirror
  DA / main NE), Ž registri (verzija 1.264.0, drift matcher
  dvosmerno + drug stolpec fail, i18n pariteta 4133/4133 + 8
  ključev, dokument §38, AUDIT, worklog Task ID).

## 39. Raziskava november 2026 (nadaljevanje 13) — EXPO POŽIG ZADRŽANIH TEČAJEV S KDS v1.265.0 (Square Vol 16 »Fire held courses from an Expo KDS«)

### A) Izmere (§37 semantika + lastno stanje po kodni preverbi)

- **Square dobesedno (Vol 16, 5. 11. 2026):** »Fire held courses from
  an Expo KDS« — tap glave tečaja na Expo KDS zaslenu → odštevanje →
  drugi tap prekliče; nastavitev per lokacija »Allow Firing from Expo
  KDS«. Ekspeditor (vloga kuhinje) torej lahko SAM pošlje zadržane
  tečaje v pripravo — pri nas je požig do tega vala IZKLJUČNO
  natakarjeva pristojnost (orders.create v POS urejevalniku).
- **Naša koda ŽE ima (izmerjeno):** skupno jedro `fireOrderCore`
  (src/lib/order-fire.ts — ista transakcija, varovala, idempotenca;
  courseId veja: fire SAMO pending postavk TEGA tečaja, tečaj pending →
  fired, revizija ORDER_FIRED) + `POST /api/orders/[id]/fire
  {courseId}` (OSS-7 coursing) + KDS glave tečajev
  (`groupKdsItemsByCourse`, regija kds-course-group od §3 — pasiven
  napis z 🔥 ob poslanem tečaju). Postajne naloge (StationTask) se
  ustvarijo OB požigu — požig s KDS torej takoj naseli postajne deske.
- **Vrzel (izmerjena):** (1) požig teče SAMO iz POS urejevalnika
  (fireCourse v NaročiloSheetu — gumb §16 F); KDS glava je pasivna;
  (2) pravice: fire zahteva orders.create (natakar), KDS zaslon nosi
  kitchen.update (kuhinja) — požig s KDS je ODLOČITEV o pristojnosti,
  ki si jo lasti lastnik lokacije (pri Square ekspeditor kuha, pri nas
  natakar — nastavitev premosti razliko); (3) countdown potrditve ne
  obstaja (požig je enkraten gumb brez obramba pred pomoto); (4)
  per-lokacijska nastavitev ne obstaja (RestaurantSettings je
  singleton — lokacije imajo svojo tabelo Location).

### B) Odločitev (Ž10)

1. **Nosilec:** `Location."kdsExpoFireEnabled" BOOLEAN NOT NULL
   DEFAULT FALSE` — PER LOKACIJA (Square dobesedno; prvi
   Location-stolpec v pending DDL družini). Privzeto IZKLOPLJENO:
   požig s KDS nemogoč — sedanje stanje (natakar v POS) byte-identično.
2. **Pravice (dvojna avtorizacija):** fire ruta dovoli orders.create
   (NESPREMENJENA POS pot — brez nastavitke) ALI kitchen.update +
   nastavitev VKLOPLJENA na lokaciji NAROČILA (403 s potjo konzole
   sicer; pre-DDL probe vrne false → 403, graceful). KDS pot nosi
   reviziji `source: 'kds'` (aditivno v details; POS pot brez polja —
   byte-identična zgodovina). Požig s KDS je ODGOVOR na povpraševanje
   kuhanja, ne prevzem natakarjeve naročnine (sklep §16 H).
3. **Countdown (dvotapna potrditev):** prvi tap na glavo PENDING
   tečaja → OBOROŽITEV (jantrobna glava, odštevanje 3 s —
   KDS_EXPO_FIRE_COUNTDOWN_MS), drugi tap → PREKLIK (toast), potek →
   POST fire {courseId} (isti jedrni klic). Arm je enočasno SAMO EN;
   avto-preklic, če tečaj med odštevanjem preide v fired (druga
   naprava/natakar — brez 409 ob poteku).
4. **Površina:** ŽIVI listki KDS vrste (ne osnutki §32 — ti so
   natakarjev prihodnji tok; ne zastareli #70 — revizijska veja; ne
   viewOnly §18 B — zaklep blokira dejanja dosledno z bumpi; ne
   KdsStationBoard — po-stajni FIFO ostaja njegova disciplina, ISKRENA
   MEJA). Naša KDS vrsta (ALL/KITCHEN/BAR pogledi) JE ekspeditorska
   površina — Square ima dedikiran Expo zaslon, mi jo pokrijemo z
   vrsto listkov, kjer glave tečajev že živijo (§3).
5. **GET /api/kitchen:** aditivno `expoFireLocations:
   Record<string, boolean>` — mapa za lokacije V VRSTI (klient prikaže
   tap tarče samo za vklopljene; pre-DDL → {} → nikjer, graceful).
   SSE OrderFired se objavi iz fireOrderCore (obstoječe — druge KDS
   naprave vidno osvežijo vrsto brez novega dogodka).
6. **Nastavitev:** PATCH /api/locations/[id] {kdsExpoFireEnabled}
   (settings.manage + guardResource; raw UPDATE, pre-DDL → 503 s potjo
   konzole; revizija LOCATION_UPDATE nosi kdsExpoFireEnabled); GET
   /api/locations nosi kdsExpoFireEnabled per vrstico +
   kdsExpoFireDdlActive; UI preklop v dialogu lokacije (migrBox vzorec
   v1.197 — disabled + jantrobni nasvet do DDL; pošlje se SAMO ob
   spremembi, da ostalo shranjevanje lokacije pre-DDL ostane čisto).

### C) Implementacija

- **Čisti sloj** (src/lib/kds-courses.ts aditivno — 0 uvozov, client
  safe): `KDS_EXPO_FIRE_COUNTDOWN_MS = 3000` + `KDS_EXPO_FIRE_TICK_MS
  = 250` + `expoFireCountdownSeconds(until, now)` (celoštevilski
  preostanek 3→1; ne-številčen/potrjen rok defenzivno 0 — §36).
- **DB sloj** (src/lib/kds-expo-fire.ts, NOVA — vzorec
  receipt-display-policy/kds-ticket-sequence): probe
  `kdsExpoFireAvailable()` + `resetKdsExpoFireProbe()` (60 s TTL,
  isMissingSchemaError); `expoFireEnabledFor(locationIds)` (raw SELECT
  IN, samo boolean vrstice, pre-DDL → {} graceful);
  `writeKdsExpoFire(locationId, enabled)` (raw UPDATE vezani parametri,
  pre-DDL → sporočilo s potjo konzole).
- **DDL**: mirror schema.sqlite.prisma + `kdsExpoFireEnabled Boolean
  @default(false)` (dev db:push); main schema NE (P2022 disciplina);
  /api/admin/migrate-kds-expo-fire (idempotentno, IF NOT EXISTS, obeh
  dialektov BOOLEAN NOT NULL DEFAULT FALSE, requireCentralRole, audit
  SCHEMA_MIGRATION_KDS_EXPO_FIRE); register SCHEMA_MIGRATIONS 42 → 43
  (id kds-expo-fire, probe columnExists('Location',
  'kdsExpoFireEnabled')); konzola HANDLERS +1; KNOWN_DRIFTS 34 → 35
  (isKdsExpoFireStatement — dvosmerno strogo SAMO
  Location.kdsExpoFireEnabled).
- **API**: POST /api/orders/[id]/fire — requireAnyPermission
  ['orders.create', 'kitchen.update'] (P0-B OR logika); KDS veja
  (klicatelj BREZ orders.create): expoFireEnabled(order.locationId)
  → 403 z nasvetom ali nadaljevanje; auditExtra {source: 'kds'} SAMO
  na KDS poti. GET /api/kitchen — aditivni `expoFireLocations` (iz
  distinct locationIds queue, isMissingSchemaError catch → {}).
  PATCH /api/locations/[id] — veja kdsExpoFireEnabled (boolean
  validacija, raw write, 503 pre-DDL, revizija + sveža vrednost v
  odgovoru); GET /api/locations — kdsExpoFireEnabled per vrstico +
  kdsExpoFireDdlActive (graceful catch).
- **UI** (dashboard): KDS glava tečaja postane GUMB, ko oborožljiva
  (!draft && !stale && !viewOnly && !fired && (canManage ||
  orders.create || (kitchen.update && lokacija vklopljena))): idle =
  isti pill + hover amber + title kds.expoFireHint; armed = amber
  animate-pulse + tabular-nums odštevanje (kds-expo-fire-countdown
  regija) + aria kds.expoFireArmed; drugi tap = preklic (toast
  kds.expoFireCancel); potek = kdsFireCourse (POST + toast
  kds.expoFireDone + load('hot'); napaka → destruktivni toast +
  resnica s strežnika). Countdown effect (interval 250 ms, ref na
  svežo funkcijo — pattern gateRef) + avto-preklic effect (tečaj ni
  več pending → arm ugasne). Dialog lokacije: preklop ob isActive
  (disabled + jantrobni nasvet do DDL, migrBox v1.197), vrednost iz
  locEditing.kdsExpoFireEnabled, pošilja se SAMO ob spremembi in
  aktivnem DDL.
- **i18n:** kds.expoFireArm/Hint/Armed/Cancel/Done,
  loc.kdsExpoFire/Hint/Ddl + mig.kdsExpoFire.desc (SL + HR,
  4133 → 4142, popolna pariteta).
- **Testi:** tests/v265-expo-pozig-tecajev.test.ts — Č1 čisti sloj
  (odštevanje 3→2→1, potek 0, NaN/Infinity defenzivno, negativni
  remain, konstanti), Č2 API + DDL + montaža (fire ruta dvojna
  avtorizacija + source:'kds' + 403 sporočilo; kitchen GET polje +
  graceful; locations PATCH veja + 503 pre-DDL + revizija; DDL stavek
  + centralna vloga + audit + alreadyApplied; register 43 + konzola
  handler; UI montaža — gumb, aria, countdown regija, viewOnly/draft/
  stale izključitve, dialog preklop; KdsStationBoard brez požiga),
  Ž registri (verzija 1.265.0, mirror DA / main NE, drift matcher
  dvosmerno + kamuflaža fail, i18n pariteta 4142/4142 + 9 ključev,
  dokument §39 + AUDIT POSODOBITEV, worklog Task ID).

## 40. Raziskava november 2026 (nadaljevanje 14) — NAPITNINSKE TOČKE PO VLOGI v1.266.0 (Square Vol 16 »Split pooled tips by points assigned to each role«)

Zadnji odloženi A-kandidat §37 (»tips by ROLE points — jedro pokrito,
delta = predpolnitev per vloga, NIZKA prioriteta«). Raziskovalno okno
Vol 17 je PRAZNO (Vol 16 objavljen 5. 11. 2026 — ritem ~2× letno,
naslednja objava pričakovana pozno pomlad 2027; Lightspeed/Toast
decembrske objave še niso na spletiščih); B-kandidati TRZNA-VRZELI-2027
(P2-11 transport, FINA 2.0 cert) čakajo lastnikove odločitve — tok
zatorej odkljuka zadnjega A-kandidata Vol 16.

### A) Izmere (§37 semantika + lastno stanje po kodni preverbi)

- **Square dobesedno (Vol 16, 5. 11. 2026):** »Split pooled tips by
  points assigned to each role« — točke za delitev bazena napitnin so
  pripisane VLOGI (enkrat nastavljeno), član delitve sledi svoji vlogi.
  §37 izmera: »Square dodeli točke VLOGI (enkrat nastavljeno, član
  sledi svoji vlogi), pri nas se točke vnesejo per oseba per dan.«
- **Naša koda ŽE ima (izmerjeno):** matematika točkovne delitve je
  IZVEDENA od Issue #1 — `TipMethod = 'hours' | 'equal' | 'points'`,
  `methodWeights` points veja + POST body `points` +
  `splitTips` (metoda največjega ostanka, vsota TOČNO skupni znesek)
  + `TipDistribution.points` zapis + hash-veriga.
- **Vrzel (izmerjena — VEČJA od §37 ocene):** (1) UI NIKOLI ni poslal
  `points` — NapitnineTab closeDay pošlje `{date, locationId, method}`
  BREZ points; izbirnik osnove dobesedno pravi »Po točkah (kmalu)«
  (`tips.basisPoints`, postojeno iz Issue #1); (2) GET predogled trdo
  kliče `methodWeights(method, rows, {})` — prazna mapa = vse uteži 0
  = splitTips fallback ENAKOVREDNO po vrstnem redu: izbira »po točkah«
  je v UI TIHO delila enakovredno (uporabnik tega ne more odkriti do
  zaključka dneva); (3) POST sanitizacija: `Math.max(0, Number(x) || 0)`
  v methodWeights spusti Infinity skozi — splitTips vrže »Uteži morajo
  biti ne-negativna števila.« = neobdelan 500; (4) predpolnitev po
  vlogi ne obstaja (Squareeva lastnost iz §37); (5) vloga dneva
  per zaposleni ni izpeljana (TimeEntry.jobId + primarna EmployeeJob
  obstajata, nihče ju ne bere za napitnine).
- **Izbira vlogе:** Job (delovno mesto) — payroll entiteta z imenom,
  aktivnostjo in plačo; EmployeeJob dodelitve (issue #22) + TimeEntry.
  jobId (snapshot izmene). NE EmployeeRole enum (sistemske pravice
  owner/admin/staff mešane s položaji waiter/bar/chef — napitninska
  vloga je plačni položaj, ne pravica).

### B) Odločitev (Ž11)

1. **Nosilec:** `Job."tipPoints" INTEGER NOT NULL DEFAULT 0` —
   privzete točke VLOGI (0 = brez predpolnitve, vnos ročen; meja 999).
   Prvi Job-stolpec v pending DDL družini; mirror DA (db:push)/main NE,
   raw SQL + probe 60 s (vzorec receipt-display-policy §37).
2. **Izpeljava vloge dneva (per zaposleni):** TimeEntry.jobId z
   NAJVEČ minutami v dnevnem oknu (izenačeno → prvi po jobId,
   deterministično); brez TimeEntry jobId → primarna EmployeeJob
   (issue #22); sicer null (— v stolpcu vloge, točke ročne).
3. **Predogled USKLAJEN s predpolnitvijo:** GET points param
   (sanitiziran JSON) — učinkovite točke predogleda = vnešene ??
   jobTipPoints (predogled SINHRON z tistim, kar UI pošlje ob
   zaključku); POST pa uporabi IZKLJUČNO prejete vrednosti — BREZ
   tihega vpliva vloge na denarno pot (revizija nosi pointsSum/
   pointsEntered = iskren zapis uteži).
4. **Iskrena obramba:** 0 točk (vseh) = gumb zaključka dneva
   ONEMOGOČEN + jantrobni nasvet — TIHA enakovredna delitev zahteva
   izrecno potrditev (vnos točke ali izbor druge osnove).
5. **Urejanje točk vloge:** JobsCard (Nastavitve → Delovna mesta),
   DDL-gated (pre-DDL skrito, graceful); PATCH /api/jobs/[id]
   (settings.manage; 400 validacija NAJPREJ, 503 DDL vrata šele nato;
   revizija JOB_TIP_POINTS before/after); POST /api/jobs opcijsen
   tipPoints (pre-DDL > 0 → 503 s potjo konzole).
6. **Meje (iskrene):** točke so UTEŽ, ne denar (0..999 celo);
   delitev ostaja per DAN + lokacija (bazen Issue #1); izplačila,
   hash-veriga in storno pot NESPREMENJENI; splitTips/methodWeights
   brez novih poti (matematika Issue #1 byte-identična).

### C) Implementacija

- **DDL (exception-policy disciplina; prvi Job-stolpec v pending
  družini):** Job."tipPoints" INTEGER NOT NULL DEFAULT 0; admin ruta
  /api/admin/migrate-job-tip-points (idempotentno IF NOT EXISTS,
  requireCentralRole, audit SCHEMA_MIGRATION_JOB_TIP_POINTS); register
  SCHEMA_MIGRATIONS 43 → 44 (id job-tip-points, probe columnExists
  Job.tipPoints); konzola HANDLERS +1; KNOWN_DRIFTS 35 → 36
  (isJobTipPointsStatement — dvosmerno strogo SAMO Job.tipPoints).
- **DB sloj src/lib/job-tip-points.ts (NOVA — kds-expo-fire vzorec):**
  probe jobTipPointsAvailable() + reset (60 s TTL, isMissingSchemaError);
  jobTipPointsFor(jobIds) (raw SELECT IN, integer-only 0..999, pre-DDL →
  {} graceful); writeJobTipPoints (integer-only, raw UPDATE, pre-DDL →
  napaka s potjo konzole).
- **Čisti sloj src/lib/tips.ts (aditivno):** TIP_POINTS_MAX 999 +
  sanitizeTipPointsRecord (vhodna sanitizacija POST body + GET query —
  končni celi 0..999 ostanejo, NaN/Infinity/negativ/decimal/niz/Polje
  izpadejo; popravek neobdelanega 500 iz §40 A(3)).
- **API /api/tips:** GET opcijsen points=<JSON> (sanitiziran) +
  previewPoints = vnešene ?? jobTipPoints + employees[].jobId/jobName/
  jobTipPoints/enteredPoints + tipPointsDdlActive; POST sanitizeTipPointsRecord
  na vhodu + revizija pointsSum/pointsEntered pri points metodi;
  dayBasisRows izpeljava vloge dneva (jobMinutes akumulacija → največ
  minut → primarna EmployeeJob fallback → imena + točke DDL-gated).
- **API /api/jobs:** GET tipPointsDdlActive + per vrstica tipPoints
  (raw read); POST opcijsen tipPoints (validacija 0..999, pre-DDL > 0 →
  503 s potjo konzole, writeJobTipPoints po typed create).
- **API /api/jobs/[id] (NOVA PATCH):** settings.manage; body
  {tipPoints}; 400 validacija NAJPREJ (celo 0..999), 503 DDL vrata
  šele nato (ločena sporočila); revizija JOB_TIP_POINTS
  {jobName, before, after}; odgovor nosi svežo vrednost iz baze.
- **UI NapitnineTab (backoffice-tab):** pri osnovi »po točkah« tabela
  dobi stolpec VLOGA (jobName, — brez) + vnosno polje TOČKE per
  zaposleni (aria, samo-cifer, ≤3 znaki); predpolnitev iz
  enteredPoints ?? jobTipPoints (varovano stanje prevData — samo dokler
  uporabnik ni spreminjal); refetch s points v query (strežniška
  matematika — en vir resnice, splitTips ostaja na strežniku); vsota
  točk; zero-guard (gumb + jantrobni nasvet); closeDay pošlje points;
  izbirnik osnove 'Po točkah (kmalu)' → 'Po točkah (po vlogi)'
  (tips.basisPoints vrednost — luknja §40 A(1) zapečatena).
- **UI JobsCard (nastavitve-tab):** DDL-gated urejanje (tipDraft
  varovano stanje, shrani SAMO ob spremembi — migrBox vzorec §39),
  aria, toast; nov vnos (create) z opcijsenimi točkami; namig
  predpolnitve; dashboard posreduje tipPointsDdlActive iz /api/jobs.
- **i18n:** tips.roleCol/pointsCol/pointsColAria/pointsRoleHint/
  pointsNoRole/pointsZero/pointsSum + jobs.tipPoints/Short/Hint/Save/
  Saved/Invalid/Aria + mig.jobTipPoints.desc (SL + HR, 4142 → 4157,
  popolna pariteta; +15 ključev).
- **Testi:** tests/v266-napitninske-tocke-vloga.test.ts — Č1 čisti
  sloj (veljavni celi ostanejo; NaN/Infinity/negativ/decimal/niz/Polje/
  Array izpadejo; prazni ključi; parseJobTipPoints meje; konstanti),
  Č2 API + DDL + montaža (GET points param + usklajen predogled; POST
  revizija pointsSum; izpeljava vloge — jobMinutes + isPrimary +
  jobTipPointsFor; sloj pre-DDL read {}/write napaka; DDL stavek +
  register 44 + konzola; PATCH 400-pred-503 + revizija; jobs GET/POST;
  NapitnineTab vnosna polja + aria + predpolnitev + refetch + vsota +
  zero-guard + closeDay points + stolpec vloge; JobsCard DDL-gated +
  shrani ob spremembi + aria; dashboard posredovanje; splitTips brez
  novih poti), Ž registri (verzija 1.266.0, mirror DA / main NE, drift
  matcher dvosmerno + kamuflaža fail + druga tabela fail, i18n pariteta
  4157/4157 + 15 ključev + 'kmalu' odšel, dokument §40 + AUDIT
  POSODOBITEV, worklog Task ID).
- **E2E najdbi (demo baza, agent-browser, 12 dokazov):** (1) NAPAKA
  zanke predpolnitve — init vnosov iz vsakega odgovora ustvari NOVO
  identiteto Record-a; pointsInput kot odvisnost efekta je poganjala
  neskončni init → refetch → init (gumb Zaključi dan ujet v busy).
  POPRAVEK: ptsSig PODPIS (JSON niz, vsebinsko stabilen) namesto
  objekta v odvisnostih — predogled brez ročnega vnosa sploh ne
  pošlje points (strežnik sam upošteva predpolnitev), ročni vnos pa
  sproži refetch SAMO ob dejanski spremembi vrednosti. (2) NAPAKA
  invarianta vsote splitTips — vsota uteži 0 je razdelila le po en
  cent po vrstnem redu in ostanek TIHO VRGLA PROČ ([1,1] pri 30,00 €
  = 29,98 € izginilo; dokumentirana invarianta »vsota je TOČNO skupni
  znesek« kršena od Issue #1, nedosegljiva dokler UI ni pošiljal
  points). POPRAVEK: vsota 0 = ENAKOVREDNA delitev (floor + ostanek
  po indeksu — ista disciplina kot fallbackEqual veja); delne ničle
  ostanejo nič (utež 0 niso enakovredne, samo PRAZNA poraba).
  Ostali dokazi: osnova brez »kmalu«, stolpec vloge, predpolnitev
  2/1, predogled 20,00/10,00, vsota 3, zero-guard (gumb izginil +
  jantrobni namig v DOM), zaključek dneva (1 točka → 10,00 €, 2
  točki → 20,00 €, hash-veriga, zgodovina), revizija pointsSum:3/
  pointsEntered:2 + JOB_TIP_POINTS before/after, JobsCard urejanje
  2 → 5 (toast, persist, DB raw), čiščenje (bazen/distribucije/
  plačilo/naročilo/izmeni/zaposlena/vloge izbrisani; revizijska
  sled ostaja).
