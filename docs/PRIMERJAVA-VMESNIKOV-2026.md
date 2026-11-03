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
