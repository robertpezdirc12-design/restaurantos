/**
 * OSS-9 (v1.202.0) — EAN / ČRTNE KODE PRI NABAVI
 * (docs/GAP-ANALIZA-odprtokodna-konkurenca.md — kandidat OSS-9, izvor OrderRestro
 * planned; skener = tipkovnica — deterministično, 0 AI, 0 novih odvisnosti).
 *
 * Merila:
 *  Č1 čisti sloj ean.ts (PURE, 0 DB): normalizeEan (trim + vse presledke ven +
 *     uppercase; prazno ostane prazno), validateEanFormat (prazno OK; 3–48;
 *     [0-9A-Z_-]; napake too_short/too_long/bad_chars), gs1CheckDigit (mod-10
 *     GS1: znani primeri EAN-13 4006381333931 / EAN-8 73513537 / UPC-A
 *     036000291452; neštevilčno → null), classifyEan (ean13/ean8/upca/code,
 *     checkValid boolean ali null).
 *  Č2 backend /api/inventory:
 *     - 401 brez žetona (GET/POST/PATCH), 403 za waiterja (brez inventory.manage);
 *     - POST z EAN → 201; normalizacija vnosa (lowercase + presledki → uppercase);
 *     - GET nosi ean za VSE vloge (operativen podatek — ni cena);
 *     - duplikat EAN → 409 z imenom obstoječega artikla (aplikačni sloj —
 *       delni unique indeks bi lomil baseline 1:1 konvencijo);
 *     - neveljavna oblika → 400 (prekratek / predolg / slabi znaki);
 *     - PATCH ean → 200 + round-trip; duplikat → 409; self z ISTO kodo → 200
 *       (izključi self); PATCH brez ean polja eana NE spremeni; ean:'' počisti;
 *     - audit: INVENTORY_CREATE/ADJUST details vsebujeta ean.
 *  Č3 DDL ruta /api/admin/migrate-inventory-ean: 401 brez žetona, 403 za
 *     managerja (requireCentralRole), 200 za admina (na SQLite stolpec že prek
 *     db push → skipped + alreadyApplied; audit SCHEMA_MIGRATION_INVENTORY_EAN);
 *     SCHEMA_MIGRATIONS 35 + vnos inventory-ean; drift allowlist 27 —
 *     isInventoryEanStatement je dvosmerno STROG (ADD/DROP "ean" na
 *     "InventoryItem"; alergenski stolpci in kombiniran ALTER ostanejo zunaj).
 *  Č4 registri + UI statika + i18n + verzija: model v OBEH shemah, baseline
 *     migracija, i18n pariteta 11 novih ključev (SL/HR), zaloga-tab (polje
 *     ni-ean, mini dialog, ScanLine, iskalnik po EAN), nabava-tab (sken polje
 *     nb-recv-scan, Enter → handleRecvScan, data-scan-hit highlight, fokus na
 *     nb-recv-accept-*), verzija pin 1.202.0.
 *
 * Fiksture s predpono v202ean-; po teku testa so InventoryItem/Location/Employee/
 * AuditLog v vhodnem stanju (COUNT fiksturnih kod = 0).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  classifyEan,
  EAN_MAX_LEN,
  EAN_MIN_LEN,
  gs1CheckDigit,
  normalizeEan,
  validateEanFormat,
} from '../src/lib/ean'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { classifyDrift, isInventoryEanStatement, KNOWN_DRIFTS } from '../scripts/drift-check'
import { GET as inventoryGET, POST as inventoryPOST, PATCH as inventoryPATCH } from '../src/app/api/inventory/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-inventory-ean/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v202ean-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TZ = 'Europe/Ljubljana'

/** GS1 referenčne kode (kontrolni modul-10 izračunan po src/lib/ean.ts):
 *  383890000001 → check 4; 7351353 → check 7. Fiksne, deterministične. */
const EAN_A = '3838900000014' // EAN-13 (SI predpona 383)
const EAN_B = '73513537' // EAN-8
const CODE_A = 'ABC-123' // interna dobaviteljeva koda (alphanumeric)

let locA = ''
let mgr = ''
let waiter = ''
let admin = ''
let mgrTok = ''
let waiterTok = ''
let adminTok = ''

