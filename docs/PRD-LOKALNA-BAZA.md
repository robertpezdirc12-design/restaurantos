# PRD — lokalna baza in samodejni zagon RestaurantOS

| | |
|---|---|
| Verzija dokumenta | 1.2 |
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
- migracije in rollback nadgradenj (R3/R4);
- šifrirana kopija v oblaku, licenciranje, paketni namestilnik (R4/R5);
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
| **R3 — v1.176.0** | Namestitev v 10 minutah | čarovnik `/setup` (ime obrata, davčna številka, lastnik, PIN), neobvezni demo podatki, natisljive poverilnice, migracije lokalne sheme | nova namestitev brez terminala; nadgradnja ohrani podatke |
| **R4 — v1.177.0** | Posodobitve in podpora | preverjanje posodobitev, podpisani paket, rollback, support bundle brez skrivnosti, dnevnik napak | nadgradnja in rollback preizkušena na kopiji |
| **R5 — neobvezno** | Oddaljena varnostna kopija in licence | šifrirana kopija v oblak, licenčni ključ, večobratni nadzor | kopija obnovljiva brez strežnika v obratu |

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
R1 je namenoma ozek: ne uvaja HTTPS, kopij ali čarovnika. To so ločene izdaje
z lastnimi merili, da prva izdaja ne postane nepreverljiva.

## 9. Operacije

- **Zagon:** `bun run local`.
- **Ponovni zagon:** isti ukaz; baza in skrivnosti se ohranijo.
- **Nadgradnja:** do R3 samo aditivne spremembe; destruktivna sprememba se
  zavrne. Pred vsakim posegom v shemo nastane kopija `backups/pre-push-*.db`
  (R1) in jo setup naredi **pred** `db push`, ne za njim.
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
- Podatki so lokalni; varnostna kopija je odgovornost obrata do R2.

## 11. Tveganja

| Tveganje | Vpliv | Ukrep |
|---|---|---|
| Vercel ne vidi lokalne baze | zmeda pri pričakovanjih | dva profila, jasna dokumentacija |
| Disk/računalnik crkne | izguba podatkov | dnevne kopije z integritetnim pregledom (R2a); kopija na istem disku ne zavaruje pred okvaro diska, zato USB (R5 za oblak) |
| Kopija, narejena s prekopom datoteke | tiho izgubljen zadnji potrjeni zapis | kopija gre čez `VACUUM INTO` (R2a); izmerjeno: navaden prekop čez umazan WAL vrne 2 od 3 vrstic |
| Obnova pod tekočo aplikacijo | pokvarjen paket namesto rešitve | obnova se zavrne, dokler ima baza rep z vsebino; čist postanek rep počisti (R2a) |
| SQLite in sočasni pisci | zaklepi/napake | en strežniški proces, WAL in busy timeout (R2a) |
| Destruktivna sprememba sheme | izguba podatkov | brez `--accept-data-loss`, zavrnitev + kopija pred `db push` |
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
| Cilj varnostnih kopij | lokalna mapa (R2a naredeno) + USB; oblak neobvezno | R5 |
| Licenciranje | brez v R1–R2b2; odločitev pred komercialno prodajo | R4 |
| Ciljni OS | Windows 10/11 prvi, Linux/macOS podprta pot | R1/R2b2 |
| Paketni namestilnik | samostojen ZIP/EXE z Bun runtime in `.next` | R3 |
| Meja offline vrste (starost in dolžina) | ODLOČENO v v1.170.0: 200 živih operacij, 12 h starosti; številki sta na programu, mehanizem in vidnost sta v mrtvi črki | R2b1 |

## 14. Kaj zavestno ne obljubljamo

- da bo Vercel kdaj uporabljal lokalno bazo;
- da bo lokalni profil deloval brez interneta za FURS ali kartična plačila;
- da bo SQLite sprejel več strežnikov hkrati;
- da bo R1 vseboval samodejne kopije, HTTPS ali čarovnik;
- da lokalna kopija pomeni varnostno kopijo: en disk, en računalnik, ena
  požarna (R2a kopije hrani na istem disku kot baza; za drugi medij poskrbi
  obrat, zunanji storjen sistem je R5).
