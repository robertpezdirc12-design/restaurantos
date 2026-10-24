# Runbook — lokalni zagon RestaurantOS (v1.175.0)

Ta dokument je operativni vodnik za namestitev, kjer RestaurantOS teče na
računalniku v obratu in uporablja **lokalno bazo SQLite**. Za oblačni profil
(Vercel + Neon) glej `docs/DEPLOYMENT-RESILIENCE.md`. Zahteve in merila sprejema
so v `docs/PRD-LOKALNA-BAZA.md` (R1, R2a, R2b1 in R2b2 so izvedena; izhodni
pogoj R2b2 na tablici še ni preizkušen).

## 1. Kaj potrebujete

- Računalnik, ki bo stal v obratu (Windows 10/11 prvi; Linux/macOS podprta pot).
- [Bun](https://bun.sh) 1.3 ali novejši.
- OpenSSL samo, če želite `--https` (izdaja lastnega CA-ja). Klic je preprosto
  `openssl`, torej mora biti na poti — na Windows ga dobiš z Git for Windows
  (izmerjeno 24. 10. 2026: `C:\Program Files\Git\ucrt64\bin\openssl.exe`, najdejo
  ga tudi cmd in PowerShell), na Linuxu je običajno nameščen, na macOS ga prinese
  Homebrew. Če ga ni, `--https` javi napako in ne tiho odneha.
- Internet samo za prvo namestitev (`bun install`) in za FURS/kartična plačila.
  Za delo z bazo internet **ni** potreben.

## 2. Prva namestitev

```bash
git clone <repo> restaurantos
cd restaurantos
bun install
bun run local
```

Prvi zagon:

1. ustvari podatkovno mapo in trajne skrivnosti (`config.json`; dovoljenja §3);
2. pripravi SQLite shemo iz `prisma/schema.sqlite.prisma`;
3. ustvari lokacijo, nastavitve in **enega lastnika** z naključnim 6-mestnim PIN-om;
4. zgradi aplikacijo (prvi build traja nekaj minut);
5. zažene strežnik na `0.0.0.0:3000` in izpiše lokalni ter omrežne naslove.

Poverilnice so v `<podatkovna mapa>/PRVIC-ZAGON.txt`. Datoteka vsebuje PIN v
čistini — shranite jo varno in izbrišite, ko si PIN zapomnite.

Demo podatki iz `prisma/seed.ts` se **ne** naložijo; demo prijava je izklopljena
(`DEMO_LOGIN_ENABLED=0`).

## 3. Kje so podatki

| Platforma | Privzeta podatkovna mapa |
|---|---|
| Windows | `%LOCALAPPDATA%\RestaurantOS` |
| macOS | `~/Library/Application Support/RestaurantOS` |
| Linux | `$XDG_DATA_HOME/restaurantos` (sicer `~/.local/share/restaurantos`) |

Mapo prepiše `RESTAURANTOS_DATA_DIR`. Vrednost se bere v sintaksi gostitelja,
na katerem proces teče — v1.171.0 je popravil prav to: eksplicitna pot je bila
absolutizirana z `path.win32.resolve` **modelirane** platforme, ki jo je posredoval
klicatelj, nastavitev gostitelja pa ne sme iti skozi simulacijo gostitelja. Pin
je host-invarianten (`tests/v165-local-runtime.test.ts` isto trditev preveri na
win32, linux in darwin). V nastavljeni mapi so:

- `data/restaurantos.db` — baza (edini vir podatkov);
- `data/restaurantos.db-wal` — rep (WAL) z nedavnimi zapisi; ob pravilnem postanku
  aplikacije ga ni;
- `config.json` — trajne skrivnosti; **ne** kopirajte v repo in ne delite;
- `PRVIC-ZAGON.txt` — prve poverilnice;
- `backups/dnevno-*.db` — samodejne dnevne kopije (zadnjih 14);
- `backups/pre-push-*.db` — kopije pred posegom v shemo (zadnjih 5);
- `backups/pred-obnovo-*.db` — stanje, ki ga je obnova prepisala (zadnjih 14);
- `tls/` — lastni CA in list za `--https` (§6.1); `ca-key.pem` je zasebni ključ
  CA-ja in ne gre nikamor, tudi ne v varnostno kopijo;
- `autostart\RestaurantOS Local.xml` — artefakt zagona ob prijavi, in sicer samo
  na Windows; na macOS je artefakt v `~/Library/LaunchAgents/`, na Linux v
  `~/.config/systemd/user/` (§6.2).

**Dovoljine datotek s skrivnostmi.** Na macOS in Linux ju koda ustvari z `0600` —
bere ju samo račun, ki jo je ustvaril. Na Windows POSIX `chmod` ne deluje, zato
`config.json` in `PRVIC-ZAGON.txt` podedujeta NTFS ACL mame `%LOCALAPPDATA`:
samo trenutni račun, `SYSTEM` in `Administrators`; skupina `Users` dostopa nima
(preverjeno z `icacls`). Skrbnik istega računalnika ju lahko prebere, zato
naj lokalni profil teče na računalniku, ki je last obrata.

Mapa je namenoma zunaj repozitorija, zato posodobitev kode ne more povoziti
podatkov in `git status` ne vidi baze.

## 4. Vsakodnevno delo

- **Zagon:** `bun run local` (isti ukaz kot prvič; baze ne ponastavi).
- **Postanek:** `Ctrl+C` v terminalu. Launcher ustavi samo svoj strežniški
  proces, ne drugih procesov v sistemu, in ob postanku počisti rep baze. Zato se
  obnova ne zruši zaradi "še teče", ko aplikacija res ne teče več.
- **Kopije:** ob zagonu in nato na vsakih 6 ur samodejno nastane dnevna kopija;
  ročno jo naredite z `bun run local:backup`, seznam pokaže `bun run
  local:restore --list` (podrobnosti v §5).
- **Dostop v omrežju:** brez `--https` na izpisanem naslovu `http://<IP>:3000`
  (npr. `http://192.168.1.20:3000`). Z `bun run local --https` je naslov
  `https://<IP>:3443` in je edina pot do namestitve PWA-ja — podrobnosti v §6.
- **Offline vrsta (v1.170.0):** ko zveza pade, grejo naročila in spremembe
  statusov v vrsto v brskalniku naprave (ne v lokalno bazo). Vrsta je omejena:
  največ **200 čakajočih operacij** in vsaka čaka največ **12 ur**. Polna vrsta
  nova naročila **zavrne** in to tudi pove — operacija se ne shrani tiho,
  košarica ostane. Zastarela operacija ne izgine: prestavi se v mrtvo črko, kjer
  jo osebje vidi (na glavni blagajni klikne rdečo značko v glavi) in se sama
  odloči, ali jo pošlje znova ali zavrne. Mrtva črka prostora ne zaseda, zato
  nova naročila lahko prihajajo tudi medtem.
- **Preverjanje:** odprite `/api/health`. V lokalnem profilu mora vrniti
  `"status":"ok"`, `"mode":"local"`, `"databaseEngine":"sqlite"`, `"schema":"ok"`.

## 5. Varnostne kopije in obnova (R2a, v1.169.0)

Baza teče v WAL načinu (`journal_mode=wal`, `synchronous=FULL`, busy timeout
5000 ms). Kopije so tri vrste, vse v `backups/`:

| Kopija | Kdaj nastane | Hrani se |
|---|---|---|
| `dnevno-<UTC>.db` | ob zagonu in nato na vsakih 6 ur; največ ena na koledarski dan | zadnjih 14 |
| `pre-push-<UTC>.db` | pred vsakim posegom v shemo | zadnjih 5 |
| `pred-obnovo-<UTC>.db` | stanje, ki ga obnova ravnokar prepisuje | zadnjih 14 |

Vsaka kopija je pred shranjevanjem preverjena z `PRAGMA integrity_check` in je
ena sama `.db` datoteka brez `-wal`/`-shm` samic, torej prenosna na USB.

**Zakaj kopija ni prekop datoteke:** izmerjeno 22. 10. 2026 je prekop datoteke
nad bazo z neprečiščenim WAL vrnil 2 od 3 vrstic — zadnji potrjeni zapis je v
kopiji manjkal. Kopija zato gre čez `VACUUM INTO`, ki prebere tudi rep.

### Ročna kopija

```bash
bun run local:backup                        # dnevna kopija
bun run local:backup --kind pred-pushom     # pred ročnim posegom v shemo
```

Kopije ležijo na **istem disku kot baza**. Vsaj eno prenesite na USB ali omrežno
mapo in skupaj s kopijami shranite tudi `config.json` in `PRVIC-ZAGON.txt`: brez
skrivnosti obnovljena baza na drugem računalniku ne prepozna obstoječih PIN-ov.

### Obnova

```bash
bun run local:restore --list
bun run local:restore --latest --force
bun run local:restore --from backups/dnevno-2026-10-22T17-08-24-494Z.db --force
```

Vrstni red, ki ga ukaz sam spoštuje:

1. izbrana kopija se preveri; če `integrity_check` ne vrne `ok`, se obnova **ne začne**;
2. če aplikacija še teče (baza ima rep z vsebino), se obnova **zavrne**;
3. trenutno stanje se shrani kot `pred-obnovo-*.db`;
4. kopija se prepise v `data/restaurantos.db` in replica se takoj vklopi nazaj;
5. zaženite `bun run local` in preverite `/api/health`.

`--latest` pomeni najnovejšo **dnevno** kopijo, ne najmlajše datoteke:
`pred-obnovo-*` je lahko mlajša in vsebuje ravno tisto stanje, ki ste ga ravnokar
zavrnili.

### Vaja obnovitve (izvedena 22. 10. 2026)

Vaja je potekala na **pravi** lokalni bazi (135 tabel, 3.682.304 B), ne na
testni napravi.

1. `bun run local:setup` — baza nastane, izpisana replica je `wal`;
2. `bun run local:backup`:

   ```text
   ✔ Kopija dnevno-2026-10-22T17-08-24-494Z.db je naredena in preverjena (integrity_check ok, 899 strani).
   ```

3. v bazi je bil namenno spremenjen podatek, ki ga kopija ne sme vsebovati
   (`Location.name` → `POZABLJEN IME PO KOMPIJI`);
4. `bun run local:restore --latest --force`:

   ```text
   ✔ Baza je obnovljena iz dnevno-2026-10-22T17-08-24-494Z.db (integrity_check ok, 899 strani).
   ✔ Stanje pred obnovo je shranjeno kot pred-obnovo-2026-10-22T17-31-49-625Z.db.
     Baza: C:\Users\admin\AppData\Local\RestaurantOS\data\restaurantos.db (replica: wal)
   ```

5. preverjeno: obnovljena baza ima spet `Moja restavracija`, `integrity_check`
   je `ok` in replica je `wal`; varnostna kopija
   `pred-obnovo-2026-10-22T17-31-49-625Z.db` pa še vedno `POZABLJEN IME PO
   KOMPIJI` — stanje, ki ga je obnova prepisala, ni izgubljeno.

Ista vaja je pokazala tudi zavrnitev: obnova nad bazo z odprtim repom se je
ustavila s sporočilom, da aplikacija še teče, in ni prepisala ničesar. Pravilno
ustavljena aplikacija (`Ctrl+C`) rep počisti sama. Če ste jo ustavili na silo
(Upravitelj opravil, izpad elektrike), enkrat zaženite `bun run local` in ga
ustavite s `Ctrl+C`; nato obnovo ponovite.

## 6. HTTPS v omrežju in zagon ob prijavi (R2b2, v1.175.0)

### 6.1 HTTPS fronta

`bun run local --https` naredi tri stvari, ki jih brez te zastavice ni:

1. **Lastni CA in list** nastaneta v `<podatkovna mapa>/tls/` (`ca-key.pem`,
   `ca-cert.pem`, `leaf-key.pem`, `leaf-cert.pem`). Oboje naredi OpenSSL, ki je
   že del Git for Windows; če ga na računalniku ni, zagon javi napako in ne tiho
   odneha. CA traja 825 dni, list 398 dni in se obnovi, ko mu ostane manj kot 14
   dni.
2. **Next se zapre na zanko** (`127.0.0.1:3000`), zato v omrežju ni več golega
   HTTP-ja tik ob obljudenem HTTPS.
3. **TLS fronta posluša na `0.0.0.0:3443`** (`--https-port` jo premakne) in je
   edini javni vnos. Prenese telo in glave, razen hop-by-hop, in zadrži tudi
   nadgradnjo povezave (WebSocket).

Zagon izpiše `https://<LAN IP>:3443`. List ima v SAN `localhost`,
`restaurantos.local`, ime računalnika in vse IPv4 naslove vmesnikov (tablica
naslov tipka, ne `localhost`; IPv6 OpenSSL zavrne). Ko se IP spremeni, ker je
DHCP podelil drugega, naslednji zagon izda **samo list**, CA ostane.

**Zaupanje CA-ju je ročni korak, ki ga ta izdaja ne naredi namesto vas.** Brez
njega brskalnik prikaže opozorilo in PWA-ja ni mogoče namestiti. Odvisno je od
operacijskega sistema naprave in z te naprave ni bilo izvedeno:

- **Windows (Edge ali Chrome):** iz skrbniške lupine
  `certutil -addstore -f Root "<podatkovna mapa>\tls\ca-cert.pem"`,
  odstrani `certutil -delstore Root "RestaurantOS Local CA"`.
- **Android:** Nastavitve → Varnost → *Namesti certifikat* → *CA certifikat*,
  datoteka `ca-cert.pem` mora biti najprej prenesena na napravo.
- **iOS:** `ca-cert.pem` pošljite na napravo, Nastavitve → Splošno → VPN in
  upravljanje naprav → namestite profil, nato Nastavitve → Splošno → O tej
  napravi → *Nastavitve zaupanja certifikatom* → celotno zaupanje.

`ca-key.pem` je zasebni ključ CA-ja: z njim je mogoče izdati poljuben veljaven
certifikat za to omrežje, zato ne gre nikamor — ne v kopijo, ne v support
bundle, ne v repozitorij.

### 6.2 Zagon ob prijavi

`bun run local:autostart` brez možnosti **je suhi tek**: pokaže artefakt in
ukaze, ne zapiše ničesar in ne zažene nobenega procesa. Privzet je prav suhi
tek, ker je to ukaz, ki spremeni sistem.

| Ukaz | Kaj stori |
|---|---|
| `bun run local:autostart` | Pokaže artefakt in ukaze. Nič se ne zapiše, nič se ne požene. |
| `bun run local:autostart --install` | Zapiše artefakt in izvede registracijo. |
| `bun run local:autostart --uninstall` | Razveljavi zagon ob prijavi; artefakt namenoma ostane na disku. |
| `bun run local:autostart --data-dir <pot>` | Podatkovna mapa na drugi poti. |

Artefakt in registracijski ukazi so po sistemu različni:

| Sistem | Artefakt | Registracija |
|---|---|---|
| Windows | `<podatkovna mapa>\autostart\RestaurantOS Local.xml` (UTF-16) | `schtasks /Create /TN "RestaurantOS Local" /XML <pot> /F` |
| macOS | `~/Library/LaunchAgents/com.restaurantos.local.plist` | `launchctl bootstrap gui/<uid> <pot>`, nato `launchctl kickstart -k` |
| Linux | `~/.config/systemd/user/restaurantos-local.service` | `systemctl --user daemon-reload`, nato `systemctl --user enable` |

Artefakt vsebuje pot do Buna, ukaz `scripts/local-start.ts --https --data-dir
<pot>` in delovni imenik repozitorija. Na Windows ima še 30-sekundno zamudo po
prijavi, tri poskuse po napaki in ničelni časovni limit (`PT0S`), da ga davčno
obračanje ne more ustaviti. `--uninstall` artefakta ne zbriše, ker je vhod za
`/Create` in edini zapis o tem, kaj je bilo sploh registrirano.

**`--install` na pravem računalniku še ni bil pognan** — o registraciji opravila
in zaupanju CA-ju odloča lastnik. Kar je preizkušeno: suhi tek ne zapiše
ničesar in ne požene nobenega ukaza (izmerjeno z enakim seznamom datotek pred in
po), izpisan ukaz pa je mogoče prilepiti v lupino brez dopolnjevanja. Obstoj
opravila se na Windows sodi po izstopni kodi `schtasks /Query`, nikoli po
besedilu napake, ker je besedilo lahko preveden.

## 7. Posodobitev na novo različico

```bash
git pull
bun install
bun run local --build
```

- Pred posodobitvijo sheme setup naredi kopijo v `backups/`.
- Če bi sprememba zahtevala izgubo podatkov, Prisma ukaz **zavrne**; aplikacija
  se ne zažene in baza ostane nespremenjena. Tedaj obnovite kopijo ali počakajte
  na migracijo iz R3 — **ne** uporabljajte `bun run db:push`, ker ta razvojni
  ukaz vsebuje `--accept-data-loss`.
- `bun run local --build` prisili ponovno gradnjo; brez zastavice se build
  izvede le, če manjka.

## 8. Odpravljanje težav

| Simptom | Vzrok in ukrep |
|---|---|
| `EADDRINUSE` | Vrata 3000 so zasedena. Zaženite `bun run local --port 3001`. |
| `Manjka Next.js` | Zaženite `bun install`. |
| `Prisma odjemalec je generiran za postgresql` | Zaženite `bun run local:setup` brez `--no-generate` (ali `bun run db:generate`). |
| Build ne uspe | Preverite `bun run typecheck` in prostor na disku; nato `bun run local --build`. |
| `/api/health` vrne `degraded` | Preberite `dbError` v odgovoru in dnevnik terminala; baza je v `data/restaurantos.db`. |
| PIN izgubljen | R1 nima samodejnega ponastavljanja. Obnovite `PRVIC-ZAGON.txt` iz kopije ali bazo iz varnostne kopije; čarovnik za ponastavitev je R3. |
| Obnova zavrne z »še teče« | Aplikacija ni bila ustavljena s `Ctrl+C` (npr. izpad elektrike ali Upravitelj opravil), zato baza ima rep z vsebino. Ustavite jo, enkrat zaženite `bun run local` in ga ustavite s `Ctrl+C`; nato obnovo ponovite. Počistiti repa ročno ne izbrišite — v njem so lahko potrjeni zapisi. |
| Kopije v `--list` manjkajo | Preverite `RESTAURANTOS_DATA_DIR`; kopije so v `<podatkovna mapa>/backups/`, ne v repozitoriju. |
| POS javi »lokalna vrsta je polna« | Brez povezave je na napravi nabralo več kot 200 operacij. Rešitev ni brisanje, ampak povezava: zaženite ali počakajte na povezavo, da se vrsta sama pošlje, nato naročilo pošljite znova. Košarica pri tem NI izpraznjena. |
| FURS ali kartično plačilo ne uspe | Lokalna baza ne odpravi odvisnosti od interneta; preverite povezavo in certifikate (`docs/FURS-CERT-RUNBOOK.md`). |
| `--https` javi, da OpenSSLa ni | Fronta sama ne zna izdati certifikata. Namestite Git for Windows (vsebuje `openssl.exe`) ali zaženite brez `--https`; ne kopirajte certifikata z drugega računalnika, CA na tej napravi ne bo imel ključa. |
| `--https` javi 502 »Aplikacijski strežnik na strani 3000 ni dosegljiv« | Fronta je zagnana, Next pa ne. Vrata 3000 so zasedena ali je proces padel — preverite terminal; fronta zaradi tega ne umre, zato lahko samo počaka. |
| Brskalnik na tablici pokaže »ni varen« | CA-ju še ni zaupano (§6.1). Opozorila ne obhodite s klikom naprej — zaupanje enkrat vzpostavite, sicer namestitev PWA-ja ni mogoča. |
| Tablica ne more odpreti `https://<IP>:3443`, računalnik pa ja | `--https` Next zapre na `127.0.0.1`, zato je edina pot fronta. Preverite, da tablica in računalnik sta v istem omrežju in da Windows požarni pregradi dovozi vhodna vrata 3443 za javno omrežje. |
| Po prijavi aplikacija ne teče | Zagon ob prijavi še registriran ni (§6.2) ali pa je bil `--install` pognan z drugimi potmi. `bun run local:autostart` brez možnosti pokaže, kaj bi se zgodilo; `schtasks /Query /TN "RestaurantOS Local"` pokaže, ali je opravilo registrirano. |
| Računalnik ima nov IP in HTTPS ne dela več | List je bil izdan za stare naslove. Naslednji `bun run local --https` ga izda znova; če naprava še vedno obupa, na njej pokličite `https://<nov IP>:3443`, ne `restaurantos.local`. |

## 9. Meje te izdaje (v1.175.0 = R1 + R2a + R2b1 + R2b2)

- Izvedeno: WAL + `synchronous=FULL` + busy timeout, samodejne dnevne kopije z
  `integrity_check`, zadrževanje zadnjih 14 dnevnih kopij, kopija pred posegom v
  shemo, `local:backup` in `local:restore` ter ena izvedena vaja obnove.
- Izvedeno (R2b1): offline vrsta je omejena na 200 čakajočih operacij in 12 ur
  starosti, je idempotentna po `clientOperationId`, ob polni vrsti ali kvoti
  brskalnika zavrne glasno, zastarele operacije pa pridejo v mrtvo črko namesto
  v tiho brisanje.
- Izvedeno (R2b2): HTTPS fronta pred Nextom s lastnim CA (OpenSSL), Next zaprt
  na `127.0.0.1`, list z LAN IPv4 v SAN in samodejno ponovno izdajo ob driftu,
  generator artefaktov za zagon ob prijavi na treh sistemih in `local:autostart`
  s suhim tekom kot privzetim.
- **Izhodni pogoj R2b2 še ni preizkušen:** PWA na tablici ni bil nameščen in
  ponovni zagon računalnika ni bil preverjen, ker `--install` in zaupanje CA-ju
  na pravi napravi še nista bila izvedena. Oboje je v §6 in zahteva privolitev
  lastnika.
- Zaupanje CA-ju ostane ročni korak na vsaki napravi; samodejne poti brez njega
  ta izdaja nima. Preden je CA zaupan, je lokalni profil še vedno interni poskus.
- `launchctl` in `systemctl` ukazi so povzeti po njunih CLI površinah in
  preizkušeni samo v suhem teku; `schtasks /Create` prav tako. Izvajalec ustavi
  ob prvem padlem ukazu in javi korak, zato napačna predpostavka pomeni glasno
  napako in ne pol-nameščenega sistema.
- Offline vrsta živi v brskalniku naprave, ne v lokalni bazi: izbris brskalnega
  podatkovnega profila ali drug brskalnik je izgubi, ne glede na omejitve te
  izdaje. Popolna lokalna samostojnost POS-a ni obseg R2.
- Brez čarovnika prve namestitve v brskalniku — R3.
- Brez migracij in rollbacka nadgradenj — R3/R4.
- Kopije so na istem disku kot baza; pred okvaro diska jih ščiti samo izvoz na
  USB ali omrežno mapo (§5).
- SQLite je **en pisec**: ne zaženite dveh kopij aplikacije nad isto bazo.

Podatki so lokalni. Aplikacije ne izpostavljajte neposredno na internet; za
oddaljen dostop uporabite oblačni profil ali VPN.
