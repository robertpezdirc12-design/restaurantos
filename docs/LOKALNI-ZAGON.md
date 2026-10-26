# Runbook — lokalni zagon RestaurantOS (v1.180.1)

Ta dokument je operativni vodnik za namestitev, kjer RestaurantOS teče na
računalniku v obratu in uporablja **lokalno bazo SQLite**. Za oblačni profil
(Vercel + Neon) glej `docs/DEPLOYMENT-RESILIENCE.md`. Zahteve in merila sprejema
so v `docs/PRD-LOKALNA-BAZA.md` (R1, R2a, R2b1, R2b2 in R3 so izvedena; izhodni
pogoj R2b2 na tablici še ni preizkušen).

## 1. Kaj potrebujete

- Računalnik, ki bo stal v obratu (Windows 10/11 prvi; Linux/macOS podprta pot).
- [Bun](https://bun.sh) 1.3 ali novejši.
- OpenSSL samo, če želite `--https` (izdaja lastnega CA-ja). Klic je preprosto
  `openssl`, torej mora biti na `PATH` — na Windows ga dobiš z Git for Windows
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
bun run local --https
```

Prvi zagon:

1. ustvari podatkovno mapo in trajne skrivnosti (`config.json`; dovoljenja §3);
2. pripravi SQLite shemo iz `prisma/schema.sqlite.prisma` in ji nastavi WAL;
3. naredi dnevno kopijo (še pred vsakim posegom v shemo, §5);
4. zgradi aplikacijo (prvi build traja nekaj minut);
5. zažene TLS fronto in Next, ki je zaprt samo na `127.0.0.1` (§6);
6. **izpiše naslov čarovnika** — obrat še ni ustanovljen.

### 2.1 Čarovnik: ime, davčna številka in PIN v brskalniku (R3, v1.180.0)

Z `--https` in brez identifikacijskih zastavic terminal namenoma ne ustvari
ničesar. Odprite naslov, ki ga je izpisal zagon:

```
čarovnik:      https://localhost:3443/setup (samo ta računalnik)
```

Vpišite **ime obrata**, **davčno številko** (SI 8 števk s kontrolno, HR OIB 11
števk; lahko tudi prazno), **e-pošto lastnika** in **PIN** (4–8 števk) ter
potrdite. Zaslon izpiše sled poverilnic in gumb **Natisni**; natisnite jo ali
shranite, preden zaprete zavihek. Od tega trenutka naprej je čarovnik zaprt
(prevzem zahteva prazno bazo), prijava pa je na `https://localhost:3443`.

Čarovnik deluje samo, kadar je zagnan `--https`: dokaz, da zahteva res prihaja iz
lokalne fronte, računa fronta, ne brskalnik. Brez njega ruta odgovori `403` in
zaslon to tudi pove. Na oblačnem profilu čarovnika ni (tam se ime in davčna
številka vpišeta v nastavitvah po prijavi).

### 2.2 Terminal: enako brez brskalnika

`bun run local` brez `--https` nastavi obrat kar ob zagonu; zastavice so
neobvezne:

```bash
bun run local --restaurant-name "Gostilna Zeleni Hrib" --owner-pin 481516 \
              --tax-id 12345678 --business-id SI-ZN-1234
```

Kadar je vsaj ena od zastavic `--restaurant-name`, `--owner-email`, `--owner-pin`,
`--tax-id` ali `--business-id` podana, velja ta pot tudi z `--https`. PIN se sicer
ustvari naključno. Enake zastavice sprejme `bun run local:setup`, ki pa tudi sam
pusti bazo prazno, če dodate `--wait-for-browser`.

Poverilnice so v `<podatkovna mapa>/PRVIC-ZAGON.txt`. Datoteka vsebuje PIN v
čistini — shranite jo varno in izbrišite, ko si PIN zapomnite. Čarovnik te
datoteke ne prepiše, izpiše pa njeno vsebino (brez PIN-a, če ga niste izbrali v
terminalu).

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
- `logs/errors-<UTC-dan>.log` — dnevnik napak lokalnega profila (R4a, v1.181.0).
  Vanj piše sama aplikacija, en zapis na dogodek; hrani se 7 dni, največ 3 datoteke
  na dan in 1 MiB na datoteko. Ni ga, če napake ni bilo;
- `support/<casovni-zig>/` — zadnji sestavljen podporni paket (§8.1). Nahaja
  se zunaj baze in se ne briše sam;
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
   odneha. CA velja 825 dni, list 398 dni in se obnovi, ko mu ostane manj kot 14
   dni.
2. **Next se zapre na zanko** (`127.0.0.1:3000`), zato v omrežju ni več golega
   HTTP-ja tik ob obljubljenem HTTPS.
3. **TLS fronta posluša na `0.0.0.0:3443`** (`--https-port` jo premakne) in je
   edini javni vnos. Prenese telo in glave, razen hop-by-hop, in prenese tudi
   nadgradnjo povezave (WebSocket). Odziva `101` fronta ne preverja — če
   nadgradnja spodrsne, je to v brskalniku videti kot prekinjena povezava, ne
   kot napaka v slovenščini.

Zagon izpiše `https://<LAN IP>:3443`. List ima v SAN `localhost`,
`restaurantos.local`, ime računalnika in vse IPv4 naslove vmesnikov (tablica ne
tipka `localhost`, ampak naslov; IPv6 OpenSSL zavrne). Ko se IP spremeni, ker je
DHCP podelil drugega, naslednji zagon izda **samo nov list**, CA ostane.

**Zaupanje CA-ju je ročni korak, ki ga ta izdaja ne naredi namesto vas.** Brez
njega brskalnik prikaže opozorilo in PWA-ja ni mogoče namestiti. Pot do zaupanja
je odvisna od operacijskega sistema naprave. Na razvojni napravi je bil korak
24. 10. 2026 izveden v **uporabniški** shrambi in izmerjen (odsek za Windows
spodaj); na tablici še ni, ker o njem odloča lastnik naprave.

- **Windows (Edge ali Chrome):** za trenutni račun zadostuje uporabniška shramba
  in ta pot **ne rabi skrbnika**:
  `certutil -addstore -user Root "<podatkovna mapa>\tls\ca-cert.pem"`; za
  odstranitev `certutil -delstore -user Root "RestaurantOS Local CA"`. Izmerjeno
  24. 10. na tej napravi: dodajanje vrne `-addstore command completed
  successfully`, nato `curl https://192.168.2.105:3443/` **brez** `--cacert`
  vrne `http=200 verify=0` in brskalnik stran odpere brez vmesnika. Strojna
  shramba velja za vse račune na napravi, a zahteva skrbniško lupino:
  `certutil -addstore -f Root "<podatkovna mapa>\tls\ca-cert.pem"`, za
  odstranitev `certutil -delstore Root "RestaurantOS Local CA"`.
- **Android:** Nastavitve → Varnost → *Namesti certifikat* → *CA certifikat* je
  prenos datoteke na napravo, **ne pa zaupanje brskalnika**. Android hrani
  uporabnikove koreninske certifikate v ločeni shrambi, sistemski omrežni sklad
  in Chrome pa ji ne zaupata, zato tablica po tem koraku še vedno obtiči na
  opozorilu in PWA-ja ni mogoče namestiti. Na Androidu zaupanje lastnemu CA-ju
  data samo še dve poti: vnos v **sistemsko** shrambo (skrbniški ali MDM poseg,
  na nekaterih napravah celo korenjenje) ali izjemo, ki jo prizna lastna
  aplikacija z `network_security_config`. Obrat lastne aplikacije ne gradi, zato
  je za Android-tablico edina praktična pot **javno veljaven certifikat** (npr.
  `--https` s DNS-01 overjenim listom), ki prenosa CA-ja na napravo ne zahteva.
  Meja na tej napravi ni bila izmerjena: Android naprave v obratu še ni, zapis
  zato temelji na uradnih dokumentih Androida in Chromiumovem sledenju.
- **iOS:** `ca-cert.pem` pošljite na napravo, Nastavitve → Splošno → VPN in
  upravljanje naprav → namestite profil, nato Nastavitve → Splošno → O tej
  napravi → *Nastavitve zaupanja certifikatom* → celotno zaupanje. Brez
  celotnega zaupanja zadnji korak ne naredi ničesar.

**Rokovanje s potrjevanjem veljavnosti, ločeno po orodjih.** Lastni CA nima
seznama razveljavitev: razveljavitvena točka in AIA sta na CA-ju in na listu
odsotna (izmerjeno z `openssl x509 -in … -text | grep -ci`, na obeh 0). Windows
`curl` (SChannel) zato po uspehnem TLS rokovanju javi
`curl: (60) schannel: the revocation status is unknown` in pade, dokler mu ne
dodate `--ssl-no-revoke`. To je lastnost orodja v lupini, ne fronte: brskalnik
isti certifikat sprejme brez kakršnekoli zastavice, zato tablica tega ukaza ne
potrebuje. Katerikoli odčitek `http=000` pri ročnem preizkusu najprej poiščite
pri pomanjkljivem ukazu, ne pri fronti.

`ca-key.pem` je zasebni ključ CA-ja: z njim je mogoče izdati poljuben veljaven
certifikat za to omrežje, zato ne gre nikamor — ne v dnevno varnostno kopijo in
ne v repozitorij.

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
prijavi, tri ponovne zagone ob napaki (presledoma ena minuta) in brez časovnega
limita (`PT0S`), da ga usodnik ne prekine sredi dolgega teka. `--uninstall`
artefakta ne zbriše, ker je vhod za
`/Create` in edini zapis o tem, kaj je bilo sploh registrirano.

**`--install` je bil 24. 10. 2026 pognan na razvojni napravi in je tam padel na
pravicah:** artefakt je zapisan (`<podatkovna mapa>\autostart\RestaurantOS
Local.xml`), `schtasks /Create` pa vrne `ERROR: Access is denied.` in izstop 1.
Isti `Access is denied.` je vrnil tudi poskus s povsem tujim opravilom
(`/TN ROSprobe /TR cmd.exe /SC ONLOGON`), zato vzrok ni najin XML, ampak to, da
v korensko mapo Načrtovalnika opravil sme pisati samo povišana lupina. Klic zato
javi točno to in ponovi ukaz; registracija na tej napravi še ni dokončana, ker
dvig pravic zahteva lastnikov klik na UAC in nobenega ponovnega zagona
računalnika še ni bilo. Kar je preizkušeno: suhi tek ne zapiše ničesar in ne
požene nobenega ukaza (izmerjeno z enakim seznamom datotek pred in po), artefakt
ostane na disku tudi po padli registraciji, obstoj opravila pa se na Windowsu
presoji po izstopni kodi `schtasks /Query`, nikoli po besedilu napake, ker je
lahko prevedeno.

## 7. Posodobitev na novo različico

```bash
git pull
bun install
bun run local --build
```

- Pred posodobitvijo sheme setup naredi kopijo v `backups/`.
- Če bi sprememba zahtevala izgubo podatkov, Prisma ukaz **zavrne**; aplikacija
  se ne zažene in baza ostane nespremenjena. Tedaj obnovite kopijo ali počakajte
  na lokalni migracijski pogon (R4b) — **ne** uporabljajte `bun run db:push`, ker
  ta razvojni ukaz vsebuje `--accept-data-loss`.
- `bun run local --build` prisili ponovno gradnjo; brez zastavice se build
  izvede le, če `.next/BUILD_ID` **manjka**. To je past pri nadgradnji: če je mapa
  `.next` že obstajala, launcher postreže **stari grad** in brskalnik pokaže staro
  različico, čeprav je vir na disku nov. Izmerjeno 26. 10. 2026: `/dashboard` je po
  popravljenem viru izrisal naslov pretekle izdaje, `BUILD_ID` je bil star 5 ur.
  Pravilo: **vsaka nadgradnja kode = `--build`**. Ob dvomu preverite `GET /api/health`
  (`version`) in primerjajte z `src/lib/version.ts`.
- Aplikacija sama ne preverja, ali je nova različica izšla, in nadgradnje ne zna
  razveljaviti (R4b, `docs/PRD-LOKALNA-BAZA.md` §8). Če posodobitev spodleti,
  naredite `bun run local:support` (§8.1) in pošljite paket; bazo obnovite po §5.

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
| Tablica ne more odpreti `https://<IP>:3443`, računalnik pa ja | `--https` Next zapre na `127.0.0.1`, zato je edina pot fronta. Preverite, da tablica in računalnik sta v istem omrežju. Vrat 3443 ni treba odpirati ročno: na tej napravi ima `bun.exe` že samodejno ustvarjeni pravili `In`/`Allow` na **zasebnem** profilu in `In`/`Block` na **javne** (izmerjeno z `netsh advfirewall firewall show rule name=all` in `Get-NetConnectionProfile`). Če je omrežje označeno kot javno ali če promet gre čez VPN (npr. CloudflareWARP), fronta pade na blok — takrat omrežje označite kot zasebno ali dodajte pravilo za 3443. |
| Po prijavi aplikacija ne teče | Zagon ob prijavi še ni registriran (§6.2), ali pa ga je `schtasks /Create` zavrnil zaradi pravic — koren Načrtovalnika opravil sme pisati samo povišana lupina. `bun run local:autostart` brez možnosti pokaže, kaj bi se zgodilo; `schtasks /Query /TN "RestaurantOS Local"` pokaže, ali je opravilo registrirano. |
| Računalnik ima nov IP in HTTPS ne dela več | List je bil izdan za stare naslove. Naslednji `bun run local --https` ga izda znova; če naprava še vedno obupa, na njej pokličite `https://<nov IP>:3443`, ne `restaurantos.local`. |
| Napaka se je zgodila, konzole pa ni bilo odprte | Od v1.181.0 aplikacija piše v `logs/errors-<UTC-dan>.log` (§3). Pred to izdajo je šla napaka samo v izpis, ta pa od v1.175.0 ob prijavi nima bralca. |
| Podpora prosi za stanje obrata | Zaženite `bun run local:support` (§8.1) in pošljite nastalo mapo. Baze, `config.json`, `PRVIC-ZAGON.txt` in `tls/` ne kopirajte in ne pošiljajte. |

### 8.1 Podporni paket (`bun run local:support`, R4a, v1.181.0)

Ko obrat javi težavo, lastnik pa takrat ni imel odprte konzole, ni treba kopirati
baze. Ukaz

    bun run local:support

sestavi mapo `<podatkovna mapa>/support/<casovni-zig>/` s šestimi datotekami
in jo takoj sam pregleda.

| Datoteka | Kaj pove |
|---|---|
| `README.txt` | kaj je v paketu in kaj namenoma ni; |
| `manifest.json` | različica, commit, način (`local`), pogon (`sqlite`), število maskiranj in seznam opozoril; |
| `okolje.json` | platforma, izdaja sistema, arhitektura, izvajalni pogon (bun ali Node), podatek o prostem prostoru na disku; pot do podatkovne mapi je z okrajšavo `~`; |
| `stanje.json` | rezultat sondy (ali baza odpira, ali je shema usklajena), `journal_mode` in število vrstic po tabelah — samo števila, nikoli vsebina; |
| `kopije.json` | ime, velikost in starost kopij; |
| `dnevnik.log` | zadnjih 400 vrstic dnevnika napak iz `logs/errors-*.log`, kronološko (najnovejše zadaj); |

**V paketu ni** `config.json`, `PRVIC-ZAGON.txt`, `tls/` in
`data/restaurantos.db`; ukaz jih ne prebere. Kar pač prebere, tudi pregleda: znane
skrivnosti, domače poti in oblike poverilnic (`Bearer …`, `https://up:geslo@…`,
`?token=…`, `sk_live_…`) so nadomeščene z `[RAZMAZKANO]` oziroma `~`, število
posegov pa je zapisano v manifestu.

Če zadnji pregled v paketu najde znano skrivnost, ukaz **mapo izbriše** in
konča z izhodno kodo 1. Paket torej ne more iti na pošto v stanju, ki ga ukaz sam
zavrne.

Ukaz deluje tudi, ko aplikacija ne teče: stanje bere neposredno iz
`data/restaurantos.db` in datoteko odpre samo za branje, ne prek `GET /api/health`.
Ravno takrat, ko aplikacija ne odgovarja, je podpora najbolj potrebna.

**Kaj paket namenoma ne ve:** `busy_timeout` in `synchronous` veljata samo za
povezavo, na sveži povezavi pa se vrneta `0` oziroma `2`, ne glede na to, kako ju
je nastavila aplikacija (izmerjeno 26. 10. 2026). Paket zato meri samo
`journal_mode`, ki je trajno zapisan v glavi datoteke, za obe pragmi pa navaja
vrednosti, ki ju aplikacija nastavlja ob zagonu.

Za napredno uporabo: `--data-dir <pot>` opiše drugo podatkovno mapo, `--json` pa
izpiše strojno berljiv povzetek. Preden mapo pošljete, zadnji pregled naredi
človek — `dnevnik.log` je edina datoteka, ki jo je napisal vaš obrat.

## 9. Meje te izdaje (v1.181.0 = R1 + R2a + R2b1 + R2b2 + R3 + R4a)

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
- Izvedeno (R3): čarovnik `/setup` z imenom obrata, davčno številko, e-pošto in
  PIN-om; `POST /api/setup/claim` za njim; natisljiva sled poverilnic; davčna in
  matična številka v stolpcih `Location`; z `--https` brez zastavic terminal bazo
  pripravi, identiteto pa prepusti brskalniku.
- Izvedeno (R4a): napake lokalnega profila pišejo v `logs/errors-*.log` in
  `bun run local:support` sestavi podporni paket brez skrivnosti (§8.1). Paket je
  bil izmerjen na živi namestitvi; maskiranje je dokazano s pozitivno kontrolo.
- **Ne izvedeno (R3, zavešno):** neobvezni demo podatki v čarovniku (odločitev
  lastnika, kaj sme priti v proizvodno bazo), lokalni migracijski pogon
  (`prisma migrate deploy` in rollback) ter paketni namestilnik ZIP/EXE. Vse tri
  nosi R4b (`docs/PRD-LOKALNA-BAZA.md` §8 in §12).
- **Izhodni pogoj R2b2 na tablici še ni preizkušen:** PWA na tablici ni bil
  nameščen in ponovni zagon računalnika ni bil preverjen. Na razvojni napravi je
  zaupanje CA-ju izvedeno v uporabniški shrambi in izmerjeno (§6.1), `--install`
  pa je padel na pravicah in čaka povišano lupino (§6.2). Obeh posegov na tablici
  ni bilo mogoče opraviti brez lastnikovih rok, Android pa ima dodatno mejo:
  uporabniški CA v brskalniku zaupanja ne da (§6.1).
- Zaupanje CA-ju ostane ročni korak na vsaki napravi; samodejne poti brez njega
  ta izdaja nima. Preden je CA zaupan, je lokalni profil še vedno interni poskus.
- `launchctl` in `systemctl` ukazi so povzeti po njihovih uradnih CLI oblikah in
  preizkušeni samo v suhem teku; `schtasks /Create` prav tako. Izvajalec ustavi
  ob prvem padlem ukazu in javi korak, zato napačna predpostavka pomeni glasno
  napako in ne delno nameščenega sistema.
- Offline vrsta živi v brskalniku naprave, ne v lokalni bazi: izbris brskalnega
  podatkovnega profila ali drug brskalnik jo izgubi, ne glede na omejitve te
  izdaje. Popolna lokalna samostojnost POS-a ni obseg R2.
- Brez preverjanja novih različic, podpisanega namestitvenega paketa in rollbacka
  nadgradenj — to nosi R4b.
- Brez oddaljene (omrežne) kopije — to nosi R5.
- Kopije so na istem disku kot baza; pred okvaro diska jih ščiti samo izvoz na
  USB ali omrežno mapo (§5).
- SQLite je **en pisec**: ne zaženite dveh kopij aplikacije nad isto bazo.

Podatki so lokalni. Aplikacije ne izpostavljajte neposredno na internet; za
oddaljen dostop uporabite oblačni profil ali VPN.
