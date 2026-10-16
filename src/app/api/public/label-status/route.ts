import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { clientIp, rateLimitPublic } from '@/lib/guest'
import { batchBucket, BATCH_SELECT_FULL } from '@/lib/lot-governance'
import { labelScanStatus } from '@/lib/label'

/**
 * Issue #24 — JAVNI status etikete (GET /api/public/label-status?token=).
 * QR z etikete → ta endpoint → statusna stran /label/<token>.
 *
 * Varnost (vzorec /api/public/reservations):
 *  - token JE skivnost (32 hex); napačen/neznan → generični 404 (brez razlike);
 *  - BREZ PII: odgovor vsebuje SAMO status, naziv, rok, pripravo, enoto —
 *    kar je fizično na etiketi. Brez količin, brez lokacij, brez imen, brez ID-jev;
 *  - rate limit 60/min/IP.
 */
export async function GET(req: NextRequest) {
  if (!(await rateLimitPublic(`labelstatus:${clientIp(req)}`, 60))) {
    return fail('Preveč zahtevkov. Poskusite čez minuto.', 429)
  }
  const token = String(req.nextUrl.searchParams.get('token') || '')
  if (!/^[a-f0-9]{32}$/i.test(token)) return fail('Etiketa ne obstaja.', 404)
  let label: Awaited<ReturnType<typeof db.prepLabel.findUnique>> | null = null
  try {
    label = await db.prepLabel.findUnique({ where: { token } })
  } catch {
    return fail('Etiketa ne obstaja.', 404) // pre-DDL (produkcija) — tabla še ne obstaja
  }
  if (!label) return fail('Etiketa ne obstaja.', 404)
  let bucket: string | null = null
  if (label.batchId) {
    try {
      const batch = await db.inventoryBatch.findUnique({
        where: { id: label.batchId },
        select: BATCH_SELECT_FULL,
      })
      if (batch) bucket = batchBucket(batch, new Date())
    } catch {
      bucket = null
    }
  }
  const status = labelScanStatus(
    { status: label.status, needsReview: label.needsReview, expiresAt: label.expiresAt, batch: { bucket: bucket as never } },
    new Date(),
  )
  return ok({
    status,
    itemName: label.itemName,
    expiresAt: label.expiresAt,
    preparedAt: label.preparedAt,
    unit: label.itemUnit,
  })
}
