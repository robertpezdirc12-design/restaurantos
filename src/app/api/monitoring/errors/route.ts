import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { mapAudit, nid, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const errors = await db.auditLog.findMany({
    where: { action: { contains: 'ERROR' } },
    orderBy: { timestamp: 'desc' },
    take: 50,
  })
  return ok({ errors: errors.map(mapAudit) })
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.message) return fail('message je obvezen.')
  // 33-c: chain polja + locationId akterja (audit §6)
  const __aId = nid(); const __chain = await auditChainFields(db, { id: __aId, action: 'ERROR_REPORT', entityType: 'client', entityId: '', details: jstr(body).slice(0, 2000), locationId: user.loc })
  const log = await db.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: user.sub,
      action: 'ERROR_REPORT',
      entityType: 'client',
      details: jstr(body).slice(0, 2000),
      // 33-c (audit §6): ERROR_REPORT dobi locationId akterja (prej neviden location-scoped uporabnikom)
      locationId: user.loc,
    },
  })
  return ok({ log: mapAudit(log) }, 201)
}
