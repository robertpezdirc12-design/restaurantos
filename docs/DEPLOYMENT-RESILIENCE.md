# Deployment Resilience (issue #12 §5 + §8)

## Cilji (raziskava: blue-green/canary + varen rollback)

RestaurantOS ostane **operativno enostaven**: ena Next.js aplikacija na Vercelu,
ena baza (Neon), en testni proračun, ki ga izvajajo trije sistemi. Blue-green/canary
dosežemo z Vercel immutability (vsak deploy = nova izvedba, star ostane zdrav do
preklopa), ne z Kubernetesom.

## Pipeline (CI — GitHub Actions, GitLab, Vercel)

CI je razdeljen na TRI sisteme, ki morajo izvesti ISTI proračun. To pogodbo
(razred napak: GitHub zelen, GitLab rdeč ali obratno) varuje
`tests/audit1516-ci-hygiene.test.ts`, sklop A5.

### GitHub Actions — glavna zapora (`.github/workflows/ci.yml`)

```
neon-smoke      : začasna Neon veja (prava Postgres) → prisma DDL + CRUD/enum/FK/JSONB
                  + drift preverba z dovoljenim seznamom znanih pending driftov
tests           : DATABASE_URL=file:./db/ci-fresh.db → prisma db push (SQLite zrcalo)
                  → check-secrets.sh → tsc --noEmit → bun run lint → bun run test
typecheck-prod  : prisma generate (produkcijska Postgres shema) → tsc --noEmit
```

`typecheck-prod` je ločen job, ker ima `tests` `file:` URL: tam generiran Prisma
klient enumeratov ne pozna (`Reservation.status` je `String`) in Json polja bere
kot `String`. Tipski razred, ki je stal padec rezervacijskega opomnika v
produkciji (v1.129.0), v jobu `tests` torej NE more pasti — tretji job je edini,
ki gleda pravo shemo. Baza tu ni potrebna: `prisma generate` se ne povezuje.

Od v1.166.0 ima `typecheck-prod` tudi lokalni par: `bun run typecheck:cloud`
(`scripts/typecheck-cloud.cjs`). Ne zaradi nezaupanja CI-ju, ampak zaradi kvote —
job teče na self-hosted runnerju (`CI_RUNNER_LABELS`) in je lahko ure v čakanju,
Vercel pa ob pushu zgradi ne glede na njega. Izdaja v1.166.0 je zaradi tega padla:
`status: 'completed'` v demo zgodovini je bil pod SQLite klientom zelen (zrcalo
ima `String`), CI job je čakal na runnerja, Vercel build pa je javil TS2322.
Skript generira produkcijski klient, požene `tsc --noEmit` in na koncu VEDNO
vrne SQLite klienta, da `bun test` ne ostane na napačnih tipih (v1.112.0: 29
lažnih padcev). Isti razred zdaj ujame tudi `tests/seed-enum-validity.test.ts`,
ki bere produkcijsko shemo in ne klienta.

`check-secrets.sh` od v1.150.0 skenira tudi `.github/`. Pred tem je pregledal
`src/`, `scripts/`, `mini-services/` in `.gitlab-ci.yml`, workflowe pa ne, zato
je step "Secrets hygiene" ostal zelen tudi ob razkritem žetonu v `sync.yml`.

Od v1.153.0 (najdba №20) skenira tudi `docs/` in korenske `*.md` ter prepozna
6-mestni PIN (`PIN`, `PIN:` ali `PIN=` + šest števk) in fine-grained GitHub PAT
(`github_pat_`). Razlog je isti kot pri №15: živ admin PIN je stal v
`worklog.md`, `DEPLOYMENT-STATUS.md` in `docs/OPS11-*.md`, scan pa je .md
namerno izključeval — pokritih je bilo 90 % datotek, v katerih skrivnosti ni, in
0 % tistih, kjer so. Scan poti se zdaj filtrirajo na obstoječe, prazen seznam pa
je trda napaka; prej je manjkajoča pot pomenila `grep` exit 2, ki ga je skript
obravnaval kot "čisto".

