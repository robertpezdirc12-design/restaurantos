/**
 * AVTODODELITEV INTERNE POTI v1.252.0 (docs/PRIMERJAVA-VMESNIKOV-2026 §26 —
 * raziskava november 2026): samodejna dodelitev mize interni rezervaciji ob
 * ustvarjanju (Lightspeed maj 2026 »automatic table assignments« — rezervaciji
 * se miza dodeli samodejno; v1.231 = ročni gumb, v1.248 = samo javni widget).
 *
 *  Č1 — nalagalca autoassignPickForWindow (prava baza: mize/kombinacije/
 *       izključene walk-in mize/zasedena okna z DEJANSKIM trajanjem)
 *  Č2 — živa interna ruta POST /api/reservations (zlata pot, sočasnost v istem
 *       oknu, izčrpane mize → brez mize, izrecen izklop skipAutoAssign,
 *       izrecna izbira vedno zmaga, revizija RESERVATION_AUTOASSIGNED,
 *       pravice reservations.manage)
 *  Ž  — registri (verzija 1.257.0, compose, i18n 4093/4093 pariteta,
 *       dokumenta §26 + AUDIT števci, montaža kode, worklog pin)
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import {
  autoassignPickForWindow,
  TABLE_COMBOS_MARKER,
  RESV_BOOKABLE_MARKER,
} from '../src/lib/table-combos'
import { POST as resvPOST } from '../src/app/api/reservations/route'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v252-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(join(process.cwd(), p), 'utf8')
}

function req(method: string, url: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function jbody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

async function seedEmp(name: string, role: string, loc: string | null): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const email = `${P}${name}-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({
    data: { id, name: `${P}${name}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
  })
  return id
}

/* ── fiksture (skupne Č1 + Č2) ─────────────────────────────────────────── */

let locA = ''
let mgrAId = ''
let kitAId = ''
let tokMgr = ''
let tokKit = ''
// mize: t1 = 2 sedeža (IZKLJUČENA — walk-in rezerva), t2 = 4, t3 = 6, t4 = 8
let t1 = '', t2 = '', t3 = '', t4 = ''
// termini: dan + 7 (zlati tok B1–B5) in dan + 8 (B6/B8 — ločen dan, da
// kombinacijska okna ne sejejo z enojnimi iz zlatega toka)
let at1800 = new Date()
let at2000 = new Date()
let atD2_1800 = new Date()
let atD2_2030 = new Date()

beforeAll(async () => {
  locA = `${P}locA-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA${RUN}`, name: `${P}Lok A`, premisesId: `${P}premA-${RUN}` } })
  // urnik 10:00–22:00 vsak dan (interni varovalec izven ur ne uide)
  for (let dow = 0; dow < 7; dow++) {
    await db.openingHours.create({
      data: { id: `${P}oh-${RUN}-${dow}`, dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false, locationId: locA },
    })
  }
  // mize 2/4/6/8 sedežev
  const caps = [2, 4, 6, 8]
  const ids: string[] = []
  let n = 1
  for (const c of caps) {
    const id = `${P}tbl-${n}-${RUN}`
    await db.table.create({ data: { id, number: n, capacity: c, locationId: locA } })
    ids.push(id)
    n++
  }
  ;[t1, t2, t3, t4] = ids
  // registr kombinacije: t3 + t4 = 14 sedežev (za velike družbe)
  await db.integration.create({
    data: { id: `${P}int-combo-${RUN}`, name: TABLE_COMBOS_MARKER, type: 'other', provider: 'internal', isActive: true, syncEnabled: false, locationId: locA, config: JSON.stringify({ combos: [{ id: `${P}c34`, tableIds: [t3, t4] }] }) },
  })
  // walk-in rezerva: t1 (2 sedeža) NE sodeluje v avtododelitvi (v1.245 §19 B)
  await db.integration.create({
    data: { id: `${P}int-book-${RUN}`, name: RESV_BOOKABLE_MARKER, type: 'other', provider: 'internal', isActive: true, syncEnabled: false, locationId: locA, config: JSON.stringify({ excludedTableIds: [t1] }) },
  })
  // zaposleni: manager (reservations.manage) + kuhar (BREZ — 403 veja)
  mgrAId = await seedEmp('mgr', 'manager', locA)
  kitAId = await seedEmp('kit', 'kitchen', locA)
  tokMgr = createToken({ sub: mgrAId, name: `${P}mgr`, role: 'MANAGER', loc: locA, sv: 0 })
  tokKit = createToken({ sub: kitAId, name: `${P}kit`, role: 'KITCHEN', loc: locA, sv: 0 })
  // termini (lokalni čas stroja — isti TZ kot urnikov varovalec)
  const day = new Date(Date.now() + 7 * 24 * 3600_000)
  at1800 = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 18, 0, 0, 0)
  at2000 = new Date(at1800.getTime() + 120 * 60_000)
  const day2 = new Date(Date.now() + 8 * 24 * 3600_000)
  atD2_1800 = new Date(day2.getFullYear(), day2.getMonth(), day2.getDate(), 18, 0, 0, 0)
  atD2_2030 = new Date(day2.getFullYear(), day2.getMonth(), day2.getDate(), 20, 30, 0, 0)
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})

