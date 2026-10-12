import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * OPS-7 (v1.70.0) — naročnina na push obvestila.
 *
 * POST body: {endpoint, keys: {p256dh, auth}} → upsert aktivne naročnine prijavljenega zaposlenega
 * DELETE body: {endpoint} → deaktivacija (odjava v brskalniku / izbris naročnine)
 */
export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
  const p256dh = typeof body?.keys?.p256dh === 'string' ? (body.keys.p256dh as string).trim() : ''
  const auth = typeof body?.keys?.auth === 'string' ? (body.keys.auth as string).trim() : ''
  if (!endpoint || !p256dh || !auth) return fail('endpoint in keys (p256dh, auth) so obvezni.', 400)
  const userAgent = req.headers.get('user-agent')?.slice(0, 180) ?? ''

  const existing = await db.pushSubscription.findFirst({ where: { employeeId: user.sub, endpoint } })
  if (existing) {
    await db.pushSubscription.update({ where: { id: existing.id }, data: { p256dhKey: p256dh, authKey: auth, isActive: true, userAgent } })
  } else {
    await db.pushSubscription.create({
      data: { id: nid(), employeeId: user.sub, endpoint: endpoint.slice(0, 500), p256dhKey: p256dh, authKey: auth, userAgent, isActive: true },
    })
  }
  return ok({ subscribed: true })
}

export async function DELETE(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
  if (!endpoint) return fail('endpoint je obvezen.', 400)
  await db.pushSubscription.updateMany({ where: { employeeId: user.sub, endpoint }, data: { isActive: false } })
  return ok({ unsubscribed: true })
}
