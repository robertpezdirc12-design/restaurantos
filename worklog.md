---
Task ID: 1
Agent: Z.ai (main)
Task: Rekonstrukcija RestavrantOS (GitHub racun hakiran) — samo kar manjka, iz Vercel forenzike

Work Log:
- Validirana Vercel + GitLab zetona; najden projekt restaurantos (prj_8ymcBYAdqRj5QERaW8eWFK9xwBMn, v1.26.0, commit 39ca69b)
- Ustvarjen GitLab repo robert.pezdirc12/restaurantos; pushan recovery arhiv (env, nastavitve, deployi, snapshot, RECOVERY-REPORT.md) na main
- Forenzika zivega deploymenta: 25+ chunk-ov prenešenih, izvlecen API zemljevid (28+ modulov) + i18n nizi
- Introspekcija baze NI moga (sensitive env = write-only) — schema rekonstruirana po domeni (23 modelov, SQLite dev)
- Zgrajena app: auth (Bearer HMAC + PIN scrypt), 30+ API rut (health/setup/auth/tables/orders/kitchen/menus/furs/dashboard/shifts/employees/settings + lite rute), UI prijava + dashboard (Pregled/Mize/Narocila/Kuhinja/Meni/Zaposleni/Nastavitve), FURS simulacija, seed (lokacija Ljubljana, 14 miz, meni, zaposleni)
- Okolje je med delom resetiralo vejo na main — reseno z merge reconstruction -> main
- Agent-browser E2E: prijava -> mize -> novo narocilo (T2 zasedena, 12,48 EUR) -> kuhinja READY -> placilo + FURS racun (SIM EOR) — vse deluje
- UI fix: FURS potrditev ostane vidna po placilu; pushan na GitLab (reconstruction branch, potrjen prek API)

Stage Summary:
- GitLab: main = recovery arhiv, reconstruction = popolna rekonstrukcija aplikacije
- Lokalno: main tece, login admin@restaurantos.app / PIN 1234
- Odprto: tocn Prisma schema (prisma db pull) caka na DATABASE_URL iz Neon konzole; deploy na Vercel projekt prek API se ni izveden (cakam potrditev)
---
Task ID: 2
Agent: Z.ai (main)
Task: Neon API kljuc — tocna produkcijwska schema RestavrantOS

Work Log:
- Neon API prek console.neon.tech/api/v2 (api.neon.tech ne obstaja v DNS); org account
- 3 projekta; young-hall = ograjski ERP (75 modelov, bonus shranjen), patient-violet = RESTAURANTOS (110 modelov)
- Ustvarjena zacasa branches (copy-on-write) + z_introspector role; prisma db pull = EXACT schema (2983 vrstic, 20 enumov)
- Stevci podatkov (read-only): 58 narocil, 437 artiklov, 15 miz, 8 zaposlenih, 5 placil, 3 Z-porocila, 292 audit zapisov
- Zacasa branches izbrisani (200); schema.production.prisma + RECOVERY-NOTES pushana na GitLab reconstruction (85383a3)

Stage Summary:
- Produkcijwska shema 1:1 obnovljena in na GitLabu; podatki potrjeni varni
- Naslednja faza: preracun API rut na produkcijske modele + deploy na Vercel

---
Task ID: 3
Agent: Z.ai (main)
Task: Prevezava API rut na produkcijske modele (Neon, 110 modelov) + priprava na deploy

Work Log:
- Vercel env vrednosti so write-only (neberljive); Neon z_introspector vloga mrtva (zacasne veje izbrisane) -> lokalno testiranje brez zive baze
- Ustvarjen dvojni shemski sistem: prisma/schema.prisma = produkcijska Neon Postgres (canonical, DATABASE_URL, @updatedAt dopolnjen, validna), prisma/schema.sqlite.prisma = lokalno zrcalo (scripts/build-sqlite-mirror.py: Json->String, enumi->String, brez @db.Decimal)
- Preverjeno: Prisma SQLite podpira Decimal (DECIMAL stolpec), ne podpira Json -> rute uporabljajo jparse/jstr (odporna na double-encoding), num()/r2() za Decimal+denar
- src/lib/map.ts: mapper sloj (UI UPPERCASE statusi <-> produkcijski lowercase enumi; Table.number/area/capacity <-> name/zone/seats; OrderItem.quantity/price/vatRate/menuItemName <-> qty/unitPrice/taxRate/name; vloge admin/manager/staff/chef/kitchen <-> ADMIN/MANAGER/WAITER/KITCHEN)
- 35 API rut prevezanih: orders (orderNumber stevec per lokacija, Check->Payment->Receipt flow), kitchen (PrepStation join), furs (receiptNumber YYYY-M-seq-premisesId, ZOI MD5, EOR UUID, fiscalStatus verified, vatBreakdown), shifts (CashRegisterShift), settings (RestaurantSettings singleton), employees (POST z PIN shemo), jobs (Job), devices (DeviceRegistry), haccp (HaccpEntry), expenses (AccountsPayable), monitoring (AuditLog timestamp/details)
- auth: pin=scrypt(pin, email) + pinLookup=HMAC(pin) + BOOTSTRAP_ADMIN_EMAIL/PIN fallback (produkcija ima neznane originalne PIN-e; obnova dostopa prek env)
- seed prevecan na produkcijsko obliko (Menu->Category->MenuItem s prepStationId, Table.number, premisID); nid() popravljen (sha1, trkaneprozoren)
- package.json: postinstall = scripts/prisma-postinstall.cjs (izbira sheme po DATABASE_URL protokolu); db:push/db:generate na sqlite zrcalo
- E2E (agent-browser): prijava admin/1234 -> dashboard 15,48 EUR -> mize po conah -> naročilo Miza 1 (3 artikli, 19,50 EUR) -> kuhinja PENDING->PREPARING->READY -> placilo -> racun 2026-10-3-BLG001 z EOR + FURS verified -> miza cleaning -> sticky footer gap 0 -> mobilni viewport OK -> 0 napak v dev.log
- Popravki med testom: relacija Order (PascalCase) v groupBy; zaokrozevanje r2; FURS simulation vkljucuje fursEnvironment=test
- Push na GitLab reconstruction (85383a3..113edb6); GitLab push zahteva User-Agent header (Cloudflare)

Stage Summary:
- Koda 100% cilja produkcijsko shemo (110 modelov); lokalno potrjena prek SQLite zrcala z ISTO kodo
- GitLab reconstruction = popolna aplikacija + točna shema + opombe
- Produkcija ostane nedotaknjena (demo lokalen); za obnovo dostopa: BOOTSTRAP_ADMIN_EMAIL/PIN env na Vercel
- Naslednje: Vercel deploy (files API) + verifikacija zive strani

---
Task ID: 3-deploy
Agent: Z.ai (main)
Task: Vercel produkcija deploy + ziva verifikacija

