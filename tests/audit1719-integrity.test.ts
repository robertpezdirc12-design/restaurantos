import { describe, test, expect, afterAll } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { KNOWN_DRIFTS, classifyDrift } from '../scripts/drift-check'

/**
 * v1.153.0 — revizija 2026-10, najdbe №17, №19, №20 (integriteta repozitorija).
 *
 *  №17 — `prisma/migrations/00000000000000_init` je imela 118 od 135 tabel:
 *        17 tabel je v bazo prišlo mimo migracij (db push + admin DDL rute),
 *        baseline pa ni bil nikoli dopolnjen. `migrate deploy` na prazno bazo
 *        bi ustvaril shemo brez teh 17 tabel; drift gate pa je 24 znanih
 *        odstopanj skrival v allowlistu, ki ga ni preverjal noben test.
 *        Tu je baseline pinan kot POPOLNA projekcija sheme, allowlist kot
 *        nedvoumen seznam z admin ruto, klasifikator pa kot blokator za
 *        neznan stavek (vir kode je prav tako pinan).
 *
 *  №19 — `Caddyfile` je imel `reverse_proxy localhost:{query.XTransformPort}`:
 *        vsak obiskovalec sandboxa je z ?XTransformPort=<poljuben port> izbral
 *        cilj na loopbacku (SSRF). Zdaj je matcher ENAKOST na 3031, cilj pa
 *        dobesedni `http://localhost:3031`. Test zahteva, da noben cilj ne
 *        vsebuje interpolacije in da sta dovoljena natanko dva porta, ki ju
 *        aplikacija dejansko uporablja.
 *
 *  №20 — živ 6-mestni admin PIN je bil zapisan v worklog.md,
 *        DEPLOYMENT-STATUS.md in docs/OPS11-*.md, `check-secrets.sh` pa je
 *        .md namerno izključeval. Test poganja PRAVI skript nad temp drevesom
 *        (PIN v docs/, PIN v korenskem .md, 4-mestni razvojni PIN, GitHub PAT)
 *        in nato preveri, da v nobenem Markdown dokumentu v repozitoriju ni
 *        več PIN-a ter da je oznaka redakcije prisotna. Rotacija PIN-ov ostaja
 *        dejanje lastnika — vrednosti so še vedno v git zgodovini.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const PROD_SCHEMA = read('prisma/schema.prisma')
const SQLITE_SCHEMA = read('prisma/schema.sqlite.prisma')
const MIGRATION = read('prisma/migrations/00000000000000_init/migration.sql')
const CADDY = read('Caddyfile')
const SECRETS_SH = read('scripts/check-secrets.sh')
const DRIFT_SRC = read('scripts/drift-check.ts')

const models = (src: string) => [...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1])
const prodModels = models(PROD_SCHEMA)
const sqliteModels = models(SQLITE_SCHEMA)
const prodEnums = [...PROD_SCHEMA.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1])
const migrationTables = [...MIGRATION.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
const migrationEnums = [...MIGRATION.matchAll(/CREATE TYPE "(\w+)"/g)].map((m) => m[1])

const tmpDirs: string[] = []
function mkTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `c17-${label}-`))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/* ═══════════════════════════ №17 — migracijski baseline ═══════════════════════════ */