/* ═══════════════ Č1 — nalagalca autoassignPickForWindow ═══════════════ */

describe('v1.252.0 Č1 — nalagalca autoassignPickForWindow (prava baza)', () => {
  test('A1: najmanjša ustrezna miza (3 osebe → 4-miza t2; izključena 2-miza t1 ne pride v poštev)', async () => {
    const pick = await autoassignPickForWindow(db, locA, at1800, 120, 3)
    expect(pick).not.toBeNull()
    expect(pick!.tableIds).toEqual([t2])
    expect(pick!.seats).toBe(4)
    expect(pick!.label).toBe('Miza 2')
    expect(pick!.comboId).toBeNull()
  })

  test('A2: izključena miza NE sodeluje — ko je edina ustrezna zasedena/rezervirana, izbira pade na naslednjo', async () => {
    // t2 zasedena v oknu 18:00–20:00 → izbira za 2 osebi pade na t3 (6),
    // NE na izključeno t1 (2) — walk-in rezerva je nedotaknjena
    await db.reservation.create({
      data: { id: `${P}hold-t2-${RUN}`, customerName: `${P}drži t2`, dateTime: at1800, partySize: 4, duration: 120, tableId: t2, comboTableIds: '', status: 'confirmed', source: 'phone', locationId: locA },
    })
    try {
      const pick = await autoassignPickForWindow(db, locA, at1800, 120, 2)
      expect(pick).not.toBeNull()
      expect(pick!.tableIds).toEqual([t3])
    } finally {
      await db.reservation.delete({ where: { id: `${P}hold-t2-${RUN}` } })
    }
  })

  test('A3: kombinacija za veliko družbo (10 oseb > največja posamezna 8 → t3+t4 = 14)', async () => {
    const pick = await autoassignPickForWindow(db, locA, atD2_1800, 120, 10)
    expect(pick).not.toBeNull()
    expect(pick!.tableIds).toEqual([t3, t4])
    expect(pick!.seats).toBe(14)
    expect(pick!.label).toBe('Miza 3+4')
    expect(pick!.comboId).toBe(`${P}c34`)
  })

  test('A4: DEJANSKO trajanje interne poti — 90-minutna rezervacija 18:00 drži mizo do 19:30; nova 19:30 (sosednje okno) je PROSTA', async () => {
    await db.reservation.create({
      data: { id: `${P}hold-90-${RUN}`, customerName: `${P}90min`, dateTime: atD2_1800, partySize: 2, duration: 90, tableId: t2, comboTableIds: '', status: 'confirmed', source: 'phone', locationId: locA },
    })
    try {
      // 19:00 se prekriva z 18:00–19:30 → t2 zasedena
      const overlap = await autoassignPickForWindow(db, locA, new Date(atD2_1800.getTime() + 60 * 60_000), 60, 2)
      expect(overlap).not.toBeNull()
      expect(overlap!.tableIds).not.toContain(t2)
      // 19:30 = točno konec (strogo odprti intervali) → t2 spet prosta
      const at1930 = new Date(atD2_1800.getTime() + 90 * 60_000)
      const adjacent = await autoassignPickForWindow(db, locA, at1930, 60, 2)
      expect(adjacent).not.toBeNull()
      expect(adjacent!.tableIds).toEqual([t2])
    } finally {
      await db.reservation.delete({ where: { id: `${P}hold-90-${RUN}` } })
    }
  })

  test('A5: statusi — cancelled/no_show NE blokirata; seated/completed BLOKIRATA (isti nabor kot javna pot)', async () => {
    const at = atD2_1800 // dan 2, 18:00–19:00 okno (A3/A4 so počiščene)
    for (const [status, blocks] of [['cancelled', false], ['no_show', false], ['seated', true], ['completed', true]] as const) {
      const rid = `${P}st-${status}-${RUN}`
      await db.reservation.create({
        data: { id: rid, customerName: `${P}${status}`, dateTime: at, partySize: 2, duration: 60, tableId: t2, comboTableIds: '', status, source: 'phone', locationId: locA },
      })
      try {
        const pick = await autoassignPickForWindow(db, locA, at, 60, 2)
        if (blocks) {
          expect(pick).not.toBeNull()
          expect(pick!.tableIds).not.toContain(t2)
        } else {
          expect(pick).not.toBeNull()
          expect(pick!.tableIds).toEqual([t2]) // t2 je spet najmanjša ustrezna
        }
      } finally {
        await db.reservation.delete({ where: { id: rid } })
      }
    }
  })
})

