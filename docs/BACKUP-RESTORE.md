# Backup & Restore — varnostne kopije in vaja obnove (issue #3 §G)

> **Stanje (v1.120.0):** dnevni backup produkcijske baze teče SAMODEJNO
> (neon-backup.yml, 02:30 UTC, 90-dnevna retencija, validacija vsake kopije).
> **RESTORE DRILL ŠE NI BIL IZVEDEN** — postopek spodaj je dokumentiran, prvi
> izvedena vaja bo zapisana sem (naloga za lastnika/opombo). NIKOLI ne obnavljaj
> čez produkcijo brez izrecne lastnikove odločitve.

## 1. Dnevni backup (avtomatski — .github/workflows/neon-backup.yml)

- **Kdaj:** vsak dan 02:30 UTC (03:30/04:30 po Ljubljani) + ročni `workflow_dispatch`.
- **Kaj:** `pg_dump --format=custom` (pg_restore združljiv) celotne baze
  `restaurantos` na produkciji (branch `prod-v2`).
- **Varnostni vzorec:** efemerna `backup_<stamp>` vloga z ločenim geslom (dobiva
  SAMO v response klica — Neon brez gesla ne dovoli povezave), `--no-owner
  --no-acl`, vloga se izbriše VEDNO (`if: always()`).
- **Validacija vsake kopije:** `pg_restore --schema-only` izpiše DDL → števec
  `CREATE TABLE` (≥100) + števec `TABLE DATA` sekcij (≥1); odpoved = rdeči run.
- **Retencija:** artifact 90 dni (`backup/BACKUP_INFO.txt` z vezjo: čas, branch,
  endpoint, št. tabel, commit).
- Skrivnosti: brez dodatnih — uporablja obstoječi `NEON_API_KEY_B64`.

## 2. Lokalni backup (dev — scripts/backup-database.sh)

```bash
bash scripts/backup-database.sh [izhodna_mapa]   # privzeto ./backups
# sqlite (DATABASE_URL=file:…) → sqlite3 .backup (konzistentna kopija; fallback cp)
# Postgres → pg_dump -Fc (custom format)
```

Raba pred vsako DDL migracijo (docs/DEPLOYMENT-RESILIENCE.md „Migracije“).

## 3. RESTORE DRILL (vaja obnove — na efemernem branchu, NE na produkciji)

Cilj vaja: DOKAZ, da je kopija uporabna (ne samo da teče job). Postopek:

1. Prenesi artifact zadnjega `neon-backup` runa (GitHub → Actions → run →
   artifact `neon-backup-<run_id>` → `neon-backup-<stamp>.dump` + `BACKUP_INFO.txt`).
2. Ustvari EFEMERNI Neon branch (ločen od `prod-v2` — npr. `restore-drill`):
   ```bash
   NEON_KEY=$(…)
   curl -X POST "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" \
     -H "Authorization: Bearer $NEON_KEY" -H 'Content-Type: application/json' \
     -d '{"branch":{"name":"restore-drill"}}'
   # endpoint + začasna vloga s SAMLO geslom (vzorec iz neon-backup.yml)
   ```
3. Obnovi dump v bazo na efemernem branchu:
   ```bash
   pg_restore -d "postgresql://<vloga>:<geslo>@<endpoint-drill>/restaurantos?sslmode=require" \
     --no-owner --no-acl neon-backup-<stamp>.dump
   ```
4. Validacijske poizvedbe (psql na drill bazi):
   ```sql
   SELECT count(*) FROM "Location";                      -- pričakovano ≥ 1
   SELECT count(*) FROM "Receipt";                       -- >0 po dnevu prometa
   SELECT count(*) FROM "AuditLog" ORDER BY 1 DESC LIMIT 1;  -- revizijska sled obstaja
   SELECT count(*) FROM "Receipt" WHERE "fiscalStatus" = 'pending';  -- znan pending števec (smoke)
   ```
   Preveri tudi: `verifyAuditChain` (lokalni skript proti drill bazi — veriga
   revizije se obnovi brezlomno), najnovejši `INVOICE_ISSUE` zapis, št. tabel.
5. Počisti: izbriši drill branch (`DELETE /branches/<id>`) — NE puščaj kopije
   podatkov na več branchih.
6. Zapiši dokaz sem (datum, run_id, št. tabel/vrstic, ugotovitve).

**Varnostna pravila:**
- NIKOLI `pg_restore` čez `prod-v2` — obnova produkcije je IZRECNA lastnikova
  odločitev (kaj je izgubljeno od backupa, kaj je nastalo po njem) in teče kot
  namenski incident postopek (INCIDENT-RUNBOOK.md §6).
- Dump vsebuje PII (osebje, gostje) — obravnavaj SAMO v varnem okolju, po vaji izbriši.

## 4. RPO / RTO (trenutno)

- **RPO:** ~24 h (dnevni dump) — dnevni promet je na kocki ob katastrofi; ni
  neprekinjene replike (Neon branch protection / WAL arhiv IZVEN obsega).
- **RTO:** manualen postopek §3 + odločitev lastnika (ure, ne minute).
- Izboljšava (odločitev lastnika): Neon point-in-time restore (7–30 dni glede na
  tarčni načrt) → RPO minute.

## 5. Referenca

- Workflow: `.github/workflows/neon-backup.yml` (dnevni 02:30 UTC, 90 dni)
- Dnevne invariance (ločeno): `.github/workflows/prod-smoke.yml` (05:00 UTC,
  read-only — vključno števec `Receipt.fiscalStatus='pending'`)
- Lokalno: `scripts/backup-database.sh`, `scripts/validate-migration.ts`
- Rollback aplikacije: docs/DEPLOYMENT-RESILIENCE.md (tabela)
