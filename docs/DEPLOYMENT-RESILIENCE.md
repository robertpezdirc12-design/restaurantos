# Deployment Resilience (issue #12 §5 + §8)

## Cilji (raziskava: blue-green/canary + varen rollback)

RestaurantOS ostane **operativno enostaven**: ena Next.js aplikacija na Vercelu,
ena baza (Neon), en CI pipeline (GitLab). Blue-green/canary dosežemo z Vercel
immutability (vsak deploy = nova izvedba, star ostane zdrav do preklopa), ne z
Kubernetesom.

## Pipeline (GitLab CI)

```
push/ MR → quality-gate (verify stage)          [VEDNO na main]
             bunx tsc --noEmit          (tipi)
             bun run lint               (eslint)
             bun test                   (enote, 105+)
             node scripts/check-schema-drift.cjs   (produkc.↔sqlite zrcalo usklajeno)
             bash scripts/check-secrets.sh         (uhajanje skrivnosti)
         → production-build (build stage)          [ko je DATABASE_URL CI variable]
             bunx prisma generate --schema prisma/schema.prisma
             bun run build              (produkcijski Next build)
```

- Verify ostane gate tudi, ko build ni aktiven (DATABASE_URL secret odločitev
  uporabnika — issue #10 P2-2).
- **Schema compatibility**: check-schema-drift vsiljuje, da je produkcijska
  Postgres shema in SQLite zrcalo strukturno usklajena pred vsakim merge-jem.

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
   GitLab račun) — osveži z veljavnimi tokeni.
3. Untracked ostanki stare ere (npr. `vercel-deploy.yml`, `schema.production.prisma`)
   — počisti po primerjavi z `git status` na resyncanem HEAD.
4. Dev strežnik: restart, če prisma client drži staro shemo v spominu (Task 44 lekcija).

## Eksterna struktura (usklajeno z Task 43+)

- **GitHub = AVTORITATIVA** (`robertpezdirc12-design/restaurantos`) — Vercel Git
  integration builda produkcijo iz GitHub main (push → deploy ~30 s; Task 43).
- **GitLab = mirror** (markec-group1/markec-project) — zrcalo istih SHA-jev;
  push po vsakem GitHub pushu (403 anti-abuse → retry po ~30 s).
- **Vercel** produkcija: env APP_SECRET, BOOTSTRAP_ADMIN_*, PIN_LOOKUP_SALT,
  Neon DATABASE_URL. Token `VERCEL_TOKEN_B64` ostane v GitHub secrets kot
  rezervni CLI mehanizem — deploy ne potrebuje več tokena.
- `bun scripts/sync-check.ts` — dokaz trojice lokal/mirror/prod (glej zgoraj).

