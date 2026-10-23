/**
 * v1.161.0 — dnevni cron: marker (lastRunDate) se zapiše SAMO ob uspehu.
 *
 * Najdba: koraki so izolirani v try/catch in napake samo zbirajo v `errors`, na
 * koncu pa se je marker zapisal vedno — tudi ko je korak padel. Posledica:
 * istodnevna ponovitev je no-op (200 already_ran_today), dead-man monitoring pa
 * vidi svež marker in lažno poroča uspeh.
 *
 * v1.171.0 — napaka koraka se NÃO več povzroča z `mock.module`. Bunjevo
 * `mock.module` zamenja modul v registru ZA CELOTEN proces: `mock.restore()` in
 * ročna vrnitev pravega izvoza NE pomine kaj, ker ima že zamenjani modul svojo
 * ponovno ovrednoteno notranjost (med drugim lastnijo `db`). Merjeno: kasnejša
 * datoteka je klicala PRAVO funkcijo (ime identično), a je njen `findMany`
 * vrnil 0 vrstic ob 7 ujemajočih se povezavah — torej druga vezava na bazo.
 * Tako je CI (bun datotek NE sortira abecedno: v161 = 10., v157 = 42.) priobčil
 * dua padca uskladitve, lokalno abecedni vrstni red pa je napako skrival.
 *
 * Zdaj korak pade po RESNI produkcijski poti: v bazi je odprta plačilna povezava
 * s Stripe sejo, ki na Stripeu ne obstaja, `STRIPE_SECRET_KEY` pa je nastavljen.
 * Dojemljivi znesek ali nedosegljiv Stripe — oboje vrne napako → `paylinks:` v
 * `errors` → dan ostane nezasklenjen. `createdAt` je ZASTARJEN (ena leto), da je
 * vrstica zagotovo v pridovanem oknu 20 najstarejših ne glede na to, koliko
 * povezav so ustvarile druge datoteke — test je torej neodvisen od vrstnega reda.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { CRON_DAILY_MARKER, localDateKey } from '../src/lib/cron-daily'
import { GET as cronGET } from '../src/app/api/cron/daily/route'

const P = 'v161-'
const LINK_ID = `${P}link`
const ORDER_ID = `${P}order`
const LOC_ID = `${P}loc`

let savedSecret: string | undefined
let savedStripeKey: string | undefined
let savedMarker: { id: string; name: string; type: string; provider: string; config: unknown; isActive: boolean; syncEnabled: boolean; locationId: string | null } | null = null

const todayKey = (): string => localDateKey(new Date())

/** Odprta povezava s sejo, ki je na Stripeu ni → korak paylinks ZAGOTOVENO pade. */
async function zastaviNedosegljivoPovezavo(): Promise<void> {
  const obstojeca = await db.location.findFirst({ where: { id: LOC_ID }, select: { id: true } })
  if (!obstojeca) {
    await db.location.create({
      data: {
        id: LOC_ID, name: `${P} lokacija`, code: `${P}code`, premisesId: `${P}BLG`,
        taxId: 'SI12345678', registerNumber: 'BLG-V161-01', fursEnvironment: 'simulation', country: 'SI',
      },
    })
  }
  await db.order.create({ data: { id: ORDER_ID, orderNumber: 961001, locationId: LOC_ID, status: 'fired', paymentStatus: 'unpaid' } })
  await db.payLink.create({
    data: {
      id: LINK_ID, token: `${P}token`, orderId: ORDER_ID, locationId: LOC_ID,
      amount: 9.99, sessionId: 'cs_v161_nedosegljiva_seja', status: 'open',
      createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    },
  })
}

async function pocistiPovezavo(): Promise<void> {
  await db.payLink.deleteMany({ where: { id: LINK_ID } })
  await db.order.deleteMany({ where: { id: ORDER_ID } })
}

function req(): NextRequest {
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
  savedStripeKey = process.env.STRIPE_SECRET_KEY
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

// Vsak tek se začne brez markerja in brez Stripe konfiguracije → paylinks korak
// je simulator no-op (skipped, ne errors) in uspešen tek res nieme napak.
beforeEach(async () => {
  delete process.env.STRIPE_SECRET_KEY
  await clearMarker()
  await pocistiPovezavo()
})

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY
  await clearMarker()
  await pocistiPovezavo()
  if (savedMarker) await db.integration.create({ data: savedMarker })
  if (savedSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedSecret
  if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = savedStripeKey
})

describe('v1.161.0 — cron marker', () => {
  test('padel korak → marker se NE zapiše (dan ni zaklenjen), napaka je v odgovoru', async () => {
    await zastaviNedosegljivoPovezavo()
    process.env.STRIPE_SECRET_KEY = 'sk_test_v161_nedosegljiv'
    try {
      const res = await cronGET(req())
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ran: boolean; errors?: string[] }
      expect(body.ran).toBe(true)
      expect((body.errors || []).some((e) => e.startsWith('paylinks:'))).toBe(true)

      const row = await marker()
      expect(row?.config?.lastRunDate).not.toBe(todayKey())
      expect(row).toBeNull()
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      await pocistiPovezavo()
    }
  })

  test('uspešen tek → marker se zapiše z današnjim datumom', async () => {
    const res = await cronGET(req())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ran: boolean; errors?: string[] }
    expect(body.errors || []).toEqual([])

    const row = await marker()
    expect(row?.config?.lastRunDate).toBe(todayKey())
  })

  test('po uspešnem teku je istodnevna ponovitev no-op (guard ostane)', async () => {
    const first = (await (await cronGET(req())).json()) as { ran: boolean }
    expect(first.ran).toBe(true)
    const second = (await (await cronGET(req())).json()) as { ran: boolean; reason?: string }
    expect(second.ran).toBe(false)
    expect(second.reason).toBe('already_ran_today')
  })
})
