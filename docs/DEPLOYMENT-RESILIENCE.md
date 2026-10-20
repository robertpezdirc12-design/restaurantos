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
                  + drift prevera z dovoljenim seznamom znanih pending driftov
tests           : DATABASE_URL=file:./db/ci-fresh.db → prisma db push (SQLite zrcalo)
                  → tsc --noEmit → bun run lint → bun run test → check-secrets.sh
typecheck-prod  : prisma generate (produkcijska Postgres shema) → tsc --noEmit
```

`typecheck-prod` je ločen job, ker ima `tests` `file:` URL: tam generiran Prisma
klient enumeratov ne pozna (`Reservation.status` je `String`) in Json polja bere
kot `String`. Tipski razred, ki je stal padec rezervacijskega opomnika v
produkciji (v1.129.0), v jobu `tests` torej NE more pasti — tretji job je edini,
ki gleda pravo shemo. Baza tu ni potrebna: `prisma generate` se ne povezuje.

`check-secrets.sh` od v1.150.0 skenira tudi `.github/`. Pred tem je pregledal
`src/`, `scripts/`, `mini-services/` in `.gitlab-ci.yml`, workflowe pa ne, zato
je step "Secrets hygiene" ostal zelen tudi ob razkritem žetonu v `sync.yml`.

### GitLab CI — zrcalni quality-gate (`.gitlab-ci.yml`)

```
quality-gate    : bun install → prisma db push (SQLite) → tsc --noEmit
                  → bun run lint → bun run test → check-schema-drift.cjs
                  → check-secrets.sh
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

### Vercel — deploy, ki je hkrati zapora

Vercel Git integration zgradi in deploya ob pushu na main, neodvisno od CI-ja.
Zato `next.config.ts` od v1.150.0 zastavice `typescript.ignoreBuildErrors` nima
več (najdba #18): build sam zaustavi tipsko napako, preden ta pride v produkcijo.
Testnih datotek deploy pri tem ne more zablokirati, ker jih `tsconfig.json`
izpušča (`exclude: ["tests"]`).

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
- **GitLab = mirror** (markec-group1/markec-project) — zrcalo istih SHA-jev;
  push po vsakem GitHub pushu (403 anti-abuse → retry po ~30 s). Zakasnitev
  zrcala NI več domneva: zadnji korak `sync.yml` primerja `refs/heads/main` na
  obeh straneh in ob razliki javi napako s številom zaostankov (najdba #15 —
  mirror je neopazeno miril 31 verzij).
- **Vercel** produkcija: env APP_SECRET, BOOTSTRAP_ADMIN_*, PIN_LOOKUP_SALT,
  Neon DATABASE_URL. Token `VERCEL_TOKEN_B64` ostane v GitHub secrets kot
  rezervni CLI mehanizem — deploy ne potrebuje več tokena.
- `bun scripts/sync-check.ts` — dokaz trojice lokal/mirror/prod (glej zgoraj).

