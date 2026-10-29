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

## 3. TRŽNA MATRIKA 2026 (RestaurantOS @ v1.82.9 proti vodilnim)

Legenda: ✓ ima · ~ delno · ✗ manjka · — ni relevantno za ta trg
| Funkcija | Lightspeed | Toast | Square | Loyverse | POS Sector (SI) | **RestaurantOS** |
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
| **Lastni portal za spletna naročila** | ✓ | ✓ | ✓ | ✗ | ✗ | **✓ (v1.190.0 /s/token: javna trgovina — prevzem/dostava, plačilo ob prevzemu)** |
| Zaloge + recepture | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Normativi/kalo | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Menu engineering | ✓ | ✓ | ✓ | — | ✗ | ✓ (Kasavana-Smith) |
| Nabava (PO/prevzemi) | ✓ | ✓ | ✓ | ~ | ✓ | ✓ (+recurring) |
| HACCP | — | — | — | — | ✓ | ✓ (+načrti) |
| Računovodstvo (izvoz) | ✓ (avto) | ✓ | ✓ | — | ✓ | ✓ (GL/CSV/eSlog AP) |
| X/Z, DDV po stopnjah | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Prodaja po urah + labor strošek | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| **Labor FORECAST (napoved ur)** | ✓ | ✓ | ✓ | ✗ | ✗ | **✓ (v1.186.0)** |
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

**Bitke, ki jih RestaurantOS ŽE ZMAGUJE:** fiskalizacija SI+HR (svetovni vodilni je nimajo),
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
| 6 | **Split po gostih** (poleg izstavkov) — »2 gosta na računu« posebni zahtevek — ✅ **ZAPRTO (v1.185.0)**: `POST /api/orders/[id]/checks/guests` (`{guestCount: N}`, 2–10) porazdeli ne-voided postavke na N pravih izstavkov (LPT po znesku: najdražja postavka v trenutno najlažje vedro — ne po številu), atomsko v transakciji, z revizijo ORDER_CHECK_GUEST_SPLIT; ponoven klic medtem, ko nič ni plačano, PREBALANSIRA (prejšnji dodatni izstavki se izbrišejo); varovalke kot split po izstavkih (samo odprto naročilo, brez plačanih izstavkov, brez plačil na izstavkih, N ≤ število postavk); UI: v plačilnem dialogu (upravljanje izstavkov) gumbi »Na 2/3/4/5 gostov«; i18n SL/HR; tests/v185-split-guests.test.ts 12 testov (pravice, validacija, konservativnost, LPT pravičnost, rebalans, voided) | Majhen → izvedeno |
| 7 | **Integrirana kartična plačila z vinjetami za napitnino na terminalu** (SumUp/Stripe Terminal/Bankart — lokalni SI/HR ponudniki) | Velik (partner) |
| 8 | **Lastni spletni portal za prevzem** (spletna stran + plačilo → direktno v POS) — ✅ **ZAPRTO (v1.190.0)**: javna gostovska stran `/s/<token>` (token = skrivnost 32 hex, rotacija = revokacija — vzorec rezervacijskega widgeta `/r`): ENOTEN meni iz POS DB (loadPublicMenu — cene/86/opcije/alergeni), košarica, prevzem ali dostava (dostavnina + minimalni znesek = denarna politika LOKACIJE — client jih ne nastavlja), kontakt gosta (ime/telefon + naslov pri dostavi), **plačilo ob prevzemu** (pošteno — nikoli lažnega "splačano"); naročilo gre SKOZI kanonično jedro `createOrderCore` z NOVIM virom `web` (peti vir poleg pos/qr/kiosk/delivery) → Order/OrderItem/KDS/plačilo/FURS brez duplikata logike; urnik lokacije zapre sprejemanje (409, posebni dnevi + tedenske vrstice + odmor + prekoračitev polnoči); idempotenca `clientOperationId` + replay kontekst vira; javno sledenje statusa prek HMAC trackKey (brez dodatnih stolpcev na Order, brez razkrivanja obstoja; rotacija tokena sledenja NE prekine); DDL: nova tabela `WebOrderPortal` (migracijska konzola → web-portal); nastavitvena kartica v Nastavitvah (settings.manage: vklop, načini, prepMinutes, minOrder, dostavnina, opomba, povezava + rotacija); push ORDER_NEW osebju; revizija GUEST_ORDER_CREATED brez PII; i18n SL/HR + polna EN pokritost gostovske strani (`web.store.` v EN_GUEST_PREFIXES); tests/v190-web-portal.test.ts 29 testov | Srednji → izvedeno |

