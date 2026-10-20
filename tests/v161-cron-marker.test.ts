/**
 * v1.161.0 — dnevni cron: marker (lastRunDate) se zapiše SAMO ob uspehu.
 *
 * Najdba: koraki so izolirani v try/catch in napake samo zbirajo v `errors`, na
 * koncu pa se je marker zapisal vedno — tudi ko je korak padel. Posledica:
 * istodnevna ponovitev je no-op (200 already_ran_today), dead-man monitoring pa
 * vidi svež marker in lažno poroča uspeh.
 *
 * Test nadzoruje zadnji korak (reconcile plačilnih povezav) z mock modulom, ker
 * je to edini deterministični način, da v testu povzročimo napako koraka brez
 * kvara baze. Vsi ostali koraki tečejo nad realno SQLite bazo.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { CRON_DAILY_MARKER, localDateKey } from '../src/lib/cron-daily'

const P = 'v161-'

let failReconcile = false
mock.module('@/lib/paylink/reconcile', () => ({
  reconcilePaidStripeSessions: async () => {
    if (failReconcile) throw new Error('v161 paylinks fail')
    return { scanned: 0, settled: 0, replayed: 0, skipped: 0, errors: 0, review: 0 }
  },
}))

const { GET: cronGET } = await import('../src/app/api/cron/daily/route')

let savedSecret: string | undefined
let savedMarker: { id: string; name: string; type: string; provider: string; config: unknown; isActive: boolean; syncEnabled: boolean; locationId: string | null } | null = null

const todayKey = (): string => localDateKey(new Date())

function cronReq(): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/daily', {
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  })
}

async function marker(): Promise<{ config: { lastRunDate?: string; lastRunAt?: string } } | null> {
  const row = await db.integration.findFirst({
    where: { name: CRON_DAILY_MARKER, type: 'other' },
    select: { config: true },
  })
  if (!row) return null
  const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
  return { config: config as { lastRunDate?: string; lastRunAt?: string } }
}

async function clearMarker(): Promise<void> {
  await db.integration.deleteMany({ where: { name: CRON_DAILY_MARKER, type: 'other' } })
}

beforeAll(async () => {
  savedSecret = process.env.CRON_SECRET
  process.env.CRON_SECRET = `${P}secret-${Date.now().toString(36)}`
  const existing = await db.integration.findFirst({ where: { name: CRON_DAILY_MARKER, type: 'other' } })
  if (existing) {
    savedMarker = {
      id: existing.id, name: existing.name, type: existing.type, provider: existing.provider,
      config: existing.config, isActive: existing.isActive, syncEnabled: existing.syncEnabled, locationId: existing.locationId,
    }
  }
  await clearMarker()
})

beforeEach(async () => {
  failReconcile = false
  await clearMarker()
})

afterAll(async () => {
  await clearMarker()
  if (savedMarker) await db.integration.create({ data: savedMarker })
  if (savedSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedSecret
  mock.restore()
})

describe('v1.161.0 — cron marker', () => {
  test('padel korak → marker se NE zapiše (dan ni zaklenjen), napaka je v odgovoru', async () => {
    failReconcile = true
    const res = await cronGET(cronReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ran: boolean; errors?: string[] }
    expect(body.ran).toBe(true)
    expect((body.errors || []).some((e) => e.startsWith('paylinks:'))).toBe(true)

    const row = await marker()
    expect(row?.config?.lastRunDate).not.toBe(todayKey())
    expect(row).toBeNull()
  })

  test('uspešen tek → marker se zapiše z današnjim datumom', async () => {
    const res = await cronGET(cronReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ran: boolean; errors?: string[] }
    expect(body.errors || []).toEqual([])

    const row = await marker()
    expect(row?.config?.lastRunDate).toBe(todayKey())
  })

  test('po uspešnem teku je istodnevna ponovitev no-op (guard ostane)', async () => {
    const first = (await (await cronGET(cronReq())).json()) as { ran: boolean }
    expect(first.ran).toBe(true)
    const second = (await (await cronGET(cronReq())).json()) as { ran: boolean; reason?: string }
    expect(second.ran).toBe(false)
    expect(second.reason).toBe('already_ran_today')
  })
})
