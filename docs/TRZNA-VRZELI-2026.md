# TRŽNA VRZEL-ANALIZA — 2. krog (v1.82.9 → v1.85.0, 2026-10-13; VSE P0 IZVEDENE: P0-3 v1.83.0, P0-1 v1.84.0, P0-2 v1.85.0)

> Nadaljevanje OPS-4 (`GAP-ANALIZA-funkcije-in-dovoljenja.md`, @ v1.66.0).
> Naročilo lastnika: »raziskuj po spletu najboljše in primerjaj, kaj nam še manjka.«
> Metodologija: (a) sveža raziskava spleta 13. 10. 2026 (uradne strani Lightspeed/Toast/
> Square/Loyverse; nevtralna primerjava TechRadar 2026; regulatorni viri EU/PCI SSC;
> Wikipedia za ViDA/QR), (b) inventar lastnega sistema IZ KODE @ v1.86.0 (grep dokazi),
> (c) primerjava matrično, (d) prioritizacija P0–P3 s trudom.
> Omejitve: toasttab.com/touchbistro.com/possector.com za bot-zaščito (Cloudflare) —
> njihovi nabori povzeti po OPS-4 (12. 10. 2026) in TechRadar 2026; FINA fina.hr nedosegljiva
> iz peskovnika — status Fiskalizacije 2.0 po lastnem FURS-CERT-RUNBOOK.

## 1. Viri (pridobljeni 2026-10-13)

| Vir | Način | Datum vira |
|---|---|---|
| Lightspeed Restaurant (uradna) | brskalnik, celoten nabor funkcij | stran »Lightspeed® 2026« |
| TechRadar »Best POS systems of 2026« | brskalnik (Toast = best for restaurants, $69+/mes + 2 %+15¢ + 1–3 letne pogodbe) | posod. 10. 2. 2026 |
| Square for Restaurants (uradna) | HTTP | 13. 10. 2026 |
| Loyverse (uradna) | HTTP | 13. 10. 2026 |
| Wikipedia: Point of sale / QR code | HTTP | 13. 10. 2026 |
| Wikipedia: VAT in the Digital Age (ViDA) | HTTP — sprejet 11. 3. 2025, v veljavi 12. 4. 2025 | 13. 10. 2026 |
| PCI SSC (uradna) — PCI DSS v4.0 velja; PA-DSS upokojen | HTTP | 13. 10. 2026 |
| Toast, TouchBistro, Menumiz, POS Sector (SI) | OPS-4 raziskava (12. 10. 2026) + TechRadar 2026 | 12.–13. 10. 2026 |

## 2. KAJ SE JE ZAPRLO OD OPS-4 (v1.66.0 → v1.82.9) — dokazi iz kode

| OPS-4 vrzel | Stanje @ v1.82.9 | Dokaz |
|---|---|---|
| P0-2 Hitra prodaja (šank) | ✅ ZAPRTO | zavihek »prodaja« (page.tsx + tab-permissions + i18n) |
| P0-3 Natakar tablica (PWA) | ✅ ZAPRTO | /tablica (hitri način) + /handheld v1.84.0: enoročni tok mize→naroči→fire→plačaj (gl. 4.1) |
| P0-5b QR na računu | ~ delno | HR fiskalni potrditveni QR ✓ (receipt.ts); QR za mnenje/loyalty na računu ŠE manjka (gost ga dobi v QR toku /m/, ne na papirju) |
| P1-6 Split bill | ✅ ZAPRTO | OPS-7 v1.68.0 — split po izstavkih (ChecksT, splitSel) |
| P1-7 Coursing | ✅ ZAPRTO | OPS-7 v1.68.0 (CourseT + fire po tečajih) |
| P1-8 Vizualni tloris | ✅ ZAPRTO | OPS-4 v1.67.0 — pogled »plan« + vlečenje posX/posY (%) |
| P1-9 SMS/e-mail potrdila | ✅ ZAPRTO | src/lib/reminders.ts — SMTP + Twilio + webhook ponudniki |
| P1-10 Urnik izmen | ✅ ZAPRTO | tabs/urnik-izmen-tab.tsx (StaffScheduleTab + TimeOff) |
| P1-11 Push obvestila | ✅ ZAPRTO | src/lib/push.ts + push-events.ts + /api/notification-rules |
| P1-14 Menu engineering | ✅ ZAPRTO | tabs/analitika-tab.tsx (Kasavana-Smith) |
| P0-1 KDS-BAR | ✅ ZAPRTO | naprava kds_bar (enroll + nastavitve) + postajni filtri |
| P0-4 KDS statistika | ✅ ZAPRTO | KdsStatsSection (prep-time razredi + heatmap) |
| P1-17 Normativi in kalo | ✅ ZAPRTO | recepture + yield (api/recipes, zaloga-tab) |
| Vloga cleaner + haccp.execute | ✅ ZAPRTO | permissions.ts CLEANER + vsi 8 novih ključev (4a) |
| P2-15 Loyalty nivoji | ✅ ZAPRTO | tier (bronze/silver/zlato) v zvestoba toku |

