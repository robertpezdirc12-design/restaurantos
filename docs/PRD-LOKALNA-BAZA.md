# PRD — lokalna baza in samodejni zagon RestaurantOS

| | |
|---|---|
| Verzija dokumenta | 1.3 |
| Datum | 24. 10. 2026 |
| Status | R1 izveden (v1.165.0); R2a izveden (v1.169.0); R2b1 izveden (v1.170.0); R2b2 izveden (v1.175.0); izhodni pogoj na tablici še ni preizkušen |
| Lastnik | lastnik izdelka |
| Povezave | `docs/ARCHITECTURE.md`, `docs/BACKUP-RESTORE.md`, `docs/DEPLOYMENT-RESILIENCE.md` |

## 1. Problem

RestaurantOS je danes v produkciji vezan na Neon Postgres in Vercel. To prinaša
tri praktične omejitve:

1. **Obrat brez oblaka ne deluje** — če Neon ni dosegljiv (pavza, kvota,
   omrežni izpad), blagajna nima baze.
2. **Vsaka namestitev potrebuje oblačni račun** — prodaja in preizkus sta
   odvisna od Neon projekta, ne od računalnika v restavraciji.
3. **Strojna oprema je v lokalnem omrežju** — tiskalniki, predal blagajne in
   terminali so dosegljivi lokalno, ne iz Vercelove brezstanovne funkcije.

Neon je bil 21. 10. 2026 začasno pavziran (do 1. 11. 2026), zato je to tudi
takojšnja operativna ovira, ne le arhitekturna želja.

## 2. Ključna arhitekturna odločitev

**Vercel ne more uporabljati lokalne baze.** Vercelove funkcije so brezstanovne
in ne vidijo datotečnega sistema restavracijskega računalnika. Zato „Vercel + lokalna
baza“ ni izvedljiv; izvedljiva sta dva profila iste kode:

| Profil | Kje teče aplikacija | Baza | Namen |
|---|---|---|---|
| **Lokalni** | računalnik v obratu (Windows/Linux/macOS) | SQLite datoteka v podatkovni mapi | produkcija v restavraciji, delo brez oblaka, dostop do lokalne strojne opreme |
| **Oblačni** | Vercel | Neon Postgres | javni demo, oddaljeni dostop, več lokacij v oblaku |

Pravila:

- Koda je **ena**; profil se izbere z `DATABASE_URL` (`file:` → lokalni,
  `postgresql://` → oblačni).
- SQLite shema je generirano zrcalo produkcijske Prisma sheme
  (`prisma/schema.sqlite.prisma`, generator `scripts/build-sqlite-mirror.py`).
- Lokalni profil **ne odpravi** potrebe po internetu za FURS fiskalizacijo in
  kartična plačila. Odpravi odvisnost od **oblačne baze**.
- PWA namestitev in offline delovanje na telefonih zahtevata varen kontekst
  (HTTPS). V R1 je lokalno omrežje na HTTP; to je bila zavestna omejitev in
  obseg R2b2, kjer je HTTPS narejen (v1.175.0).

```
LOKALNI PROFIL                          OBLAČNI PROFIL
┌──────────────────────────┐            ┌──────────────────────────┐
│  brskalnik / PWA         │            │  brskalnik               │
│  (LAN, HTTPS od v1.175)  │            │  (HTTPS)                 │
└────────────┬─────────────┘            └────────────┬─────────────┘
             │                                       │
┌────────────▼─────────────┐            ┌────────────▼─────────────┐
│  Next.js na računalniku  │            │  Vercel (serverless)     │
│  v obratu + TLS fronta   │            │                          │
└────────────┬─────────────┘            └────────────┬─────────────┘
             │                                       │
┌────────────▼─────────────┐            ┌────────────▼─────────────┐
│  SQLite (lokalna datoteka)│            │  Neon Postgres           │
│  %LOCALAPPDATA%\...       │            │  (oblačna baza)          │
└──────────────────────────┘            └──────────────────────────┘
```

## 3. Cilj in merila uspeha

**Cilj:** lastnik po namestitvi zažene RestaurantOS z enim ukazom, brez Neon
računa in brez ročnega urejanja `.env`; baza se ustvari sama, podatki ostanejo
lokalno, aplikacija pa je dostopna z računalnika in naprav v lokalnem omrežju.

**Merila uspeha R1:**

- od svežega klona do prijave **≤ 10 minut** (brez čakanja na oblak);
- **0 klicev** na oblačno bazo v lokalnem profilu;
- ponovni zagon **ne** izgubi podatkov in **ne** podvoji uporabnikov;
- nobena nadgradnja ne sme tiho uničiti podatkov (destruktivna sprememba se
  zavrne);
- oblačni profil ostane nespremenjen in zelen.

## 4. Obseg

**V obsegu R1:**

- samodejno določena podatkovna mapa zunaj repozitorija;
- samodejno ustvarjene in trajne skrivnosti (`APP_SECRET`, `PIN_LOOKUP_SALT`,
  `CRON_SECRET`) z restriktivnimi pravicami;
- samodejna priprava SQLite sheme iz zrcala;
- varen prvi zagon: lastniški račun z naključnim PIN-om, brez demo PIN-ov;
- samodejni zagon aplikacije in izpis lokalnega ter omrežnega naslova;
- `mode`/`databaseEngine` v `/api/health`;
- runbook in ta PRD.

**Izven obsega R1 (po izdajah):**

- HTTPS v lokalnem omrežju in zagon ob prijavi (R2b2, izvedeno v v1.175.0);
  namestitev PWA na tablici je predmet sprejemnega preizkusa, ki še ni bil
  opravljen;
- omejitev offline vrste glede na dolžino in starost (R2b1, izvedeno v v1.170.0);
- samodejne varnostne kopije in obnova (R2a, izvedeno v v1.169.0);
- WAL, `synchronous=FULL` in busy timeout (R2a, izvedeno v v1.169.0);
- čarovnik prve namestitve v brskalniku (R3);
- rollback nadgradenj (R4b); lokalni migracijski pogon, ki je bil del te vrzeli,
  je izdan v v1.183.0 (R6) in sme samo dodajati — kar shema vzame nazaj, ta pogon
  samo javi, ne more pa storiti;