### GitLab CI — zrcalni quality-gate (`.gitlab-ci.yml`)

```
quality-gate    : bun install → (git bootstrap, best-effort) → prisma db push (SQLite)
                  → check-schema-drift.cjs → check-secrets.sh → tsc --noEmit
                  → bun run lint → bun run test
production-build: prisma generate (Postgres) → bun run build
```

Edina razlika med sistemoma je `check-schema-drift.cjs`: GitHub drift preverja na
PRAVI Postgres bazi (job `neon-smoke`), GitLab pa obe shemi primerja lokalno, ker
nima Neon dostopa. Vse ostalo mora biti identično — to pinira sklop A5.

`node_modules` predpomnik ima za oba joba RAZLIČEN `key.prefix`. Brez tega bi
`quality-gate` (ki hoče SQLite klienta) lahko prevzel produkcijskega s shranjenega
predpomnika in obratno — isti razred tihe napake kot zgoraj, le da ga povzroči
predpomnik, zato se pokaže šele takrat, ko runner prejme zadetek.

### Obseg jobskega loga (najdba №23)

GitLab ima na izpis enega joba trdo mejo 4.194.304 B. Ko jo job preseže,
zbiranje loga prenehe in job umre — brez napake v kodi in brez razloga v
izpisu.

Vzrok za šest zaporednih rdečih pipeline-ov je bil `log: ['query']` v
`src/lib/db.ts`: celoten testni proračun je z njim natisnil 17.044.192 B
(59.255 vrstic `prisma:query`) — štirikrat čez mejo — in job je umrl sredi
`bun run test`. Zadnja dva koraka (`check-schema-drift.cjs`, `check-secrets.sh`)
se nikoli nista izvedla. Zrcalni gate je bil torej rdeč zaradi lastnega
izpisa, ne zaradi vsebine.

Od v1.151.0 `src/lib/db.ts` poizvedbe logira SAMO, če je `PRISMA_LOG_QUERIES=1`,
in nobena CI konfiguracija tega stikala ne prižge. Ista sprememba je odpravila
še eno tiho napako: predhodni `log` je bil seznam z ENO samo stopnjo, zato
Prisma `warn` in `error` sporočil ni pisal nikoli. Zrcalni gate je s tem utišal
prav tista sporočila, ki opozarjata na neskladje sheme in na težave s povezavo.

Meritev po popravku: celoten suite (2889 testov) zapiše 448.369 B in nobene
`prisma:query` vrstice — devetkrat prostora pod mejo. Sklop B v
`tests/audit2324-log-noise.test.ts` to preverja dinamično: sonda
`scripts/log-noise-probe.ts` zažene pravi Prisma klient, test pa šteje
`prisma:query` vrstice nje — z stikalom in brez njega.

### Determinizem zrcalnega gate-a (najdbe №25–№30, v1.152.0)

Po tem, ko je №23 odpravil izpad zaradi obsega loga, smo v pipeline #57 prvič
dobili ČIST izid: 653.068 B loga, suite se je izvedel do konca in odkril devet
pravih padcev, odvisnih od okolja. Vseh devet izhaja iz šestih vzrokov, vsak od
njih pa je bil tiha napaka v repozitoriju — ne v kodi produkta, ampak v tem,
kako se koda izvaja v CI:

- **№25 — `git` manjka v sliki `oven/bun:1`.** Pet od devetih padcev je bilo
  `Executable not found in $PATH: "git"` v skupini B2
  (`tests/audit1516-ci-hygiene.test.ts`), ki dokazuje sync-guard z realnim
  gitom v temp repozitorijih. Kvaliteta produkta ni bila nikoli ogrožena, a
  padec zaradi orodja zamaskira vse, kar pride za njim. `quality-gate` zdaj
  najprej poskuša `apt-get install git` (best-effort; neuspeh odtiska
  `GIT-MISSING` in ne ustavi joba), skupina B2 pa je vezana na sondo
  `HAS_GIT` prek `describe.skipIf` — padec zaradi orodja je tako nemogoč,
  pokritost ostane na GitHub Actions in lokalno.