**Bilanca: 14/20 OPS-4 vrzeli popolnoma zaprtih + 2 delno** v 16 izdajah (v1.67.0 → v1.82.9).
Odprte ostanejo (stanje @ v1.84.0): QR mnenje na računu, EN/DE/IT jeziki,
spletni rezervacijski widget, kampanje, AI napovedi, predavtorizacija, knjigovodski portal (delno).

## 3. TRŽNA MATRIKA 2026 (RestavrantOS @ v1.82.9 proti vodilnim)

Legenda: ✓ ima · ~ delno · ✗ manjka · — ni relevantno za ta trg
| Funkcija | Lightspeed | Toast | Square | Loyverse | POS Sector (SI) | **RestavrantOS** |
|---|---|---|---|---|---|---|
| Mize/ cone/ statusi | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Vizualni tloris | ✓ | ✓ | ✓ | ✓ | ~ | ✓ (drag&drop) |
| Hitra prodaja | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Split računa | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (po izstavkih) |
| Tečaji (coursing) | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| KDS + statistika priprave | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (+heatmap) |
| Šank (KDS-BAR) filter | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Customer-facing display | ✓ | ✓ | ✓ | ✓ | ~ | ✓ (/display, pari) |
| **Handheld/tableside tok** | ✓ | ✓ | ✓ | ✗ | ✗ | **✓ (v1.84.0 /handheld: enoročni mize→fire→plačilo pri mizi + offline vrsta)** |
| Kiosk samopostrežni | ✓ | ✓ | ✓ | ✗ | ~ | ✓ (+vplačilo) |
| QR naročanje gosta | ✓ | ✓ | ✓ | ✗ | ~ (cenik) | ✓ (/m/token) |
| Offline način | ✓ | ~ | ✓ | ✓ | ✓ | ✓ (POS vrsta + resilience) |
| **Hiter »86« toggle na KDS** | ✓ | ✓ | ✓ | ✓ | ✓ | **✓ v1.83.0 (86-plošča + nadomestki; gumb na listkah + ozek API od OPS-4)** |
| Integrirana kartična plačila | ✓ | ✓ | ✓ | ✓ | ✓ | ~ (terminal, brez PAN) |
| **Online plačilo (pay link)** | ✓ | ✓ | ✓ | ✗ | ✗ | **✓ (v1.85.0 /pay/token: QR položnica + napitnina + kanonični FURS zaključek)** |
| Fiskalizacija SI (FURS) | ✗ | ✗ | ✗ | ✗ | ✓ | **✓ (EOR/ZOI)** |
| Fiskalizacija HR (FINA 2.0) | ✗ | ✗ | ✗ | ✗ | ~ | **✓ (pripr. na cert)** |
| Dostava webhook (agregatorji) | ✓ | ✓ | ✓ | — | ~ | ✓ (Glovo/Wolt) |
| **Lastni portal za spletna naročila** | ✓ | ✓ | ✓ | ✗ | ✗ | **✗** |
| Zaloge + recepture | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Normativi/kalo | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Menu engineering | ✓ | ✓ | ✓ | — | ✗ | ✓ (Kasavana-Smith) |
| Nabava (PO/prevzemi) | ✓ | ✓ | ✓ | ~ | ✓ | ✓ (+recurring) |
| HACCP | — | — | — | — | ✓ | ✓ (+načrti) |
| Računovodstvo (izvoz) | ✓ (avto) | ✓ | ✓ | — | ✓ | ✓ (GL/CSV/eSlog AP) |
| X/Z, DDV po stopnjah | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Prodaja po urah + labor strošek | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| **Labor FORECAST (napoved ur)** | ✓ | ✓ | ✓ | ✗ | ✗ | **✗** |
| Payroll | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Urniki izmen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Timeclock | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| RBAC fino + MFA | ✓ | ✓ | ✓ | ✓ | ~ | ✓ (18 dovoljenj) |
| Push/SMS/e-mail obvestila | ✓ | ✓ | ✓ | ✗ | ~ | ✓ |
| Rezervacije (interno) | ✓ | ✓ | ✓ | ✓ | ~ | ✓ |
| **Javni rezervacijski widget** | ✓ | ✓ | ✓ | ✓ | ~ | **✗** |
| Waitlist | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Loyalty (točke/nivoji) | ✓ | ✓ | ✓ | ✓ | ~ | ✓ (tierji) |
| **Loyalty kampanje/marketing** | ✓ | ✓ | ✓ | ✗ | ✗ | **✗** |
| Darilne kartice | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Popusti + happy hour | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **AI vpogledi/napovedi** | ✓ | ✓ | ✗ | ✗ | ✗ | **✗ (model v shemi!)** |
| Benchmarks (anonim.) | ✓ | — | — | — | — | ✗ |
| Multi-lokacija/tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (Org→Brand→Property) |
| Hotel PMS | ✓ | — | — | — | — | ✗ |
| **Večjezičnost za goste** | ✓ | ✓ | ✓ | ✓ | ~ (EN) | **~ (SL/HR samo)** |
| Audit veriga (hash) | — | — | — | — | — | **✓ (blockchain)** |