- šifrirana kopija v oblaku, licenciranje, paketni namestilnik (R4b/R5b);
- sinhronizacija med več strežniki (ni cilj; SQLite je en pisec).

## 5. Uporabniške zgodbe

- **US1 (lastnik):** kot lastnik na nov računalnik namestim RestaurantOS in se
  prijavim z natisnjenimi poverilnicami, ne da bi odprl Neon ali urejal `.env`.
- **US2 (natakar):** kot natakar odprem aplikacijo na tablici v lokalnem omrežju
  in se prijavim s svojim PIN-om.
- **US3 (podpora):** kot podpora po posodobitvi vidim, ali je baza lokalna ali
  oblačna, in poznam pot do podatkov ter varnostne kopije.
- **US4 (razvijalec):** kot razvijalec ohranim Vercel + Neon za oblačni profil
  brez sprememb v kodi.

## 6. Funkcionalne zahteve

| ID | Zahteva | Prioriteta |
|---|---|---|
| F1 | Podatkovna mapa: `RESTAURANTOS_DATA_DIR`, sicer `%LOCALAPPDATA%\RestaurantOS` (Windows), `~/Library/Application Support/RestaurantOS` (macOS), `$XDG_DATA_HOME/restaurantos` (Linux) | P0 |
| F2 | Skrivnosti se ustvarijo enkrat, shranijo v `config.json` z lastnikovimi pravicami (POSIX `0600`; Windows NTFS ACL brez skupine `Users`) in se ob ponovnem zagonu **ne** rotirajo | P0 |
| F3 | Shema se ustvari iz `prisma/schema.sqlite.prisma`; na obstoječi bazi brez `--accept-data-loss` | P0 |
| F4 | Prvi zagon ustvari lokacijo, nastavitve in lastnika z naključnim 6-mestnim PIN-om; PIN se izpiše enkrat in shrani v `PRVIC-ZAGON.txt` | P0 |
| F5 | Demo seed (`prisma/seed.ts`) se v lokalnem profilu **ne** izvede; demo prijava je izklopljena | P0 |
| F6 | Zagon zgradi aplikacijo, če manjka, in jo zažene na `0.0.0.0`, z izpisom localhost in LAN naslovov | P0 |
| F7 | `/api/health` vrne `mode` in `databaseEngine` brez razkritja poti | P0 |
| F8 | Ponovni zagon je idempoten: brez novih uporabnikov, brez novih skrivnosti, podatki ostanejo | P0 |
| F9 | Destruktivna sprememba sheme se zavrne z jasnim sporočilom in brez spremembe baze | P0 |
| F10 | Runbook in README opisujeta lokalni in oblačni profil ter omejitve R1 | P0 |

## 7. Merila sprejema R1

| ID | Merilo | Preveritev |
|---|---|---|
| A1 | Svež klon + `bun install` + `bun run local` pripelje do prijave brez Neon/Postgres okolja | ročni E2E + curl `/api/health` |
| A2 | Baza nastane v podatkovni mapi zunaj repozitorija; v repo se ne zapiše nobena baza | test poti + pregled `git status` |
| A3 | Skrivnosti so stabilne med zagoni in se ne izpišejo v log | test ponovnega branja + pregled izpisa |
| A4 | Shema se ustvari; destruktivna sprememba se zavrne brez `--accept-data-loss` | test + statična invarianta |
| A5 | Lastnik je ustvarjen z naključnim PIN-om, hashiranim; demo računi ne obstajajo | integracijski test + SQL poizvedba |
| A6 | `/api/health` vrne `status:"ok"`, `mode:"local"`, `databaseEngine:"sqlite"`, `schema:"ok"` | E2E curl |
| A7 | Drugi zagon ne podvoji lastnika in ne spremeni PIN-hasha | integracijski test |
| A8 | Ponovna prijava z istimi poverilnicami deluje po ponovnem zagonu | E2E: login → restart → login |
| A9 | Oblačni profil ostane nespremenjen; testi in `tsc` so zeleni | polni suite + Vercel health |
| A10 | README, PRD in runbook so posodobljeni | pregled dokumentacije |

## 8. Vrstni red izdaj