describe('№17 — baseline migracija je popolna projekcija sheme', () => {
  test('baseline pokrije VSE modele in enume produkcijske sheme', () => {
    expect(prodModels).toHaveLength(137)
    expect(prodEnums).toHaveLength(20)
    expect(migrationTables).toHaveLength(prodModels.length)
    expect(new Set(migrationTables).size).toBe(prodModels.length)
    expect([...migrationTables].sort()).toEqual([...prodModels].sort())
    expect([...migrationEnums].sort()).toEqual([...prodEnums].sort())
  })

  test('nobena tabela ne manjka in nobena ni odveč', () => {
    expect(prodModels.filter((m) => !migrationTables.includes(m))).toEqual([])
    expect(migrationTables.filter((t) => !prodModels.includes(t))).toEqual([])
  })

  test('ime modela je enako imenu tabele (brez @@map) — pogoj za primerjavo množic', () => {
    expect(PROD_SCHEMA).not.toContain('@@map')
    expect(SQLITE_SCHEMA).not.toContain('@@map')
  })

  test('17 nekoč manjkajočih tabel je v baselineu', () => {
    const formerly = [
      'PayLink', 'ReservationWidget', 'StockTransfer', 'CashMovement',
      'EInvoiceOutbox', 'HaccpAction', 'ManagerCall', 'PrepLabel',
      'LabelShelfRule', 'PayrollPeriod', 'PayrollExport', 'StationTask',
      'MenuItemStation', 'StockTransferItem', 'GuestConsent', 'Campaign',
      'CampaignSend',
    ]
    expect(formerly).toHaveLength(17)
    for (const t of formerly) expect(migrationTables).toContain(t)
  })

  test('baseline je zgolj kreacija — nobenega DROP stavka', () => {
    expect(MIGRATION).not.toMatch(/DROP\s+TABLE/i)
    expect(MIGRATION).not.toMatch(/DROP\s+COLUMN/i)
  })

  test('glava migracije pojasni squash in korak migrate resolve', () => {
    const header = MIGRATION.slice(0, 3000)
    expect(header).toMatch(/squashed baseline/i)
    expect(header).toContain('bunx prisma migrate resolve --applied 00000000000000_init')
  })

  test('SQLite zrcalo pokriva isto množico modelov', () => {
    expect([...sqliteModels].sort()).toEqual([...prodModels].sort())
  })
})

describe('№17 — drift allowlist in blokatorska pot', () => {
  test('allowlist ima 24 edinstvenih vnosov in vsak navaja admin DDL ruto', () => {
    expect(KNOWN_DRIFTS).toHaveLength(24)
    expect(new Set(KNOWN_DRIFTS.map((k) => k.id)).size).toBe(24)
    for (const k of KNOWN_DRIFTS) expect(k.reason).toContain('/api/admin/migrate-')
  })

  test('znan drift (issue-13) je dovoljen, neznan stavek pa blokator', () => {
    const known = classifyDrift(
      'ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL;',
    )
    expect(known.known.map((k) => k.id)).toContain('issue-13')
    expect(known.unexpected).toEqual([])

    const unknown = classifyDrift('ALTER TABLE "Users" ADD COLUMN "backdoor" TEXT;')
    expect(unknown.known).toEqual([])
    expect(unknown.unexpected).toHaveLength(1)
  })

  test('vir vrača exit 1 za nepričakovan drift in za infra napako', () => {
    expect(DRIFT_SRC).toContain("annotation('error'")
    expect(DRIFT_SRC).toMatch(/if \(cls\.unexpected\.length > 0\) return 1/)
    expect(DRIFT_SRC).toMatch(/if \(diff\.status === 1\)[\s\S]{0,500}?return 1/)
  })

  test('db:push cilja izključno na SQLite shemo; CI ne uporablja --accept-data-loss', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['db:push']).toContain('--schema prisma/schema.sqlite.prisma')
    const ci = read('.github/workflows/ci.yml')
    const gitlab = read('.gitlab-ci.yml')
    for (const text of [ci, gitlab]) {
      expect(text).toContain('prisma db push --schema prisma/schema.sqlite.prisma')
      expect(text).not.toContain('--accept-data-loss')
    }
  })
})

/* ═══════════════════════════ №19 — Caddy SSRF ═══════════════════════════ */

