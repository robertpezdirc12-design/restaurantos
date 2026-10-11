import { describe, expect, test, afterAll, beforeAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { POST as feedbackPOST } from '../src/app/api/public/feedback/route'

/**
 * P1 audit točka 6 — javni vnos mnenja gosta (POST /api/public/feedback).
 * Varnostne invariante:
 *  - lokacija/miza se rešita IZ QR tokena (gost ne pošilja locationId — spoofing nemogoč)
 *  - ocene 1–5 (clamp), komentar ≤ 1000, ime ≤ 80, tags ≤ 10 × 30
 *  - orderId sprejet SAMO če pripada isti mizi/lokaciji
 *  - rate limit 5/min/IP — 6. klic → 429 (test zadnji, da ne uniči prejšnjih)
 *
 * Predpona fiksatur `gfb-` + RUN; cleanup v afterAll (obratna smer FK).
 */

const PREFIX = 'gfb-'
const RUN = Date.now().toString(36)
const QR = (Date.now().toString(16) + 'a'.repeat(32)).slice(0, 32) // 32 hex znakov (token je hex-only)

let locId = ''
let tableId = ''

function post(body: unknown, ip = '10.7.7.7'): NextRequest {
  return new NextRequest('http://localhost:3000/api/public/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: {
      id: `${PREFIX}loc-${RUN}`,
      name: `${PREFIX}Testna lokacija`,
      code: `GFB-${RUN.toUpperCase()}`,
      premisesId: `gfb-prem-${RUN}`,
    },
  })
  locId = loc.id
  const table = await db.table.create({
    data: { id: `${PREFIX}tbl-${RUN}`, number: 990 + 1, locationId: locId, qrToken: QR, qrEnabled: true },
  })
  tableId = table.id
})

afterAll(async () => {
  await db.guestFeedback.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: `${PREFIX}tbl` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: locId || '__x__' } }).catch(() => null)
})

describe('POST /api/public/feedback — javni vnos mnenja', () => {
  test('neveljaven/izklopljen token → 404', async () => {
    const res = await feedbackPOST(post({ token: 'ffffffffffffffffffffffffffffffff', overallRating: 5 }, '10.7.0.1'))
    expect(res.status).toBe(404)
    const res2 = await feedbackPOST(post({ token: 'kratko', overallRating: 5 }, '10.7.0.1'))
    expect(res2.status).toBe(404)
  })

  test('manjkajoča ocena → 400 (ocena 1–5 obvezna)', async () => {
    const res = await feedbackPOST(post({ token: QR }, '10.7.0.2'))
    expect(res.status).toBe(400)
    const res2 = await feedbackPOST(post({ token: QR, overallRating: 0 }, '10.7.0.2'))
    expect(res2.status).toBe(400)
  })

  test('srečna pot → 201; lokacija/miza rešeni iz tokena, source=qr, clamp + trim', async () => {
    const res = await feedbackPOST(post({
      token: QR,
      overallRating: 9, // clamp → 5
      foodRating: 4,
      serviceRating: '3', // string → 3
      atmosphereRating: 99, // clamp → 5
      comment: `  ${PREFIX} super hrana!  `,
      guestName: `  ${PREFIX} Ana  `,
      tags: ['hitro', 'okusno', 42, ''],
    }, '10.7.0.3'))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.feedbackId).toBeTruthy()
    const row = await db.guestFeedback.findUnique({ where: { id: j.feedbackId } })
    expect(row).not.toBeNull()
    expect(row?.locationId).toBe(locId)
    expect(row?.tableId).toBe(tableId)
    expect(String(row?.tableNumber)).toBe('991')
    expect(row?.source).toBe('qr')
    expect(row?.overallRating).toBe(5)
    expect(row?.foodRating).toBe(4)
    expect(row?.serviceRating).toBe(3)
    expect(row?.atmosphereRating).toBe(5)
    expect(row?.comment).toBe(`${PREFIX} super hrana!`)
    expect(row?.guestName).toBe(`${PREFIX} Ana`)
    expect(row?.status).toBe('new')
    const tags = JSON.parse(String(row?.tags ?? '[]'))
    expect(tags).toEqual(['hitro', 'okusno', '42'])
  })

  test('orderId tujega naročila se IGNORIRA (anti-spoofing)', async () => {
    // naročilo na DRUGi lokaciji (brez mize)
    const otherLoc = await db.location.create({
      data: { id: `${PREFIX}loc2-${RUN}`, name: `${PREFIX}Druga`, code: `GFB2-${RUN.toUpperCase()}`, premisesId: `gfb-prem2-${RUN}` },
    })
    const order = await db.order.create({
      data: { id: `${PREFIX}ord-${RUN}`, orderNumber: 87100, locationId: otherLoc.id, status: 'open', paymentStatus: 'unpaid' },
    })
    const res = await feedbackPOST(post({ token: QR, overallRating: 4, orderId: order.id }, '10.7.0.4'))
    expect(res.status).toBe(201)
    const j = await res.json()
    const row = await db.guestFeedback.findUnique({ where: { id: j.feedbackId } })
    expect(row?.orderId).toBeNull() // tuje naročilo zavrnjeno
    await db.order.delete({ where: { id: order.id } }).catch(() => null)
    await db.location.delete({ where: { id: otherLoc.id } }).catch(() => null)
  })

  test('rate limit: 6. klic v minuti → 429 (isti IP)', async () => {
    // do tu so porabili 3 klice z IP 10.7.7.7 (2 × 404 se štejeta? — 404 po rate limit
    // preverbi NE, ker je limit PRVA preverba: porabili 201+201 = 2 uspešna + 3 neuspeli
    // (vsi so šteti, ker limit teče pred validacijo) → pošljemo do konca kvote in presežemo
    let got429 = false
    for (let i = 0; i < 8 && !got429; i++) {
      const res = await feedbackPOST(post({ token: QR, overallRating: 5, comment: `${PREFIX} limit ${i}` }))
      if (res.status === 429) got429 = true
    }
    expect(got429).toBe(true)
  })
})