- **№26 — varnostna preverba je bila zadnji korak.** `check-secrets.sh` (in na
  GitLabu `check-schema-drift.cjs`) sta se izvedla ŠELE, če so bili tsc, lint
  in vsi testi zeleni. Rdeč tsc torej pomeni, da izpuščen žeton NIKOLI ne
  pride do pregleda — varnostni gate, ki je odvisen od tega, da je vse ostalo
  zeleno, ni varnostni gate. Oba sistema ju zdaj izvedeta PREJ dragih gate-ov;
  pogodbo pinirata sklop B v `tests/audit2530-ci-determinism.test.ts` in
  posodobljeni A5 v `tests/audit1516-ci-hygiene.test.ts`.
- **№27 — počistilo po neobstoječem stolpcu.** `tests/handheld-flow.test.ts`
  je v `.catch(() => null)` tiho pogoltnil `Unknown argument 'orderId'`
  (`Payment` ima samo `checkId`, `prisma/schema.prisma`), 12× na posamezen
  tek — izjava
  je od začetka nikoli ne uspela. Odstranjena; edini prehod plačil gre po
  `checkId` in je piniran v obe smeri.
- **№28 — Upstash URL brez sheme.** CI spremenljivka
  `UPSTASH_REDIS_REST_URL` vsebuje vrednost brez `https://` (dokaz:
  `fetch() URL is invalid` v logu). `getStore()` jo je vseeno sprejel, limiter
  pa je za vsak zadetek naredil DVA fetch klica, obsojena na neuspeh
  (INCR + PTTL). Ker
  testi za plačilne povezave štejejo klice `globalThis.fetch`, je števec
  Stripe klicev v CI stalno kazal 2 namesto 0. `upstashEndpoint()` zdaj
  sprejme SAMO absoluten http(s) URL; neuporabna nastavitev pomeni memory
  store (zaščita ostane aktivna, brez mrežnega poskusa). Lastnik naj
  spremenljivko popravi ali odstrani.
- **№29 — padec odvisen od hitrosti stroja.** Zamekana dirka med plačilom in
  preklicem je na SQLite (en sam pisalec) ob sočasnosti vrgla `P1008 Socket
  timeout` po 5174 ms — time-out, ki ni napaka izdelka, je pobarval suite
  rdeče. `raceSweep` zdaj požre SAMO P1008 in jo šteje (več kot ena na skupno
  dirko je spet odvisnost od stroja), varnostna invarianta pa ima poleg
  zamekane dirke še dva deterministična primera (plačilo-prej, preklic-prej).
- **№30 — globalna številka brez imena krivca.** Preklic, ki ga je prehitelo
  plačilo, pušča `pending` vrstico v `EventLog`, ki pade v globalni dispatch
  naslednjega teka; bootstrap testu je ob tujih vrsticah padla ena sama
  številka (`processed`), ne da bi povedala katera vrstica in čigava je.
  Bootstrap zdaj loči lastne vrstice (točno 5) od tujih in te v sporočilu
  o napaki IMENUJE.

Vseh šest najdb pokriva 22 novih testov v
`tests/audit2530-ci-determinism.test.ts` (dinamični dokaz za №28 brez mreže +
statični pini za ostale), mutacijsko dokazanih z M1–M18. V v1.152.1 je sklop B
dobil še pin produkcijskega tipskega gate-a (spodaj).

### Vercel — deploy, ki je hkrati zapora

