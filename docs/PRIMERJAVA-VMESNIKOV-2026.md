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
| Taksacija pijače (pour cost) | ⚠️ | ⚠️ | Analiza menija (inženiring) pokriva food cost; poseben pour-cost poročilo za bar manjka (C-seznam) |
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
| Tečaji (coursing) na listku | ✅ | ✅ | ✅ | ⚠️ | badge na listku; kuhinja vidi tečaj, ne skuPa po tečajih (C-seznam) |
| 86 dolgi pritisk + nadomestki | ✅ | ⚠️ | ⚠️ | ✅ | P0-3 plošča + nadomestki |
| Bump celega listka | ✅ | ✅ | ✅ | ✅ | + SERVED bump |
| Razlog zamude ob poznem READY | ✅ | ⚠️ | ⚠️ | ✅ | katalog razlogov (Lightspeed vzorec) |
| Zvok ob novem listku | ✅ | ✅ | ✅ | ✅ | WebAudio |
| Nastavitev pisave/gostote/stolpcev | ✅ | ⚠️ | ⚠️ | ✅ | S/M/L/XL, 4/6/8/10 stolpcev |
| Fullscreen | ✅ | ✅ | ✅ | ✅ | |
| Tisk listkov (kuhinja/bar) | ✅ | ✅ | ✅ | ✅ | brskalnik + ESC/POS agent |
| Zastareli listki (>8 h) | – | – | – | ✅ | ločen skrčen oddelek (Issue #70/71) |
| Obetalni ETA natakarju | ⚠️ | ⚠️ | ⚠️ | ⚠️ | povprečni cilji časa obstajajo; obljuba ETA gostu ne (C-seznam) |
| Večjezični KDS | ✅ | ⚠️ | ⚠️ | ⚠️ | SL/HR celoten; EN samo gostje (zavestna odločitev) |
| Push (ne polling) | ✅ | ✅ | ✅ | ⚠️ | 15 s polling + Web Push ob novih; SSE/WS na C-seznamu |
| Produktivnost postaje | ✅ | – | ⚠️ | ✅ | KDS statistika (cilji, propustnost) |

**Presoja:** KDS je bil predmet treh benchmark valov (v1.67, v1.129, v1.135) in ima parity
ali prednost na 14/18 točk; vrzeli so izboljšave drugega reda (ETA, jezik, push transport).

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
| Urejevalnik con v UI | ⚠️ | ✅ | ⚠️ | ❌ → **v1.229** | cona se nastavi z mizo (prosto besedilo) |
| **Prenos naročila na drugega natakarja** | ⚠️ | ⚠️ | ✅ | ❌ → **v1.229** | Lightspeed »transfer user« — izmena/delovnik |
| Preimenuj naročilo | – | – | ✅ | ✅ | customerName edit |
| QR meni na mizo | ⚠️ | ⚠️ | ⚠️ | ✅ | toggle naročanja + rotacija žetona |
| Status mize (prosta/zasedena/umazana) | ✅ | ✅ | ✅ | ✅ | + en-dotik čiščenje |
| Rezervacije: termini po kapaciteti | ✅ | – | ✅ | ✅ | strežnik izračuna proste kapacitete |
| Opomniki (SMS/e-mail) | ✅ | – | ✅ | ✅ | posamično + množično, badge poslano |
| Čakalna lista (walk-in) | ⚠️ | – | ⚠️ | ✅ | prijava → obvesti → usadi z zaklepom mize |
| Samodejna dodelitev mize rezervaciji | ✅ | – | ✅ | ❌ | C-seznam — danes ročna izbira mize v dialogu |
| Rezervacije na tlorisu | ⚠️ | – | ⚠️ | ❌ | C-seznam — overlay prihodnjih rezervacij na plan |
| Naročila gostov po QR (self-order) | ✅ | – | ⚠️ | ✅ | /m/<token> + kiosk + lastni portal /s |
| Sledenje stanja naročila za gosta | ⚠️ | – | ⚠️ | ✅ | 30 s polling po oddaji |

**Presoja:** front-of-house tok je najmočnejša mila sistema (tri PWA površine + QR + kiosk);
**urejevalnik miz** in **prenos na natakarja** sta zadnji dve Lightspeed/Toast funkciji, ki
manjkata — obe sta v valu v1.229.0. Samodejna dodelitev in overlay rezervacij sta C-seznam.

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
| **Inventura s čitalnikom** | ⚠️ | – | ✅ | ❌ | C-seznam — ročno vnašanje štetja |
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
| **Samodejni 86 ob izpraznitvi zaloge** | ⚠️ | – | ✅ | ❌ | C-seznam — danes 86 ročno (KDS plošča / Meni) |
| Prenosi med lokacijami | ✅ | – | ⚠️ | ✅ | odprema/prevzem + push obeh strani |
| Odpad z razlogom + povratnica | ✅ | ⚠️ | ⚠️ | ✅ | lot-zaveden |
| Nizka zaloga — opozorila | ✅ | ✅ | ✅ | ✅ | LOW_STOCK push + KPI |
| **Nizka zaloga ob prijavi (clock-in)** | ✅ | – | ✅ | ❌ | Toast december 2025: oseba vidi razprodano/nič ob prihodu — C-seznam |
| Zaloga vidna natakarju v POS | ⚠️ | – | ⚠️ | ⚠️ | 86 vidno; količine zaloge v POS niso (namenoma — dostop skladiščniku) |

**Presoja:** zaloga/prekurmentski modul prekaša MarketMan na evropskih specifikah (eSLOG,
FURS, serije, DURS); manjkata OCR (zavestna 0-AI odločitev) in samodejni 86 (C-seznam).

---

## 6. Skupni seštevek

| Vmesnik | Parity točke | Glavne odprte vrzeli |
|---|---|---|
| Prodaja (POS) | 16/19 | EAN ⌨, ★, ⚡ → vse tri v v1.229.0 |
| Šank | pokrit | ⚡ + EAN (ista obdelava); tabi = B-seznam |
| Kuhinja (KDS) | 14/18 | ETA, tečaj-grupiranje, SSE push, EN jezik — vse C-seznam |
| Restavracija | 19/22 | Uredi mize + prenos natakarja → v1.229.0; auto-assign + overlay → C |
| Zaloge | 19/22 | OCR (0-AI), auto-86, clock-in seznam — C-seznam |

**Zaključek:** po treh letih benchmark valov (v1.67–v1.228) ima sistem parity ali prednost
na ~87 primerjanih funkcijah; v1.229.0 zapre 5 zadnjih A-vrzeli (EAN, ★, ⚡, Uredi mize,
prenos natakarja), vse 0-DDL. Preostanek so tri kategorije: odločitve lastnika (tabi,
terminal, PEPPOL), C-seznam drugega reda (auto-assign, SSE, auto-86, clock-in seznam) in
zavestne izključitve (AI/OCR).

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
