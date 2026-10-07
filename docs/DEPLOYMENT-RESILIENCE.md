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

## Eksterna struktura

- **GitLab = canonical** (robert.pezdirc12/restaurantos)
- **GitHub = samodejni push-mirror** (GitLab push mirror + sync-service :3032
  kot varovalka) — mirror nikoli ni vir sprememb.
- **Vercel** files-API deploy iz te seje (produkcija); env: APP_SECRET,
  BOOTSTRAP_ADMIN_*, PIN_LOOKUP_SALT, Neon DATABASE_URL.
