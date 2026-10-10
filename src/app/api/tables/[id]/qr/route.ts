import { NextRequest } from 'next/server'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { requirePermission, assertResourceLocation, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { newQrToken, qrUrl } from '@/lib/guest'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Issue #3 — QR meni po mizah (administracija).
 * GET  /api/tables/[id]/qr  → informacija + QR slika (data URL) + URL
 * POST /api/tables/[id]/qr  → { action: 'rotate' } regenerira/revokira token
 *                             { action: 'toggle', enabled } začasni izklop QR naročanja
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Issue #4 §1: QR token = naročilna sposobnost — zahteva orders.create + lastna lokacija
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params

  const table = await db.table.findUnique({ where: { id }, include: { Location: true } })
  if (!table) return fail('Miza ne obstaja.', 404)
  // Issue #4 §1: pred mintanjem/razkritjem tokena preveri pripadnost lokaciji (fail-closed)
  const locRes = assertResourceLocation(user, table.locationId)
  if (locRes) return locRes

  let token = table.qrToken
  if (!token) {
    token = newQrToken()
    await db.table.update({ where: { id }, data: { qrToken: token, qrRotatedAt: new Date() } })
  }
  const url = qrUrl(req, token)
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 })
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 })

  return ok({
    table: { id: table.id, number: table.number, location: table.Location?.name || '' },
    qrEnabled: table.qrEnabled,
    qrRotatedAt: table.qrRotatedAt,
    url,
    svg,
    dataUrl,
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const action = String(body?.action || '')

  const table = await db.table.findUnique({ where: { id } })
  if (!table) return fail('Miza ne obstaja.', 404)
  // Issue #4 §1: rotacija/izklop QR naročanja samo na mizah lastne lokacije
  const locRes = assertResourceLocation(user, table.locationId)
  if (locRes) return locRes

  if (action === 'rotate') {
    const token = newQrToken()
    await db.table.update({ where: { id }, data: { qrToken: token, qrRotatedAt: new Date() } })
    const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'QR_TOKEN_ROTATED', entityType: 'Table', entityId: id, details: `miza=${table.number} — stari token revokiran, QR povezave pred rotacijo ne delujejo več`, locationId: table.locationId, id: __aId2 })
    await db.auditLog.create({
      data: { ...__chain2,
        id: __aId2,
        userId: user.sub,
        action: 'QR_TOKEN_ROTATED',
        entityType: 'Table',
        entityId: id,
        details: `miza=${table.number} — stari token revokiran, QR povezave pred rotacijo ne delujejo več`,
        locationId: table.locationId,
      },
    })
    return ok({ rotated: true, url: qrUrl(req, token) })
  }

  if (action === 'toggle') {
    const enabled = Boolean(body?.enabled)
    await db.table.update({ where: { id }, data: { qrEnabled: enabled } })
    const __aId4 = nid(); const __chain4 = await auditChainFields(db, { action: 'QR_ORDER_TOGGLE', entityType: 'Table', entityId: id, details: `miza=${table.number} QR naročanje ${enabled ? 'vklopljeno' : 'izklopljeno'}`, locationId: table.locationId, id: __aId4 })
    await db.auditLog.create({
      data: { ...__chain4,
        id: __aId4,
        userId: user.sub,
        action: 'QR_ORDER_TOGGLE',
        entityType: 'Table',
        entityId: id,
        details: `miza=${table.number} QR naročanje ${enabled ? 'vklopljeno' : 'izklopljeno'}`,
        locationId: table.locationId,
      },
    })
    return ok({ qrEnabled: enabled })
  }

  return fail('Neznan action (rotate | toggle).', 400)
}