describe('№19 — Caddy ne dovoli izbire ciljnih vrat', () => {
  // Komentarji v Caddyfilu dokumentirajo staro ranljivost (`{query.XTransformPort}`),
  // zato se vse trditve berejo iz AKTIVNE konfiguracije — komentar ne more
  // preusmeriti prometa in ne sme niti ujeti niti sprostiti testa.
  const CADDY_ACTIVE = CADDY.split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')

  test('noben cilj reverse_proxy ne vsebuje interpolacije', () => {
    expect(CADDY_ACTIVE).not.toContain('{query.')
    const targets = [...CADDY_ACTIVE.matchAll(/^\s*reverse_proxy\s+(\S+)/gm)].map((m) => m[1])
    expect(targets).toHaveLength(2)
    for (const t of targets) expect(t).toMatch(/^http:\/\/localhost:\d+$/)
  })

  test('dovoljena sta natanko dva porta: 3031 (print-agent) in 3000 (aplikacija)', () => {
    const ports = [...CADDY_ACTIVE.matchAll(/localhost:(\d+)/g)].map((m) => m[1])
    expect([...new Set(ports)].sort()).toEqual(['3000', '3031'])
    expect(CADDY_ACTIVE).toMatch(/^\s*query XTransformPort=3031$/m)
  })

  test('X-Forwarded-For se nastavi na dejanski oddaljeni naslov', () => {
    const xff = [...CADDY_ACTIVE.matchAll(/^\s*header_up X-Forwarded-For\s+(\S+)$/gm)].map(
      (m) => m[1],
    )
    expect(xff).toEqual(['{remote_host}', '{remote_host}'])
  })

  test('port 3031 v Caddyfilu ustreza edini uporabi transform poti v kodi', () => {
    const used = [...read('src/lib/devices/print.ts').matchAll(/XTransformPort=(\d+)/g)].map(
      (m) => m[1],
    )
    expect([...new Set(used)]).toEqual(['3031'])
  })
})

/* ═══════════════════════════ №20 — PIN v dokumentaciji ═══════════════════════════ */

function secretProbe(files: Record<string, string>): { status: number; out: string } {
  const dir = mkTmp('secrets')
  for (const d of ['scripts', 'src', 'mini-services', '.github', 'docs']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, 'scripts/check-secrets.sh'), SECRETS_SH)
  writeFileSync(join(dir, '.gitlab-ci.yml'), '')
  writeFileSync(join(dir, 'README.md'), '# temp fixture\n')
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c)
  const r = spawnSync('bash', ['scripts/check-secrets.sh'], { cwd: dir, encoding: 'utf8' })
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('№20 — scanner pokrije Markdown in 6-mestni PIN', () => {
  test('check-secrets.sh skenira .md (koren + docs), GitHub PAT in PIN', () => {
    expect(SECRETS_SH).toContain("--include='*.md'")
    expect(SECRETS_SH).toContain('docs/')
    expect(SECRETS_SH).toContain('github_pat_')
    expect(SECRETS_SH).toContain('PIN')
  })

  test('čisto temp drevo je zeleno', () => {
    expect(secretProbe({}).status).toBe(0)
  })

  test('PIN v docs/*.md in v korenskem *.md povzroči exit 1 z imenom datoteke', () => {
    const a = secretProbe({ 'docs/probe.md': 'demo PIN 123456\n' })
    expect(a.status).toBe(1)
    expect(a.out).toContain('docs/probe.md')
    const b = secretProbe({ 'PROBE.md': 'PIN: 654321\n' })
    expect(b.status).toBe(1)
    expect(b.out).toContain('PROBE.md')
  })

  test('4-mestni razvojni PIN ostane dovoljen (brez lažnega alarma)', () => {
    expect(secretProbe({ 'docs/probe.md': 'dev PIN 4567\n' }).status).toBe(0)
  })

  test('GitHub PAT (klasični in fine-grained) v Markdownu povzroči exit 1', () => {
    expect(secretProbe({ 'docs/notes.md': `token ghp_${'a'.repeat(36)}\n` }).status).toBe(1)
    expect(secretProbe({ 'docs/notes.md': `token github_pat_${'b'.repeat(30)}\n` }).status).toBe(1)
  })

  test('v repozitoriju ni več živih PIN-ov, oznaka redakcije pa je prisotna', () => {
    const mdFiles: string[] = []
    for (const name of readdirSync(ROOT)) {
      if (name.endsWith('.md') && statSync(join(ROOT, name)).isFile()) {
        mdFiles.push(join(ROOT, name))
      }
    }
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(p)
        } else if (entry.name.endsWith('.md')) {
          mdFiles.push(p)
        }
      }
    }
    walk(join(ROOT, 'docs'))

    const pin = /\bPIN\s*[:=]?\s*\d{6}\b/
    const hits = mdFiles
      .filter((f) => pin.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
    expect(hits).toEqual([])

    expect(read('DEPLOYMENT-STATUS.md')).toContain('[PIN ODSTRANJEN')
    expect(read('worklog.md')).toContain('[PIN ODSTRANJEN')
  })
})