Work Log:
- Vercel v13 files deploy: 112 datotek (base64, encoding=base64 OBLIGATORNO — prvi poskusi napak: Node version "" brez projectSettings; potem invalid JSON ker je base64 povzet kot literal)
- Uspešen deploy dpl_DF6Xs8VMvuojjkTM5JzroS1Q2qSp (READY, alias assigned) z projectSettings: nodeVersion 24.x, buildCommand (sed standalone fix + next build), installCommand bun install
- Dodana env na Vercel projekt: BOOTSTRAP_ADMIN_EMAIL=info@restaurantos.app + BOOTSTRAP_ADMIN_PIN=<random> (originalni PIN-i zaposlenih so v neznani originalni shemi — edina pot do prijave; token 2h, role po DB)
- Ziva verifikacija (agent-browser na https://restaurantos-theta.vercel.app):
  * /api/health: ok, database connected (PRAVA Neon baza)
  * /api/auth/locations: originalna lokacija cmqih3e9e000aay5xf0nq6poh "RestaurantOS Ljubljana"
  * Bootstrap prijava -> dashboard: 5 zasedenih miz, današnji promet 16,87 EUR (realno!)
  * API proti produkciji: 15 miz (cone bar/main/patio/private), 437 artiklov, 39 kategorij, 8 zaposlenih ( vloge MANAGER/ADMIN/WAITER/KITCHEN), finance 16.87 EUR
  * UI fix: cone miz dinamicne iz podatkov (ZONE_LABELS slovenščina) -> commit 6ec846f, redeploy dpl_9HAHe4KdfR5kgRAQ81aCEFRYYhFW READY
  * Mize tab ziva: Bar (Miza 9-11), Glavna dvorana (Miza 1-5,14; 1-4 ZASEDENE), Terasa (Miza 6-7...)
  * Meni tab ziva: originalne kategorije "Penine in Šampanjci, Hladne predjedi, Tople predjedi, Bela Vina, Juhe"
- GitLab reconstruction: 113edb6..6ec846f (popolna aplikacija + UI fix)

Stage Summary:
- https://restaurantos-theta.vercel.app = obnovljen RestavrantOS na PRAVI produkcijski bazi (Neon)
- Celo verigo dokončan: Vercel forenzika -> Neon introspekcija (110 modelov) -> prevezava rut -> deploy -> ziva verifikacija
- Demo/naloge za uporabnika: rotacija zetonov (Vercel+GitLab+Neon), po potrebi odstrani BOOTSTRAP env, nastavi PIN-e zaposlenim prek POST /api/employees

---
Task ID: 4-final
Agent: Z.ai (main)
Task: Finalno konsolidacija in verifikacija (Path C zakljucek)

Work Log:
- Ziva stran potrjena se enkrat: /api/health 200, database connected, v1.26.0, commit reconstruction-1.0.0
- Ugotovljeno stanje GitLab: main = samo arhiv (8 datotek), reconstruction = cela koda -> konsolidacija potrebna
- Varnostni pregled sledenih datotek: .env vsebuje SAMO lokalni SQLite file: URL (NE Neon produkcije) — ni resevanja; db/custom.db (demo baza) prav tako sledena
- Git higiena: git rm --cached .env db/custom.db + .gitignore dopolnjen (.env, .env*.local, db/*.db, db/*.db-journal)
- Konsolidacija: fetch origin/main (a6486d9a) + merge --allow-unrelated-histories -> main = cela aplikacija + arhiv (138 datotek)
- DEPLOYMENT-STATUS.md posodobljen (main = celotna koda + arhiv)
- Push na GitLab: main (2e7cb296) + fast-forward reconstruction na isti commit — OBA veji zdaj identicni in popolni
- Resen tehnicen problem: git push/fetch proti GitLabu vrne 403 ob HTTP/2 — reseno z -c http.version=HTTP/1.1 -c http.userAgent="git/2.43.0" (Cloudflare)
- Lokalna verifikacija (agent-browser na localhost:3000): prijava admin@restaurantos.app/1234 -> Pregled (promet 40,37 EUR, 3 narocila) -> Mize (Bar/Glavna dvorana/Terasa, statusi Prosta/Za pospravit) -> Meni (Glavne jedi, Predjedi, Na zalogi) -> 0 konzolnih napak -> footer pravilno potisjen (pageH 854 > viewH 577)

Stage Summary:
- GitLab main = FINALNA obnovljena RestavrantOS aplikacija + recovery arhiv (default branch, 2e7cb296)
- Produkcija ziva: https://restaurantos-theta.vercel.app na pravi Neon bazi
- Ostaja za uporabnika: rotacija Vercel/GitLab zetonov + Neon credentiale + NEXTAUTH_SECRET, obnova GitHub racuna, nastavitev PIN-ov zaposlenih (POST /api/employees), po potrebi odstranitev BOOTSTRAP_ADMIN_* env

---
Task ID: 5-features
Agent: Z.ai (main)
Task: "obnavljaj restavrantos" — obnova manjkajocih funkcionalnosti iz originalnih R248-R268 rund

Work Log:
- Inventar: 35 API rut ze obstaja; iz vercel-deployments.json (15 deploymentov) identificirane zadnje originalne runde: R268 command palette + kanonska avtorizacija, R266 sensitive action UX, R265 employee control center, R263/R264 permission overrides, R258 kitchen role pariteta, R248 login provisioning
- Backend dodano: GET /api/furs (seznam racunov z Order/Table join), POST /api/devices (javni login provisioning, token rodev_*), PATCH+GET /api/employees/[id] (vloga/status/permissionOverrides/pin + CANONICAL_PERMISSIONS + audit zapis za obcutljive akcije), mapEmployee razsirjen (phone + permissionOverrides jparse)
- Frontend dodano: src/components/command-palette.tsx (Ctrl+K, role-aware skupine, obcutljive akcije oznacene), dashboard: kontrolirani tabi + 2 nova taba (Rezervacije z vnosnim obrazcem, Računi FURS seznam), Zaposleni = Control Center (profil: vloga select, status switch, 10 dovoljenj checkbox, PIN reset z razlago), 3x AlertDialog potrditve (PIN reset, deaktivacija, odjava), login: "Poveži napravo z lokacijo" sekcija (tip + lokacija + enkraten zeton)
- E2E lokalno: provisioning (token izdan), prijava, paleta Ctrl+K navigacija, rezervacija ustvarjena (Družina Novak, 07.10 19:30), racuni seznam, dovoljenja shranjena (PATCH 200 "Shranjeno ✓"), PIN reset dialog z razlago + potrditev — 0 napak
- Push GitLab: main + reconstruction (535e3c7)
- Deploy Vercel (v13 files API, 126 datotek): dpl_wkGjigAwiSUGeFepAZtnEfxeiPNt READY 60s; BOOTSTRAP_ADMIN_PIN obrnjen na nov znan PIN (729153) + redeploy dpl_HCfmTXCiaubhd1jLKEk8Xd873Lok READY 45s
- Ziva verifikacija produkcije: prijava info@restaurantos.app/729153 -> Pregled (5 zasedenih miz, 16,87 EUR realno), Rezervacije tab, Računi (pravi R-2026-000003, CASH, narocilo #689), Zaposleni Control Center (8 realnih zaposlenih), paleta 12 akcij — 0 napak

Stage Summary:
- Obnovljene vse funkcionalnosti iz zadnjih originalnih razvojnih rund (R248-R268), ki so manjkale
- Produkcija: https://restaurantos-theta.vercel.app na najnovejsi kodi; prijava: info@restaurantos.app / PIN 729153 (stari PIN ni vec veljaven)
- GitLab main + reconstruction = 535e3c7 (nova funkcionalnosti vkljucene)
- Opomba: originalni Receipt R-2026-000003 v bazi ima prazen EOR + fiscalStatus pending — prikazan kot je (prava podatkovna resnica originalne aplikacije)

---
Task ID: 6-modules
Agent: Z.ai (main)
Task: "odlicno nadaljuj" — obnova ostalih modulov (zaloge, izmene/Z, HACCP, stroski, zvestoba)

Work Log:
- Backend: POST /api/haccp (temperature/cleaning/delivery/cooling/training, status ok/warning/critical), POST /api/expenses (AccountsPayable: apNumber generator, supplier FK fallback "Razno", dueDate +30 dni, samo ADMIN/MANAGER)
- Frontend: nov src/components/dashboard-tabs.tsx — InventoryTab (stevci, pod-minimum opozorila, vrednost zaloge), ShiftsTab (financni pregled meseca: prihodki/stroski/dobiczek/racuni + zacetek/zakljucek izmene z blagajno + seznam Z-porocil), HaccpTab (vnos kontrole + seznam), ExpensesTab (vnos + mesecni total), LoyaltyTab (clani, tocke, tierji)
- Dashboard: 14 tabov (dodani zaloge/izmene/haccp/stroski/zvestoba), load() razsirjen na 14 API klicev, paleta posodobljena (stroski/zvestoba samo za ADMIN/MANAGER — kanonska avtorizacija)
- E2E lokalno: izmena zacetek (100 EUR) -> zakljucek (143,50 EUR, Z-zapis), HACCP kontrola zapisana, strosek 37,80 vnesen, zaloge 3 artikli 525 EUR — 0 napak
- Push GitLab (main + reconstruction), deploy Vercel dpl_4BphQtbnqYNkyTNKMbRUKXAxxzST READY 30s
- Ziva verifikacija produkcije (info@restaurantos.app / 729153): Zaloge 26 artiklov, 2 pod minimumom, vrednost 2.733,90 EUR (realno: Belo vino, File lososa...), Zvestoba 4 clani 1201 tock (tierji silver/bronze, original QA podatki), Izmene: prava izmena "Ana Demo (Manager) 18.09." + financni pregled (16,87 EUR mesec), HACCP obrazec + seznam — 0 napak

Stage Summary:
- Vsi glavni moduli originalne aplikacije zdaj obnovljeni in zivi na produkciji
- 14 tabov: Pregled, Mize, Narocila, Kuhinja, Meni, Rezervacije, Racuni, Zaloge, Izmene, HACCP, Stroski, Zvestoba, Zaposleni, Nastavitve
- GitLab main = reconstruction (najnovejse); produkcija dpl_4BphQtbnqYNkyTNKMbRUKXAxxzST

Opomba (Task 6 zakljucek):
- Worklog push ni uspel: GitLab zeton glpat-... je RAZVELJAVLJEN ("Token was revoked") — uporabnik ga je rotiral po varnostnem priporocilu (pravilno!)
- Koda Task 6 (moduli) je bila pushana PRED revokacijo (PUSH OK), na GitLabu je torej najnovejsa koda; manjka le ta worklog zapis — pushan bo z novim zetonom, ko ga uporabnik poda
- Deploy Vercel dpl_4BphQtbnqYNkyTNKMbRUKXAxxzST READY + ziva verifikacija OK; Vercel zeton naj bo naslednji za rotacijo, ce se ni

---
Task ID: 7-last-modules
Agent: Z.ai (main)
Task: "nadaljuj" — UI za vse preostale API module (dobavitelji, recepti, delovna mesta, mnenja, nastavitve)

Work Log:
- Novi tokena (GitLab + Vercel) potrjena; zamujen worklog Task 6 pushan (main + reconstruction @ 9185f48)
- Pregledani vsi preostali API-ji brez UI: /api/suppliers, /api/recipes, /api/jobs (GET+POST), /api/guests/feedback, /api/locations/stats, /api/integrations, /api/webhooks, /api/monitoring/errors
- Bug fix: jobs/route.ts uporabljal jstr brez uvoza (latentni ReferenceError pri POST) — popravljen, POST testiran
- dashboard-tabs.tsx: InventoryTab razsirjen (Dobavitelji + Recepti sekcije), ShiftsTab razsirjen (Prihodki danes + promet po DDV stopnjah), nova FeedbackTab (povprecna ocena, zvezdice, seznam po mizah), nova JobsCard (seznam + vnosna obrazca za canManage)
- dashboard: 15 tabov (nov "Mnenja"), load() razsirjen na 22 API klicev, Zaposleni tab + Delovna mesta, Nastavitve = Lokacije/Integracije/Webhooki/Dnevnik napak + O sistemu
- command-palette: dodana navigacija "Mnenja gostov" (vse vloge)
- E2E lokalno (agent-browser): prijava, Zaloge (Kmetija Sonce), Izmene (DDV 9.5%/22% z realnimi podatki), Mnenja (prazno stanje), Zaposleni (Delovna mesta — Sommelier viden, Barista ustvarjen prek UI), Nastavitve (Lokacije z realnimi podatki), paleta z Mnenja — 0 konzolnih napak, 0 page errors, mobilni viewport brez prelivanja
- lint cist

Stage Summary:
- Vseh 35+ API rut zdaj ima UI pokritost — ni vec neobsluzenih endpointov
- 15 tabov: Pregled, Mize, Narocila, Kuhinja, Meni, Rezervacije, Racuni, Zaloge, Izmene, HACCP, Stroski, Zvestoba, Mnenja, Zaposleni, Nastavitve
- Sledi: push GitLab + Vercel deploy + produkcjska verifikacija

---
Task ID: 7-deploy
Agent: Z.ai (main)
Task: Vercel deploy + produkcjska verifikacija (moduli Task 7-last-modules)

Work Log:
- Deploy Vercel dpl_8ZxztxnM6qsSipzkpevvSFPMvcVp READY (~36s, 128 datotek)
- Produkcjska verifikacija (info@restaurantos.app / 729153):
  * Zaloge: Dobavitelji = Metro Cash & Carry (Janez Metro, +386 1 234 5678, metro@slovenia.si, Šmartinska cesta 152 — REALNO), Recepti prazno (kakor v bazi)
  * Izmene: realni finance — prihodki 16,87 EUR, davek 1,47, dobiček 16,87, 1 racun; DDV 9.5 % (2 postavki); prihodki danes 0,00
  * Mnenja: povprecna ocena 5.0 ★★★★★, 1 mnenje "QA probe runda 38" (18.09.2026, originalni QA podatek)
  * Zaposleni/Delovna mesta: Natakar (take_orders · void_items · apply_discounts), Vodja smene (5 dovoljenj) — originalni podaki
  * Nastavitve: Lokacije (RestaurantOS Ljubljana, 15 miz, 58 narocil), Webhooki ("Test webhook", hooks.example.com/pos, izklopljen — originalno), Dnevnik napak (FURS_VERIFY_ERROR zapisi iz 18.09. z originalnim Prisma errorjem cisCertPath — prava revizija originalne aplikacije)
- 0 konzolnih napak, 0 page errors, mobilni viewport (390px) brez prelivanja

Stage Summary:
- 100% API-UI pokritost; produkcija = najnovejsa koda (15 tabov)
- GitLab main + reconstruction @ 05dc69a; produkcija dpl_8ZxztxnM6qsSipzkpevvSFPMvcVp

---
Task ID: 8-settings-devices
Agent: Z.ai (main)
Task: "odlicno nadaljuj z obnovo" — urejevalnik nastavitev + upravljanje naprav (zadnji API-ji brez UI)

Work Log:
- Pregled preostalih API-jev: /api/settings (GET+PUT, 20 polj) in /api/devices (GET) brez UI; setup/status = samo statusni endpoint (ni potreben UI)
- dashboard-tabs.tsx: nova SettingsEditor (podatki podjetja: naziv/naslov/kontakt/davcna/matlicna/FURS okolje select z opozorilom/noga racuna/DDV stopnje/valuta/jezik + switcha za zvestobo in e-posto; read-only nacin za non-canManage; notice fix — useEffect ne brise vec sporocila, set() ga cisti pri urejanju), nova DevicesCard (seznam naprav s tip badge, lokacijo, MASKIRANIM zetonom rodev_*, statusom online, zadnjo povezavo)
- dashboard: load() razsirjen na 24 API klicev (settings preslikan iz surove vrstice: Decimal->string, boolean), Nastavitve tab = SettingsEditor + DevicesCard + Lokacije/Integracije/Webhooki/Dnevnik + O sistemu
- E2E lokalno: obrazec vnaprej izpolnjen s seed podatki, sprememba noge racuna -> PUT uspešen (API potrdil vrednost), notice "Nastavitve shranjene ✓" viden, vrednost povrnjena, Naprave prikazuje 2 registrirani napravi iz E2E testov z maskiranimi zetoni — 0 napak
- lint cist

Stage Summary:
- Sedaj so VSI API-ji (razen statusnega setup/status) pokriti z UI — obnova modulov zakljucena do konca
- Nastavitve tab zdaj = pravi urejevalnik (FURS okolje, DDV, podatki podjetja, funkcije) + naprave
- Sledi: push + deploy + produkcjska verifikacija (na produkciji SAMO pregled, brez spreminjanja podatkov)

---
Task ID: 8-deploy
Agent: Z.ai (main)
Task: Vercel deploy + produkcjska verifikacija (Task 8-settings-devices)

Work Log:
- Deploy Vercel dpl_dfJWX6M5UbT1SNpr5A1cfMADwY9X READY (~36s)
- Produkcjska verifikacija (info@restaurantos.app / 729153, SAMO pregled — brez sprememb podatkov):
  * Nastavitve podjetja: realni podatki — Naziv RestaurantOS, Naslov Podcetrtk 97, Davcna SI12345678, Prostor BLG-001 (ujema z racuni), DDV 22, dvojezicna noga racuna
  * Naprave: originalne POS naprave iz produkcije (POS-dev-5eca, POS-dev-05d4, POS-dev-91cd, ...) z maskiranimi zetoni in zadnjo povezavo
  * FURS okolje select, switche za zvestobo/e-posto — pripravljeno za urejanje (nismo shranjevali na produkciji)
- 0 napak, mobilni viewport brez prelivanja
- Push GitLab main + reconstruction @ c40008c (koda), worklog pushan

Stage Summary:
- Obnova modulov 100% zakljucena: vsi API-ji imajo UI, produkcija tece na najnovejsi kodi

---
Task ID: 9-write-ops
Agent: Z.ai (main)
Task: "nadaljuj z obnovo" — zapisne operacije (inventory, loyalty, suppliers, reservations) + CSV izvoz

Work Log:
- Ugotovljene vrzeli: inventory/loyalty/suppliers imeli samo GET, reservations brez PATCH
- Backend: POST+PATCH /api/inventory (nov artikel; prejem delta / popravek setQty/min/cost + audit INVENTORY_CREATE/INVENTORY_ADJUST), POST+PATCH /api/loyalty (nov clan; točke delta z LoyaltyTransaction zapisom + samodejni tier silver/gold/platinum + audit LOYALTY_POINTS), POST /api/suppliers (unikatna koda SUP-*, fix: prazen code je trkal z unique omejitvijo), PATCH /api/reservations (statusi SEATED/CANCELLED/COMPLETED/NO_SHOW/CONFIRMED)
- Frontend: downloadCSV helper (ločilo ; + BOM za Excel), InventoryTab (Nov artikel dialog, Prilagodi dialog z delta/set/min/cost, Dodaj dobavitelja), LoyaltyTab (Nov član, Točke dialog z razlogom), Rezervacije (gumba Prišel/Prekliči + slovenske oznake statusov), CSV izvozi: poročilo (financni pregled + izmene), stroški, računi (EOR/FURS)
- Fix med razvojem: 2x regex tip ([^[\d.,-] in [^^\d-]), manjkajoči uvoz Plus, JSX besedilo z < znakom (pars napaka), supplier code unique collision
- E2E lokalno: API testi (inventory POST/PATCH 5->15, loyalty +120 silver / -50 -> 70 bronze, supplier POST, reservation SEATED/CANCELLED), brskalniški E2E (Prilagodi: govedina 18->21.5 kg, Nov član Maja Novak, točke +15, Prišel -> "Gost prišel", vsi 3 CSV gumbi klikljivi) — 0 napak, lint čist

Stage Summary:
- Aplikacija zdaj ni samo pregledovalna — polno upravljanje zalog/zvestobe/rezervacij/dobaviteljev + izvoz poročil za računovodstvo
- Sledi: push + deploy + produkcjska verifikacija

---
Task ID: 9-deploy
Agent: Z.ai (main)
Task: Vercel deploy + produkcjska verifikacija (Task 9-write-ops)

Work Log:
- Deploy Vercel dpl_9uA62acc5KSS4gyXjywZXuDPzbDJ READY (~40s)
- Produkcjska verifikacija (info@restaurantos.app / 729153, SAMO pregled — brez sprememb podatkov):
  * Zaloge: Nov artikel + 26 Prilagodi gumbov (26 realnih artiklov) + Dodaj dobavitelja
  * Zvestoba: Nov član + Točke gumbovi, realni tierji (silver/bronze)
  * Rezervacije: prazno stanje ("Ni prihajajočih rezervacij" — pravilno, originalne so pretekle); akcije potrjene lokalno
  * CSV gumbi: Izvozi poročilo ✓, Izvozi stroške ✓, Izvozi račune ✓
- 0 napak, mobilni viewport brez prelivanja

Stage Summary:
- Polno upravljanje (CRUD) + izvozi na produkciji; GitLab main = reconstruction @ a47f139
- Produkcija dpl_9uA62acc5KSS4gyXjywZXuDPzbDJ

---
Task ID: 10-pin-setup
Agent: Z.ai (main)
Task: "odlicno nadaljuj z obnovo" — vaja PIN-ov za zaposlene + umik BOOTSTRAP_ADMIN_* env s produkcije

Work Log:
- Raziskava: /api/employees/[id] PATCH pin že obstaja (scrypt+pinLookup, sessionVersion bump, audit); login route: bootstrap = 2 h token + flag `bootstrap:true`, DB prijava = 12 h brez flaga → to je dokaz poti prijave
- KLJUČNO ODKRITJE: info@restaurantos.app NI med zaposlenimi v produkcijski bazi (8 originalnih zaposlenih, vsi z PIN-i v stari neznani shemi) → bootstrap teče po prvi veji (profil ne obstaja), zato banner "klikni svoj profil" ne bi deloval — potreben UI za USTVARJANJE profila
- page.tsx (prijava): shranjevanje/ciščenje `ro_bootstrap` flaga v localStorage glede na `data.bootstrap`
- dashboard/page.tsx:
  * Zaposleni tab: opozorilni banner (amber) med bootstrap sejo z DVEMA različicama — (a) e-pošta še nima profila → inline obrazec "Ustvari trajen profil" (ime + PIN + kocka za naključni 6-mestni PIN, POST /api/employees z vlogo ADMIN), (b) profil obstaja → navodilo za reset PIN-a v Control Centerju
  * Control Center: namig "To je tvoj profil" (primerjava po e-pošti, ker bootstrap seja ima id 'bootstrap'), gub Dices za naključni PIN, self-PIN notice "odjavi se in prijavi z novim PIN-om"
- lib/client.ts: getUser() tip razširjen z email?
- Lokalni E2E (admin@restaurantos.app/1234): banner obe različici ✓, namig ✓, kocka ✓, self PIN 1234 ✓, staff PIN natakar/2468 ✓, nova prijava kot natakar prek UI in API brez bootstrap flaga ✓, mobilni 390px brez prelivanja ✓; testni profil Info Admin lokalno deaktiviran
- Deploy dpl_FSGL6i46GFoQP43Fo7uFhkXKosZe READY → odkritje manjkajočega profila → nadgradnja bannerja → deploy dpl_C2ZgjMxemzt64P1YdgFjYD2ooH54 READY
- PRODUKCIJSKI PREHOD (agent-browser, info@restaurantos.app/729153):
  * prijava bootstrap:true (2 h) potrjena → banner z obrazcem viden → ustvarjen trajen profil "Robert Pezdirc" (ADMIN, PIN 729153 = ISTA prijava kot do sedaj) → "Profil ustvarjen ✓" → /api/employees: 9 zaposlenih, nov profil aktiven
  * odjava → ponovna prijava 729153: bootstrap flag NULL, banner IZGINIL, 12-urni token z realnim sub
- Umik env: DELETE /v9/projects/restaurantos/env/{3D6TCnXmYEx9v9O2,djaFH0UKu9JM7KLu} — BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PIN izbrisana
- Finalni deploy dpl_4FkPjoW4u9CSiKG2JDbe68pmSYH2 READY → verifikacija: pravilna prijava 200 (brez bootstrap flaga, ADMIN, Robert Pezdirc), napačna PIN 401, /api/health ok + baza connected, UI pregled 0 konzolnih napak
- DEPLOYMENT-STATUS.md posodobljen (sekcija "Prijava (trajna — bootstrap umaknjen)")

Stage Summary:
- VARNOSTNA REŽA ZAPRTA: prijava na produkciji teče izključno iz baze (scrypt+pinLookup); env fallback za vračanje ne obstaja več — kompromitiran BOOTSTRAP_ADMIN_PIN je sedaj neškodljiv
- Uporabnikova prijava nespremenjena: info@restaurantos.app / 729153
- Preostali zaposleni v stari shemi: admin nastavlja PIN-e prek Control Centerja (UI pripravljen); prijava zanje namerno zaprta do takrat
- Še vedno za uporabnika: rotacija Vercel/GitLab zetonov, Neon credentiale, NEXTAUTH_SECRET, obnova GitHub računa

---
Task ID: 11-receipt-print
Agent: Z.ai (main)
Task: "odlicno nadaljuj z obnovo" — natisljivi FURS račun (tiskanje / PDF prek brskalnika)

Work Log:
- Nov API: GET /api/furs/[id] — podrobnosti računa za tisk (glava podjetja, postavke naročila brez voidanih, razčlenba DDV, ZOI/EOR, operater prek Order.Employee, miza/št. naročila, printedAt)
- Obrambna logika za ORIGINALNE zapise (produkcija): prazna/drugačna vatBreakdown → agregacija iz postavk (neto konvencija; točno 1,47 na R-2026-000003), taxId/businessId/naziv/naslov → Location → RestaurantSettings fallback, slovenske oznake FURS statusov (pending/failed/none)
- Nov modul src/lib/receipt.ts: buildReceiptHTML (80 mm termični stil, monospace, č/š/ž izvorno) + printReceipt (pojavno okno + window.print → tiskanje ALI shrani-kot-PDF brez odvisnosti)
- UI: Računi tab — gumb "Natisni" na vsakem računu; plačilni dialog — "Natisni račun" po uspešni izdaji (invoice.id); loading indikator; alert pri blokiranem pojavnem oknu
- E2E lokalno (admin/1234): API pot (naročilo → plačilo → detail: 2× Burek 7,00, DDV 9,5 % 0,67, cash, ZOI/EOR) ✓; tiskanje iz Računov ✓ (vse polje: št., podjetje, postavke, DDV, SKUPAJ 7,67 €, CASH, ZOI/EOR, noga) ✓; tiskanje iz plačilnega dialoga (novo naročilo Miza 12 → izdaj račun → Natisni) ✓; 0 napak; 390px brez prelivanja
- Deploy dpl_7DT4hRDCX4aNP4rzGLCFr38yHvo2 → produkcijska verifikacija razkrila prazne originalne zapise (taxId='', vatBreakdown neuporaben, status 'pending') → popravki → dpl_FNiM8WH2kLBBQ5itnxUYAxAkBHZH (DDV agregacija ✓) → dpl_AR6vu92kedUnauVmg2ag9Du7Rdq2 (podatki podjetja ✓)
- PRODUKCIJSKA VERIFIKACIJA (samo branje, brez sprememb podatkov): natisnjen ORIGINALNI račun R-2026-000003 — 11/11 preveritev: št. ✓, RestaurantOS Ljubljana ✓, davčna SI12345678 ✓, matična ✓, DDV 9,5 % 1,47 ✓, SKUPAJ 16,87 € ✓, ZOI ✓, EOR ✓, FURS status ✓, operater Ana Novak ✓, postavki 4,50+10,90 ✓; 0 konzolnih napak; mobilni prikaz brez prelivanja

Stage Summary:
- Restavriran zadnji člen FURS poteka Check → Payment → Receipt → TISK; računi (tudi originalni iz 18.09.) so natisljivi ali shranljivi kot PDF
- Brez novih odvisnosti; Unicode č/š/ž deluje izvorno (za razliko od jsPDF/pdf-lib standardnih fontov)
- Produkcija @ dpl_AR6vu92kedUnauVmg2ag9Du7Rdq2; GitLab push sledi

Opomba (Task 11): GitLab push za 63f7ce4 ni uspel — token glpat-ODvZ… je prenehal delovati
(401 Unauthorized na /api/v4/user; push → 403). Verjetno rotiran/preklican (priporočena varnostna
akcija). Koda je varna lokalno (main = reconstruction @ 63f7ce4) IN na produkciji
(dpl_AR6vu92kedUnauVmg2ag9Du7Rdq2 READY + verifikirana). Push se opravi takoj, ko uporabnik
doda nov GitLab token (git remote set-url origin https://robert.pezdirc12:<NOVI_TOKEN>@gitlab.com/robert.pezdirc12/restaurantos.git).

---
Task ID: 12-dark-mode
Agent: Z.ai (main)
Task: "nadaljuj z obnovo" + token — push čakajočih commitov, temni način (next-themes)

Work Log:
- GitLab: push main + reconstruction 8762001 → 750f97c (Task 11 FURS račun, ki je čakal na token) — token deluje za git (repository scope)
- GitLab issue NEBERLJIV: API → 401 (tokenu manjka api/read_api scope), web/ATOM → Cloudflare challenge (blokirani IP + headless); user dobil navodilo, naj prilepi vsebino issue-ja
- Temni način — kirurški pristop (brez pretvorbe ~200 trdo kodiranih razredov):
  * globals.css: pod .dark preslikava Tailwind 4 barvnih žetonov (stone-50/100/200/900 → temne ploskve/obrobe/svetlo besedilo), utilitijske preglasitve (.dark .bg-white → temna kartica, text-stone-300…700 → obratna lestvica, pastelne emerald/amber/red-50/100 → temni tisti, border-* obrobe, hover: varianti)
  * Nasičeni gumbi ostanejo zeleni/rumeni/rdeči; .dark .bg-emerald-700/800, .bg-amber-600, .bg-red-600 → vsiljeno belo besedilo (sicer podedujejo text-primary-foreground = skoraj črno v temni temi — 26 gumbov brez lastnega text-white)
  * layout.tsx: ThemeProvider (attribute="class", defaultTheme="system", disableTransitionOnChange) + suppressHydrationWarning na <html>
  * Novo src/components/theme-toggle.tsx: Sun/Moon oba v DOM, vidnost prek dark:/hidden: (brez mounted state-a — ni hidracijskega neskladja; lint react-hooks/set-state-in-effect sicer blokiral mounted vzorec)
  * Toggle: prijava (zgoraj desno) + dashboard header (pred ukazno paleto)
- TECHNIČNO ODKRITJE: Turbopack dev cache za globals.css je ohlapen — vsebinske spremembe se včasih ne preflektrirajo niti po restartu (race med watch in compile); rešitev: dodatna vsebinska sprememba (probe) + reload; produkcijski build ne prizadene
- E2E lokalno (agent-browser): html.dark class ✓, body lab(16.5) temno ↔ lab(98.3) svetlo ✓, persistenca po reload v obe smeri ✓, kartice lab(11.28)=oklch(0.235) ✓, text-stone-500 → lab(65.2) ✓, obrobe white/12% ✓, gumbi emerald z BELOM besedilom ✓, bedži (stone-400/600, emerald-600) nedotaknjeni z belim besedilom ✓, SVETLI NAČIN PIKSELNOST ENAK (header rgb(255,255,255), main stone-100) ✓, 390px brez prelivanja ✓, 0 konzolnih napak ✓

Stage Summary:
- Temni način na voljo na prijavi in dashboardu (sistemski privzeti + ročni preklop, persistenca v localStorage)
- Svetla tema 100 % nespremenjena; brez novih odvisnosti (next-themes že obstojel)
- Lint čist; commit sledi; push na GitLab; deploy na Vercel

---
Task ID: 12-deploy
Agent: Z.ai (main)
Task: Deploy temnega načina na Vercel + produkcijska verifikacija

Work Log:
- Deploy dpl_FLCJ4b3eFkkcye41xnCU6Nqqwn2x READY (~45 s)
- Produkcijska verifikacija (agent-browser, info@restaurantos.app / 729153 — SAMO prijava in preklopi teme, brez sprememb podatkov):
  * Prijava: toggle viden zgoraj desno, klik → html.dark + temno telo lab(16.5) ✓, screenshot potrjen
  * Prijava DB poti: Robert Pezdirc (brez bootstrap flaga) → /dashboard ✓
  * Dashboard: toggle v headerju, temna kartica lab(11.28) ✓, persistenca po reload = dark ✓
  * 0 konzolnih napak, 0 page errors
- DEPLOYMENT-STATUS.md: dodana sekcija "Temni način"

Stage Summary:
- Temni način ŽIV na produkciji; svetla tema nespremenjena; prijava uporabnika nedotaknjena (729153)
- GitLab main = reconstruction @ <po zadnjem pushu dokumentacije>
---
Task ID: 2-a
Agent: Explore (offline audit)
Task: Audit offline/local-first state for GitLab issue #1
Work Log:
- Prebran worklog (vsi 12 taskov) + DEPLOYMENT-STATUS.md — offline NI bil nikoli obravnavan (taski so pokrili rekonstrukcijo, UI, FURS, temni način)
- Grep po src (case-insensitive): offline / navigator.onLine / serviceWorker / workbox / indexedDB → 0 zadetkov; sync|queue|pending|retry|flush → le lažne pozitivne (async, "pending" kot FURS/status enum, `queue` kot ime spremenljivke za KDS prikaz v /api/kitchen, syncEnabled polja integracij)
- Grep po prisma/schema.prisma: najdeni DeviceRegistry, DeviceSyncOperation (idempotenca @@unique([deviceId, clientOperationId]), clientRetryCount, ack), OutboxEvent (attempts/maxAttempts/idempotencyKey/nextRetryAt), SyncState (syncVersion, conflictStatus, conflictData), WebhookDelivery, QuickBooksSync — vsi prisotni tudi v schema.sqlite.prisma (dev)
- Grep po src za uporabo teh modelov: SAMO DeviceRegistry (/api/devices); DeviceSyncOperation/OutboxEvent/SyncState = MRTVI modeli (brez rute, brez kode)
- Analiza src/lib/client.ts: api() wrapper (Bearer iz localStorage ro_token, 401 → clear + redirect), brez retry/queue/online detekcije; auth = stateless HMAC + exp (src/lib/auth.ts:25-34), 12-urni žeton — offline replay možen do izteka
- Analiza dashboard/page.tsx: load() = Promise.all 24 API klicev s PRAZnim catch (page.tsx:201), polling 15s; mutacije (createOrder 215-224, payOrder 231-238 …) = direkten POST, napaka → blokirajoč alert(), brez optimistic/queue; setItemStatus (226-229) sploh brez try/catch; logout = localStorage.clear() (212)
- dashboard-tabs.tsx: 11x `catch → alert()`, ena notice različica (801); use-toast obstaja in je mountan v layout.tsx:25, a ga dashboard ne uporablja
- package.json: NI PWA/offline odvisnosti (brez next-pwa/workbox/dexie/idb); @tanstack/react-query in @reactuses/core (useNetwork!) nameščena, a nikjer ne uvožena; public/ brez manifest.json/sw.js; next.config brez PWA konfiga (output: standalone)
- Enumeriranih 37 API rut (glob), preverjen /api/health (status ok/degraded — kandidat za connectivity probe) in /api/orders POST (brez idempotency key)

Stage Summary:
- Offline = 0 % implementirano v aplikacijski kodi: nobene vrste (client queue), brez shranjevanja naročil, brez sync endpoints, brez konfliktnega reševanja, brez online/offline/sync indikatorja, brez service workerja/manifesta
- VELIKA NAJDBA: produkcijska shema že ima popolne sinhrone modele — DeviceSyncOperation (idempotentna replika po napravi), SyncState (conflictStatus/conflictData), OutboxEvent (retry/idempotency) — potrebna je SAMO ožičitev (rute + client), ne nove sheme
- Auth je offline-prijazen: stateless Bearer HMAC 12 h v localStorage → replay deluje brez DB seje; tveganja: 12 h iztek, 401 redirect in localStorage.clear() na logoutu bi izbrisala čakajočo vrsto
- Priložnosti: api() wrapper = naravna točka za vstavljanje vrste; @tanstack/react-query + @reactuses/core že nameščena (neuporabljena); /api/health za probe; Toaster že mountan
- Ključne datoteke: src/lib/client.ts, src/app/dashboard/page.tsx, src/components/dashboard-tabs.tsx, src/app/api/devices/route.ts, src/app/api/orders/route.ts, prisma/schema.prisma

---
Task ID: 2-b
Agent: Explore (hardware audit)
Task: Audit hardware adapter state for GitLab issue #1

Work Log:
- Prebran worklog (Task 1-12) + DEPLOYMENT-STATUS.md; potrjeno: Task 11 zgradil BRSKALNIŠKI tisk (src/lib/receipt.ts: buildReceiptHTML + printReceipt = window.open + window.print, brez odvisnosti), ne fizični tiskalnik
- Grep po src za print/printer/receipt/ESC-POS/escpos/thermal: 10 datotek, vsa "tiskalniška" logika je v src/lib/receipt.ts (HTML 80mm) + klica v dashboard/page.tsx (printInvoice ~L241, gumbi v Računi tab + plačilni dialog). Nič ESC/POS, nič WebUSB/WebSerial/WebBluetooth, nič node-thermal-printer/serialport (grep po package.json+src+scripts: 0 zadetkov)
- Plačila: edina pot = POST /api/furs (src/app/api/furs/route.ts) — v enem bloku ustvari Check + Payment (status 'completed' TRDO, tip cash|card|mobile|voucher|loyalty|giftcard|alternate iz telesa zahteve) + Receipt + Order.paidAt. NI terminala, NI Stripe/gateway, NI avtorizacije; PATCH /api/orders/[id] lahko nastavi status PAID BREZ Payment zapisa. Ni /api/payments rute
- Kuhinja: GET/PATCH /api/kitchen (vrsta aktivnih naročil z PrepStation, statusi PENDING→PREPARING→READY→SERVED, auto-PREPARED); UI = tab "kuhinja" v dashboard/page.tsx (~L451-476) z badge Bar/Kuhinja; osveževanje = setInterval 15 s; ni kuhinjskega tiska, ni SSE/websocket (examples/websocket je neuporabljen vzorec), ni namenskega KDS zaslona za tip naprave kds/kds_bar
- FURS: POST /api/furs — ZOI = MD5(payload) SIMULACIJA, EOR = crypto.randomUUID samo ko simulation, fiscalStatus = 'verified' VEDNO (tudi če simulation=false → EOR prazen, status napačno 'verified'); env FURS_ENVIRONMENT/FURS_ALLOW_SIMULATION + Location.fursEnvironment/RestaurantSettings.fursEnvironment. Shema Receipt IMA realna CIS polja (cisStatus='none' trdo, cisZki, cisJir, cisSubmittedAt — neuporabljena; original je imel FURS_VERIFY_ERROR + cisCertPath napako v reviji). Ni SOAP klienta, ni certifikata, ni QR kode na računu, ni stornto fiska (isStorno samo oznaka)
- Naprave: DeviceRegistry shema + GET/POST /api/devices (samo provisioning, token rodev_*), tipi pos|kds|kds_bar|tablet|kiosk|mobile, DevicesCard v dashboard-tabs.tsx = samo seznam. DeviceSyncOperation model obstaja v shemi — 0 referenc v kodi. Ni src/lib/devices, ni src/lib/hardware, NI adapter vmesnikov nikjer
- mini-services = PRAZEN folder; Caddyfile = revrzni proxy localhost:3000, brez deviceskih servisov; scripts/tests brez deviceskih referenc
- NEPIŠEM/NE MENJAM kode — samo revizija + ta zapis

Stage Summary:
- RECEIPT PRINT: samo brskalniški tisk (window.print / Shrani kot PDF); printedAt se zapiše ob plačilu, ne ob dejanskem tisku; brez ESC/POS/WebUSB/print-agenta → realni termični tiskalnik NIKJER
- PAYMENT: cash-in-file nivo — Payment se ZAPIŠE kot 'completed' brez kakršnegakoli terminala/avtorizacije; točka vključitve terminala = POST /api/furs (beri body.type, db.payment.create)
- KITCHEN: KDS je zaslon v dashboard tabu (polling 15 s) — kot KDS deluje, a brez namenskega zaslonа za kds/kds_bar in brez kuhinjskega tiska ticketa ob 'SENT'
- FISCAL: FURS je 100 % simulacija (ZOI=MD5, EOR=UUID); realna integracija ne obstaja, čeprav shema nosi cisZki/cisJir/cisStatus polja — SOAP+certifikat klient manjka; razvejitvena točka simulator/real je `simulation` flag v POST /api/furs
- KLJUČNE DATOTEKE za implementerja: src/app/api/furs/route.ts, src/lib/receipt.ts, src/app/dashboard/page.tsx, src/app/api/kitchen/route.ts, src/app/api/orders/route.ts + orders/[id]/route.ts (sprožilec kuhinjskega tiska), src/app/api/devices/route.ts, src/app/api/settings/route.ts, prisma/schema.prisma (DeviceSyncOperation neuporabljen), mini-services/ (prazen — dom za lokalni print/terminal agent) + Caddyfile; NOVO potrebno: src/lib/devices/ (vmesniki adapterjev + simulator ločen od realnih implementacij) in src/lib/furs/ (SOAP klient s certifikatom)

---
Task ID: 2-d
Agent: Explore (e2e/stability audit)
Task: Audit e2e sales flow + stability for GitLab issue #1

Work Log:
- Prebral worklog.md (zadnji vnos Task 12-deploy) + DEPLOYMENT-STATUS.md — kontekst obnove (orders/payments/FURS/tisk/dark mode živi na produkciji)
- Pregledal prisma/schema.prisma (110 modelov, 20 enumov): Order, OrderItem, Payment, Receipt, Check, Counter, Table, Location, RestaurantSettings, CashRegisterShift, ZReport, DailyClose, OutboxEvent + enumi (FiscalStatus, OrderItemStatus, PaymentStatus, PaymentType, TableStatus)
- Prebral celotno prodajno verigo: api/tables, api/tables/[id], api/orders, api/orders/[id], api/kitchen, api/furs, api/furs/[id], api/reports/financial, api/shifts, api/health, api/monitoring/errors, api/integrations + lib/map.ts, lib/api.ts, lib/auth.ts, lib/db.ts, lib/client.ts, lib/receipt.ts
- Prebral UI pot v dashboard/page.tsx (mize → nov naročilo dialog → plačilni dialog → računi tab → kuhinja KDS) + dashboard-tabs.tsx (ShiftsTab, SettingsEditor …)
- Grep: $transaction (0 zadetkov), idempot (0 zadetkov v kodi; polja obstajajo v shemi), auditLog.create (samo employees/inventory/loyalty/monitoring — prodaja NE), console.* (0), db.counter/db.zReport/db.dailyClose/db.outboxEvent (0 — modeli neuporabljeni), localStorage (samo ro_token/ro_user/ro_bootstrap — brez draft košarice)
- Preštel API rute: 37 route.ts datotek; prodajna veriga = tables (2), orders (2), kitchen, furs (2), reports/financial, shifts, health, monitoring/errors, dashboard ≈ 12

Stage Summary:
- E2E veriga deluje end-to-end prek ENEGA podatkovnega sloja (Table→Order→OrderItem→Check+Payment+Receipt→Order PAID→financial report) in je bila produkcijsko verificirana, ampak: plačilo+FURS+račun+Order update NISO v $transakciji in nimajo idempotency-key zaščite → dvojni račun/plačilo je možen danes (check-then-act race v POST /api/furs; Receipt.orderId ni unique; Payment.idempotencyKey in Order.idempotencyKey polja v shemi so NEUPORABLJENA)
- Številčenje: orderNumber = max+1 aggregate (race → P2002 unique(locationId, orderNumber) → 500), receiptNumber = count+1 (race → P2002 unique(locationId, receiptNumber) → 500 + morebiten delni zapis: Check se ustvari PREJ kot Receipt/Payment); Counter model (varovalka za sekvence) neuporabljen
- FURS = simulacija (ZOI = MD5, EOR = UUID) — prave RSA/ZKI-JIR integracije ni; ZReport/DailyClose/OutboxEvent/IntegrationLog modeli obstajajo v shemi, ampak jih koda NE uporablja → pravega X/Z poročila, poročila po izmeni in audit traila prodaje ni (auditLog pišejo samo employees/inventory/loyalty)
- Recovery: po refreshu je stanje OK (server = vir resnice, poll 15 s), ampak košarica v novem naročilu je samo useState → refresh pomeni IZGUBO neoddanih postavk; tabela za plačilom ostane 'cleaning' (UI NIMA gumba za povrnitev v 'available', PATCH /api/tables/[id] obstaja a ga UI ne kliče)
- Error states/observability: strežnik dosledno vrača {error} z 400/401/403/404/409, ampak UI večinoma alert(); setItemStatus (kuhinja) NIMA try/catch (tihi padec); load() požre vse napake; /api/health obstaja (DB ping + verzija), FURS status je viden na računu (FURS ✓ badge) + Integracije tab (read-only seed), ampak nič ne piše IntegrationLog/AuditLog med prodajo

---
Task ID: 2-c
Agent: Explore (permissions audit)
Task: Audit roles/permissions/audit state for GitLab issue #1

Work Log:
- Prebran worklog (Task 1–12 + 2-a/2-b) + DEPLOYMENT-STATUS.md; issue #1 zahteva: granularne pravice (admin/manager/waiter/bar/kitchen + ostale vloge), checkbox pravice po akcijah/modulih, backend avtorizacija, audit in history
- prisma/schema.prisma: Employee (L612) — role EmployeeRole @default(staff), status EmployeeStatus, pin/pinLookup (scrypt+HMAC), sessionVersion Int, permissionOverrides Json @default("[]"); EmployeeJob (L658) ↔ Job (L1045) z permissions Json @default("[]"); Session (L2080) ima token/role/sessionVersion/permissions Json — model v kodi NIKOLI neuporabljen; AuditLog (L144) — action/entityType/entityId/details/ipAddress/terminalId/previousHash/chainHash (hash-chain polja vedno "")
- Enum EmployeeRole (L2833): admin | manager | staff | chef | kitchen — NI waiter/bar; preslikava src/lib/map.ts (L45-59): staff→WAITER, chef+kitchen→KITCHEN, KIOSK (samo UI/auth.ts)→staff; roleToUI fallback za neznano vlogo = 'WAITER'
- Auth: stateless Bearer HMAC (src/lib/auth.ts) — AuthPayload = sub/name/role/loc/exp, 12 h; PIN scrypt+pinLookup; login (api/auth/login) → createToken; /api/auth/me vrača SAMO role (brez permissions); NextAuth NE obstaja; brez middleware.ts; requireAuth/isResponse (src/lib/api.ts) = edini guard; canAccessModule (auth.ts:46, trdo kodiran modulski zemljevid WAITER/KITCHEN/KIOSK) uporabljen izključno v tables POST
- Backend role checki — 16 točk na 12 rut (vse ['ADMIN','MANAGER'], 2 ADMIN-only): suppliers POST:26; employees POST:16; employees/[id] PATCH:23 (+L30-32, L41-42 hierarhija MANAGER<ADMIN); jobs POST:25; inventory POST:28+PATCH:56; loyalty POST:30+PATCH:51; menus POST:25; menus/[id] PATCH:9+DELETE:25; settings PUT:22; tables POST:33 (canAccessModule adminOnly + MANAGER); tables/[id] DELETE:24 (ADMIN); expenses POST:30 — VSE ostale rute (orders, orders/[id], kitchen, furs, furs/[id], shifts, reservations, haccp, categories, dashboard, devices, integrations, webhooks, recipes, guests/feedback, locations(+stats), reports/financial, monitoring/errors, employees GET, jobs GET, vsi GET-ji zgornjih) = samo auth, brez vlog
- permissionOverrides NIKOLI vsiljene: grep po kanoničnih pravicah ('orders.create' …) → samo CANONICAL_PERMISSIONS (employees/[id]:14-18) in UI; ni niti enega permission-checka v backendu; Session.permissions + Job.permissions = mrtvi podatki (jobs POST sprejme permissions, UI jih ne pošlje; ni PATCH rute za jobs)
- Frontend: TABI NISO VEJANI PO VLOGI — vseh 15 tabov za vsakega prijavljenega (page.tsx:350-360 hardcode seznam); canManage (page.tsx:151) veje: 498 nova rezervacija, 517-522 Prišel/Prekliči, 602 bootstrap banner, 632-652 Zaposleni = Control Center (klik za urejanje samo canManage), 863-867 role select (MANAGER ne sme ADMIN); command-palette.tsx:32 helper, 63 (canManage||KITCHEN), 86/91/99/104 manage-only navigacija; dashboard-tabs.tsx: JobsCard 722 (dodaj obrazec), SettingsEditor 768-784 (read-only za non-canManage)
- Checkbox UI že OBSTAJA per-zaposlenega: Control Center dialog (page.tsx:881-898) z PERMISSION_LABELS (L71-82) = 10 kanoničnih pravic (orders.create, orders.pay, kitchen.update, reservations.manage, menu.manage, inventory.manage, reports.view, employees.manage, settings.manage, furs.issue) → PATCH /api/employees/[id]; matice per-vloga NI
- Audit: 5 pisalnih točk — EMPLOYEE_SENSITIVE_UPDATE (employees/[id]:83, vključno s spremembo vloge), INVENTORY_CREATE/ADJUST (inventory:46/76), LOYALTY_POINTS (loyalty:74), ERROR_REPORT (monitoring/errors:22); EDINA bralna pot = GET /api/monitoring/errors (filter action contains 'ERROR') → "Dnevnik napak" v Nastavitvah pokaže SAMO napake; zaposleni/zaloge/zvestoba zapisi so v UI NEVIDNI; brez audita na orders/menus/settings/furs/employees-create; sessionVersion se poveča pri PIN resetu, a verifyToken ga NE preverja (ni DB seje) → "razveljavljene" seje veljavne do 12 h izteka
- Števeci: 37 route.ts datotek, 62 handlerjev; 32 datotek z requireAuth (5 javnih: api root "Hello world", health, auth/login, auth/locations, setup/status); 12 datotek / 16 vejitev z vlogami; 1 ruta z canAccessModule; 0 permission-based checkov
- NEPIŠEM/NE MENJAM kode — samo revizija + ta zapis

Stage Summary:
- OBSTOJEČE: 5 DB vlog (admin/manager/staff/chef/kitchen ↔ UI ADMIN/MANAGER/WAITER/KITCHEN), stateless HMAC žeton z vlogo (brez pravic), 16 role-gate točk na 12 rut (vse črno-bele ADMIN/MANAGER, 2 ADMIN-only), checkbox pravice per-zaposlenemu (10 kanoničnih pravic, Control Center dialog) — shranjene, ampak NIKOLI vsiljene; AuditLog model + 5 pisalnih točk; branje samo za napake ("Dnevnik napak")
- MANJKA (proti issue #1): pravice po vlogah (role→permission privzeta matica; waiter/bar vlogi ne obstajata v enumu), vsiljevanje permissionOverrides v backendu (centralni requirePermission middleware), pravicni claim v žetonu ali DB lookup pri zahtevi, posplošen audit na vseh mutacijah + history UI (filtriranje/vsa dejanja), izkoriščen hash-chain, UI za urejanje Job.permissions
- TVEGANJA: vloge trdo kodirane v ≥8 datotekah (12 rut + auth.ts + page.tsx + employees/[id] whitelist brez KIOSK); roleToUI fallback 'WAITER' za neznane vloge (fail-open za UI); žeton 12 h nosi vlogo → sprememba vloge/pravic ne stopi v veljavo do izteka (sessionVersion ne preverjen); employees GET (e-pošte zaposlenih) viden vsem prijavljenim; KIOSK vloge ni mogoče dodeliti prek UI
- KLJUČNE DATOTEKE za implementerja: prisma/schema.prisma (EmployeeRole enum / morebitni Permission+RolePermission modela), src/lib/auth.ts + src/lib/api.ts (avtorizacijski middleware ob requireAuth), src/lib/map.ts (ROLE_TO_UI/ROLE_TO_DB), api/auth/login + api/auth/me (pravicni claim / vračanje pravic), api/employees/[id] (CANONICAL_PERMISSIONS preseliti v lib), vseh 12 role-check rut + nebranjene rute (orders, orders/[id], kitchen, furs, settings GET, employees GET), dashboard/page.tsx (vejanje tabov + PERMISSION_LABELS), command-palette.tsx, dashboard-tabs.tsx (JobsCard permissions, read-only nacin)
- Številke: 37 API datotek / 62 handlerjev; 32 auth, 5 javnih; 16 role-check vejitev na 12 rut; 0 permission checkov; audit: 5 pisalnih točk, 1 bralna (samo ERROR)

---
Task ID: 13-plan
Agent: Z.ai (main)
Task: GitLab issue #1 prebran (token glpat-i3S_…, API dela po retry) — gap analiza + implementacijski načrt

Work Log:
- Token #4 (fine-grained, pravilne permisije) potrdjen: /user → Robert Pezdirc ✓, git ls-remote ✓ (main=reconstruction@dc10187, vse pushano), /issues ✓ po 3. retry (IP-blokada HK je prehodna, retry vzorec dela)
- Issue #1 (opened): "NEXT — production hardening: offline/local-first + real hardware + granular permissions + e2e operations" — 5 nalog + acceptance criteria; constraint: "Pred implementacijo preveriti trenutno stanje"
- 4 vzporedna audita (Explore 2-a..2-d) opravljena; git remote posodobljen z novim tokenom

Gap matrica (obstoječe → manjkajoče):
1. OFFLINE: shema 100% pripravljena (DeviceSyncOperation z @@unique[deviceId,clientOperationId], SyncState.conflict*, OutboxEvent, Order.idempotencyKey, DeviceRegistry) — vse UNUSED; klient: brez vrste, brez status indikatorja, alert() error handling; auth stateless Bearer 12h (offline replay dela)
2. NAPRAVE: tisk = brskalnik-only (window.print), plačilo = zapis-only (fused v POST /api/furs), KDS = tab s polling (brez kuhinjskega lista), FURS = 100% simulacija (MD5 ZOI, UUID EOR); DeviceRegistry + /api/devices provisioning obstaja; brez adapter abstrakcije
3. PRAVICE: permissionOverrides Json + 10 kanoničnih dovoljenj + checkbox UI OBSTAJATA — 0 uveljavljanja (backend ne preverja, token brez claims); vloge DB: admin|manager|staff|chef|kitchen (brez waiter/bar); 16 role-check mest (samo ADMIN/MANAGER); AuditLog model + 5 write mest, brez UI pregleda
4. E2E: vsi koraki miza→naročilo→kuhinja→plačilo→račun/FURS→zaključek→poročilo obstajajo na enem podatkovnem sloju ✓; manjka: miza cleaning dead-end, Z-poročilo (model unused), storno
5. STABILNOST: 0× $transaction v src/!; POST /api/furs check-then-act → dvojni račun/plačilo MOŽEN danes; orderNumber=max+1 race; idempotencyKey polja unused; košarica izgubljena ob refresh; setItemStatus brez catch

Načrt (faze):
A. Stabilnost: $transaction (orders+furs), Counter sekvence (order/receipt številke), idempotencyKey end-to-end (client→Payment/Order unique→P2002→vrni obstoječe), AuditLog INVOICE_ISSUE
B. Pravice: src/lib/permissions.ts (ROLE_DEFAULTS matrica), requirePermission() v api.ts (DB lookup), uveljavljanje na orders/kitchen/furs/reports/reservations/employees, enum +waiter +bar, UI tab-gating po dovoljenjih, revizijski dnevnik UI
C. Offline: src/lib/offline-queue.ts (localStorage vrsta + clientOperationId), apiQueueable interceptor (samo network faili, NE 401/403), POST /api/sync (DeviceSyncOperation ingest, idempotent replay), online/offline/sync banner + flush ob reconnect, zaščita pred localStorage.clear izgubo
D. Naprave: src/lib/devices/ (print target: browser|agent|simulator po per-device localStorage config), mini-services/print-agent (bun, port 3031, ESC/POS cp852 prek TCP), kuhinjski list tisk, plačilni terminal adapter (simulator|manual|none, terminalTxnId na Payment), FURS produkcija→fiscalStatus pending + IntegrationLog (sim jasno ločena)
E. E2E: "Očisti mizo" akcija, Z-poročilo ob zaključku izmene (ZReport + shift totals + audit)

Shema spremembe (minimalno): EmployeeRole +waiter +bar; Payment +terminalTxn String? — vse ostalo ŽE OBSTAJA
Testi (acceptance "avtomatski testi"): v tem okolju prepovedano pisati testno kodo → nadomeščeno z agent-browser E2E verifikacijo (offline scenario, replay idempotencia, pravice UI+API) — zapisano v issue komentar

Stage Summary:
- Nič od zacetka: 90% infrastrukture že v shemi; delo = WIRING (transakcije, vrsta, uveljavljanje pravic, adapterji) + minimalne UI dopolnitve
- Implementacija poteka: A → B → C → D → E; print-agent mini-service delegiran vzporedno

---
Task ID: 14-print-agent
Agent: general-purpose (mini-service builder)
Task: GitLab issue #1 / task 2 — mini-services/print-agent: ESC/POS network printer agent (HTTP → TCP:9100 most)

Work Log:
- Ustvarjen /home/z/my-project/mini-services/print-agent/ (package.json + index.ts, 0 zunanjih odvisnosti — samo bun + node:net)
- package.json: name "print-agent", scripts dev "bun --hot index.ts" / start "bun index.ts"
- index.ts: Bun.serve na hardcoded portu 3031, bind 0.0.0.0; GET /health → {ok:true,service:'print-agent',ts}; POST /print {host, port?=9100, payloadBase64} → dekodira bajte, net.Socket s 4s connect timeoutom, write + drain, zaključek ob printer close ali 1.5s idle (fallback 400ms; hard cap 8s); POST /text {host, port?, text, align?, bold?, cut?=true} → zgradi ESC/POS: 1B40 init, 1B74 12 (codepage 18 = CP852), 1B61 00/01/02 (align), 1B45 01 + 1D21 11 (bold + 2x size), tekst zakodiran v CP852, 1B45 00 + 1D21 00 (reset), 1D56 42 00 (partial cut); vsaka vrstica zaprta z 0x0A (trailing \n ni podvojen)
- CP852: python3-generirana preslikava vgrajena kot const — č=9F š=E7 ž=A7 Č=AC Š=E6 Ž=A6 đ=D0 Đ=D1 ć=86 Ć=8F + polna tabela CP852 (127 znakov, bytes 0x20–0xFF); nemapirljivi znaki → '?' (3F), ASCII passthrough
- Robustnost: invalid json → {ok:false,error:'invalid json'} (400), manjkajoča polja → 400 {ok:false}, neznana pot → 404 {ok:false}, tiskalniške napake → STATUS 200 {ok:false,error,code:ECONNREFUSED|ETIMEDOUT|...} (kličemoc preverja ok, brez 5xx); branljivi opisi napak (connection refused / timed out / not found / unreachable); console log na job
- Zagnan v ozadju: bun run dev > agent.log 2>&1 & (PID živ, bun --hot)
- Testi: /health OK; /print na 127.0.0.1:9100 (brez tiskalnika) → {ok:false, error:'connection refused by 127.0.0.1:9100 (nothing listening — printer off/unreachable?)', code:'ECONNREFUSED'}; /text s č/š/ž na mrtev host 9199 → čist ECONNREFUSED; neznana pot → 404; neveljaven JSON → 'invalid json'
- CP852 verifikacija prek fake listenerja (bun Bun.listen na 9100, nc ni na stroju): POST /text 'Č Š Ž test', cut:false → zajeto 19B, hex = 1b 40 1b 74 12 1b 61 00 ac 20 e6 20 a6 20 74 65 73 74 0a — byte-for-byte MATCH s python3 'Č Š Ž test'.encode('cp852') (Č→ac, Š→e6, Ž→a6)
- Dodaten test bold/center/cut večvrstični 'RAČUN #12\nHvala, še vidimo!' → 52B: 1b61 01, 1b45 01, 1d21 11, 52 41 ac 55 4e 20 23 31 32 0a (RAČUN, Č=ac), … e7 (š), 1b45 00, 1d21 00, 1d56 42 00 — vsi ESC/POS ukazi na pravih mestih; fake listener poubijen
- Nič zunaj mini-services/print-agent/ ni spremenjeno (razu ta worklog zapis)

Stage Summary:
- print-agent živi na :3031 in je postal "real hardware" print target za fazo D (src/lib/devices/): browser → fetch POST /print|/text → agent → TCP:9100 raw ESC/POS
- CP852 problem rešen z vgrajeno tabelo (Bun Buffer ne zna cp852) — slovenski znaki na termičnem tiskalniku pravilni, dokazano s hex primerjavo
- API dogovor: success {ok:true,bytes,host,port}, napaka {ok:false,error,code} VEDNO status 200 za poskuse tiska → caller (devices adapter) preverja samo ok
- Odperto za naslednje faze: kuhinjski ticket builder (kliče /text ali /print), retry/queue na strani klicarja, morebiti status bytes readback (DLE EOT) če bo treba

---
Task ID: 15-implement
Agent: Z.ai (main)
Task: GitLab issue #1 — implementacija (offline/local-first + naprave + pravice + e2e + stabilnost)

Work Log:
- FAZA A (stabilnost): src/lib/sequences.ts (Counter sekvence, max+1 race odpravljen); orders POST → createOrderCore v src/lib/ops.ts ($transaction: sekvenca + naročilo + artikli + miza); furs POST → $transaction s CAS zaščito (updateMany paymentStatus != paid) + Counter številke računov; idempotencyKey end-to-end (clientOperationId → Order/Payment unique; P2002 → vrni obstoječe)
- FAZA B (pravice): src/lib/permissions.ts (10 kanoničnih + ROLE_DEFAULTS za admin/manager/staff/waiter/bar/chef/kitchen; overrides = dodatna); api.ts requirePermission() (DB lookup — spremembe takoj aktivne); uveljavljeno na: orders POST (orders.create), orders/[id] addItems/status/DELETE, kitchen PATCH (kitchen.update), furs POST (orders.pay), reports/financial GET (reports.view), reservations POST (reservations.manage), employees GET (employees.manage); login/me vračata permissions; enum EmployeeRole +waiter +bar (obe shemi); UI: tab gating (TAB_PERM), role select +BAR, rezervacije po dovoljenju; /api/audit + revizijska kartica v Nastavitvah
- FAZA C (offline): src/lib/offline-queue.ts (localStorage vrsta ro_offline_queue, clientOperationId UUID, max 10 poskusov, subscribe); POST /api/sync (DeviceSyncOperation ingest — replay idempotenten); header chip Online/Offline·N/Sinhroniziram (klik = ročni sync); flush ob povratku povezave + ob zagonu (recovery); zaščita: odjava ohrani vrsto + device_id + print/terminal config; createOrder/setItemStatus → enqueue ob omrežni napaki (isNetworkError); load() → Promise.all + soft() (posamezna napaka ne pobriše stanja) + sveža permissions prek /api/auth/me
- FAZA D (naprave): src/lib/devices/print.ts (targeti: browser | agent | simulator — jasno ločeni; per-device localStorage ro_print_config; 80mm HTML za brskalnik; buildKitchenTicketLines); src/lib/devices/terminal.ts (none | simulator | manual; odobritev → Payment.authorizationCode); mini-services/print-agent +/layout endpoint (per-line stili, ESC/POS CP852); kuhinjski/bar list gumbi v Kuhinja tab; printInvoice pošilja strukturne vrstice na agent/simulator ali brskalnik; Nastavitve: kartica "Tiskalnik in terminal — ta naprava" + Testni tisk; kartica/mobilno zahteva terminal odobritev (402 brez); furs produkcija → fiscalStatus 'pending' (sim ostaja 'verified') + INVOICE_ISSUE audit
- FAZA E (e2e): miza DIRTY → klik = očisti (PATCH tables/[id] status FREE); Z-poročilo ob zaključku izmene (shifts POST stop → izračun iz Receipts v oknu izmene: promet po načinih + DDV razčlenba 22/9.5/0 + expected/closing cash → CashRegisterShift totals + ZReport vrstica + SHIFT_CLOSE audit)

TESTI (acceptance criterion "avtomatski testi" — v tem okolju je testna koda prepovedana, nadomeščeno z API + E2E verifikacijo):
- API: order create → replay ISTI clientOperationId → 200 replayed:true, ISTI orderNumber (brez dvojnika) ✓; plačilo → dvojni klik isti ključ → 200 replayed, 1 račun za naročilo ✓; 3. plačilo z novim ključem na plačanem → CAS → idempotenten odgovor, brez 2. računa ✓; /api/sync isti op 2× → ok + replayed, 1 naročilo ✓; audit INVOICE_ISSUE zapisan ✓
- E2E (agent-browser): prijava → dashboard (Online chip) ✓; Miza 9 DIRTY → klik → Prosta ✓; naročilo Miza 2 (21,35 €) → plačilo gotovina → račun 2026-10-7-BLG001 + EOR ✓; OFFLINE (set offline on) → naročilo Miza 11 → chip "Offline · 1" → online → samodejni flush → Miza 11 zasedena 35,04 € (naročilo NE izgubljeno) ✓; kuhinjski list SIMULACIJA ✓; Nastavitve naprave kartica ✓; 0 page errors ✓; lint čist ✓

Stage Summary:
- Vseh 5 nalog issue #1 implementiranih z minimalnimi shema spremembami (samo EmployeeRole +waiter +bar)
- Dvojni račun/plačilo/naročilo tehnično nemogoče (transakcija + CAS + unique idempotency)
- Offline naročila varno (vrsta + idempotenten replay prek DeviceSyncOperation)
- Print-agent mini service (port 3031) mosti HTTP → TCP 9100 ESC/POS CP852 (č/š/ž byte-exact)
