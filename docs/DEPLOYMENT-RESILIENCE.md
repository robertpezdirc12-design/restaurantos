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

Vsak job vseh šestih workflowov ima zadnji korak `if: failure()` → lokalno
akcijo `ci-alarm`, ki odpre ali dopolni GitHub issue z oznako `ci-alarm` in ga
dodeli lastniku repozitorija. Ker v repo secrets ni nobenega kanala za sporočila
(Slack, e-pošta, webhook), je issue edino mesto, ki opozorilo pokaže tudi zunaj
Actions — rdeč pipeline, ki ga ne najde nihče, je enak modremu (najdba #16).
Issue namenoma NE vsebuje izsečka loga, ker lahko log nosi zneske, davčne
podatke in kratke odtise skrivnosti.

Od v1.171.0 ima ta korak pogoj, brez katerega je navidezno prisoten alarm
neuporaben: `uses: ./.github/actions/ci-alarm` se naloži iz delovnega prostora,
zato ga lahko pokliče samo job, ki ima `actions/checkout`. `neon-backup.yml` in
`prod-smoke.yml` ga do takrat nista imela — alarmni korak je v njiju stal, a na
runnerju se nikoli ni mogel izvesti. Izmerjeno na runu 39920450748 (23. 10. 2026
ob 08:03:05 UTC): za pravim vzrokom (`POST /roles` → „quota exceeded") je
sledilo `##[error]Can't find 'action.yml' ... Did you forget to run
actions/checkout before running your local action?`. To pojasni tišino okrog
backupa: zadnji uspešen je bil 18. 10., nato né issue, né komentar, né povzetek
koraka. Zato korak v obeh workflowih ni več zadnji, ampak prvi (`checkout@v5`,
isti kot `ci.yml`; `ci-canary` je še vedno na `v4` in zaradi tega v logu
izpisuje opozorilo o ukinjenem Node 20). Strukturo pinira
`tests/v171-alarm-checkout.test.ts`, ki zahteva checkout pred alarmom v vsakem
workflowu, ki akcijo kliče, in alarm v vsakem workflowu s `schedule:` — oba
pina sta mutacijsko dokazana, pri čemer je moral prvi brati strukturo brez
komentarjev, ker je besedilo pojasnila vsebovalo isti niz in je pin po lastnem
popravku ostal rdeč. Korak je sicer v ta dva joba vnesel `f3f08c8` (v1.150.0,
revizija #16 »alarm javi«) in z njim takrat NI bil dodan checkout:
`git log -S actions/checkout -- .github/workflows/neon-backup.yml` je prazen,
torej korak v tem jobu nikoli ni bil naložljiv.

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

### Dead-man alarm je moral dostopiti prejemnika (v1.168.0)

Alarmna plast (`.github/actions/ci-alarm`, osem klicev: `ci.yml` ×3, `ci-canary`,
`neon-backup`, `prod-smoke`, `sync`, `vercel-ops`) je bila vgrajena kot odgovor na
pet dni tiho izpadlega backupa (13.–18. 10.). **Do v1.168.0 ni nikoli dostopila.**
Canary (№24) je pravilno javil 6 zaporednih izpadov CI-ja (16.–22. 10.), vsi
klici alarmnega koraka so vrnili `success`, `gh issue list --state all`
pa nima **niti ene** `[CI alarm]` vrstice. Alarm, ki se ne oglasi, je slabši od
brez-alarma: sam korak dostave je bil videzno zelen.

Štiri lastne napake, vse izmerjene:

1. **Pokvarjen REST base.** `API="${{ github.server_url }}/api/v3/repos/…"` vrne
   404 (pravilen base je `github.api_url` → `https://api.github.com`; isti base
   že uspešno uporablja `scripts/ci-canary-check.mjs`). Ker `api()` uporablja
   `curl -f`, je padel *vsak* poziv, ne samo prvi, in korak je tiho šel na
   `state=spodletela`.
2. **`${{ }}` vpoki sredi shell besedila.** `inputs.hint` se v besedilo vpiše
   dobesedno, hint pa ima narekovaje → `line 5: [: too many arguments`
   (run 39742241206) in ključno navodilo „najprej preveri“ je izginilo iz
   povzetka in issue.
3. **`python3 -c` kot JSON gradnik.** Na Windows runnerjih (in na tej razvojni
   škatli) je `python3` stub, ki izpiše napako in **vrne 0** → tiho prazen
   payload. Edini upoštevani gradnik je zdaj `node`.
4. **`curl` argv in kodna stran.** MSYS (Git Bash) pri predaji argv nativnemu
   `curl.exe` preklopi na OEM kodno stran, zato UTF-8 (š, č, ž, —) razpade v
   `?` — izmerjeno 22. 10. na lokalnem stubu: `curl -d "$P"` → `"?ED ? ?iv"`,
   `printf '%s' "$P" | curl --data-binary @-` → `"ČED — živ"`. `node` argv je
   varen, `curl` argv ni. Ker sta naslov in body alarmne issue slovenska, telo
   zdaj potuje prek stdin.

**Popravek:** vsaka zunanja vrednost gre prek `env:` (`SCOPE, HINT, JOB, API_BASE,
SERVER_URL, RUNNER_NAME, RUNNER_OS, TOKEN`), payloadi jih berejo iz `argv`/`stdin`;
JSON gradi `node`; curl dobi telo prek **stdin** (`--data-binary @-`, glej
napako 4). Spanje med poskusi je zdaj konfigurabilno
(`API_RETRY_SLEEP`, privzeto 3 → vedenje na runnerju nespremenjeno), korak pa
ob treh padcih istega endpointa izpiše `::warning::api <metoda> <pot> ni uspel`,
da je vzrok v logu, ne samo posledica.

**Namensko ohranjeno:** korak nikoli ne vrne napake (`exit 0` +
`state=spodletela`), da ne zakrije pravega vzroka odpovedi; nadaljnje odpovedi
istega joba se deduplicirajo v komentar; dodelitev lastniku ostaja edini signal,
ki pride do človeka brez Actions zaslona; body namenoma nima izsečka loga (№20).

**Peta luknja, druge vrste — našel jo je šele v1.171.0.** Zgornje štiri so bile
napake *v* akciji; ta je bila napaka *klicevca*. Dva od osmih klicev
(`neon-backup.yml`, `prod-smoke.yml`) v jobu nimata `actions/checkout`, lokalna
composite akcija pa se naloži iz delovnega prostora, zato korak na runnerju ne
more obstajati: `##[error]Can't find 'action.yml'` (run 39920450748, 23. 10.).
Takratni test dostave je bil lokalni — `node` pokliče isto logiko z izmišljenim
`GITHUB_*` okoljem — in lokalno datoteke akcije vedno obstajajo, zato luknje ni
mogel videti. Pokriva jo statični pin, ki v vsaki `.github/workflows/*.yml`
preveri par (checkout, alarm) — glej *Alarm ob izpadu* in
*Kaj je triažing razkril zunaj suite-a*.

Zakaj to do zdaj ni bilo odkrito: `audit1516` A2 je pinil *obliko* koraka
(`state=…`, `$GITHUB_STEP_SUMMARY`, `/assignees`), nikoli pa HTTP basea ali
izvedbe. Test je zdaj **vedenostni** — iz `action.yml` izvlečen `run:` blok se
zažene kot pravi skript proti lokalnemu HTTP stubu in preveri, kaj se zgodi (8
mutacij, vseh 8 ujetih: `tests/v168-ci-alarm-delivery.test.ts`).

**Kar kod popraviti ne more (lastnik, Settings):** ~~izbrisati spremenljivko
`CI_RUNNER_LABELS`~~ — **IZVEDENO 2026-10-23**: spremenljivka je izbrisana, ker je
meritev pokazala, da hosted pool NI izčrpan: canary job (ki ima hardkodiran
`ubuntu-latest`) je ob 01:35 tekel na `runner_name: GitHub Actions 1000002687` in
dokončal v 27 s. Koment ob `ci.yml:28` je trdil nasprotno (kvota izčrpana do
1. 11. 2026) — bil je zastarel. Opomba: komentar je zapisan kot mehanizem, ki
ostane v veljavi (če kvota res zmanjka, se spremenljivka vrne z
`gh api -X PUT …/actions/variables -f name=CI_RUNNER_LABELS -f value=self-hosted`).

~~Odstraniti je treba še neveljaven label `ubuntu-latest` s runnerja
`sandbox-ci-runner-1`~~ — **OVRGNJENO IN ZAPRTO 2026-10-23, ista mera je našla
pravi vzrok.** Label na uhovaljenem runnerju hosted jobov ne krade: sync runi so
bili `jobs: []` zaradi ENEGA samega runa `39855929868`, ki je od 22. 10. 21:16Z
naprej stal v `queued` z `labels: ["self-hosted"]` (ustvarjen, ko je
`CI_RUNNER_LABELS` še živel) in je zaradi `cancel-in-progress: false` držal
celo `gitlab-sync` skupino. Preklic runa je zadostoval; od 12:42Z naprej so vsi
synci zeleni (25 s, 12 s, 10 s) in GitLab zrcalo spet hoda korak za korakom.
Brisanje labela ali runnerja torej ni bilo potrebno — odločitev lastnika
(»Zaenkrat ne«) je bila pravilna in je zdaj tudi izmerjena.

### Šesta luknja alarmne plasti: `cancelled` run ne more alarmirati sam sebe (v1.172.0)

Zgoraj štiri luknje so bile v akciji, peta v klicatelju. Šesta je bila **v
predpogoju canary-ja**: `scripts/ci-canary-check.mjs` je ob zaključenem runu, ki
ni `success`, rekel »ta run ima svoj alarm, canary ne sme podvajati« in vrnil 0.
Predpogoj drži za `failure` (job se je izvedel, `if: failure()` je tekel), ne
drži pa za `cancelled` in `startup_failure` — na preklicanem runu se koraki z
`if: failure()` **ne izvedejo nikoli**, zato takega izpada v repozitoriju ni
mogel javiti nihče.

Izmerjeno 22.–23. 10.: trije zaporedni `gitlab-sync` runi ob tipih `7ff89ef` in
`06a4c02` (#42, #43, #44) so končali `cancelled`, canary pa je vsakič vrnil 0.
Isti nabor podatkov danes odloči drugače. Na **pravem** API odzivu (1.516.726 B,
`/actions/runs?branch=main&event=push`, 100 runov) je bila odločitev izmerjena z
enakim vhodom na obeh različicah skripta:

| tip na veji | različica | izhod | izpis |
|---|---|---|---|
| `7ff89ef` (sync #44 `cancelled`) | pred popravkom | **0** | `OK (tih): zadnji run #undefined … canary ne sme podvajati` |
| `7ff89ef` (sync #44 `cancelled`) | po popravku | **1** | `ALARM: run #44 (workflow: Dvosmerna sinhronizacija GitLab <-> GitHub) je zaključen z 'cancelled'` |
| `c085689` (zdrav tip) | pred popravkom | 0 | `OK: … run #undefined` |
| `c085689` (zdrav tip) | po popravku | **0** | `OK: … za vsak od 1 workflowov na tipu: #48 (Dvosmerna sinhronizacija …)` |

Zakaj to ni preklop na stalno rdeče: na zdravem tipu novi skript vrne 0, alarmira
pa samo ob zaključku, ki svojih korakov ne more izvesti.

Zdravilo je odločanje **po workflowu**: za vsak push run na tipu se pogleda njegov
najnovejši zaključen izid; dopustna sta samo `success` in `failure` (množica
`SELF_ALARMING`), vse ostalo je izpad, v sporočilu pa je ukaz za diagnozo
`gh api 'repos/<repo>/actions/runs?status=queued'`. Stranski učinek, ki ga je
razkrila ista mera: pravi API imenuje polje `run_number`, lokalne fixture pa
`number` — brez testa na **pravi** obliki bi alarm izpisal `#undefined` in
klicatelj ne bi vedel, kateri run naj išče. Pokrito z dodatnim testom, ki
uporablja pravo obliko in trdi na `#44` ter prepoveduje `undefined`.

Suite: 19 canary testov (5 statičnih pogodb + 14 odločitev) v datoteki z 25
testi, mutacijski ledger **7/7 ujetih**: M1 `cancelled` dopolni množico
`SELF_ALARMING` → 4 padci; M2 vsi workflowi v eno skupino → 2; M3 najstarejši
namesto najnovejšega runa → 1; M4 `failure` postane glasen → 2; M5 samo
`number` → 1; M6 spremenjen `scope` → 1; M7 iz hinta izpuščena beseda
`cancelled` → 1. Po zadnji mutaciji sta obe datoteki vrnjeni, njuna vsota
`sha256` pa je primerjana z izvirnikom (`0f073c2819b3` / `bf61e8c11762`).

**Ledger je bil v prvem poskusu lažen, in sicer v svojem lastnem harnessu:**
poganjalski skript je mutacije zajel z `execFileSync`, bun pa rezultate piše na
**stderr** — pri izhodu 0 `execFileSync` vrne samo stdout, driver torej ni videl
ničesar in je vsako mutacijo razglasil za `fail=0`. Brez kontrolnega koraka
(brez mutacije, z zahtevo, da se številka `pass` sploh razčleni) bi to izgledalo
kot 7/7 preživetih mutacij, torej kot napačno pričevanje o tem, da testi nič ne
merijo. Zdaj `spawnSync` pobere oba toka in neznan izhod **vrže**, namesto da bi
ga tolmačil kot zelenega. Pin na stabilen `scope` ni okras: `ci-alarm`
deduplicira po točnem naslovu issue-a (`action.yml:143`), spremenjen naslov pa
pomeni nov issue, ob njem pa bi #77 ostal večno odprt.

**Meja tega dokaza:** meritev je zajela samo `/actions/runs`. `/commits` je v
fixture-ih ostal izmišljen, zato odločitveni del v1.172.0 na produkciji nikoli ni
bil izveden — to je razkrila šele mera spodaj (sedma luknja, v1.173.0).

### Sedma luknja: canary je javljal, a vedno napačen razlog (v1.173.0)

Šesta luknja je bila zaprta, nihče pa ni vprašal, ali se popravek v produkciji
sploh izvede. Odgovor je bil ne: canary je odpovedal na **vsakem** od 16
zasledovanih načrtovanih runov (20. 10. do 23. 10.), vedno z istim izpisom
`ALARM: zadnjega commita na veji main ni bilo mogoče določiti (prazen odgovor)`.
Vzrok ni bil izpad CI-ja, ampak **oblika odgovora**: `/commits?sha=main` vrne
seznam, skript pa je bral `commits.sha` — na seznamu je to vedno `undefined`,
zato je canary umrl na prvi odločitveni vrstici in do odločitve iz v1.172.0 ni
prišel nikoli. Issue #77 je v tišini nabiral komentarje s trditvijo, ki ne drži:
`main` je zaključene rune imel.

Dokaz o obliki, ne predpostavka:

| meritev | izid |
|---|---|
| `gh api "…/commits?sha=main&per_page=1" --jq 'type'` | `array` |
| `gh api "…/commits?sha=main&per_page=1" --jq '.sha'` | `expected an object but got: array` |
| `gh api "…/commits?sha=neobstojeca-veja-2026&per_page=1"` | HTTP 404, body `{"message":"Not Found","status":"404"}` |
| zadnji dva runa (20. 10., oba 4 s) | `log not found` — odpovedi nisem mogel klasificirati, zato ju ne navajam |

Zdravilo je dvodelno in namerno brez uganke: glava veje se razreše prek
`Array.isArray(commits) ? commits[0]?.sha : undefined`, sporočilo o odpovedi pa
opisuje **dejansko** videno obliko (`/commits je vrnil seznam z 0 elementov` ali
`odgovor tipa object namesto seznam-a`) namesto doslej vedno izmišljenega
»prazen odgovor«. Ker neobstoječa veja vrne 404 in ne praznega seznama, je
prazen seznam v resnici sprememba oblike odgovora, ne izbrisan branch — to
razliko mora videti vsak, ki bo alarm bral pozneje, ne samo avtor popravka.

A/B na **živem** API-ju (23. 10., isti žeton, neposredno brez proxy-ja):

| različica | izhod | izpis |
|---|---|---|
| pred popravkom | **1** | `ALARM: … (prazen odgovor)` |
| po popravku | **0** | `OK: zadnji commit na veji main ima zaključen uspešen run za vsak od 1 workflowov na tipu: #50 (Dvosmerna sinhronizacija GitLab <-> GitHub)` |

Zakaj prejšnje dokazovanje ni ujelo: 14 odločitvenih testov je v `/commits`
pisalo `{ sha }` — obliko, ki jo je predpostavil avtor testov. Trditev »dokazano
na pravem API odzivu« je v v1.172.0 veljala samo za `/actions/runs` (1.516.726 B,
pobrano z `gh api`), ne za `/commits`; meja dokaza je bila zapisana šele tukaj,
namesto da bi jo pokrila zelena barva. Helper zdaj piše **pravo** obliko
(karkoli ni seznam, postane seznam z enim elementom), zato je bil popravek
najprej viden kot **15 padcev** (12 pass / 15 fail), šele nato zelen.

Suite: 27 testov v datoteki, od tega canary 5 statičnih pogodb (C) + 16
odločitvenih (D). Mutacijski ledger te izdaje: **4/4 ujetih** — M1 neposredno
`commits.sha` → 13 padcev; M2 helper vrne izmišljeno obliko → 13 padcev; M3
sporočilo brez `commits.length` → 1 padec; M4 `if (!head)` izklopljen → 1 padec.
Kontrolni korak brez mutacije je moral pokazati 27/0, sicer ledger nima veljave.

**Pokritost canary-ja je bila napačno dokumentirana, in jo je popravila ista
mera.** Cron pravi `17 * * * *`, vodni komentar workflowa pa »en kratek run na
uro (~24 min/mesec)«. Vseh 16 runov, ki jih je ta workflow kdaj dobil (prvi
20. 10. 14:21:31Z, zadnji 23. 10. 13:32:50Z), ima razmike med **2,47 h in
6,19 h**, povprečje **4,75 h** — torej okoli 6 preverjanj na dan. Iz tega je
sledila še ena napačna domneva: ob 14:17 runa ni bilo, kar je bilo videti kot
izpad planerja, je pa povsem v skladu z merjenim razmikom. Komentar je zdaj
prepisan na številke; **zakaj** GitHub dobavlja redkeje, kot cron obljublja,
izmera ne pove in trditve o tem ne pišem. Praktična posledica je realnejša meja
detekcije: alarmni layer opozori na zablokiran run šele po največ ~6 h, ne po
eni uri.

**Objava te izdaje je bila preverjena na živem sistemu** (`0634e89`): `/api/health`
služi 1.173.0, `sync-check` je SYNCED na vseh treh pikah, GitLab zrcalo je
napredovalo za tri commite, `tests` job v CI-ju je prvič po v1.171.0 zelen na
release commitu, `neon-smoke` pa je rdeč z istim izmerjenim zunanjim vzrokom
(`quota exceeded` petkrat zapored na `POST /endpoints`). Canary je na živem
API-ju izdal obe odločitvi: `OK: run #186 je še v teku (1 min, prag 20 min)` med
gradnjo in `OK (tih): run #186 … je zaključen z failure` po njej. Naslednji
načrtovani run bo prvi, ki to odločitev izvede v produkciji.

### Alarmno besedilo je bilo zapisano brez šumnikov (v1.174.0)

Sedem lukenj je opisovalo, **kdaj** alarm molči. Ta izdaja zapira drug razred
napake: alarm, ki spregovori, a ga lastnik ne more prebrati. `hint` joba `tests`
v `.github/workflows/ci.yml:245` je bil zapisan transliterirano — »Ce je padel
tsc, je v produkciji ze verjetno deployano isto stanje« — in je bil **edini**
tak niz med 16 `scope`/`hint` vrednostmi v 6 workflow datotekah. Alarmni tekst je
edini del CI-ja, ki ga lastnik prebere brez odpiranja zaslona Actions, zato mora
biti zapisan do konca.

**Vzrok ni bil transport, ampak izvor niza.** Transportna težava je bila
odpravljena v v1.168.0: MSYS je argumente poslal po `argv` v domorodni
`curl.exe`, ta jih je predal v kodični strani, in je namesto šumnikov izdal `?`;
rešitev je bil prenos po stdinu z `--data-binary @-`
(`.github/actions/ci-alarm/action.yml:123–126`). Dokaz, da tokrat transport ni
kriv, je v **telesu samega issue-a #79**, kamor oba zapisa potujeta z enim samim
curl klicem:

| zapis v telesu #79 | kdo ga sestavi | kako pride do prejemnika |
|---|---|---|
| »sprožil«, »izsečka« | `action.yml` (generično besedilo) | **s šumniki**, nepoškodovano |
| »Ce je padel tsc, je v produkciji ze verjetno deployano isto stanje« | `hint` iz `ci.yml:245` | **brez šumnikov**, dobesedno kot v viru |

En transport, dva izida. Zvestost prenosa je sicer pinned tudi v testih —
`payload.title` se v `tests/v168-ci-alarm-delivery.test.ts` primerja z nizom, ki v
resnici vsebuje `č` (iz »zaključenega«), zato bi transliteracija med potjo takoj
padla. Kar nihče ni preverjal, je bila **vsebina datoteke**.

Varovalka: `tests/v174-alarm-text-fidelity.test.ts` (7 testov / 33 expect-ov).
Gre za statično pogodbo nad YAML-om in ne za vedenjski test, ker transliteriran
niz ne more pokvariti obnašanja — njegova edina posledica je berljivost. Tri
odločitve, ki niso bile samoumevne:

| odločitev | razlog, izmerjen pred pisanjem |
|---|---|
| bralec preverja samega sebe | test zahteva natanko 16 nizov iz natanko 6 datotek, vsaj 6 `hint`-ov in dolžino vsake vrednosti > 10 — sicer bi ga pokvarjen izvleček (regex, ki ne najde več vrstic) utišal, varovalka pa bi ostala zelena |
| dve tabeli, ne ena | en sam seznam korenov lažno javi: `\bce\w*\b` ujame besedo »celoten«, `\bnic\w*\b` pa veljaven rodilnik »nice«. Tabeli sta ločeni (cele besede / koreni), lažne prijave pa so pinned kot lasten test |
| vsebina ostane podpisana | hint mora še vedno vsebovati ukaz »padel tsc … deployment« in omenjati obe predponi `a56-`/`i4-` — v v1.168.0 je operativni ukaz že enkrat tiho izginil iz telesa |

Mutacijski ledger: **5/5 pojmljenih** (M1 izpraznjeni tabeli, M2 `ce` premaknjen
med korene → lažna prijava na »celoten«, M3 pokvarjen bralec YAML-a → 0 nizov,
M4 ASCII hint vrnjen v `ci.yml`, M5 hint izgubi predponi). Vsaka mutacija je
morala pokazati natanko pričakovana imena padlih testov in nič več, obnovitev
datotek pa je preverjena s sha256 in kontrolnim tekom.

**Issue #79 je zaprt po izmerjeni verigi, ne po predpostavki.** Stanje `tests`
joba na vseh šestih runih, ki jih je issue pokrival:

| run | commit | `tests` job | izmera |
|---|---|---|---|
| #182 | `d61dd9b` | failure | **3211 pass / 13 fail** — 8× rate limit, 2× `reconcilePaidStripeSessions`, 1× podatkovna mapa, 2× WAL |
| #183 | `dc2c886` | failure | **3231 pass / 1 fail** — dirka `PATCH/DELETE … nikoli 'cancelled' z fiskalnim računom` |
| #184 | `030ad25` | **success** | prvi zeleni `tests` |
| #185–#187 | `03c5f5a`, `0634e89`, `b66875b` | **success** | še trije zaporedni zeleni `tests` jobi na gostitelju |

Vseh štirinajst padcev spada med napake, ki so jih že zaprli objavljeni commiti:
trinajst pokrijeta `b201b35` (FIX: omejevalnik fail-closed, gostiteljeva pot,
checkout pred lokalno akcijo) in `ceef7fd` (TEST: determinizem suite-a),
četrtenega pa `480ce07` (TEST: dirka ne sodi več po hitrosti gostitelja). Zato
issue ni samo dobil dokaznega komentarja, ampak je bil tudi zaprt: dedupe pri
`ci-alarm` išče samo po `state=open`
(`.github/actions/ci-alarm/action.yml:143`), tako da naslednji enak izpad odpre
svež issue z novo mero namesto komentarja na staro.

### Determinizem suite-a in tiho izklopljene kontrole (v1.171.0)

**Kaj je CI takoj pokazal (prvi živi run po presklopu, `39905677431` na `d61dd9b`,
2026-10-23):** `typecheck-prod` SUCCESS, `tests` **13 padcev / 3211 zelenih** (od
3224, enako število kot lokalno), `neon-smoke` FAILURE. Noben razred ni regresija
kode iz `v1.170.0`: lokalno jih je prekrival vrstni red, ki ga `bun test` sam
izbere — vsi vzroki so bili vidni šele ob dejanskem izidu.

1. **8 × rate limit** (`Expected: 429, Received: 200`) — **uhajanje globalnega
   stanja + fail-open v produkciji**, ne „manjkajoči env" (to sem najprej
   zapisal in je bilo napačno):
   - `tests/rate-limit.test.ts` je nastavil `UPSTASH_REDIS_REST_URL/TOKEN` in ju
     nikoli počistil. `getStore()` rezultat kešira v modulski `activeStore`, zato
     je vsaka kasnejša datotela v istem procesu dobila Upstash store — neodvisno
     od tega, kaj je sama nastavila.
   - `tests/v170-offline-queue-limits.test.ts` je z `Object.defineProperty`
     zamenjal `globalThis.fetch` s stubom `{ ok: true, status: 200, json: () =>
     ({ results: [] }) }` in ga ni vrnil. Stub je bil najdaljši živi v procesu.
   - Posledica verige: Upstash REST vrne 200 brez polja `result` →
     `upstashCommand` vrne `null` → `Number(null) === 0` → `0 <= limit` →
     omejevalnik je **tiho izklopljen** in vsaka zahteva dobi 200 namesto 429.
   Popravljeno na obeh koncih. Testi počistijo svoje (`ORIG_ENV` +
   `__resetStoreForTests()` v `afterEach`/`afterAll`; `IZVIRNI` deskriptorji +
   `afterAll(povrniDOM)`). Produkcija **vrže napako**, če INCR odgovor ni celo
   število ≥ 1 (`src/lib/rate-limit.ts`): fail-open na varnostni kontroli ni
   izbira med dvema varnostnima metodama, je izbira brez kontrole.
2. **3 × odvisno od gostitelja, ne „od okolja"**:
   - `RESTAURANTOS_DATA_DIR` (`v165`): implementacija je eksplicitno pot
     absolutizirala z `platform` (`path.win32.resolve`), ki jo je posredoval test
     kot simulator. Na Windowsu se je to ujelo z gostiteljem, na Linuxu ne.
     Eksplicitna nastavitev gostitelja ne sme biti prevedena skozi modelirano
     platformo: zdaj je `path.resolve` (sintaksa gostitelja), `platform` pa velja
     samo za izpeljano privzeto pot. To je **produkcijski popravek**, ne
     popravek testa — lokalni profil mora živeti tam, kjer je nastavljen.
   - 2 × WAL (`v169`): trditev „po izhodu procesa rep ostane poln" je pravilna,
     dokaz napačen. Rep preživi samo **naglo** smrt procesa; ob čistem zaprtju
     SQLite checkpointa in `-wal` pobriše, zato je Linux dobil `ENOENT`. Test
     zdaj piše v podprocesu (`spawn`, nato ubit z `kill()`), kar pusti neprebran
     rep na obeh gostiteljih; kontrola `applyDurability počisti osirotele rep`
     nato briše resnično obstoječ rep in ne predpostavlja, zakaj je nastal.
3. **2 × Stripe reconcile** (`summary.settled` 0 namesto ≥ 1) — krivec ni
   vrstni red ali stanje sveže baze, ampak **`mock.module` v
   `tests/v161-cron-marker.test.ts`**. Bun z njim zastrupi modulski registry
   v celem procesu: vrnitev identitete izvoza ne vrne notranjih vezi mockanega
   modula, zato je njegova `db` vez ostala druga (prazna) instanca. Kasnejši
   `v157` je klical pravo funkcijo ob drugi vezi in dobil 0 vrstic.
   `mock.module` je **odstranjen iz suite-a**; pogoj, ki ga je mock lažno
   prikazoval, se zdaj sproži prek prave produkcjske poti (payLink s
   nedosegljivo sejo + `STRIPE_SECRET_KEY`), uporaba `mock.module` pa je
   prepovedana s statičnim pinom v celotnem suite-u (`audit2530` F).
4. **neon-smoke**: `POST /projects/…/endpoints` → `{"message":"quota exceeded"}`
   v petih poskusih. Branch je bil ustvarjen (`br-damp-sun-andbkw4b`), a ker
   korak teče z `bash -e` in `BR_ID` pride v `$GITHUB_ENV` šele na njegovem
   koncu, se je ustavil pred izpisom → cleanup (`if: always()`) je dobil prazen
   ID in **branch je ušel**. `BR_ID` je zdaj zapisan takoj za ustvarjanjem
   brancha, pred endpoint klicem (pin v `audit2530` F).
   **Kvota NI posledica kopičenja branchov** — tisto trditev sem imel tukaj
   zapisano in je napačna: `describe_project` 23. 10. kaže 4 od
   `branches_limit: 10` branchov, oba ušla CI brancha (`ci-smoke-7378994`,
   `ci-smoke-d61dd9b`) pa nimata **nobenega** endpointa. `quota exceeded` je
   kvota porabe načrta `free_v3`; popravek workflowa odstrani samo
   puščanje, kvote ne reši, zato neon-smoke ostane rdeč, dokler kvota drži.
   Oba ušla brancha sta še vedno v projektu — njuno brisanje je uničujoče zunanje
   dejanje in čaka na izrecno dovoljenje lastnika.

**Kaj je triažing razkril zunaj suite-a (osmi poseg te izdaje):** isti
`quota exceeded` kot neon-smoke je 23. 10. ubil tudi `Neon backup (pg_dump
production)` (run 39920450748). Niz, izmerjen po `created_at`/`updated_at`
posameznega runa: zadnji z validacijo skloden backup je 39110190199 (18. 10.
08:06 UTC), nato 19./20./21./22. 10. **cancelled**, 23. 10. **failure**.
Odpovedi sta dva različna razloga, in samo enega lahko reši koda:
1. **19.–22. 10. job sploh ni dobil runnerja.** Cron je `30 2 * * *`, vsi štirje
   runi pa so nastali ob 07:51–08:00 UTC, imeli `created_at == run_started_at`,
   `total_count: 1` brez katerekoli `workflow_job` in so bili prekinjeni točno
   24 h pozneje (08:00:51/53/54 + dan). To je podpis reda, ki čaka na
   `CI_RUNNER_LABELS`, usmerjene na mrtve self-hosted runnerje. Tak run
   `if: failure()` ne more doseči — edina plast, ki to vidi, je canary dead-man
   (najdba №24), in je: issue #77 s komentarji za rdeče 13./14./15. canary run.
2. **23. 10. je runner prišel, kvota pa ne.** Tu bi moral `if: failure()` odpreti
   issue, a se lokalna akcija ni mogla naložiti, ker job nima
   `actions/checkout` — `##[error]Can't find 'action.yml'`. Posledica: **prodaja
   pet dni nima sveže kopije in izdaja tega ni vedela**, ker je bil alarmni
   korak v backup workflowu videzno nameščen, a neizvedljiv.

Mehanizem je popravljen (checkout kot prvi korak, piniran z
`tests/v171-alarm-checkout.test.ts`); kvote porabe, zakasnelega razporedilnika in
mrtvih runnerjev koda ne reši.

**Zavestno NE storeno v tej izdaji (odločitev ni moja):**
1. **Zastaranje reconcile okna.** Nič ne zapre poteklih `open` payLinkov (v kodi
   obstajata samo `superseded` in `revoked` zapis), zato vrsta za
   `reconcilePaidStripeSessions` monotono raste. `take: 20` po `createdAt ASC`
   vedno pobere **najstarejše** vrstice: plačana povezava, ki je nastala za 20
   umrlimi, ostane neprebrana. Popravek bi bil paginacija (→ več Stripe klicev
   na run, kar na Vercel Hobby funkciji pade čez ~10 s budget) ali poslovno
   pravilo o zaprtju poteklih povezav — pravila ne določam sam.
2. **Brez timeouta na Stripe klicu.** `stripeSessionStatus()` nima
   `AbortSignal.timeout()`, paylinks korak pa Stripe seje bere zaporedoma. En
   obeseni odgovor pomeni, da cron job prestopi budget in se zaključi kot
   odpoved.

**Alarmna plast je potrdila delovanje drugič in tretjič v naravi:** run
`39905677431` je odprl issue **#78** (`neon-smoke`, 19 s po zadnji odpovedi
koraka) in **#79** (`tests`, 58 s) — prvi dokazani dostavi je bil canary
issue #77 (22. 10.).

Odprto ostaja merjenje canary
cronu: izraz je `17 * * * *` (vsako uro ob 17. minuti), dejanski
zagoni pa so 20.–22. 10. prišli ob 14:21, 19:20, 23:13, 01:41, 07:45, 13:53,
18:43, 22:25, 01:35, 07:41, 13:52 — **nobeden ne pade na 17. minuto, sledijo pa jim
3–6-urni presledki**, `createdAt` pa je enak `startedAt`. Run torej ni čakal v
vrsti za runnerja — zakasnil je že sam `schedule` dogodek. To je lastnost
GitHubovega razporedilnika (best-effort; ob vrhu zakasni ali sprožitev izpusti),
ne naša koda. Posledica: realna zazava mrtvega CI-ja je 3–6 h namesto 1 h, kar je
sprejeto: štiri do osem preverjanj na dan je več kot nič. Če hoče lastnik urno
zazavo, je zanesljivejša pot zunanji poklicatelj (`workflow_dispatch` prek GitHub
API-ja iz lastnega cron-a), ne `schedule:`.

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