**Bitke, ki jih RestavrantOS ŽE ZMAGUJE:** fiskalizacija SI+HR (svetovni vodilni je nimajo),
HACCP, menu engineering + normativi hkrati, audit hash veriga, offline POS vrsta,
dvojezičnost SL/HR, multi-tenant enterprise, lastništvo kode (0 € mesečnin —
Toast 69 $+/mes + 2 %+15¢ + 1–3 letna pogodba po TechRadar 2026).

## 4. VRZELI — prioritiziran seznam @ v1.82.9

### P0 — odločilno za vsakdan (vodilni imajo, mi ne)

| # | Manjka | Zakaj pomembno | Trud |
|---|---|---|---|
| ~~1~~ | ~~Handheld tok za natakarja~~ — ✅ **izvedeno v v1.84.0** (/handheld: mize → naroči → fire → plačaj pri mizi; offline vrsta order.create/addItems; fire+plačilo zavestno samo online; 12-testni pokrov tests/handheld-flow.test.ts) | Lightspeed Tableside/Toast handheld = #1 prodajni argument | ~~Srednji~~ |
| ~~2~~ | ~~**Online plačilo QR položnice (pay link)**~~ — ✅ **ZAPRTO v v1.85.0**: /pay/&lt;token&gt; javna stran (kanonični račun, napitnina 0/5/10/15 % + po meri, kartica) + POST /api/orders/[id]/paylink (QR + SMS fail-soft, pravica orders.pay) + GET/POST /api/public/pay/[token] (brez prijave, rate limit) — plačilo teče SKOZI kanonično FURS jedro (issueFursReceipt z break-glass žetonom — 0 duplikata fiskalne logike, CAS + idempotenca plk:&lt;token&gt;); ponudnik: Stripe Checkout (env STRIPE_SECRET_KEY oz. Integration type=payments) ali honest simulator (vidna značka); tests/paylink-flow.test.ts 19 testov | Square/Toast/Lightspeed vsi; zmanjša čakanje natakarja pri mizi; poveča turnover | Zaprto (v1.85.0) |
| 3 | **Hiter »86« toggle na KDS/šank** — ✅ **ZAPRTO v v1.83.0**: 86-plošča na KDS (proaktivni 86 katerega koli artikla, obnova z enim klikom, števec razprodanih), avtomatski nadomestki iz iste kategorije (prioriteta ista postaja, max 3), waiter dialogi (novo naročilo + urejevalnik OPS-7) kažejo 86 + nadomestke namesto tihega skrivanja/zavrnitve; ozek API PATCH /api/menus/[id]/availability + menu.availability obstajata od OPS-4 (4e7b6e6) | Popravek poštenosti: v1.82.10 je vrstico ocenil ✗ — gumb na listkah naročil JE obstajal; manjkali so proaktivna plošča, nadomestki, waiter vidnost in testni pokrov (dodan tests/menu-86-board.test.ts: 401/403×2/400/404, toggle, revizijska veriga, idempotenca) | Zaprto (v1.83.0) |

