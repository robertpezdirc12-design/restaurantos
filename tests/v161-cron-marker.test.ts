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
 * s Stripe sejo, ki na Stripeu ne obstaja, ponudnik pa je določen prek
 * LOKACIJSKO vezane Integration vrstice (type='payments', provider='stripe') —
 * NE prek `process.env.STRIPE_SECRET_KEY`. Zakaj: bun test poganje datoteke v
 * ENEM procesu, pet datotek pa upravlja isti env ključ (v157, v161, paylink-flow,
 * issue30-37, v156); vsak await med testovo nastavitvijo in branjem znotraj
 * cron teka je okno, v katerem tuja datoteka ključ izbriše → ponudnik padne na
 * simulator → korak `skipped`, brez napake → test lažno rdeč (izmerjeno 20. tek
 * suitea). Baza je za vsako datoteko skupna, vrstica z lastnim id-predponom pa
 * lastnina te datoteke. Env ključ, če ga tuja datoteka ravno nastavi, sicer
 * ZMAGA nad Integration vrstico — a tudi tedan ključ ne zna preveriti seje
 * `cs_v161_…`, torej korak VSEENO pade; oba svetova sta za ta test enaka.
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
const PAY_INTEGRATION_ID = `${P}payments`
const CRON_SECRET_VALUE = `${P}secret-${Date.now().toString(36)}`

let savedSecret: string | undefined
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
  // Ponudnik določimo z LOKACIJSKO vezano vrstico, ne z env (glej glavo):
  // resolvePayProvider ima env ključ PRED bazo, a tudi env ključ tuje datoteke
  // ne zmore preveriti te seje — korak pade v obeh svetovih.
  await db.integration.upsert({
    where: { id: PAY_INTEGRATION_ID },
    create: {
      id: PAY_INTEGRATION_ID, name: `${P}stripe`, type: 'payments', provider: 'stripe',
      isActive: true, syncEnabled: false, locationId: LOC_ID,
      config: JSON.stringify({ provider: 'stripe', secretKey: 'sk_test_v161_nedosegljiv' }),
    },
    update: { isActive: true, config: JSON.stringify({ provider: 'stripe', secretKey: 'sk_test_v161_nedosegljiv' }) },
  })
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
  await db.integration.deleteMany({ where: { id: PAY_INTEGRATION_ID } })
}

function req(): NextRequest {
  // Skrivnost se nastavi SINHRONO tik pred klicem: route jo bere v prvem stavku
  // handle → authorize (prek prvega awaita nič ne teče vmes), tako da tuja
  // datoteka ne more med nastavitvijo in branjem zamenjati env ključa.
  process.env.CRON_SECRET = CRON_SECRET_VALUE
  return new NextRequest('http://localhost:3000/api/cron/daily', {
    method: 'GET',
    headers: { authorization: `Bearer ${CRON_SECRET_VALUE}` },
  })
}

/**
 * Za čas `fn` je VSAK klic na api.stripe.com NAMENOMA neuspešen (omrežje dol).
 *
 * Zakaj je to potrebno, čeprav je `sk_test_v161_nedosegljiv` resnično neveljaven
 * ključ: tuje datoteke (issue30-37 #37) med svojimi testi zamenjajo
 * `globalThis.fetch` v ISTEM procesu; njihov stub vrne `Response('{}', 200)` za
 * VSE naslove. Naš reconcile, ki teče vzporedno, bi od stuba dobil `paid:false`
 * → `skipped` → korak brez napake → test lažno rdeč (izmerjeno). Z ovojem je
 * neuspeh DETERMINISTIČEN in neodvisen od tega, kaj tuje datoteke počnejo s
 * fetch-om: klical bo kateri koli ključ, napaka bo vedno padla v
 * `fetchStatus` catch → `summary.errors++` → `paylinks:` v `errors`. Klici na
 * druge naslove se prepustijo obstoječemu fetch-u (pravemu ali tujemu stubu —
 * ta cron tek v testnem okolju drugih klicev ne dela: brez SMTP in Upstash).
 * Ovoj se vedno povrne, tudi ob padcu `fn`.
 */
async function zNedosegljivimStripeom<T>(fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes('api.stripe.com')) throw new Error('v161: Stripe namenoma nedosegljiv')
    return orig(input as Parameters<typeof fetch>[0], undefined as never)
  }) as unknown as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = orig
  }
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
  const existing = await db.integration.findFirst({ where: { name: CRON_DAILY_MARKER, type: 'other' } })
  if (existing) {
    savedMarker = {
      id: existing.id, name: existing.name, type: existing.type, provider: existing.provider,
      config: existing.config, isActive: existing.isActive, syncEnabled: existing.syncEnabled, locationId: existing.locationId,
    }
  }
  await clearMarker()
})

// Vsak tek se začne brez markerja in brez plačilne Integration vrstice →
// paylinks korak je simulator no-op (skipped, ne errors) in uspešen tek res
// nima napak. Skrivnost cron auth se nastavlja SINHRONO v req() (glej zgoraj).
beforeEach(async () => {
  await clearMarker()
  await pocistiPovezavo()
})

afterAll(async () => {
  await clearMarker()
  await pocistiPovezavo()
  if (savedMarker) await db.integration.create({ data: savedMarker })
  if (savedSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedSecret
})

describe('v1.161.0 — cron marker', () => {
  test('padel korak → marker se NE zapiše (dan ni zaklenjen), napaka je v odgovoru', async () => {
    await zastaviNedosegljivoPovezavo()
    try {
      // Ponovitev do 3× je varovalka ZA KRIŽNO interferenco, ne za kodo: med
      // našim cron tekom lahko tuja datoteka (issue30-37) namesti svoj fetch
      // stub in TA EN KRAT pogoltne naš Stripe klic (200 '{}' → paid:false →
      // skip). Ovoj `zNedosegljivimStripeom` okno močno zoži; ponovitev ga
      // praktično zapre (tudi tuji stub mora zadeti vseh 3 poskuse). Ponavlja
      // se SAMO ob odsotnosti `paylinks:` napake — padec marker discipline
      // (korak je padel, marker pa zapisan) bi bil ujet v vsakem poskusu.
      let body: { ran: boolean; errors?: string[] } | null = null
      let brezNapakePoskusi = 0
      for (let poskus = 1; poskus <= 3; poskus++) {
        await clearMarker()
        const res = await zNedosegljivimStripeom(() => cronGET(req()))
        expect(res.status).toBe(200)
        body = (await res.json()) as { ran: boolean; errors?: string[] }
        expect(body.ran).toBe(true)
        if ((body.errors || []).some((e) => e.startsWith('paylinks:'))) break
        brezNapakePoskusi++
      }
      // Spremljajoča potrditev: če so vsi poskusi brez napake, je tuji stub
      // pogoltnil VSE — sporočilo naj to pove z kontekstom, ne brez njega.
      expect(
        (body?.errors || []).some((e) => e.startsWith('paylinks:')),
        `paylinks napaka v ${3 - brezNapakePoskusi}/3 poskusih; zadnje napake: ${JSON.stringify(body?.errors || [])}`,
      ).toBe(true)

      const row = await marker()
      expect(row?.config?.lastRunDate).not.toBe(todayKey())
      expect(row).toBeNull()
    } finally {
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