| Izdaja | Naslov | Obseg | Izhodni pogoj |
|---|---|---|---|
| **R1 — v1.165.0** | Lokalna baza iz enega ukaza | F1–F10, A1–A10 | `bun run local` ustvari bazo in lastnika, aplikacija teče, Vercel nespremenjen |
| **R2a — v1.169.0** | Vzdržljiva lokalna baza | WAL + `synchronous=FULL` + busy timeout, dnevna kopija čez `VACUUM INTO` (ne prekop datoteke), integritetni pregled kopije, zadrževanje 14 dni, `local:backup`, `local:restore`, čist postanek počisti rep | kopija vsebuje zadnji potrjeni zapis, obnova je **izvedena** na pravi bazi in zapisana v `LOKALNI-ZAGON.md` §5 |
| **R2b1 — v1.170.0** | Omejena offline vrsta | stožec 200 živih operacij, starost 12 h preide v mrtvo črko, idempotenca po `clientOperationId`, zavrnitev zaradi kvote brskalnika, zavrnitev je rezultat in ne izjema | vrsta se ne podvoji in ne raste neomejeno; ob zavrnitvi se košarica NE izprazni in osebje to tudi vidi |
| **R2b2 — v1.175.0** | Varen lokalni obrat brez žice | HTTPS fronta v Node-u s lastnim CA (OpenSSL iz Git for Windows), Next zaprt na 127.0.0.1, v omrežje vodi samo fronta; zagon ob prijavi: generator opravil (Windows XML / launchd / systemd) in `local:autostart` s suhim tekom kot privzetim | PWA se namesti na tablico in ostane dostopna po ponovnem zagonu računalnika — **preizkus še ni opravljen** |
| **R3 — v1.180.0** | Namestitev v 10 minutah | čarovnik `/setup` (ime obrata, davčna številka, lastnik, PIN), natisljive poverilnice, identiteta v stolpcih `Location`; **nerobjeno:** neobvezni demo podatki, lokalne migracije sheme | nova namestitev brez terminala (`65/65` §A–§H); nadgradnja ohrani podatke (H2/H3) |
| **R4a — v1.181.0** | Podpora, ki ne izroči skrivnosti | lokalni dnevnik napak v datoteko (dnevna rota, 1 MiB, 7 dni), `bun run local:support` (podporni paket: manifest, stanje, kopije, dnevnik, okolje, README — brez `config.json`, `PRVIC-ZAGON.txt`, `tls/` in baze), samodejno maskiranje in zavrnitev paketa, če maskiranje spodleti | paket na živi namestitvi ne nosi nobene znane skrivnosti; trditev drži samo mutacijski dokaz (19/19) in meritev iz `%LOCALAPPDATA%` |
| **R4b — številka ni določena** | Posodobitve in rollback | preverjanje novih različic, podpisani paket, rollback nadgradnje | prvotni pogoj te vrstice (lokalni migracijski pogon) je izpolnjen v v1.183.0, a rollbacka aditivni pogon ne more narediti: stolpca, ki ga shema vzame nazaj, ne more ne odstraniti ne vrniti. Ostajata dva dela, ki ju danes ni mogoče preizkusiti: preverjanje novih različic in podpisani paket |
| **R5a — v1.182.0** | Kopija, ki preživi izgubljen disk | šifriran kontejner `ros-offsite-1` (scrypt `N=2^15`, AES-256-GCM) na medij, ki ga lastnik odnese sam (USB, zunanji disk, omrežna mapa); `bun run local:offsite`, obnova `local:restore --bundle`, zadrževanje 8 kontejnerjev, zavrnitev istega diska brez `--allow-same-volume`, geslo samo iz okolja ali datoteke | kontejner je obnovljen na napravi, ki baze v obratu nikoli ni imela — izmerjeno na živi namestitvi: 899 strani, 3 682 591 B, C:→D: (različna `dev`), 3,6 s do zapisanega kontejnerja in 0,9 s do obnovljene baze |
| **R5b — številka ni določena** | Prevoz v oblak in licence | samodejna pošiljka kontejnerja, licenčni ključ, večobratni nadzor | pogojujeta produkcijsko bazo, ki je danes ni (Neon je na kvoti); samodejna pošiljka je nov izhod podatkov, ki ga nihče ni preizkusil |
| **R6 — v1.183.0** | Lokalni migracijski pogon, ki samo dodaja | `bun run local:migrate`: suhi tek je privzet, `--apply` izvede; primerjava po SQLite **afiniteti** in ne po črki, kanonični DDL je `prisma migrate diff --from-empty` nad SQLite zrcalom; dovoljene so samo aditivne stavke (manjkajoč stolpec, manjkajoča tabela, manjkajoč indeks); vse ostalo (spremenjen tip, NOT NULL brez privzetka, tuj ključ na živo tabelo, odvečen stolpec) je zavrnitev z razlogom in ne izjema; pred prvim zapisom preverjena kopija `pred-migracijo-`, celoten batch v eni transakciji, pred `COMMIT` še `PRAGMA foreign_key_check`; manjkajoča baza **ni** izmišljen načrt — ukaz manjkajočo bazo zavrne pred načrtovanjem (izhod 1), `--db <pot>` pa pove datoteko neposredno in preseže `--data-dir`; DDL brez nobene tabele **ni vir definicij**, zato pogon ne more trditi, da je baza usklajena | izmerjeno 27. 10. 2026: živa baza obrata (kopija 3 682 304 B, 135 tabel, `journal_mode=wal`) vrne `0 dodatkov · 0 zavrnitev · 0 odvečnih stolpcev` — torej noben lažen razkorak; na akumulirani testni bazi `ci1.182.0.db` (4 042 752 B) Prisma sama zahteva 2 796 B, v katerih sta dva `DROP TABLE`, pogon pa ne izda nobenega stavka za brisanje, javi pa eno samo pojasnjeno zavrnitev (`PayLink.orderId` → tuj ključ, ki ga SQLite na živo tabelo ne more dodati); zapis na kopiji prave baze 3 804 ms, `Employee` 1 → 1 vrstica, `integrity_check` ok, rep ostane `wal`, odvečni stolpec je še vedno na mestu; sabotaža zadnjega stavka → `no such table: main.NiTeTabele`, nobena stavka ni bila aplicirana, datoteka pa bajt za bajtom enaka; CLI nad manjkajočo potjo izstopi **1** v ~380 ms brez izpisa načrta (pred popravkom: „dodatki: 706" in izstop **0**), `--db` nad mini zrcalom vrne en sam stavek `ALTER TABLE … ADD COLUMN` v 4 152 ms; mutacije samega CLI-ja (prevera manjkajoče baze izpade, `--db` je zavrnjen, izstopna koda postane 0) ⇒ 3/3 ujeto |

R2 je razcepljen, ker ga je vmes pojedlo drugo delo: v1.166.0–v1.168.0 so
porabile druge izdaje, cesta tukaj ne obljublja več številk, ki jih ni več.
Varnost podatkov (R2a) je bila bolj nujna kot HTTPS (R2b), zato je šla prva.
R2b je razcepljen (R2b1/R2b2), ker HTTPS in samodejni zagon nista bila gotova v
enem koraku: izdaja, ki bi ju združila z offline vrsto, bi imela tri sprejemna
merila in nobenega hitro preverljivega. R2b1 (v1.170.0) zato samo omeji offline
vrsto, R2b2 prevzame HTTPS in samodejni zagon.
v1.171.0 je nato pojedla izdaja za determinizem CI-ja (prvi živi hosted run
`39905677431` je pokazal 13 padcev, ki jih lokalno ni bilo), v1.172.0 pa izdaja
za šesto luknjo alarmne plasti (canary je tiho požiral `cancelled` rune, zato
dvodnevni izpad zrcala v repozitoriju ni mogel javiti nihče), v1.173.0 pa še
izdaja za sedmo luknjo: canary je sicer javljal, a vedno napačen razlog, ker je
na seznamu commitov bral `commits.sha` — odločitev iz v1.172.0 se v produkciji
torej nikoli ni izvedla. v1.174.0 je nato pojedla izdaja za besedilo samega
alarma: hint joba `tests` je bil zapisan brez šumnikov, alarmno besedilo pa je
edini tekst, ki ga lastnik prebere brez odpiranja zaslona Actions. Vsaka pojedena
številka premakne celoten nepoddan rep ceste za eno naprej.
v1.176.0 je pojedla izdaja za jezik dokumenta na gostovih zaslonih: ZDPSI
(izvedba direktive (EU) 2019/882, EAA) v Sloveniji zavezuje od 28. 6. 2025 in
zajema storitve e-trgovine — to sta QR meni in javna plačilna povezava —,
`layout.tsx` pa je imel trdo zapisan `lang="sl"`.
v1.177.0 je pojedla izdaja za celovit WCAG pregled gostovih strani: drobnjak iz
v1.176.0 ni smel ostati edini dokaz. Gate je na štirih javnih rutah naštel 74
kršitev (z eno ročno najdeno jih je 75), in sicer s končnim seznamom osmih pravil.
Tri vrste napak je najprej pokazal brskalnik in ne branje kode, ker vsaka leži
izven JSX-a, ki ga pravila berejo: kaskada stylesheeta (ne-layered `min-height` je
gostov cilj znižal na 40 px), zaporna gumba v skupnih komponentah (dialog in sheet,
16 × 16 px) in trije overlayi, ki so na `role="dialog"` pisali `aria-describedby`
na vozlišče, ki ga ni. Zato ima vsaka svoj preizkus: `cascade`, pin nad skupnima
komponentama in pravilo `dialog`. Rep se premakne: R3 → v1.178.0, R4 → v1.179.0.
v1.178.0 je pojedla izdaja za zanko ponovnega nalaganja gostovih strani. WCAG
pregled jo je že pokazal kot stranski učinek, a ji ni sledil: gostova stran `/m`
si je ob stalno odprtem zavihku sama sebe sprašala po meniju (izmerjeno 190
zahtevkov `/api/public/menu` v 8 s), javna ruta pa je po nekaj sekundah
odgovarjala samo še s `429`, zato je gostu ostal zaslon »Nalagam meni …« brez
enega samega gumba. Vzrok ni logika ampak identiteta: `useGuestApiError()` vrne
ob vsakem renderju nov objekt; kjer je šel ta objekt v niz odvisnosti, se je
callback regeneriral in effect za njim se je pognal znova. Na `/kiosk` isti
vzorec zanke ni povzročal (tam je `loadMenu` navadna funkcija), je pa ob vsakem
renderju ponovno postavljal 90-sekundni timer mirovanja, ki naj sicer počisti tok
prejšnjega gosta. Rep se premakne: R3 → v1.179.0, R4 → v1.180.0.
v1.179.0 je pojedla izdaja za kontrast, izmerjen v obeh paletah. WCAG vrata iz
v1.177.0 so pravilo 1.4.3 računala iz svetle palete (`node_modules/tailwindcss/theme.css`),
gostove rute pa se na temno nastavljeni napravi izrišejo pod slojem `.dark` v
`src/app/globals.css` — vrata torej merijo paleto, ki je gost nikoli ne vidi. Ko je
helper dobil drugo modo, je na nepopravljenem drevesu javil **48 kršitev, in vse
so padle samo v temnem načinu** (po rutah: `/m` 4, `/kiosk` 35, `/pay` 6, `/r` 3;
8 različnih parov besedilo–podlaga). Vzrok ni bil napačen odtenek, ampak vloga:
Tailwind naredi `bg-X` in `text-X` iz ISTEGA žetona, zato prepis
žetona pod `.dark` obrne obe vlogi hkrati — `bg-stone-900 text-white` je pod
`.dark` postal skoraj bela ploskev z belim besedilom (izmerjeno **1,09:1** v živo).
Popravek je zato na vlogsko ločenih razrednih pravilih, ne na žetonih. Živa
meritev v brskalniku pod `.dark` (barvi sta razrešeni s canvasom, ker brskalnik
vrne `lab()/oklab()`): `/m` je padel **3 od 27** izrisanih parov, najslabši 1,09:1
→ **0 od 27**, najslabši 6,35:1;
`/kiosk` **9 od 22**, najslabši 2,75:1 → **0 od 22**, najslabši 4,87:1. Gate in
brskalnik se strinjeta do 0,02 (4,89 proti 4,87; 5,62 proti 5,62; 6,33 proti 6,35;
13,38 proti 13,37; 17,49 proti 17,49). Rep se premakne: R3 → v1.180.0, R4 → v1.181.0.
**R3 je oddana (v1.180.0).** Čarovnik `/setup` zbere ime obrata, davčno številko,
e-pošto lastnika in PIN; oddaja gre na `POST /api/setup/claim`, ki je javna PO
NAMENU (brez uporabnika še ne more biti seje) in jo drži petpogojna ograja:
lokalni profil + dokaz fronte (HMAC iz `APP_SECRET`, ki ga postavi samo fronta) +
naslov klienta v zanki + limit 5/min/IP + prazna baza. Edini pošten vir naslova je
soket fronte, zato `glaveZaVir` prepiše `x-forwarded-for` in ga ne sprejme od
klienta; fronta pa glavo `x-local-front` nastavi SAMO, kadar ji jo je launcher
dal — brez `--https` torej prevzem ne obstaja. Poverilnice so natisljive (ista
`credentialsSheet` kot `PRVIC-ZAGON.txt`, a PIN se v brskalnik nikoli ne izroči,
če ga je izbral lastnik). Identiteta (davčna in matična številka) gre v STOLPCA
`Location` in se ob naslednjem zagonu samo dopolni, nikoli ne prepiše.
Merilo „brez terminala" je do te izdaje lagalo: launcher je vedno ustvaril
lastnika, s tem pa je bazo zasedel, prevzem pa zahteva prazno — čarovnik je bil
torej nedosegljiv ravno tistemu, za katerega je namenjen. Od zdaj `--https` brez
identifikacijskih zastavic pomeni „identiteto določi brskalnik"
(`provisionFromTerminal`, preizkus §I), baza pa je kljub temu pripravljena
(push + WAL + kopija), da prvi prevzem piše v isto skledo.
**Nerobjeno v R3 (zavešno, ne pozabljeno):** neobvezni demo podatki (zahtevajo
lastnovo odločitev, kaj sme biti v proizvodnem obratu), lokalni migracijski pogon
`migrate deploy` (R4 ga potrebuje za rollback), paketni namestilnik ZIP/EXE in
nadgradnja obstoječih baz po `prisma migrate` — vse štiri ostajajo v §8 kot
vrstice brez opravljene izdaje. Od teh štirih je pogon prišel pozneje, kot
samostojna izdaja v1.183.0 (R6 spodaj), in ne v obliki `migrate deploy`.
v1.180.1 je posredovala izdaja za **ime izdelka**, ki na rep ceste ne spada. Drevo
je imelo dva črkovna zapisa hkrati: kanoničnega 162 pojavitev in razcepljenega 50
pojavitev v 25 datotekah. Odločitev ni okus: `common.app` v obeh slovarjih je edini
vir, ki ime nosi kot spremenljivko, zato je izbrani kanonični zapis in je preostanek
pripet nanj — popravljeno je 36 pojavitev v 22 datotekah (naslov strani, noge in
zadevi dnevne pošte, privzeto ime na računu in v opomnikih, naslov push obvestila,
service worker, oznaka v konzoli, semeni, zrcalna shema in njen generator). Nov gate
`tests/v1801-brand-name.test.ts` ima štiri dele: §A skenira 770 besedilnih datotek in
zahteva nič zadetkov, §B pripne posamezen niz (ne samo „ime nekje obstaja"), §C
zavešno pusti 14 preostalih pojavitev v TREH DATUMIRANIH dokumentih — njihov zapis je
meritev izdaje, ki jo je tisto ime takrat dejansko imela, §D je pozitivna kontrola:
isti bralnik MORA najti teh 14 zadetkov, sicer §A ne trdi ničesar. Zato gate sam sebe
ne more ubiti: v svojih kontrolnih nizih je stari zapis sestavljen iz treh fragmentov.
Kanoničnih pojavitev je zdaj 197. **Rep se ne premakne** — patch izdaja; R4 ostaja
v1.181.0.
v1.181.0 je izdala R4, ne celotnega R4. Razcep ni urejanje seznama, ampak merilo:
dnevnik napak in podporni paket sta dela, kjer napaka lahko tiho izroči skrivnosti
navzven, preverjanje posodobitev, podpisani paket in rollback pa so dela, ki jih
danes ni mogoče preizkusiti. Cesta zato dobi **R4a (izdano na v1.181.0)** in
**R4b (številke nima)**: rollback je odvisen od lokalnega migracijskega pogona
(`prisma migrate deploy`), ki ga takrat še ni — ista zadeva, ki jo je R3 že pustila
v §8 kot zavešno. Ker se R4 ni premaknil, se rep ceste tudi tokrat ne premakne:
naslednja na vrsti je R5.
v1.182.0 je izdala R5, ne celotnega R5. Merilo je isto kot pri R4: izdano je samo
tisto, kar je bilo na tej napravi tudi preizkušeno. **R5a (v1.182.0)** je kopija na
mediju, ki ga lastnik odnese sam — šifrirana, ker medij zapusti obrat, in obnovljena
na napravi, ki baze v obratu nikoli ni imela. **R5b (številke nima)** ostanek je
prevoz v oblak, licenčni ključ in večobratni nadzor: produkcijska baza danes ne
obstaja (Neon je na kvoti), samodejna pošiljka pa bi bila nov izhod podatkov, ki ga
nihče ni pregledal — isti razlog, zaradi katerega R4b nima rollbacka. Ker R5a ne
posega v obveznosti prejšnjih vrstic, se rep ceste ne premakne niti tokrat.
v1.183.0 je izdala R6, lokalni migracijski pogon. Zanj je bila predpisana
osnova, ki ne more delovati: `prisma migrate deploy` bere journal že uporabljenih
migracij, lokalna baza pa takega nima, ker nastane z `db push` in ne z `migrate` —
izmerjeno 27. 10. 2026: v vsaki od obeh baz je 135 tabel in nobena se ne imenuje
`_prisma_migrations`. Odstopiti od predpisane
osnove ni bližnjica, ampak edina izvedljiva pot.
Kaj pogon v resnici preverja, se vidi iz dveh meritev na istih datotekah.
`prisma migrate diff --from-empty` nad SQLite zrcalom da kanonični DDL (167 915 B,
135 `CREATE TABLE`, 571 `CREATE INDEX`, 0 `ALTER TABLE`, 0 `DROP`, 2,78 s) in ta DDL
je edini vir definicij. Na kopiji žive baze obrata (3 682 304 B, 135 tabel,
`journal_mode=wal`) je načrt prazen: `0 dodatkov · 0 zavrnitev · 0 odvečnih
stolpcev` — najpomembnejša od meritev, ker bi vsak lažen razkorak pomenil poseg v
bazi, ki je že usklajena. Nasprotni primer je akumulirana `ci1.182.0.db`
(4 042 752 B): Prisma sama zahteva 2 796 B, in ti bajti vsebujejo dva `DROP TABLE`
(PayLink in PrintJob, vsak v preobleki `CREATE TABLE "new_*"` → `DROP` → `RENAME`),
dve `CREATE TABLE`, dva `ALTER TABLE RENAME` in štiri `PRAGMA` vrste okrog njiju.
Pogon na isti datoteki ne izda nobenega stavka za brisanje, javi pa eno samo
zavrnitev z razlogom: `PayLink.orderId` mora dobiti tuj ključ v `Order`, SQLite pa
ga na živo tabelo ne more dodati brez preoblikovanja. Preostanka te razlike
pogon upravičeno ne vidi, ker primerja po SQLite afiniteti in ne po črki:
`TIMESTAMP(3)` v bazi in `DATETIME` v zrcalu sta oba NUMERIC, `DECIMAL(65,30)` in
`DECIMAL` tudi, `CONSTRAINT "PrintJob_pkey" PRIMARY KEY` in `PRIMARY KEY` pa
se razlikujeta samo po imenu ograde.
Zapisni del je preizkušen na kopiji prave baze, ne na bazi obrata: ena sama
transakcija, `Employee` 1 → 1 vrstica, `integrity_check` ok, `journal_mode` ostane
`wal`, odvečni stolpec na koncu tabele ostane v bazi, ker ga pogon ne sme izbrisati,
celoten poseg 3 804 ms. Sabotaža — zadnji stavek je kazal na tabelo, ki ne obstaja —
je pokazala lastnost vse ali nič: `no such table: main.NiTeTabele`, 0 apliciranih
stavkov in datoteka bajt za bajtom enaka tisti pred poskusom. Zadnja meritev velja
izhodni kodi: baza, kjer pogon najde samo zavrnitev, z `--apply` ne zapiše ničesar
in vrne 1, baza po usklajenem posegu pa vrne 0. Zavrnitev je od te izdaje naprej
rezultat in ne blokada celotnega batcha: aditivni stavki, ki so varni, pridejo v
bazo, razlika, ki je pogon ne sme storiti, pa ostane javljena — meritev na
`ci1.182.0.db` je pokazala zakaj: brez te ločnice bi ukaz na nabrani bazi vedno
ostal brez učinka, namesto da je orodje, ki ga je mogoče uporabiti.
Tokrat se rep ceste premakne: R6 je zadnja vrstica z izdano številko. Za njo
ostajata R4b in R5b, in nobene od njiju ne more izdati program sam: R4b rabi
preverjanje novih različic in podpisani paket, R5b rabi produkcijo, ki je danes ni.
R1 je namenoma ozek: ne uvaja HTTPS, kopij ali čarovnika. To so ločene izdaje
z lastnimi merili, da prva izdaja ne postane nepreverljiva.

## 9. Operacije

- **Zagon:** `bun run local`.
- **Ponovni zagon:** isti ukaz; baza in skrivnosti se ohranijo.
- **Nadgradnja:** do R3 samo aditivne spremembe; destruktivna sprememba se
  zavrne. Pred vsakim posegom v shemo nastane kopija `backups/pre-push-*.db`
  (R1) in jo setup naredi **pred** `db push`, ne za njim.
- **Uskladitev sheme (R6, v1.183.0):** `bun run local:migrate` pokaže načrt,
  `--apply` ga tudi izvede — suhi tek je privzet in se baze ne dotakne, niti
  kopije ne. Pogon sme samo dodajati (manjkajoč stolpec, manjkajoča tabela,
  manjkajoč indeks); kar zahteva preoblikovanje tabele ali brisanje, javi kot
  zavrnitev z razlogom in tega ne stori. Pred prvim zapisom nastane preverjena
  kopija `backups/pred-migracijo-<UTC>.db` (hrani jih 5), celoten batch teče v eni
  transakciji, pred `COMMIT` pa še `PRAGMA foreign_key_check`. Aplikacija mora biti
  med posegom ustavljena: baza z neprečiščenim repom poseg zavrne, ker bi kopija,
  narejena pod tekočim piscem, lahko izgubila zadnji potrjeni zapis (R2a je
  izmerila, da navaden prekop čez umazan WAL vrne 2 od 3 vrstic). Izhodna koda je 0 samo takrat, ko ni
  razlike, ki je pogon ne sme storiti — drugače 1, da se uskladitev ne more tiho
  končati kot uspeh.
- **Varnostna kopija (R2a, v1.169.0):** ob zagonu in nato na vsakih 6 ur nastane
  `backups/dnevno-<UTC>.db` — ena na koledarski dan, z integritetnim pregledom.
  Ročno: `bun run local:backup`. Kopija je ena sama `.db` datoteka, prenosna na USB.
- **Obnova (R2a, v1.169.0):** `bun run local:restore --list`, nato
  `bun run local:restore --latest --force`. Stanje, ki ga obnova prepisuje, sama
  shrani kot `backups/pred-obnovo-*.db`; aplikacija mora biti ustavljena.
- **Izpad elektrike:** baza teče v WAL načinu s `synchronous=FULL` (R2a), zato
  izpad pomeni izgubo najvišje nezaključene transakcije, ne pokvarjene datoteke.
  Pred R2a je lokalni profil uporabljal privzeti dnevnik in je bil primeren za
  preizkus, ne za kritično produkcijo.
- **HTTPS v omrežju (R2b2, v1.175.0):** `bun run local --https`. Lastni CA in
  list nastaneta s OpenSSLom v `<podatkovna mapa>/tls/`, javni vnos pa je fronta
  na 3443 (`--https-port` jo premakne); Next sam ostane zaprt na `127.0.0.1`.
  Zaupanje CA-ju je na vsaki napravi ročni korak — brez njega brskalnik prikaže
  opozorilo in PWA-ja ni mogoče namestiti. Postopek je v `LOKALNI-ZAGON.md` §6.
- **Zagon ob prijavi (R2b2, v1.175.0):** `bun run local:autostart` brez možnosti
  samo pokaže artefakt in ukaze; `--install` zapiše in izvede, `--uninstall`
  razveljavi, artefakt pa namenoma ostane na disku. Registracija opravila na
  pravem računalniku še ni bila izvedena (zahteva privolitev lastnika).
- **Prva namestitev brez terminala (R3, v1.180.0):** `bun run local --https` na
  PRAZNI podatkovni mapi pripravi bazo (push + WAL + kopija), ne ustvari pa obrata;
  zagon izpiše `čarovnik: https://localhost:<vrata>/setup`. Tam lastnik vpiše ime
  obrata, davčno številko, e-pošto in PIN, po oddaji pa zaslon izpiše sled
  poverilnic in ima gumb **Natisni**. Isto storitev terminalu pusti
  `--restaurant-name`/`--owner-pin`/`--tax-id`/`--business-id`: kadar je katera
  koli podana, velja star potek. Povezava do čarovnika se na prijavnem zaslonu
  pokaže samo, dokler je baza prazna in profil lokalni.
- **Podpora (R4a, v1.181.0):** `bun run local:support` sestavi paket šestih
  datotek v `<podatkovna mapa>/support/<UTC>`. Paket sme iti na pošto: `config.json`,
  `PRVIC-ZAGON.txt`, `tls/` in `data/restaurantos.db` vanj ne smejo, ukaz jih ne
  prebere, znane skrivnosti in domače poti pa so maskirane, posegi pa šteti v
  manifestu. Če zadnji pregled najde znano skrivnost, ukaz mapo izbriše in konča
  z izhodno kodo 1. Paket se sestavi tudi, ko aplikacija NE teče — bazo odpre
  bralno neposredno iz datoteke, ne prek `GET /api/health`. Napake jih aplikacija
  sama piše v `logs/errors-*.log` (dnevna rota, 1 MiB na datoteko, 7 dni), ker od
  v1.175.0 stdout ob prijavi nima bralca.
- **Oddaljena kopija (R5a, v1.182.0):** `bun run local:offsite --to <pot>` zapiše
  ŠIFRIRAN kontejner `dalec-<UTC>.rosbak` na medij, ki ga lastnik odnese sam (USB,
  zunanji disk, omrežna mapa), in ga pred razglasitvijo preveri TRIKRAT: odsek čez
  `VACUUM INTO`, `integrity_check` nad jasnim odsekom, nato branje kontejnerja S
  DISKA, dešifriranje in primerjava žiga SHA-256. Geslo pride iz
  `RESTAURANTOS_OFFSITE_PASSPHRASE` ali iz datoteke (`--passphrase-file`), nikoli iz
  `argv`, ker seznam procesov ga izda vsakemu `Get-CimInstance`. Če je ciljna mapa
  na istem disku kot baza, ukaz zavrne; `--allow-same-volume` je izrecna privolitev
  in jo izpis tudi razkrije. Obnova na drugi napravi je `bun run local:restore
  --bundle <rosbak> --passphrase-file <geslo> [--force]` — isti preizkušeni korak
  kot R2a, ki najprej preveri kopijo in stanje, ki ga bo prepisala. `bun run local`
  kopije na tujem mediju NE dela sam: samodejna pošiljka, ki je nihče ne preverja,
  ni varnostna kopija ampak nov izhod podatkov.

## 10. Varnost in zasebnost

- Naključne skrivnosti, nikoli v repozitoriju ali izpisu; datoteka samo za
  lastnika računa (POSIX `0600`, na Windows NTFS ACL — `LOKALNI-ZAGON.md` §3).
- Naključen PIN lastnika; brez `1234`/demo PIN-ov; demo prijava privzeto
  izklopljena (`DEMO_LOGIN_ENABLED=0`).
- `BOOTSTRAP_ADMIN_*` se v lokalnem okolju izpraznita; break-glass ostane
  oblačna funkcija.
- Aplikacija je brez `--https` vezana na `0.0.0.0` in je dostopna vsem v istem
  omrežju na golu HTTP. Z `--https` (v1.175.0) Next veže samo `127.0.0.1`, v
  omrežje pa odpira samo TLS fronta — goli HTTP v LAN tako ni več dosegljiv.
  Priporočilo: ločeno omrežje za goste in osebje, požarna pregrada, močni PIN-i.
- `/api/health` ne razkrije poti do baze, uporabniškega imena ali gesla.
- **`POST /api/setup/claim` (R3) je javna luknja z namenom** in je zato vpisana v
  register javnih endpointov (`tests/route-coverage.test.ts`), ne pozabljena:
  kliče jo stroj, ki še nima uporabnika — seja torej ne more obstajati. Namesto
  prijave jo drži pet pogojev (lokalni profil, dokaz fronte, zanka, 5/min/IP,
  prazna baza); zaporedje je taki, da tuji klient ne more izzvati poizvedbe ne iz
  razlike med kodami razbrati, ali je namestitev že prevzeta. Lastnik ostane
  edini administrator, PIN ostane v `PRVIC-ZAGON.txt` (0600), odgovor brskalnika
  pa ga povzame samo takrat, ko ga je izbral lastnik sam (§D2).
- Podatki so lokalni; varnostna kopija je odgovornost obrata. Od R2a naprej jo
  naredi sam vsak zagon, od R5a naprej jo lastnik sam odnese na tujem mediju.
- **Kontejner R5a sme obstajati samo šifriran** (`aes-256-gcm`, ključ iz
  `scrypt` `N=2^15, r=8, p=1`). Ker medij zapusti obrat, je to edini razred
  kopij, ki sme biti izročena svetu — karkoli ni šifrirano, na tuj medij ne sme
  biti zapisano. Glava nosi format, parametre KDF, sol, IV, žig in številke
  strani; NE nosi poti do baze, imen tabel, vsebine gesla ali kakršnegakoli
  podatka iz baze.
- **Moč kopije je moč gesla.** Izmerjeno 26. 10. 2026 na tej napravi (pet
  zaporednih izpeljav pri N=2^15): 89–139 ms, povprečje 102 ms, torej ~10 poskusov
  na sekundo na eni sledi. Geslo, podobno PIN-u, na ključku,
  ki pade v tuje roke, NI varno; dolžina 12 znakov je najmanjša dovolena, ne
  priporočena. Izgubljeno geslo pomeni, da kopije ni mogoče obnoviti — backdoorja
  ni in ga ne sme biti.
- **Omejitve veljajo PRED derivacijo ključa.** Tuji kontejner ne sme narekati
  gigabajtov pomnilnika: `N` je omejen na razpon 2^14–2^17, `maxmem` se RAČUNA
  (2× potrebe) in je omejen navzgor na 268 MiB, glava sme biti največ 8 KiB.
  Izmerjeno: privzeti BoringSSL `maxmem` (32 MiB) je na meji pri `N=2^15` in v
  enem procesu uspe, v drugem pade — zato ga koda izrecno nastavlja.

## 11. Tveganja

| Tveganje | Vpliv | Ukrep |
|---|---|---|
| Vercel ne vidi lokalne baze | zmeda pri pričakovanjih | dva profila, jasna dokumentacija |
| Disk/računalnik crkne | izguba podatkov | dnevne kopije z integritetnim pregledom (R2a); ker kopija na istem disku ne zavaruje pred okvaro diska, jo je od v1.182.0 mogoče odnesti na šifriranem kontejnerju (R5a); prevoz v oblak ostaja R5b |
| Kopija, narejena s prekopom datoteke | tiho izgubljen zadnji potrjeni zapis | kopija gre čez `VACUUM INTO` (R2a); izmerjeno: navaden prekop čez umazan WAL vrne 2 od 3 vrstic |
| Obnova pod tekočo aplikacijo | pokvarjen paket namesto rešitve | obnova se zavrne, dokler ima baza rep z vsebino; čist postanek rep počisti (R2a) |
| Geslo za kontejner je izgubljeno | kopije ni mogoče odpreti, nikoli | dokumentirano kot lastnikova obveznost; obnovitve brez gesla ni in je ne sme biti (R5a) |
| Geslo bi bilo v `argv` | razkrijeta ga seznam procesov in zgodovina lupine | geslo samo iz okolja ali datoteke; izpis, glava in ime datoteke ga ne ponovijo (R5a) |
| Kopija bi tiho pristala na istem disku | lažen občutek varnosti | zavrnitev, dokler lastnik ne potrdi z `--allow-same-volume`; izpis nato razkrije, da kopija NI oddaljena (R5a) |
| Tuji kontejner narekuje parametre KDF | enormna poraba pomnilnika ob branju | meje `N`, `r`, `p` in dolžina glave se preverijo PRED derivacijo ključa (R5a) |
| Jasen odsek obstaja kratek čas med šifriranjem | trenutek, ko so podatki na disku nešifrirani | odsek nastane samo na ciljnem mediju in se pobriše tudi ob odpovedi sredi poti; dokazano s seznamom datotek PO poskusu (R5a, D4b in E7) |
| SQLite in sočasni pisci | zaklepi/napake | en strežniški proces, WAL in busy timeout (R2a) |
| Destruktivna sprememba sheme | izguba podatkov | brez `--accept-data-loss`, zavrnitev + kopija pred `db push`; lokalni pogon (R6, v1.183.0) pa takega stavka ne zna narediti sploh — tip stavke je omejen na tri aditivne vrste (`dodaj-stolpec`, `ustvari-tabelo`, `ustvari-indeks`), razliko nad njimi samo javi |
| Nadgradnja z aditivnim pogonom, ki bi blokirala cel batch | nabrana baza, kjer ukaz vedno ostane brez učinka | zavrnitev je rezultat in ne blokada: varni dodatki pridejo v bazo, nevaren poseg ostane javljen z izhodno kodo 1 (R6, izmerjeno na `ci1.182.0.db`) |
| HTTP v LAN | PWA/offline ne deluje | HTTPS fronta z lastnim CA (R2b2, v1.175.0); dokler operater ne zaupa CA-ju, brskalnik na tablici prikaže opozorilo in PWA-ja ni mogoče namestiti |
| FURS/plačila brez interneta | fiskalni zaključek ne uspe | lokalna baza tega ne reši; dokumentirano |
| Razlika med Postgres in SQLite shemo | napake ob nadgradnji | generator zrcala + drift gate |

## 12. Metrike

| Metrika | Cilj R1 | Cilj R3 |
|---|---|---|
| Čas od namestitve do prvega naročila | ≤ 10 min | ≤ 5 min |
| Čas zagona po prvem buildu | ≤ 10 s | ≤ 5 s |
| Klici na oblačno bazo v lokalnem profilu | 0 | 0 |
| Uspešnost obnove kopije | — | 100 % na mesečnem preizkusu |
| Podvojeni lastniki ob ponovnem zagonu | 0 | 0 |

## 13. Odprte odločitve

| Odločitev | Predlog | Kdaj |
|---|---|---|
| HTTPS v LAN | ODLOČENO v v1.175.0: fronta v Node-u s lastnim CA, ki ga sestavi OpenSSL (že del Git for Windows). Caddy in mkcert ostaneta tuji binarni odvisnosti; izmerjeno 24. 10. 2026 na razvini napravi nista. **Del prvotnega predloga ni izpolnjen:** zaupanje CA-ju je na vsaki napravi ročni korak, samodejne poti brez njega v tej izdaji ni | R2b2 |
| Cilj varnostnih kopij | lokalna mapa (R2a, naredeno) + šifriran kontejner na tujem mediju (R5a, od v1.182.0); oblak R5b | R5a naredeno, R5b brez številke |
| Licenciranje | brez v R1–R2b2; odločitev pred komercialno prodajo | R4 |
| Ciljni OS | Windows 10/11 prvi, Linux/macOS podprta pot | R1/R2b2 |
| Paketni namestilnik | samostojen ZIP/EXE z Bun runtime in `.next` | R3 |
| Meja offline vrste (starost in dolžina) | ODLOČENO v v1.170.0: 200 živih operacij, 12 h starosti; številki sta na programu, mehanizem in vidnost sta v mrtvi črki | R2b1 |
| Lokalni migracijski pogon | ODLOČENO v v1.183.0: cesta je predpisala `prisma migrate deploy`, ta pa zahteva journal migracij, ki ga lokalna baza nima (`db push` ga ne piše) — izdani pogon primerja zrcalo in bazo po SQLite afiniteti ter samo dodaja | R6, naredeno |
| Rollback nadgradnje | ODLOČENO delno v v1.183.0: aditivni pogon nasprotne migracije ne more narediti, zato je povratna pot obnova preverjene kopije (`local:restore`), ne nasprotni stavek. Odprta ostajata preverjanje novih različic in podpisani paket | R4b |

## 14. Kaj zavestno ne obljubljamo

- da bo Vercel kdaj uporabljal lokalno bazo;
- da bo lokalni profil deloval brez interneta za FURS ali kartična plačila;
- da bo SQLite sprejel več strežnikov hkrati;
- da bo R1 vseboval samodejne kopije, HTTPS ali čarovnik;
- da lokalna kopija pomeni varnostno kopijo: en disk, en računalnik, ena
  požarna (R2a kopije hrani na istem disku kot baza; zato od v1.182.0 obstaja
  R5a — šifriran kontejner na mediju, ki ga lastnik odnese sam. Obnova takšne
  kopije na drugi napravi je izmerjena, samodejnega prevoza v oblak ni in
  ostaja R5b brez številke);
- da bo oddaljena kopija nastala sama: `bun run local` naredi dnevno kopijo na
  istem disku, kopija izven diska je ročna odločitev z ukazom in z geslom, ker
  samodejna pošiljka, je je nihče ne preverja, ni varnostna kopija;
- da bi kontejner obnovili brez gesla: drvnika, izvoza ključa ali podpore za
  pozabljeno geslo ni in ne sme biti, ker bi bil tak vrat vedno odprt tudi
  napadalcu, ne samo lastniku;
- da kopija sama po sebi varuje pred krajo: medij je šifriran, a geslo,
  napisano na papirček in prilepljen na ključek, ni varnostni ukrep ampak nova
  ranljivost.
- da bo lokalni migracijski pogon (R6, v1.183.0) kdaj kaj spremenil ali vzel
  nazaj: sme izdati samo tri aditivne vrste stavka, vse ostalo javi kot
  zavrnitev. Nadgradnja, ki zahteva preoblikovanje tabele, zato potrebuje ročno
  selitev v razvojni veji; v obratu je edina povratna pot obnova kopije, ne
  nasprotni stavek.
