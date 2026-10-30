# Runbook — samogostiteljstvo na NAS (Docker / CasaOS / ZimaOS) — v1.207.0

Ta dokument je operativni vodnik za **OSS-13 one-click pakiranje** (docs/
GAP-ANALIZA-odprtokodna-konkurenca.md): RestaurantOS na lastnikovem NAS-u
kot Docker storitev, z enakim lokalnim profilom (SQLite) kot `bun run local`
(docs/LOKALNI-ZAGON.md). Za oblačni profil (Vercel + Neon) glej
docs/DEPLOYMENT-RESILIENCE.md.

**Ena resnica o vedenju:** zabojnik NE izumlja svoje poti zagona — izvrši
obstoječi `scripts/local-start.ts`, ki uredi podatkovno mapo, skrivnosti,
SQLite shemo, WAL, dnevno varnostno kopijo in zagon Next. Paket je le ovitek.

## 1. Kaj potrebujete

- NAS ali strežnik z Docker Engineom; **CasaOS ali ZimaOS** za res »en klik«
  (uvoz compose datoteke prek vmesnika), sicer običajen `docker compose`.
- Približno 2 GB prostora za sliko (build) + prostor za podatke in dnevne kopije.
- Internet samo za prvo gradnjo slike in za fiskalizacijo/kartična plačila.
  Za delo z bazo internet **ni** potreben.

## 2. Prvi zagon (en ukaz)

```bash
cd restaurantos
cp deploy/.env.example deploy/.env    # izpolni identiteto obrata (§3)
docker compose -f deploy/docker-compose.yml up -d --build
```

Po gradnji (prvič nekaj minut) aplikacija teče na `http://<NAS-IP>:3000`.
Stanje in zdravje:

```bash
docker compose -f deploy/docker-compose.yml ps       # stanje (healthy/unhealthy)
curl http://localhost:3000/api/health                # sonda: povezava + shema
```

Pred vsakim resnim zagonom priporočamo `bun scripts/selfhost-check.ts`
(pred-let kontrakta: datoteke paketa, preslikave okolja, oznaka slike ↔
verzija aplikacije).

## 3. Identiteta obrata — obvezno prek okolja (brez čarovnika)

V zabojniku **ni** TLS fronte, zato čarovnik `/setup` prevzema ne more prevzeti
(dokaz računa fronta — docs/LOKALNI-ZAGON.md §2.1). Identiteto zato vpišeš v
`deploy/.env` **pred** prvim zagonom:

| Spremenljivka | Pomen |
| --- | --- |
| `RESTAURANTOS_NAME` | ime obrata |
| `RESTAURANTOS_OWNER_EMAIL` | prijavni e-poštni naslov lastnika |
| `RESTAURANTOS_OWNER_PIN` | PIN lastnika, 4–8 števk |
| `RESTAURANTOS_TAX_ID` | davčna številka (SI 8 števk s kontrolno / HR OIB 11) ali prazno |
| `RESTAURANTOS_BUSINESS_ID` | matična številka (opcijsko) |
| `RESTAURANTOS_PORT` | zunanja vrata gostitelja (privzeto 3000) |

Po spremembi `.env`: `docker compose -f deploy/docker-compose.yml up -d`
(znova ustvari zabojnik; podatki v nosilcu ostanejo). Prijava je na
`http://<NAS-IP>:3000` z e-pošto in PIN-om iz `.env`.

## 4. CasaOS / ZimaOS (en klik)

1. Odpri CasaOS → **App Store** → ikona **⊕ (namesti po meri)** →
   **Import / docker-compose**.
2. Izberi datoteko `deploy/docker-compose.yml` iz repozitorija (ali prilepi
   vsebino). CasaOS jo registrira kot aplikacijo `restaurantos`.
3. V CasaOS nastavitvah aplikacije po potrebi spremeni zunanja vrata in vklopi
   dostop prek CasaOS domene (tam teče tudi HTTPS — paket namerno brez TLS).
4. Pred prvim zagonom izpolni `deploy/.env` (§3) — CasaOS zgradi sliko in
   požene zabojnik; podatki ostanejo v imenovanem nosilcu `restaurantos-data`.