### P2 — konkurenčna prednost

| # | Manjka | Trud |
|---|---|---|
| 9 | ~~**AI napovedi/insights**~~ — **DELNO ZAPRTO (v1.186.0)**: deterministični motor (`src/lib/ai-insights.ts`) — mrtvi artikli, predlog restocka, vrhovi obremenitve, labor anomalije; vsak klic zapisan v AIConversation (prvi pisec doslej mrtve tabele, `deterministic-v1`); ruta `/api/reports/ai-insights` + kartica v pregledu. OSTAJA (P2-9b): LLM naracija nad strukturiranimi vpogledi (provider odprt — brez nove odvisnosti v CI) | Srednji–velik → jedro izvedeno |
| 10 | ~~**Loyalty kampanje + e-mail marketing**~~ — ✅ **ZAPRTO**: kampanje z življenjskim ciklom + segmenti (all/vip/loyalty/frequent/new/inactive — win-back) so zaprte od v1.126.0 (issue #11: Campaign/CampaignSend/GuestConsent, SMTP+SMS, cron odprema, CRM tab); rojstnodnevni kupon **ZAPRTO (v1.187.0, P2-10b)**: model Coupon (unikatna koda BD{YY}-{8}, idempotenca @@unique(gost, razlog, leto pojavljanja), 29. 2. v ne-prestopnem letu = 28. 2.), dnevni cron korak 'coupons' (okno 3 dni pred praznikom, 15 %, velja 30 dni, obvestilo po e-pošti SAMO z veljavnim soglasjem — fail-soft), odkup SKOZI kanonično popustno jedro (POST /api/orders/[id]/discount { couponCode } — CAS, osebnost gosta, izpeljana zapadlost, brez vračanja ob odstranitvi popusta, kot #45), ročna izdaja/preklic (settings.manage, POST/PATCH /api/coupons), UI: CouponsCard v CRM tab + koda kupona v plačilnem dialogu; tests/v187-coupons.test.ts | Zaprto (v1.187.0) |
| 11 | **eSlog B2B IZVOZ + Peppol** — **KODA ZAKLJUČENA (issue #4, v1.125.0 → v1.149.0)**: generator UBL 2.1 (eSLOG 2.0 SI + HR profil), življenjski cikel EInvoiceOutbox (9 statusov, forward-only, CAS/idempotenca), issue/send/retry/webhook rute, UI kartica v financih, AP uvoz že od prej. OSTAJA (LASTNIKOVA odločitev, ne koda): izbira ponudnika e-poti / PEPPOL dostopne točke (transport je ključavniško BLOKIRAN — nikoli ne lažemo, da je poslano), potrditev profilnih oznak pred produkcijo, validacija proti uradni XSD (čaka uradni validator) — docs/E-INVOICES-SI-HR.md | Srednji → koda končana, transport čaka lastnika |
| 12 | ~~**Javni rezervacijski widget** (/r/[token] javni URL + Google Business link)~~ — ✅ **ZAPRTO (v1.110.0, issue #13)**: /r/&lt;token&gt; javna stran (datum/št. oseb/prost termin/stik → REZERVIRA, termini in prostost strežniško), nastavitvena kartica v zavihku Nastavitve (vklop, rotacija skrivnosti, politika terminov); a11y vrata pokrivajo /r od v1.177.0 | Zaprto (v1.110.0) |
| 13 | ~~**Knjigovodski portal**~~ — ✅ **ZAPRTO (v1.189.0, P2-13)**: read-only agregacijska kartica `AccountingPortalCard` na vrhu zavihka Računi (kamor vloga accounting PRISTANE po tab-permissions), ki na enem mestu za izbrano obdobje prikaže: KPI (neto promet, DDV, popusti iz X/Z payloada `/api/reports/export?section=zz&format=json`), DDV po stopnjah + plačila po načinih, GL obračun z balanso (uravnovešena/NE + razlika, radij 0.02 — enako kot jedro gl.ts; `/api/reports/gl`), eSlog odpremo po vseh 9 statusih z opozorili (failed/needs_review/rejected; `/api/einvoices`) in stroške obdobja (agregat `periodTotal/periodPaid/periodCount` nad CELO periodo — GET `/api/expenses` razširjen z opcijskima from/to, brez DDL, brez nove rute, brez parametrov odgovor nespremenjen). **Ključna najdba:** eSlog kartica je v nabavi (inventory.manage) — knjigovodja je odpremo prej sploh VIDEL; 0 mutacij (read-only — dejanja ostajajo v obstoječih karticah), 0 novih rut, 0 DDL; izračuni v čistem sloju `src/lib/accounting-portal.ts`; tests/v189-accounting-portal.test.ts (čisti sloj, backend obdobje + obseg, read-only invarianta, ožičenje, i18n pariteta) | Zaprto (v1.189.0) |
| 14 | ~~**Waitlist SMS opomnik** »vaša miza je prosta«~~ — ✅ **ZAPRTO (v1.188.0, P2-14)**: prehod waiting → notified na PATCH /api/waitlist POSKUŠA poslati SMS na guestPhone (fail-soft — izid NIKOLI ne blokira prehoda; usaditev gosta je primarno dejanje): brez številke → 'no_phone', brez SMS integracije lokacije → 'sms_unconfigured', napaka ponudnika → 'failed', uspeh → 'sent'; izid na vnosu (notifyStatus), v reviziji (SAMO status — brez številke in vsebine, PII higiena; GDPR: enkratno storitveno obvestilo = izvedba zahtevane storitve, ne marketing) in v odgovoru (UI takoj pokaže izid); ponovni poskus failed (resend) samo za obveščenega gosta (audit WAITLIST_SMS_RESEND); besedilo po jeziku lokacije (sl/hr, src/lib/waitlist.ts čisti sloj); UI: izid pod statusom, gumb za ponovni pošiljanje, namig o namenu številke pri vnosu; strežniški sloj z vbrizgaljivimi odvisnostmi (src/lib/waitlist-run.ts — mock.module zavrnan, vzorec crm.ts); tests/v188-waitlist-sms.test.ts | Zaprto (v1.188.0) |
| 15 | ~~**Manager approval tok** — popust nad limitom zahteva vodjin PIN~~ — ✅ **ZAPRTO (v1.107.0, issue #19)**: generični dialog razloga/odobritve (strežnik avtoritativen — vsak klic validira prag/odobritelja), politik izjem (excVoidApprovalAmountCents itd.), prikaz polj odobritelja po politiki; tok uporabljen tudi za kupon izjem (v1.187.0) | Zaprto (v1.107.0) |

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

| Področje | Zahteve | RestaurantOS | Vrzel |
|---|---|---|---|
| **ViDA (EU)** | Sprejeta 11. 3. 2025, v veljavi 12. 4. 2025; steber 1 = e-računi/digitalno poročanje; harmonizacija do 2030–2035; B2C POS računi ostanejo fiskalni (SI/HR) | eSlog AP uvoz ✓, GL izvoz ✓ | B2B IZVOZ eSlog/Peppol (P2 #11) |
| **PCI DSS v4.0** | Kartični podatki; PA-DSS upokojen (SSF) | Hranimo SAMO cardLast4, brez PAN/CVV, terminal izven | Ni KAZENSKE vrzeli — dokumentirati SAQ-A pristop v SECURITY-BOUNDARY.md |
| **NIS2** | Essen. subjekti (digitalna infrastruktura); restavracije večinoma IZVEN | SaaS lasten | Higiena: obveščanje o incidentih (EventLog že) |
| **GDPR** | PII gostov/zaposlenih | Loyalty PII že obdelan (Task 32-b), audit | Redni pregled (obstoječe) |
| **FURS SI / FINA HR** | Fiskalizacija | FURS ✓ (test), FINA 2.0 pripr. na cert | Certifikat = uporabniški korak (FURS-CERT-RUNBOOK) |
| **ZDPSI (izvedba EAA, dir. (EU) 2019/882)** | Zakon o dostopnosti do proizvodov in storitev za invalide velja od 28. 6. 2025 in zajema **storitve e-trgovine** (3. člen, 2. odstavek, 6. točka — tako sekundarni viri); nadzira Tržni inšpektorat RS. **Globe so razredene, ne en sam razpon:** pravna oseba 500–5.000 €, srednja ali velika gospodarska družba 1.000–10.000 €, samostojni podjetnik 250–2.500 €, odgovorna oseba 120–400 € (viri se razhajajo samo pri zadnji). Mikropodjetja so **izvzeta za storitve** — 3. člen, 5. odstavek direktive (EU) 2019/882 (besedilo prebrano v eur-lex: „Microenterprises providing services shall be exempt from complying with the accessibility requirements referred to in paragraph 3 of this Article"), merila < 10 zaposlenih in letni promet ali bilančna vsota do 2 mio €. To spremeni utemeljitev dostopnostnega dela: pri lastniku in pri mikropodjetjih med naročniki gre za **prodajni in uporabnostni razlog**, ne za globno grožnjo; zavezujoče je za naročnike, ki mikropodjetja niso (verige, hoteli, pogoni v trgovskih centrih), in ti bodo od produkta pričakovali izjavo o dostopnosti. RestaurantOS-a zadeva samo javni del: QR meni ter javna plačilna in rezervacijska povezava. **Novela ZDPSI-A (UL RS št. 14/26 z dne 24. 2. 2026) je že v veljavi** in leta 2026 je izdan še pravilnik o merilih funkcionalne učinkovitosti in dostopnosti; katero obveznost novela doda, sekundarni viri ne pišejo enotno (navajajo 8.a ali 9.a člen in najbrž podatke o dostopnosti ter zaznavnost identifikacijskih, varnostnih in plačilnih funkcij) **[nepreverjeno v uradnem besedilu]**. Tehnični referenci naj bi bila EN 301 549 in WCAG, a viri se razhajajo že pri različici (2.1 AA proti 2.2 A/AA) in noben od prebranih virov te povezave ne citira **[nepreverjeno v uradnem besedilu]**; ali zakon zajame tudi naročilni terminal (kiosk), je odvisno od razlage, ne od kode | `lang` dokumenta zdaj sledi jeziku, ki ga gost dejansko vidi (v1.176.0, WCAG 3.1.1/3.1.2 — prej je bil `lang="sl"` trdo zapisan); gostovi jezikovni preklopniki so pravi `<button>`-i ≥ 44 px (commit `74dcfd5`, takratna produkcija v1.45.0); celovit WCAG pregled gostovih strani izmerjen in odpravljen (v1.177.0); kontrast 1.4.3 od v1.179.0 preverjen v OBAH paletah, svetli in temni | **Izmerjeno v v1.177.0.** Gate `tests/v177-guest-a11y.test.ts` meri osem pravil (name 4.1.2, label 3.3.2, group 1.3.1, keyboard 2.1.1, target EN 301 549 5.6, contrast 1.4.3, status 4.1.3, dialog 4.1.2 — opis okna) čez štiri javne gostove rute (`/m/<token>`, `/kiosk`, `/pay/<token>`, `/r/<token>`). Na izvirni kodi je naštel **74 kršitev** (/m 47, /kiosk 18, /pay 5, /r 4; po pravilih target 22, contrast 14, name 11, group 8, status 8, label 7, dialog 3, keyboard 1 — vključno s starejšo najdbo Minus/Plus na `/kiosk`). Ročno najdena je bila še ena (besedilo v nogi `/pay`), skupaj **75**, vse odpravljene in vrata so zdaj brezhibne. Tri kršitve so prišle iz **brskalnika in ne iz branja kode**: `globals.css:653` je z ne-layered `min-height: 2.5rem` (zdaj `2.75rem`, izmerjeno na vrstici **687** — numerično se je premaknila za +30, ker je v1.179.0 dodala `.dark` pravila nad njo; vsebina je nespremenjena) v kaskadi premagal utility razred `min-h-11` in gostov cilj tiho znižal na 40 px; zaporna gumba `<DialogPrimitive.Close>`/`<SheetPrimitive.Close>` sta merila 16 × 16 px; tri okna (voziček in artikel na `/m` ter artikel na `/kiosk`) so imela `aria-describedby`, ki je kazal na vozlišče, ki ga ni — Radix je zato v konzoli javljal opozorilo. Vsaka ima svoj preizkus (`cascade`, pin nad skupnima komponentama in pravilo `dialog`), ker jih branje JSX-a ne more videti. **Merjeni kontrast (1.4.3) je v tisti izdaji veljal samo za svetlo paleto**: helper je bral `node_modules/tailwindcss/theme.css`, `src/app/globals.css:147-153` pa ima sloj `.dark`, ki žetone `--color-stone-50/100/200/900` prepiše (razredni del istega sloja je na vrsticah 154–201) — izmerjeno je, da se `/m` na tej napravi izriše prav pod njim (`documentElement.className = "dark"`, `prefers-color-scheme: dark` je res). Vrata torej **niso potrjevala kontrasta v temnem načinu**; za spremembe, ki jih je izdaja naredila (`text-stone-400` → `text-stone-600`), sta izračunana oba načina in v obeh razmerje zviša (svetlo 2,59 → 7,64; temno 3,70 → 7,29). **Vrzel je zaprta v v1.179.0:** helper pozna obe paleti, o vsakem elementu odloča v obeh in pade, če pade v kateremkoli načinu, sporočilo pa imenuje način. Na nepopravljenem drevesu je javil **48 kršitev, in vse so padle samo v temnem načinu** (po rutah `/m` 4, `/kiosk` 35, `/pay` 6, `/r` 3; 8 parov): `text-stone-100` na `bg-stone-800` 1,22:1 (19 rab), `text-white` na `bg-stone-900` 1,09:1 (12), `text-stone-800` na `bg-white` 1,10:1 (2), `text-stone-900` na `bg-amber-500` 1,97:1 (2), `text-stone-400` na `bg-stone-800` 3,85:1 in na `bg-stone-900` 3,62:1 (11), `text-red-400` na `bg-stone-900` 2,65:1, `text-stone-500` na `bg-green-50` 2,55:1. Vzrok ni bil napačen odtenek ampak vloga: Tailwind naredi `bg-X` in `text-X` iz istega žetona, zato je vsak prepis žetona pod `.dark` obrnil površino in besedilo hkrati — temna lupina `/kiosk` je pod `.dark` postala bela ploščad z belim besedilom. Popravek je zato na vlogsko ločenih razrednih pravilih (`globals.css:215-226`; žetoni sami niso spremenjeni), en par pa je rešen z izbiro razreda (`src/app/kiosk/page.tsx:379`, `text-stone-900` → `text-stone-950`), ker para `stone-900`/`amber-500` z žetonom ni rešiti brez posrednosti v barvi gumba. Po popravku istih osem parov v temnem načinu: 13,93 / 17,49 / 13,57 / 9,21 (prej 1,97) / 5,69 in 6,55 / 6,05 / 5,39 — svetla stran tabele je nespremenjena. Živo v brskalniku pod `.dark` (barvi razrešeni s canvasom): `/m` **3 od 27** izrisanih parov v padcu, najslabši 1,09:1 → **0 od 27**, najslabši 6,35:1; `/kiosk` **9 od 22**, najslabši 2,75:1 → **0 od 22**, najslabši 4,87:1. Gate in brskalnik se ujemata do 0,02 (5,62 proti 5,62; 4,89 proti 4,87; 6,33 proti 6,35; 13,38 proti 13,37; 17,49 proti 17,49). Varuje `tests/v179-dark-contrast.test.ts` (24 testov, 84 expect-ov); mehanizem je bil mutacijsko preizkušen na končnem drevesu in vseh šest namernih posegov v paleto ali v bralnik `.dark` je javilo rdeče na pričakovanem kraju (izhodišče in vsaka obnova: 112 pass / 0 fail čez obe WCAG datoteki, drevo `cmp`-identično vrnjeno). Prvi tek harnessa je en poseg spustil: preizkus D6 je bil **lažen priklop** — trdil je pravilen rezultat iz napačnega razloga, ker variantni razred `.dark .hover\:bg-x` zavrne že regex in preverjanje lastnosti, ne varnostna plast za variante. Fixture je bil prepisan v obliko `.dark .bg-white\:focus`, ki jo drži samo tista plast, in poseg je nato javil 1 padec. Izven dosega te izdaje ostaja tudi zahteva, ki jo uvaja novela (izjava oziroma podatki o dostopnosti, zaznavnost plačilnih funkcij) — merjena bo šele, ko bo prebrano uradno besedilo ZDPSI-A. **Naslednja izdaja (v1.178.0) je zaprla enega od stranskih učinkov tega pregleda, dostopnostna napaka pa ni bila:** gostova stran `/m` si je ob stalno odprtem zavihku sama sebe sprašala po meniju (izmerjeno **190 zahtevkov `/api/public/menu` v 8 s**, nato je ruta odgovarjala samo še s `429`), zato gost menija ni dobil pred oči; odpravljeno je z dekonstrukcijo stabilnih setterjev po vzoru `/r` na rutinah `/m`, `/pay` in `/kiosk`. Po popravku na živo izmerjeno **0 zahtevkov v 20 s**, 13/13 poimenovanih gumbov pa ostane. Varuje `tests/v178-menu-refetch-loop.test.ts`: nobena gostova ruta ne sme imeti containerja `useGuestApiError()` v nizu odvisnosti |

## 6. PRIporočen VRSTNI RED

1. ~~86-toggle (P0-3)~~ — ✅ **izvedeno v v1.83.0** (86-plošča + nadomestki + waiter-UI + testni pokrov; gl. §4).
2. ~~Handheld tok (P0-1)~~ — ✅ **izvedeno v v1.84.0** (/handheld — enoročni tok mize→naroči→fire→plačaj pri mizi z velikimi CTA v coni palca, 86 artikli sivo, offline vrsta; tests/handheld-flow.test.ts 12 testov; gl. §4.1).
3. ~~Pay link (P0-2)~~ — ✅ **izvedeno v v1.85.0** (ponudnik: Stripe Checkout prek env/Integration; simulator privzet — gl. §4).
4. ~~EN jezik gostu (P1-5)~~ — ✓ **izvedeno v v1.86.0** (delni EN slovar + 3-jezikovni preklopnik + prevod API napak; gl. §4). ~~Ostaja: split po gostih (P1-6) — hiter dobiček.~~ — ✓ **izvedeno v v1.185.0** (gl. §4 #6).
5. ~~Labor forecast + AI (P1-4, P2-9)~~ — ✓ **izvedeno v v1.186.0** (P1-4: deterministična napoved dela — povprečje istega dne tedna, uteži ur, potreba po urah iz ciljnega labor-% in tehtane urne postavke, vrzeli vs. načrt; P2-9a: AI vpogledi — mrtvi artikli, restock, vrhovi, labor anomalije + prvi zapis v AIConversation; ostaja P2-9b: LLM naracija — gl. §4).
6. ~~Nato P2 po poslovnih prioritetah (kampanje > eSlog izvoz > widget > portal).~~ — kampanje + rojstnodnevni kupon (P2-10) zaprto v v1.126.0 + v1.187.0; waitlist SMS (P2-14) zaprto v v1.188.0; knjigovodski portal (P2-13) zaprto v v1.189.0; P2-12 (widget) in P2-15 (approval tok) sta bili že zaprti (v1.110.0/v1.107.0 — preverjeno v kodi, vrstica je bila zastarela); P2-11 je koda končana, transport čaka lastnikovo izbiro ponudnika; **P1 #8 (lastni spletni portal za naročila) ZAPRTO v v1.190.0** — zadnja odprta P1 vrzel. Naslednji vrstni red: **P2-9b (LLM naracija nad strukturiranimi vpogledi — po lastnikovem navodilu trenutno izključeno, dela brez AI)** > preostanek (P3: payroll #19, seat-level #20, DE/IT #21; #16–#18 odvisni od mreže/partnerjev).

## 7. Sklep

RestaurantOS @ v1.85.0 je na **feature-parity s svetovnimi vodilnimi v vseh P0 vrstah
matrike** in **vodi v fiskalizaciji SI/HR, HACCP, audit verigi, menu engineeringu in
lastništvu kode**. VSE 3 P0 vrzeli so ZAPRTE: 86-toggle v v1.83.0, handheld tok v
v1.84.0 (/handheld) in online plačilna povezava v v1.85.0 (/pay/token — QR položnica
z napitnino, plačilo skozi kanonični FURS zaključek, Stripe Checkout ali simulator,
19-testni pokrov). Preostale vrzeli so P1+ (split po gostih, labor forecast, spletni portal); EN jezik za goste je ZAPRT v v1.86.0 (turistični trg).

**Posodobitev oktober 2026 (v1.190.0):** B2B e-račun IZVOZ je koda zaključena (generator UBL 2.1/eSLOG 2.0 + življenjski cikel + rute + UI, v1.125.0–v1.149.0) — produkcija čaka IZKLJUČNO lastnikovo izbiro ponudnika e-poti/PEPPOL; waitlist SMS opomnik je zaprt (v1.188.0); knjigovodski portal je zaprt (v1.189.0 — read-only agregacija promet/DDV/GL/e-računi/stroški za vlogo accounting); **lastni spletni portal za naročila je zaprt (v1.190.0 — /s/<token>: javna trgovina s prevzemom/dostavo, naročilo skozi kanonično jedro z virom `web`, urnik lokacije kot vrata, HMAC sledenje statusa; zadnja odprta P1 vrzel)**; ostaja P2-9b (LLM naracija — izključena medtem, ko lastnik dela brez AI) in lastniške odločitve (transport e-poti, Fiskalizacija 2.0 cert).
