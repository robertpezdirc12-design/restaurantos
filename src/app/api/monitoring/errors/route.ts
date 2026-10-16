import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, locationScope, isResponse, ok, fail } from '@/lib/api'
import { mapAudit, nid, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'
import { validateErrorReport } from '@/lib/error-report'

/**
 * Issue #5 (P0, kommentar #4): vpogled v diagnostične dnevnike = settings.manage
 * (integracije-tab) + lokacijski obseg (AuditLog.locationId obstaja — prej brez
 * filtra, cross-org). Pošiljanje prijave napak (POST) ostaja vsem prijavljenim —
 * ločeno od vpogleda (issue: »loči pošiljanje varno očiščene prijave od vpogleda«).
 *
 * Issue #25 (P1): POST ne sme slepo kopirati klientovega objekta v audit.
 *  - allow-list DTO (message/code/component/correlationId/context) + meje → 400;
 *  - vsa polja PO REDAKCIJI (žetoni/gesla/ključi/PAN/PII/stack) — src/lib/error-report.ts;
 *  - v AuditLog.details se zapiše SAMO kanonični DTO, ne surovo telo;
 *  - odgovor: accepted + reportId + status (BREZ shranjenih details — surov odmev
 *    nazaj k pošiljatelju je odstranjen; bralci gredo čez GET s pravicami).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  // Issue #3 §G/H (P2): filter je ujel SAMO akcije z 'ERROR' v imenu — PRINT_FAILED
  // (issue #10), FISCAL_SUBMIT_FAILED (issue #3 §B) in SYNC_OP_DROPPED (issue #3 §A)
  // so operativne napake BREZ 'ERROR' podniza in so bile NEVIDNE v diagnostiki.
  const errors = await db.auditLog.findMany({
    where: {
      OR: [
        { action: { contains: 'ERROR' } },
        { action: { in: ['PRINT_FAILED', 'FISCAL_SUBMIT_FAILED', 'SYNC_OP_DROPPED'] } },
      ],
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: 50,
  })
  return ok({ errors: errors.map(mapAudit) })
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (body === null) return fail('Neveljavno JSON telo.')

  // Issue #25: validacija (allow-list/meje) + sanitizacija (redakcija) PRED zapisom
  const parsed = validateErrorReport(body)
  if (!parsed.ok) return fail(parsed.error)

  const details = jstr(parsed.dto) // SAMO kanonični, sanitiziran DTO
  // 33-c: chain polja + locationId akterja (audit §6); entityId = reportId (sledljivost v GET)
  const __aId = nid()
  const __chain = await auditChainFields(db, {
    id: __aId, action: 'ERROR_REPORT', entityType: 'client', entityId: __aId,
    details, locationId: user.loc,
  })
  await db.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: user.sub,
      action: 'ERROR_REPORT',
      entityType: 'client',
      entityId: __aId,
      details,
      // 33-c (audit §6): ERROR_REPORT dobi locationId akterja (prej neviden location-scoped uporabnikom)
      locationId: user.loc,
    },
  })
  // Issue #25: NE vračaj details/log (raw odmev) — samo potrditev + varni reportId
  return ok({ accepted: true, reportId: __aId, status: 'recorded' }, 201)
}