Vercel Git integration zgradi in deploya ob pushu na main, neodvisno od CI-ja.
Zato `next.config.ts` od v1.150.0 zastavice `typescript.ignoreBuildErrors` nima
več (najdba #18): build sam zaustavi tipsko napako, preden ta pride v produkcijo.
Testnih datotek deploy pri tem ne more zablokirati, ker jih `tsconfig.json`
izpušča (`exclude: ["tests"]`).

### Produkcijski tipski gate (v1.152.1)

Odprava `ignoreBuildErrors` je razkrila drugo tiho razhajanje: `quality-gate`
generira SQLite client, kjer so enum polja `String`, Vercel pa si generira
Postgres client, kjer so pravi Prisma enumerati. `tsc` na SQLite clientu zato
ne vidi neveljavnega literala, ki ga Postgres client zavrne. Trije takšni
literali (seed `source: 'web'`, `itemStatus` tipa `string`, `PaymentStatus` v
`src/lib/ops.ts`) so med v1.150.0 in v1.152.0 pustili produkcijo na 1.149.0:
vsak deployment se je končal z `ERROR`, build log pa ni bil dosegljiv brez
`bld_` identifikatorja. Napaka je bila reproducirana lokalno — dovolj je bilo
generirati Postgres client in zagnati `tsc --noEmit` (točno tri napake).

Zdaj imata oba sistema po dva tipska gate-a: SQLite client (hitro, brez baze)
in Postgres client (produkcijska resnica). GitHub je imel `typecheck-prod` že
od v1.150.0; GitLab je v v1.152.1 dobil `production-typecheck` v stopnji
`verify` (brez `DATABASE_URL`, ker `prisma generate` ne potrebuje povezave).
Vsak od treh jobov, ki uporablja predpomnilnik `node_modules`, ima svojega, ker
vsak generira drugega od treh Prisma klientov. Pogodbo pineta A5 v
`tests/audit1516-ci-hygiene.test.ts` (trije poimenovani predpomniki) in sklop B
v `tests/audit2530-ci-determinism.test.ts` (isti recept na obeh sistemih).
Literale v seed skriptah, ki jih prejšnji sweeper ni gledal (pregledoval je
samo `src/`), zdaj pokriva `tests/seed-enum-validity.test.ts`.

### Alarm ob izpadu (`.github/actions/ci-alarm`)

Vsak job vseh petih workflowov ima zadnji korak `if: failure()` → lokalno
akcijo `ci-alarm`, ki odpre ali dopolni GitHub issue z oznako `ci-alarm` in ga
dodeli lastniku repozitorija. Ker v repo secrets ni nobenega kanala za sporočila
(Slack, e-pošta, webhook), je issue edino mesto, ki opozorilo pokaže tudi zunaj
Actions — rdeč pipeline, ki ga ne najde nihče, je enak modremu (najdba #16).
Issue namenoma NE vsebuje izsečka loga, ker lahko log nosi zneske, davčne
podatke in kratke odtise skrivnosti.

Pri `sync.yml` je bilo stanje do v1.150.0 še hujše: pogoja `if: failure()` ni
bilo in napake ni bilo. Koraki so uspeh potrdili ne glede na izid (`|| true`,
pregrt izhod), run je bil zelen in sinhronizirano ni bilo ničesar. Zato isti
release fetch, push in tage naredi fail-loud in dodaja varovko zakasnitve
zrcala — alarm brez resnega izhoda je ornament.

### Dead-man za run, ki se nikoli ne začne (najdba №24)

`if: failure()` je pogoj, ki ga Actions izvede samo za run, ki se je začel in
končal. Trije načini, kako CI izgine, a nobeden od njih ne povzroči rdečega
izida: (a) workflow je onemogočen ali pa je njegov `on:` blok neveljaven, tako
da se ob pushu sploh ne ustvari run; (b) run nastane, a runner nikoli ni
dodeljen — prazna hosted kvota ali nedosegljiv self-hosted runner, kar je
točno scenarij najdbe №15; (c) cron sploh ne sproži. V nobenem od teh primerov
noben job ne odpove, zato noben `ci-alarm` issue ne more biti odprt — najdba
№16 je bila s tem pokrita samo v polovici.

`ci-canary.yml` je šesti workflow in teče vsako uro (`cron: 17 * * * *`) na
GitHubovi hosted napravi. To je EDINA izjema od usmerjanja prek
`vars.CI_RUNNER_LABELS` in je utemeljena v glavi datoteke z oznako
`IZJEMA-CI-CANARY`: opazovalec ne sme biti nameščen na isto napravo, ki jo
opazuje, sicer bi prazna kvota ali ugasnjen self-hosted runner utišal tudi
alarm zanjo. Cena izjeme je ~24 minut hosted-računa na mesec. Pogodba, da se
izjema ne sme razširiti na pet delivery workflowov, je pinirana v obe smeri
(sklop C v `tests/audit2324-log-noise.test.ts`).

Sam preizkus je kratek (`node scripts/ci-canary-check.mjs`) in ne kopira
odločitvenega drevesa v YAML: poišče najnovejši commit na `main`, nato run-e
tega commita in napove izid po lestvici — prazen odgovor, spremenjena oblika
API-ja, nič zabeleženih runov na veji, commit brez runa, run zunaj praga 20
min. Zadnji primer je najbolj verjeten in edini, ki ga GitHub sam ne javi: run
obstaja, samo nikoli se ni začel.

En primer je namenoma TIH (`exit 0`): če je zadnji run zaključen z napako,
canary ne odpira ničesar, ker ga `if: failure()` že pokriva. Podvajanje bi vsako
odpoved spremenilo v dva issuea in alarm razredčilo do neuporabnosti. Ker
canary ob lastni odpovedi pokliče isti `ci-alarm`, je pokrita tudi zavora
same zavore.

### Površina odvisnosti (v1.154.0)

Dobavljena koda je enako del produkcijske slike kot naša, zato ima svojo mejo:
`bun install --frozen-lockfile` na Vercelu in v obeh CI-jih pomeni, da različica
ne more „uplavati“ med buildom — kar je v `bun.lock`, gre v produkcijo. Spodnje
meje (next ≥ 16.3.8, sharp ≥ 0.35.5, js-yaml 4.3.2, eslint-plugin-react-hooks
7.0.1) in ocena preostalih OSV najdb so zapisane v
`docs/SECURITY-BOUNDARY.md`, zaklene pa jih
`tests/dependency-advisories.test.ts` na treh ravneh: deklaracija v
`package.json`, resnično stanje v `bun.lock` in nameščeno stanje v
`node_modules`. Nadgradnja zato ni „npm install in upanje“, ampak izdaja z
enakimi vrati kot koda.

## Migracije (varne proti obstoječim podatkom)

- Pravilo: **samo aditivne, idempotentne DDL** prek in-app endpointov
  `/api/admin/migrate-issue*` (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT
  EXISTS, ADD VALUE IF NOT EXISTS). Brez prostoformskega SQL. Vsaka izvede
  audit (`SCHEMA_MIGRATION_ISSUE*`).
- Pre-verifikacija: `bunx prisma validate` obe shemi + drift check + (lokalno)
  `bun run db:push` na zrcalo.
- Backup pred migracijo: `bash scripts/backup-database.sh`
  (SQLite `.backup` ali `pg_dump -Fc`) — #11 §8.
- Validacija migracije: `bun run scripts/validate-migration.ts`
  (prisma validate ×2 + drift + obvezni modeli + vloge).

### Migracijski baseline (najdba №17, v1.153.0)

`prisma/migrations/00000000000000_init/migration.sql` je od v1.153.0 POLNA
projekcija `prisma/schema.prisma`: **135 `CREATE TABLE` + 20 `CREATE TYPE`**.
Prejšnja verzija iste mape je imela 118 tabel — 17 tabel (PayLink,
ReservationWidget, StockTransfer, CashMovement, EInvoiceOutbox, HaccpAction,
ManagerCall, PrepLabel, LabelShelfRule, PayrollPeriod, PayrollExport,
StationTask, MenuItemStation, StockTransferItem, GuestConsent, Campaign,
CampaignSend) je v bazo prišlo prek `db push` in admin DDL rut, migracijska
zgodovina pa ni bila nikoli vodena. `migrate deploy` na prazno bazo bi torej
ustvaril shemo brez teh 17 tabel.

Produkcija migracijskega toka ne uporablja (shema je zgrajena z `db push` in
aditivnimi DDL rutami). Ob morebitni selitvi obstoječe baze na `migrate` tok jo
je treba najprej označiti kot aplicirano:

```bash
bunx prisma migrate resolve --applied 00000000000000_init
```

`tests/audit1719-integrity.test.ts` pinira ujemanje množic modelov in tabel,
prisotnost vseh 17 nekdanjih tabel, odsotnost `DROP` stavkov v baselineu in
glavo z zgornjim korakom.

**Drift gate.** 24 vnosov v `KNOWN_DRIFTS` opisuje dokumentiran pending drift:
znan drift izpiše `::warning::` in konča z exit 0, neznan stavek izpiše
`::error::` in konča z **exit 1**, infrastrukturna napaka (npr. pavziran Neon)
pa prav tako exit 1. Trditev iz revizije, da gate "nikoli ne javi `::error::`",
je bila artefakt iskanja po dobesednem nizu — anotacija se gradi kot
`` `::${level}::` ``, zato `grep "::error::"` v izvirniku ne najde ničesar.
Test zato pinuje VEDENJE (`classifyDrift` + oba `return 1`), ne niza.

**Obseg `db:push`.** `package.json` `db:push` cilja izključno na
`prisma/schema.sqlite.prisma` (SQLite zrcalo, sandbox) in uporablja
`--accept-data-loss`. Produkcije ne more doseči: tam je Postgres URL, shema pa
se spreminja prek admin DDL rut. Noben CI recept ne kliče `bun run db:push` in
ne uporablja `--accept-data-loss`; to pinuje isti test.

## Sandbox reverse proxy (najdba №19, v1.153.0)

`Caddyfile` (port 81) je samo peskovni obhod do aplikacije na 3000 in
print-agenta na 3031. Prej je bil cilj `localhost:{query.XTransformPort}` —
vsak neavtenticiran obiskovalec je z `?XTransformPort=<port>` izbral POLJUBNO
lokalno vrato (5432 → Postgres, 9100 → tiskalnik), kar je SSRF. Zdaj:

- matcher je ENAKOST `query XTransformPort=3031`, ne vzorec;
- cilj je dobesedni `http://localhost:3031` oziroma `http://localhost:3000`;
- `X-Forwarded-For` se NASTAVI na `{remote_host}`; Caddy privzeto ignorira
  odjemalčev XFF, zato prvi člen seznama ni ponaredljiv.

`:81` ostaja brez TLS — to je peskovni zdravstveni kanal, produkcijski promet
pa gre na Vercel, kjer TLS zaključi platforma. Če se pesek kdaj izpostavi izven
localhosta, mora TLS/avtentikacijo prevzeti meja platforme; dodajanje
samopodpisanega TLS v ta Caddyfile tega ne bi rešilo. `tests/audit1719-integrity.test.ts`
bere samo aktivno konfiguracijo (komentarji so izključeni) in zahteva natanko
dva dovoljena porta.

## Post-deploy smoke (rollback sprožilec)

```bash
BASE_URL=https://restaurantos-theta.vercel.app ./scripts/smoke-test.sh
# + opcijsko: SMOKE_EMAIL=... SMOKE_PIN=... (prijava E2E)
# izhod 1 → razmislek o rollbacku
```

Preveri: health (status+DB), lokacije, javni meni, 401 fail-closed na
zaščiteni ruti, (opcijsko) prijavo.

## Rollback

| Vrsta spremembe | Postopek |
|---|---|
| Aplikacija (koda) | Vercel: prejšnji deployment je immutable in zdrav → **Promote/Rollback** na prejšnji build (Vercel UI ali `vercel rollback <url>`). Alternativa: `git revert` + redeploy. |
| Migracija (shema) | Aditivne DDL so po zasnovi **naprej-združljive**: stara koda deluje z novimi stolpci (DEFAULT). Rollback kode zadostuje; stolpci ostanejo (ničesar ne izsušimo — politika). |
| Kombinacija | 1) Promote stare kode (Vercel) 2) preveri smoke 3) revert commit 4) naslednji deploy vključi spremembo znova z fixom. |