ZimaOS uvaža compose po istem postopku (Aplikacije → namesti po meri).

## 5. Kje so podatki (baza, skrivnosti, kopije)

Vse živi v imenovanem nosilcu `restaurantos-data` na `/data` znotraj zabojnika:

- `/data/restaurantos.db` — SQLite baza (WAL način, kot v lokalnem profilu);
- `/data/config.json` — trajne skrivnosti (APP_SECRET, sol za PIN …; dovoljenja
  ureja profil — v zabojniku jih zagotavlja ne-root uporabnik `bun`);
- `/data/backups/` — dnevne varnostne kopije (ene na dan UTC, delajo se
  samodejno ob zagonu in vsakih 6 h — ISTA logika kot `bun run local`).

Pogled vanje brez ustavljanja storitve:

```bash
docker compose -f deploy/docker-compose.yml exec restaurantos ls -l /data/backups
```

## 6. Varnostne kopije izven NAS-a (offsite)

Znotraj zabojnika lahko uporabiš obstoječi offsite korak lokalnega profila
(cilj je mapica z dovoljenjem za pisanje, ki jo montiraš v zabojnik ali dosežeš
po omrežju):

```bash
# primer: dodatni montirani imenik /offsite v compose (volumes:) + ukaz
docker compose -f deploy/docker-compose.yml exec restaurantos \
  bun scripts/local-offsite.ts --help
```

Ročna kopija trenutne baze (npr. pred posodobitvijo):

```bash
docker compose -f deploy/docker-compose.yml exec restaurantos \
  bun -e "import {backupDatabase} from './src/lib/local-durability'; \
console.log(await backupDatabase('/data/restaurantos.db','/data/backups',{kind:'rocna'}))"
```

Obnovitev: ustavi storitev, zamenjaj `restaurantos.db` z želeno kopijo iz
`/data/backups`, zaženi storitev. Detajli o formatu kopij: docs/BACKUP-RESTORE.md.

## 7. Posodobitev na novo izdajo

```bash
cd restaurantos && git pull
bun scripts/selfhost-check.ts        # oznaka slike ↔ verzija aplikacije
docker compose -f deploy/docker-compose.yml up -d --build
```

Shema se ob zagonu samodejno uskladi (`prisma db push` znotraj lokalnega
profila), pred posegom pa profil NAREDI varnostno kopijo (ista vrstni red
garancij kot na lastnikovem računalniku). Oznaka slike v
`deploy/docker-compose.yml` sledi `src/lib/version.ts` — to preverja
`selfhost-check` in tests/v207-selfhost-kit.

## 8. Meje paketa (poštene, ne skrite)

- **TLS ni del paketa** — na NAS-u ga pokrije CasaOS/ZimaOS ali obratni
  posrednik; `--https` iz lokalnega profila v zabojniku NAMERNO ni na voljo.
- **Čarovnika ni** — prvi prevzem je prek okolja (§3). To je posledica
  varnostnega modela dokaza (brez fronte ni prevzema), ne omejitev funkcije.
- **PWS/Upstash in deljeni rate-limit** so opcijski (env iz korenskega
  `.env.example` prek `environment:` v compose); brez njih deluje lokalni
  profil v celoti.
- Slika vsebuje razvojne odvisnosti (prisma CLI za db push ob zagonu) —
  preprostost in zvestoba lokalnemu profilu sta pred minimalizmom velikosti.

## 9. Preverjeno stanje kontrakta (peskovnik)

Gradnja slike v peskovniku NI izvedljiva (ni Docker daemon). Skladenje paketa
je zato deterministično preverjeno na ravni kontrakta: `bun scripts/selfhost-check.ts`
(zeleno) + `tests/v207-selfhost-kit.test.ts` (čisti validatorji, kit na disku,
registri). Ukazi v receptu so IZMERJENI vzorci iz repozitorija: `bun install`,
`bun node_modules/prisma/build/index.js …` in `bun node_modules/next/dist/bin/next …`
(isti klici kot `src/lib/local-setup.ts` in `scripts/local-start.ts`).