/* ═══════════════ Č2 — živa interna ruta POST /api/reservations ═══════════════ */

describe('v1.252.0 Č2 — interna ruta: avtododelitev ob ustvarjanju (živa)', () => {
  test('B1: zlata pot — brez izbrane mize → NAJMANJŠA ustrezna (t2, ne izključena t1) + revizija', async () => {
    const res = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Ana Zlata`, reservedAt: at1800.toISOString(), guests: 3, phone: '+38640111222',
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect(j.autoAssignedTable).toBe('Miza 2')
    const r = (j.reservation as { tableId?: string | null; tableIds?: string[] })
    expect(r.tableId).toBe(t2)
    expect((r.tableIds ?? []).length).toBe(0) // enojna rezervacija — brez kombinacije
    // revizijska sled: kdor vidi mizo, vidi ZAKAJ (strežnik jo je izbral sam)
    const audit = await db.auditLog.findFirst({
      where: { action: 'RESERVATION_AUTOASSIGNED', entityId: r.id ?? '' },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    expect(audit!.details).toContain('Miza 2')
    expect(audit!.locationId).toBe(locA)
  })

  test('B2: druga rezervacija v ISTEM oknu dobi NASLEDNJO najmanjšo (t3) — sočasnost varna', async () => {
    const res = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Borut Drugi`, reservedAt: at1800.toISOString(), guests: 2,
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect(j.autoAssignedTable).toBe('Miza 3')
    expect((j.reservation as { tableId?: string | null }).tableId).toBe(t3)
  })

  test('B3: tretja dobi t4; četrta — vse mize in kombinacija zasedene → 201 BREZ mize (iskren null)', async () => {
    const r3 = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Cvetka Tretja`, reservedAt: at1800.toISOString(), guests: 2,
    }))
    expect(r3.status).toBe(201)
    const j3 = await jbody(r3)
    expect(j3.autoAssignedTable).toBe('Miza 4')
    // četrta: t2/t3/t4 posamično zasedene, kombinacija t3+t4 prav tako (članici) → null
    const r4 = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Denis Četrti`, reservedAt: at1800.toISOString(), guests: 2,
    }))
    expect(r4.status).toBe(201)
    const j4 = await jbody(r4)
    expect(j4.autoAssignedTable).toBeNull()
    expect((j4.reservation as { tableId?: string | null }).tableId).toBeNull()
    // in NI revizijskega zapisa za brez-mize odločitev (revizija samo ob dodelitvi)
    const audit = await db.auditLog.findFirst({
      where: { action: 'RESERVATION_AUTOASSIGNED', entityId: (j4.reservation as { id: string }).id },
    })
    expect(audit).toBeNull()
  })

  test('B4: izrecen izklop skipAutoAssign → 201 brez mize, kljub prostim mizam (20:00 okno je prosto)', async () => {
    const res = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Eva Izklop`, reservedAt: at2000.toISOString(), guests: 2, skipAutoAssign: true,
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect(j.autoAssignedTable).toBeNull()
    expect((j.reservation as { tableId?: string | null }).tableId).toBeNull()
  })

  test('B5: izrecna izbira VEDNO zmaga — tableId t4 brez avtododelitve (autoAssignedTable null)', async () => {
    const res = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Filip Izrecen`, reservedAt: at2000.toISOString(), guests: 6, tableId: t4,
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect(j.autoAssignedTable).toBeNull() // človeška izbira NI avtododelitev
    expect((j.reservation as { tableId?: string | null }).tableId).toBe(t4)
  })

  test('B6: izrecna kombinacija (tableIds) prav tako ne sproži avtododelitve (dan 2, 18:00 — vse prosto)', async () => {
    const res = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Greta Kombinacija`, reservedAt: atD2_1800.toISOString(), guests: 12, tableIds: [t3, t4],
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect(j.autoAssignedTable).toBeNull()
    const r = (j.reservation as { tableId?: string | null; tableIds?: string[] })
    expect(r.tableId).toBe(t3) // primarna = prva članica
    expect((r.tableIds ?? []).sort()).toEqual([t3, t4].sort())
  })

  test('B7: pravice — kuhar (BREZ reservations.manage) → 403', async () => {
    const res = await resvPOST(req('POST', '/api/reservations', tokKit, {
      guestName: `${P}Hana Kuhar`, reservedAt: at2000.toISOString(), guests: 2,
    }))
    expect(res.status).toBe(403)
  })

  test('B8: velika družba brez izbire → avtododelitev KOMBINACIJE (12 oseb → Miza 3+4; dan 2, 20:30 — sosednje za B6)', async () => {
    const res = await resvPOST(req('POST', '/api/reservations', tokMgr, {
      guestName: `${P}Ivan Družina`, reservedAt: atD2_2030.toISOString(), guests: 12,
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect(j.autoAssignedTable).toBe('Miza 3+4')
    const r = (j.reservation as { tableId?: string | null; tableIds?: string[] })
    expect(r.tableId).toBe(t3)
    expect((r.tableIds ?? []).sort()).toEqual([t3, t4].sort())
  })
})

/* ═══════════════ Ž — registri ═══════════════ */

describe('v1.252.0 Ž — registri', () => {
  const compose = read('deploy/docker-compose.yml')
  const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
  const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
  const wl = read('worklog.md')
  const routeSrc = read('src/app/api/reservations/route.ts')

  test('Ž1: verzija 1.257.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.269.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.269.0'")
    expect(compose).toContain('restaurantos:1.269.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+4 resv.autoServer*)', () => {
    expect(Object.keys(sl).length).toBe(4231)
    expect(Object.keys(hr).length).toBe(4231)
    for (const k of ['resv.autoServerOk', 'resv.autoServerNone', 'resv.autoServerToggle', 'resv.autoServerToggleHint']) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
  })

  test('Ž3: montaža — varovalo poti, revizija, odgovor; 0 DDL dokaz', () => {
    // avtododelitev SAMO ko ni izrecne izbire in ni izklopa
    expect(routeSrc).toContain('!body.tableId && comboIds.length < 2 && !body.skipAutoAssign')
    // nalagalca iz table-combos (ena resnica o izbiri z javno potjo)
    expect(routeSrc).toContain('autoassignPickForWindow(tx, locationId, when, duration')
    // revizijska sled ob dodelitvi
    expect(routeSrc).toContain('RESERVATION_AUTOASSIGNED')
    // aditivni odgovor
    expect(routeSrc).toContain('autoAssignedTable: autoPick ? autoPick.label : null')
    // 0 DDL: prisma shema brez novih stolpcev/modelov tega vala
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('skipAutoAssign')
    expect(schema).not.toContain('autoAssigned')
    // UI: potrditveno polje + izklop v telesu
    const ui = read('src/app/dashboard/page.tsx')
    expect(ui).toContain('res-auto-table')
    expect(ui).toContain('skipAutoAssign: true')
  })

  test('Ž4: dokumenta — PRIMERJAVA §26 + AUDIT števci', () => {
    expect(doc).toContain('## 26.')
    expect(doc).toContain('automatic table\nassignments')
    expect(auditDoc).toContain('v1.252.0')
    expect(auditDoc).toContain('- 4231 ključev SL in 4231 HR')
  })

  test('Ž5: worklog vrhnji vnos nosi Task ID v1.252.0-finalna-verifikacija', () => {
    expect(wl.slice(0, 400)).toContain('Task ID: v1.269.0-finalna-verifikacija')
  })
})