### P1 — vsi vodilni imajo, konkurenčna parity

| # | Manjka | Trud |
|---|---|---|
| 4 | **Labor forecast** — iz zgodovine prodaje priporočeno število ur/izm. (imamo actuals + prodaja po urah) | Srednji |
| 5 | **EN jezik za goste** | ✓ ZAPRTO | P1-5 v1.86.0 — delni EN slovar (guest./pay. 140 ključev), GuestLanguageToggle SL/HR/EN, samodejna izbira po brskalniku, javne API napake preslikane v i18n (31 nizov) |
| 5 | **EN jezik za goste** | ✓ **ZAPRTO (P1-5, v1.86.0)** — delni EN slovar (140 ključev 'guest.*'+'pay.*': QR meni, kiosk, display, /pay), GuestLanguageToggle SL/HR/EN (44px), samodejna izbira po jeziku brskalnika (en→EN, hr→HR), dashboard varovalka (locale 'en' → SL vsebina + SL poudarjen), javne API SL napake (31 fail-nizov) preslikane v i18n prek guestApiErrorKey/Text (vzorec guestStatusKey), "Miza N" → Table/Stol N; fallback veriga en→SL (delna pokritost varna) | Majhen–srednji → izvedeno |
| 6 | **Split po gostih** (poleg izstavkov) — »2 gosta na računu« posebni zahtevek | Majhen |
| 7 | **Integrirana kartična plačila z vinjetami za napitnino na terminalu** (SumUp/Stripe Terminal/Bankart — lokalni SI/HR ponudniki) | Velik (partner) |
| 8 | **Lastni spletni portal za prevzem** (spletna stran + plačilo → direktno v POS) | Srednji–velik |

### P2 — konkurenčna prednost

| # | Manjka | Trud |
|---|---|---|
| 9 | **AI napovedi/insights** (AIConversation model JE v shemi, neuporabljen): napoved obremenitve, predlog naročila zalog, opozorila na mrtve artikle | Srednji–velik |
| 10 | **Loyalty kampanje + e-mail marketing** (SMTP ŽE v reminders.ts): rojstnodnevni kupon, win-back | Srednji |
| 11 | **eSlog B2B IZVOZ + Peppol** (ViDA: e-računi po 2030 harmonizirano; AP import že imamo) | Srednji |
| 12 | **Javni rezervacijski widget** (/r/[token] javni URL + Google Business link) | Majhen–srednji |
| 13 | **Knjigovodski portal** — read-only dashboard za vlogo accounting (GL/CSV ŽE izvažamo; samo še prikaz) | Majhen |
| 14 | **Waitlist SMS opomnik** »vaš miza je prosta« (SMS ŽE nameščeno) | Majhen |
| 15 | **Manager approval tok** — popust nad limitom zahteva vodjin PIN (dovoljenja + limit opis ŽE; manjka modalni tok) | Majhen–srednji |

