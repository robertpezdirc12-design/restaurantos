# Runbook — lokalni zagon RestaurantOS (R1, v1.165.0)

Ta dokument je operativni vodnik za namestitev, kjer RestaurantOS teče na
računalniku v obratu in uporablja **lokalno bazo SQLite**. Za oblačni profil
(Vercel + Neon) glej `docs/DEPLOYMENT-RESILIENCE.md`. Zahteve in merila sprejema
so v `docs/PRD-LOKALNA-BAZA.md`.

## 1. Kaj potrebujete

- Računalnik, ki bo stal v obratu (Windows 10/11 prvi; Linux/macOS podprta pot).
- [Bun](https://bun.sh) 1.3 ali novejši.
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

1. ustvari podatkovno mapo in trajne skrivnosti (`config.json`, `0600`);
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

Mapo prepiše `RESTAURANTOS_DATA_DIR`. V njej so:

- `data/restaurantos.db` — baza (edini vir podatkov v R1);
- `config.json` — trajne skrivnosti; **ne** kopirajte v repo in ne delite;
- `PRVIC-ZAGON.txt` — prve poverilnice;
- `backups/pre-push-*.db` — kopije pred posodobitvijo sheme (zadnjih 5).

Mapa je namenoma zunaj repozitorija, zato posodobitev kode ne more povoziti
podatkov in `git status` ne vidi baze.

## 4. Vsakodnevno delo

- **Zagon:** `bun run local` (isti ukaz kot prvič; baze ne ponastavi).
- **Postanek:** `Ctrl+C` v terminalu. Launcher ustavi samo svoj strežniški
  proces, ne drugih procesov v sistemu.
- **Dostop v omrežju:** na izpisanem naslovu `http://<IP>:3000` (npr.
  `http://192.168.1.20:3000`) z računalnika, tablice ali handhelda v istem
  omrežju. R1 uporablja HTTP; PWA namestitev zahteva HTTPS in je obseg R2.
- **Preverjanje:** odprite `/api/health`. V lokalnem profilu mora vrniti
  `"status":"ok"`, `"mode":"local"`, `"databaseEngine":"sqlite"`, `"schema":"ok"`.

## 5. Varnostne kopije in obnova (R1)

R1 nima samodejnih dnevnih kopij. Pred vsakim zagonom, ki posodobi shemo, nastane
`backups/pre-push-*.db`, kar ščiti pred neuspešno nadgradnjo — ne pa pred okvaro
diska.

**Ročna kopija:** ustavite aplikacijo in kopirajte `data/restaurantos.db` na
drug medij (USB, omrežna mapa). Kopirajte tudi `config.json`, sicer po obnovi na
drugem računalniku ne boste mogli preveriti obstoječih PIN-ov.

**Obnova:**

1. ustavite aplikacijo (`Ctrl+C`);
2. shranite trenutno bazo stran (ne izbrišite je);
3. kopirajte izbrano kopijo v `data/restaurantos.db`;
4. zaženite `bun run local`.

## 6. Posodobitev na novo različico

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

## 7. Odpravljanje težav

| Simptom | Vzrok in ukrep |
|---|---|
| `EADDRINUSE` | Vrata 3000 so zasedena. Zaženite `bun run local --port 3001`. |
| `Manjka Next.js` | Zaženite `bun install`. |
| `Prisma odjemalec je generiran za postgresql` | Zaženite `bun run local:setup` brez `--no-generate` (ali `bun run db:generate`). |
| Build ne uspe | Preverite `bun run typecheck` in prostor na disku; nato `bun run local --build`. |
| `/api/health` vrne `degraded` | Preberite `dbError` v odgovoru in dnevnik terminala; baza je v `data/restaurantos.db`. |
| PIN izgubljen | R1 nima samodejnega ponastavljanja. Obnovite `PRVIC-ZAGON.txt` iz kopije ali bazo iz varnostne kopije; čarovnik za ponastavitev je R3. |
| FURS ali kartično plačilo ne uspe | Lokalna baza ne odpravi odvisnosti od interneta; preverite povezavo in certifikate (`docs/FURS-CERT-RUNBOOK.md`). |

## 8. Meje izdaje R1

- HTTP v lokalnem omrežju (brez HTTPS in namestitve PWA) — R2.
- Ročne kopije in obnova — R2 doda samodejne dnevne kopije in integritetni pregled.
- Brez čarovnika prve namestitve v brskalniku — R3.
- Brez migracij in rollbacka nadgradenj — R3/R4.
- SQLite je **en pisec**: ne zaženite dveh kopij aplikacije nad isto bazo.

Podatki so lokalni. Aplikacije ne izpostavljajte neposredno na internet; za
oddaljen dostop uporabite oblačni profil ali VPN.