function req(method: string, url: string, token: string | null, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

/** Fiksturni filter: vsi artikli, ki jih ustvari TA suite — po lokaciji,
 * nazivu (POST dodeli nid(), ne fiksturnega id) in fikturnih kodah. */
const fixtureInvWhere = {
  OR: [
    { locationId: { startsWith: P } },
    { name: { startsWith: P } },
    { ean: { in: [EAN_A, EAN_B, CODE_A, 'DEF-456'] } },
  ],
}

async function cleanup() {
  // 1. FK večni vrstni red: opening-balance StockTransaction (POST z qty>0)
  //    in inventurne variance (PATCH delta) prvo vežejo artikel — brez tega
  //    deleteMany pade z "Foreign key constraint violated" in fiksture puščajo
  //    ostalke (dokazano: naslednji run → POST dup 409).
  await db.stockTransaction.deleteMany({ where: { InventoryItem: fixtureInvWhere } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: fixtureInvWhere }).catch(() => null)
  await db.auditLog
    .deleteMany({
      where: {
        OR: [
          { locationId: { startsWith: P } },
          { entityId: { startsWith: P } },
          { action: { in: ['INVENTORY_CREATE', 'INVENTORY_ADJUST', 'SCHEMA_MIGRATION_INVENTORY_EAN'] } },
        ],
      },
    })
    .catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()

  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Celje`, code: `W22A-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locA = la.id

  const seed = async (key: string, name: string, role: string, seq: number): Promise<string> => {
    const id = `${P}${key}-${RUN}`
    const f = employeePinFields(`${PIN_BASE}${seq}`, `${id}@test.local`)
    await db.employee.create({
      data: { id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: locA, pin: f.pin, pinLookup: f.pinLookup },
    })
    return id
  }
  mgr = await seed('mgr', `${P}Vodja Vida`, 'manager', 1)
  waiter = await seed('waiter', `${P}Natakar Nace`, 'waiter', 2)
  admin = await seed('admin', `${P}Admin Alja`, 'admin', 3)
  mgrTok = createToken({ sub: mgr, name: `${P}Vodja Vida`, role: 'MANAGER', loc: locA, sv: 0 })
  waiterTok = createToken({ sub: waiter, name: `${P}Natakar Nace`, role: 'WAITER', loc: locA, sv: 0 })
  adminTok = createToken({ sub: admin, name: `${P}Admin Alja`, role: 'ADMIN', loc: locA, sv: 0 })
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ Č1. ČISTI SLOJ (ean.ts) ═══════════════════ */

describe('Č1 čisti sloj EAN (pure)', () => {
  it('normalizeEan: trim + vse presledke ven + uppercase; prazno ostane prazno', () => {
    expect(normalizeEan('  383 8900 0000 16 ')).toBe('3838900000016')
    expect(normalizeEan('abc-123')).toBe('ABC-123')
    expect(normalizeEan('\t ABC-123 \n')).toBe('ABC-123')
    expect(normalizeEan('')).toBe('')
    expect(normalizeEan('   ')).toBe('')
    expect(normalizeEan(undefined as unknown as string)).toBe('')
  })

  it('validateEanFormat: prazno OK, 3–48, [0-9A-Z_-], tri vrste napak', () => {
    expect(validateEanFormat('')).toEqual({ ok: true })
    expect(validateEanFormat(EAN_A)).toEqual({ ok: true })
    expect(validateEanFormat('AB-1')).toEqual({ ok: true })
    expect(validateEanFormat('AB')).toEqual({ ok: false, error: 'too_short' })
    expect(validateEanFormat('x'.repeat(EAN_MAX_LEN + 1))).toEqual({ ok: false, error: 'too_long' })
    expect(validateEanFormat('AB 1')).toEqual({ ok: false, error: 'bad_chars' })
    expect(validateEanFormat('AB*1')).toEqual({ ok: false, error: 'bad_chars' })
    expect(EAN_MIN_LEN).toBe(3)
    expect(EAN_MAX_LEN).toBe(48)
  })

  it('gs1CheckDigit: mod-10 GS1 — znani primeri EAN-13/EAN-8/UPC-A; neštevilčno null', () => {
    expect(gs1CheckDigit('383890000001')).toBe(4)
    expect(gs1CheckDigit('7351353')).toBe(7)
    expect(gs1CheckDigit('03600029145')).toBe(2)
    expect(gs1CheckDigit('4006381333931')).not.toBeNull()
    expect(gs1CheckDigit('ABC')).toBeNull()
    expect(gs1CheckDigit('')).toBeNull()
    expect(gs1CheckDigit('4')).toBeNull()
  })

  it('classifyEan: ean13/ean8/upca z checkValid, interne kode code/null', () => {
    expect(classifyEan(EAN_A)).toEqual({ kind: 'ean13', checkValid: true })
    expect(classifyEan(EAN_B)).toEqual({ kind: 'ean8', checkValid: true })
    expect(classifyEan('036000291452')).toEqual({ kind: 'upca', checkValid: true })
    // zamenjana kontrolna številka → checkValid false (shranimo, UI opozori)
    expect(classifyEan('3838900000015')).toEqual({ kind: 'ean13', checkValid: false })
    expect(classifyEan('ABC-123')).toEqual({ kind: 'code', checkValid: null })
  })
})

/* ═══════════════════ Č2. BACKEND (/api/inventory) ═══════════════════ */

describe('Č2 backend EAN (/api/inventory)', () => {
  it('401 brez žetona (GET/POST/PATCH)', async () => {
    expect((await inventoryGET(req('GET', '/api/inventory', null))).status).toBe(401)
    expect((await inventoryPOST(req('POST', '/api/inventory', null, { name: 'x' }))).status).toBe(401)
    expect((await inventoryPATCH(req('PATCH', '/api/inventory', null, { id: 'x' }))).status).toBe(401)
  })

  it('POST: EAN se shrani + normalizira (lowercase, presledki) + audit nosi ean', async () => {
    const r = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}Kava A`, unit: 'kg', qty: '2', minQty: '1', cost: '12.5', ean: `  ${EAN_A.toLowerCase().replace(/(\d{6})(\d{6})(\d)/, '$1 $2 $3')} ` }))
    expect(r.status).toBe(201)
    const b = await body(r)
    const created = await db.inventoryItem.findUnique({ where: { id: String(b.item?.id) } })
    expect(created?.ean).toBe(EAN_A)
    const audit = await db.auditLog.findFirst({ where: { action: 'INVENTORY_CREATE', entityId: String(b.item?.id) } })
    expect(audit).not.toBeNull()
    expect(audit?.details).toContain(EAN_A)
  })

  it('GET: ean viden vsem vlogam (operativen podatek — ni cena)', async () => {
    const waiterRes = await inventoryGET(req('GET', '/api/inventory', waiterTok))
    expect(waiterRes.status).toBe(200)
    const wb = await body(waiterRes)
    const rowsW = (wb.inventory as { ean?: string; cost: number }[]) ?? []
    expect(rowsW.some((x) => x.ean === EAN_A)).toBe(true)
    // waiter (brez reports.sales/inventory.manage) ne vidi cost, ampak vidi ean
    expect(rowsW.find((x) => x.ean === EAN_A)?.cost).toBe(0)
  })

  it('POST: duplikat EAN → 409 z imenom obstoječega artikla', async () => {
    const r = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}Kava dup`, unit: 'kg', ean: EAN_A }))
    expect(r.status).toBe(409)
    const b = await body(r)
    expect(String(b.error)).toContain(EAN_A)
    expect(String(b.error)).toContain(`${P}Kava A`)
  })

  it('POST: neveljavna oblika → 400 (prekratek / predolg / slabi znaki)', async () => {
    const s1 = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}x1`, ean: 'AB' }))
    expect(s1.status).toBe(400)
    const s2 = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}x2`, ean: 'x'.repeat(49) }))
    expect(s2.status).toBe(400)
    const s3 = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}x3`, ean: 'AB CD*' }))
    expect(s3.status).toBe(400)
  })

  it('POST brez EAN → 201 (prazno = artikel brez kode)', async () => {
    const r = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}Brez kode`, unit: 'pcs' }))
    expect(r.status).toBe(201)
    const b = await body(r)
    const created = await db.inventoryItem.findUnique({ where: { id: String(b.item?.id) } })
    expect(created?.ean).toBe('')
  })

  it('PATCH: EAN round-trip; duplikat → 409; self z ISTO kodo → 200; ean:"" počisti; brez polja ne spreminja', async () => {
    const create = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}Cukor B`, unit: 'kg', ean: EAN_B }))
    expect(create.status).toBe(201)
    const cb = await body(create)
    const itemId = String(cb.item?.id)
    const other = await inventoryPOST(req('POST', '/api/inventory', mgrTok, { name: `${P}So C`, unit: 'kg', ean: 'ABC-123' }))
    expect(other.status).toBe(201)
    const ob = await body(other)
    const otherId = String(ob.item?.id)

    // round-trip: spremeni na interno kodo
    const up = await inventoryPATCH(req('PATCH', '/api/inventory', mgrTok, { id: itemId, ean: 'abc-123' }))
    expect(up.status).toBe(409) // ABC-123 že ima ${P}So C — duplikat

    const free = await inventoryPATCH(req('PATCH', '/api/inventory', mgrTok, { id: itemId, ean: 'DEF-456' }))
    expect(free.status).toBe(200)
    expect((await db.inventoryItem.findUnique({ where: { id: itemId } }))?.ean).toBe('DEF-456')

    // self z ISTO kodo → 200 (izključi self)
    const self = await inventoryPATCH(req('PATCH', '/api/inventory', mgrTok, { id: itemId, ean: 'DEF-456' }))
    expect(self.status).toBe(200)

    // brez ean polja → ean ostane
    const noEan = await inventoryPATCH(req('PATCH', '/api/inventory', mgrTok, { id: itemId, delta: 1 }))
    expect(noEan.status).toBe(200)
    expect((await db.inventoryItem.findUnique({ where: { id: itemId } }))?.ean).toBe('DEF-456')

    // ean:'' → počisti
    const clear = await inventoryPATCH(req('PATCH', '/api/inventory', mgrTok, { id: itemId, ean: '' }))
    expect(clear.status).toBe(200)
    expect((await db.inventoryItem.findUnique({ where: { id: itemId } }))?.ean).toBe('')
  })

  it('403: waiter brez inventory.manage ne ustvarja artiklov', async () => {
    const r = await inventoryPOST(req('POST', '/api/inventory', waiterTok, { name: `${P}Nace`, ean: EAN_A }))
    expect(r.status).toBe(403)
  })
})

/* ═══════════════════ Č3. DDL RUTA + REGISTRI ═══════════════════ */

describe('Č3 DDL ruta migrate-inventory-ean + registri', () => {
  it('SCHEMA_MIGRATIONS: 36 vnosov, documents na koncu; inventory-ean ostane (endpoint + probe)', async () => {
    expect(SCHEMA_MIGRATIONS.length).toBe(36)
    const last = SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]
    expect(last.id).toBe('documents') // v1.203.0: +documents (OSS-2) — inventory-ean zdaj predzadnji
    const ean = SCHEMA_MIGRATIONS.find((x) => x.id === 'inventory-ean')
    expect(ean).toBeDefined()
    expect(ean?.endpoint).toBe('/api/admin/migrate-inventory-ean')
    expect(ean?.descKey).toBe('mig.inventoryEan.desc')
    // probe: stolpec obstaja (db push) → true
    expect(await ean?.probe()).toBe(true)
  })

  it('migrate POST: 401 brez žetona, 403 manager, 200 admin (skipped + alreadyApplied) + audit', async () => {
    expect((await migratePOST(req('POST', '/api/admin/migrate-inventory-ean', null))).status).toBe(401)
    expect((await migratePOST(req('POST', '/api/admin/migrate-inventory-ean', mgrTok))).status).toBe(403)
    const r = await migratePOST(req('POST', '/api/admin/migrate-inventory-ean', adminTok))
    expect(r.status).toBe(200)
    const b = await body(r)
    // SQLite baza ima stolpec prek db push → idempotentna preverba ga preskoči
    expect(b.skipped).toEqual(['InventoryItem.ean'])
    expect(b.alreadyApplied).toBe(true)
    const audit = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_INVENTORY_EAN' } })
    expect(audit).not.toBeNull()
  })

  it('drift: isInventoryEanStatement dvosmerno STROG — allergens/kombiniran ostane zunaj', () => {
    expect(isInventoryEanStatement(`ALTER TABLE "InventoryItem" ADD COLUMN "ean" TEXT NOT NULL DEFAULT ''`)).toBe(true)
    expect(isInventoryEanStatement(`ALTER TABLE "InventoryItem" ADD COLUMN "ean" TEXT NOT NULL DEFAULT '';`)).toBe(true)
    expect(isInventoryEanStatement(`ALTER TABLE "InventoryItem" DROP COLUMN "ean"`)).toBe(true)
    // alergenski stolpci na ISTI tabeli se NE smejo ujeti
    expect(isInventoryEanStatement(`ALTER TABLE "InventoryItem" ADD COLUMN "allergens" TEXT NOT NULL DEFAULT '[]'`)).toBe(false)
    expect(isInventoryEanStatement(`ALTER TABLE "MenuItem" ADD COLUMN "ean" TEXT`)).toBe(false)
    // kombiniran ALTER z dodatnim stolpcem ostane unexpected
    expect(isInventoryEanStatement(`ALTER TABLE "InventoryItem" ADD COLUMN "ean" TEXT, ADD COLUMN "x" INT`)).toBe(false)
    expect(isInventoryEanStatement(`CREATE TABLE "InventoryItem" ("ean" TEXT)`)).toBe(false)
  })

  it('drift: classifyDrift uvrsti ADD COLUMN "ean" med KNOWN (inventory-ean); register 28', () => {
    expect(KNOWN_DRIFTS.length).toBe(28)
    expect(KNOWN_DRIFTS[KNOWN_DRIFTS.length - 1].id).toBe('documents') // v1.203.0: +documents (OSS-2)
    const c = classifyDrift(`ALTER TABLE "InventoryItem" ADD COLUMN "ean" TEXT NOT NULL DEFAULT '';`)
    expect(c.known.map((k) => k.id)).toEqual(['inventory-ean'])
    expect(c.unexpected.length).toBe(0)
  })
})

/* ═══════════════════ Č4. REGISTRI + UI STATIKA + i18n + VERZIJA ═══════════════════ */

describe('Č4 registri, UI statika, i18n, verzija', () => {
  it('shema: InventoryItem.ean v OBEH shemah + baseline migracija', () => {
    const pg = readFileSync('prisma/schema.prisma', 'utf8')
    const lite = readFileSync('prisma/schema.sqlite.prisma', 'utf8')
    const baseline = readFileSync('prisma/migrations/00000000000000_init/migration.sql', 'utf8')
    expect(pg).toMatch(/ean\s+String\s+@default\(""\)/)
    expect(lite).toMatch(/ean\s+String\s+@default\(""\)/)
    expect(baseline).toContain(`"ean" TEXT NOT NULL DEFAULT ''`)
    // baseline 1:1 — ean v CREATE TABLE "InventoryItem" (v redu za init repliko)
    const invBlock = baseline.slice(baseline.indexOf('CREATE TABLE "InventoryItem"'), baseline.indexOf('CREATE TABLE "Job"'))
    expect(invBlock).toContain('"ean" TEXT NOT NULL DEFAULT \'\'')
  })

  it('i18n: 11 novih ključev z pariteto SL/HR', () => {
    const keys = [
      'inv.ean', 'inv.eanPlaceholder', 'inv.eanHint', 'inv.eanCheckWarn',
      'inv.editEan', 'inv.editEanTitle',
      'proc.scanLabel', 'proc.scanPlaceholder', 'proc.scanNotFound', 'proc.scanFound',
      'mig.inventoryEan.desc',
    ]
    for (const k of keys) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
      expect(((sl as Record<string, string>)[k] || '').length).toBeGreaterThan(0)
      expect(((hr as Record<string, string>)[k] || '').length).toBeGreaterThan(0)
    }
  })

  it('UI zaloga-tab: polje EAN, mini dialog, ScanLine, iskalnik po EAN', () => {
    const src = readFileSync('src/components/tabs/zaloga-tab.tsx', 'utf8')
    expect(src).toContain("id=\"ni-ean\"")
    expect(src).toContain("id=\"ean-edit\"")
    expect(src).toContain("normalizeEan")
    expect(src).toContain("classifyEan")
    expect(src).toContain("ScanLine")
    expect(src).toContain("t('inv.ean')")
    expect(src).toContain("t('inv.editEan')")
    expect(src).toContain("t('inv.eanCheckWarn')")
    // iskalnik najde artikel tudi po EAN
    expect(src).toContain("(i.ean || '').toLowerCase().includes(q)")
  })

  it('UI nabava-tab: sken polje + Enter handler + highlight + fokus na količino', () => {
    const src = readFileSync('src/components/tabs/nabava-tab.tsx', 'utf8')
    expect(src).toContain("id=\"nb-recv-scan\"")
    expect(src).toContain("handleRecvScan")
    expect(src).toContain("e.key === 'Enter'")
    expect(src).toContain("data-scan-hit")
    expect(src).toContain('ring-emerald-500')
    expect(src).toContain('nb-recv-accept-${it.id}')
    expect(src).toContain("normalizeEan")
    expect(src).toContain("t('proc.scanNotFound'")
    expect(src).toContain("t('proc.scanFound'")
    // handler deterministično: EAN → invItems → PO vrstica z vezanim inventoryItemId
    expect(src).toContain("it.inventoryItemId && it.inventoryItemId === invId")
  })

  it('verzija: pin 1.212.0', () => {
    expect(APP_VERSION).toBe('1.214.0')
  })
})