### P3 — kasneje / odvisno od mreže

| # | Ideja | Opomba |
|---|---|---|
| 16 | Benchmarks (anonimizirana primerjava med lokacijami/uporabniki) | zahteva mrežo uporabnikov |
| 17 | Hotel PMS integracija | Lightspeed vertical (Terme/hoteli SI/HR) |
| 18 | Bolt Food webhook (regionalni agregator) | poleg Glovo/Wolt |
| 19 | Payroll (ali integracija lokalnega) | Toast/Lightspeed imajo |
| 20 | Seat-level management (raven sedeža) | Square; sedeži trenutno samo števec |
| 21 | DE/IT jeziki za goste | po EN |

## 5. REGULATIVA 2026 — pripravljenost

| Področje | Zahteve | RestavrantOS | Vrzel |
|---|---|---|---|
| **ViDA (EU)** | Sprejeta 11. 3. 2025, v veljavi 12. 4. 2025; steber 1 = e-računi/digitalno poročanje; harmonizacija do 2030–2035; B2C POS računi ostanejo fiskalni (SI/HR) | eSlog AP uvoz ✓, GL izvoz ✓ | B2B IZVOZ eSlog/Peppol (P2 #11) |
| **PCI DSS v4.0** | Kartični podatki; PA-DSS upokojen (SSF) | Hranimo SAMO cardLast4, brez PAN/CVV, terminal izven | Ni KAZENSKE vrzeli — dokumentirati SAQ-A pristop v SECURITY-BOUNDARY.md |
| **NIS2** | Essen. subjekti (digitalna infrastruktura); restavracije večinoma IZVEN | SaaS lasten | Higiena: obveščanje o incidentih (EventLog že) |
| **GDPR** | PII gostov/zaposlenih | Loyalty PII že obdelan (Task 32-b), audit | Redni pregled (obstoječe) |
| **FURS SI / FINA HR** | Fiskalizacija | FURS ✓ (test), FINA 2.0 pripr. na cert | Certifikat = uporabniški korak (FURS-CERT-RUNBOOK) |
| **ZDPSI (izvedba EAA, dir. (EU) 2019/882)** | Zakon o dostopnosti do proizvodov in storitev za invalide velja od 28. 6. 2025 in zajema **storitve e-trgovine** (3. člen, 2. odstavek, 6. točka — tako sekundarni viri); nadzira Tržni inšpektorat RS. **Globe so razredene, ne en sam razpon:** pravna oseba 500–5.000 €, srednja ali velika gospodarska družba 1.000–10.000 €, samostojni podjetnik 250–2.500 €, odgovorna oseba 120–400 € (viri se razhajajo samo pri zadnji). Mikropodjetja so **izvzeta za storitve** — 3. člen, 5. odstavek direktive (EU) 2019/882 (besedilo prebrano v eur-lex: „Microenterprises providing services shall be exempt from complying with the accessibility requirements referred to in paragraph 3 of this Article"), merila < 10 zaposlenih in letni promet ali bilančna vsota do 2 mio €. To spremeni utemeljitev dostopnostnega dela: pri lastniku in pri mikropodjetjih med naročniki gre za **prodajni in uporabnostni razlog**, ne za globno grožnjo; zavezujoče je za naročnike, ki mikropodjetja niso (verige, hoteli, pogoni v trgovskih centrih), in ti bodo od produkta pričakovali izjavo o dostopnosti. RestavrantOS-a zadeva samo javni del: QR meni ter javna plačilna in rezervacijska povezava. **Novela ZDPSI-A (UL RS št. 14/26 z dne 24. 2. 2026) je že v veljavi** in leta 2026 je izdan še pravilnik o merilih funkcionalne učinkovitosti in dostopnosti; katero obveznost novela doda, sekundarni viri ne pišejo enotno (navajajo 8.a ali 9.a člen in najbrž podatke o dostopnosti ter zaznavnost identifikacijskih, varnostnih in plačilnih funkcij) **[nepreverjeno v uradnem besedilu]**. Tehnični referenci naj bi bila EN 301 549 in WCAG, a viri se razhajajo že pri različici (2.1 AA proti 2.2 A/AA) in noben od prebranih virov te povezave ne citira **[nepreverjeno v uradnem besedilu]**; ali zakon zajame tudi naročilni terminal (kiosk), je odvisno od razlage, ne od kode | `lang` dokumenta zdaj sledi jeziku, ki ga gost dejansko vidi (v1.176.0, WCAG 3.1.1/3.1.2 — prej je bil `lang="sl"` trdo zapisan); gostovi jezikovni preklopniki so pravi `<button>`-i ≥ 44 px (commit `74dcfd5`, takratna produkcija v1.45.0) | **Celoten WCAG pregled gostovih strani še ni izmerjen.** Že izmerjena drobna pomanjkljivost: na `/kiosk` sta dva gumba za količino brez imena za bralni zaslon in brez izrecno določene ciljne velikosti (`src/app/kiosk/page.tsx:449-450`, Minus/Plus brez `aria-label`). Izven dosega te izdaje ostaja tudi zahteva, ki jo uvaja novela (izjava oziroma podatki o dostopnosti, zaznavnost plačilnih funkcij) — merjena bo šele, ko bo prebrano uradno besedilo ZDPSI-A |

## 6. PRIporočen VRSTNI RED

1. ~~86-toggle (P0-3)~~ — ✅ **izvedeno v v1.83.0** (86-plošča + nadomestki + waiter-UI + testni pokrov; gl. §4).
2. ~~Handheld tok (P0-1)~~ — ✅ **izvedeno v v1.84.0** (/handheld — enoročni tok mize→naroči→fire→plačaj pri mizi z velikimi CTA v coni palca, 86 artikli sivo, offline vrsta; tests/handheld-flow.test.ts 12 testov; gl. §4.1).
3. ~~Pay link (P0-2)~~ — ✅ **izvedeno v v1.85.0** (ponudnik: Stripe Checkout prek env/Integration; simulator privzet — gl. §4).
4. ~~EN jezik gostu (P1-5)~~ — ✓ **izvedeno v v1.86.0** (delni EN slovar + 3-jezikovni preklopnik + prevod API napak; gl. §4). Ostaja: split po gostih (P1-6) — hiter dobiček.
5. **Labor forecast + AI** (P1-4, P2-9) — podatki že zbrani (prodaja po urah, labor cost).
6. Nato P2 po poslovnih prioritetah (kampanje > eSlog izvoz > widget > portal).

## 7. Sklep

RestavrantOS @ v1.85.0 je na **feature-parity s svetovnimi vodilnimi v vseh P0 vrstah
matrike** in **vodi v fiskalizaciji SI/HR, HACCP, audit verigi, menu engineeringu in
lastništvu kode**. VSE 3 P0 vrzeli so ZAPRTE: 86-toggle v v1.83.0, handheld tok v
v1.84.0 (/handheld) in online plačilna povezava v v1.85.0 (/pay/token — QR položnica
z napitnino, plačilo skozi kanonični FURS zaključek, Stripe Checkout ali simulator,
19-testni pokrov). Preostale vrzeli so P1+ (split po gostih, labor forecast, spletni portal); EN jezik za goste je ZAPRT v v1.86.0 (turistični trg).
Regulatorno je sistem pripravljen na ViDA-ero z izjemo B2B e-račun izvoza (rok 2030+).