## Zdravje in opazljivost

- `/api/health` — status + DB povezava + verzija (uporablja smoke + monitoring).
- `/api/monitoring/errors` — Dnevnik napak (UI).
- `/api/audit`, `/api/events` — sledljivost akcij/dogodkov.
- `bun run scripts/system-health.ts` — DB/vrsta/naprave/drift/izhodne kode (#11 §8).
- `scripts/sync-status.ts` — git + DeviceSyncOperation + EventLog stanje.

### Poraba prenosa baze (Neon egress, v1.156.0 + v1.164.0)

Neon free plan šteje prenesene podatke; 24/7 odjemalci so glavni vir. Pravila:

- **customer display**: `?v=<version>` → ob nespremenjenem stanju strežnik vrne le
  `{unchanged, posOnline}` brez `payload`/`promos` (v1.156.0, test `v156-cfd-conditional`).
- **dashboard**: 15-sekundni »hot« cikel nosi le statistiko, mize, naročila in kuhinjo;
  meni, rezervacije, računi in izmene se osvežijo v 60-sekundnem polnem ciklu
  (v1.164.0, test `v164-poll-egress`).
- **handheld/tablica**: mize in naročila na 15 s, meni vsak 4. cikel (60 s); po
  naročilu/plačilu se meni osveži takoj (`load(true)`).

Strežniška validacija naročila ostaja avtoritativna (razpoložljivost/86), zato
morebitna do 60 s stara kopija menija ne more obiti poslovnih pravil.

### Ponovni zagon dnevnega crona (marker + dedupe digesta, v1.167.0)

`/api/cron/daily` je idempotenten prek markerja `lastRunDate` (`already_ran_today`),
marker pa se ob napaki **ne** zapiše (v1.161.0) — lažni uspeh v markerju je slabši
od ponovitve. Posledica je namenoma ta, da istodnevna ročna ponovitev zažene vse
korake znova. Koraki z lastnim dnevnim stanjem (recurring pravila, LOT/HACCP
markerji) to preživijo; edini korak s stranskim učinkom, ki ga ni mogoče umakniti,
je **dnevni digest e-pošta**.

Od v1.167.0 zato `sendDailyDigest` pred pošiljanjem preveri `ScheduledEmailLog`
za vrstico `reportType = DAILY_DIGEST`, `status = sent` na **zajeti dan** (včerajšnji
koledarski dan) in vrne `{ sent: false, reason: 'already_sent' }`; cron odgovor
reason pokaže v `steps.digest`. Neuspešna vrstica (`failed`) **ne** blokira
ponovitve — poskus, ki ni bil dostavljen, je treba ponoviti.

Omejitve: ključ je dan + vrsta poročila, ne lokacija (`ScheduledEmailLog` nima
lokacijskega stolpca, digest pa je globalen — cron kliče brez `locationId`), in
brez edinstvenega indeksa (DDL) dva sočasna klica v istem trenutku teoretično
oba pošljeta — realni scenarij pa je ponovitev minute ali ure pozneje.
Dokaz: `tests/v167-digest-dedupe.test.ts` (5 testov, mutacijsko dokazano 6/6).

## Sandbox rollback resync (Task 46)

Peskovno okolje lahko **vrne git refse na star snapshot**, medtem ko je GitHub
avtoritativa novojevanska (incident 2×: Task 26, Task 46). Simptom: lokal
`git log` kaže star commit, `git fetch github` pa "Authentication failed"
(stari token v rollbackanem `.git/config`).

**Diagnoza (1 ukaz):**

```bash
bun scripts/sync-check.ts
# local / mirror / prod trojica + klasifikacija:
#   synced       — vse pike isti commit (exit 0)
#   local-behind — mirror+prod naprej → --fix
#   local-ahead  — mirror zaostaja → git push origin main
#   diverged     — mirror != prod → ročni pregled avtoritativnosti
#   unknown      — katera pika nedosegljiva → infra diagnoza
```

**Resync lokalnega repoja (ko je klasifikacija `local-behind`):**

```bash
bun scripts/sync-check.ts --fix        # fetch origin + reset --hard origin/main
# --fix blokira samo spremembe na SLEDENIH datotekah (untracked ostanejo);
# uporabi --force izrecno, če veš kaj delaš.
```

**Pomni po rollbacku (checklist):**
1. `git config user.name / user.email` — rollback povrne peskovno identiteto
   `Z User <z@container>`; nujno nazaj na GitHub noreply identiteto
   (`249648337+robertpezdirc12-design@users.noreply.github.com`), sicer Vercel
   Git deploy BLOCKED ("couldn't find a Git account for the commit author" — Task 43).
2. Remote URL-i v `.git/config` so lahko stari (mrtev GitHub PAT, blokiran
   GitLab račun) — popravi pot, NE vgradi novega žetona v URL. Žeton gre v
   `GIT_ASKPASS` program (`sync.yml` ga zgradi v `$RUNNER_TEMP` in ga nikoli ne
   zapiše). URL z vgrajenim žetonom namreč pristane v `.git/config`, v
   `git remote -v` in v vsakem peskovnem snapshotu, od tam naprej pa ni več
   odstranljiv (najdba #15).
3. Untracked ostanki stare ere (npr. `vercel-deploy.yml`, `schema.production.prisma`)
   — počisti po primerjavi z `git status` na resyncanem HEAD.
4. Dev strežnik: restart, če prisma client drži staro shemo v spominu (Task 44 lekcija).

## Eksterna struktura (usklajeno z Task 43+)

- **GitHub = AVTORITATIVA** (`robertpezdirc12-design/restaurantos`) — Vercel Git
  integration builda produkcijo iz GitHub main (push → deploy ~30 s; Task 43).
- **GitLab = mirror** (`robertpezdirc8/restaurantos`, projekt ID 87573786) —
  zrcalo istih SHA-jev; push po vsakem GitHub pushu (403 anti-abuse → retry po
  ~30 s). Pot markec-group1/markec-project je ZGODOVINSKA: zrcalo je bilo
  preseljeno na račun robertpezdirc8 (worklog v1.107.0), `git remote -v` in
  `git ls-remote` oba potrjujeta novo pot. Zakasnitev zrcala NI več domneva:
  zadnji korak `sync.yml` primerja `refs/heads/main` na obeh straneh in ob
  razliki javi napako s številom zaostankov (najdba #15 — mirror je neopazeno
  miril 31 verzij).
- **Vercel** produkcija: env APP_SECRET, BOOTSTRAP_ADMIN_*, PIN_LOOKUP_SALT,
  Neon DATABASE_URL. Token `VERCEL_TOKEN_B64` ostane v GitHub secrets kot
  rezervni CLI mehanizem — deploy ne potrebuje več tokena.
- `bun scripts/sync-check.ts` — dokaz trojice lokal/mirror/prod (glej zgoraj).

