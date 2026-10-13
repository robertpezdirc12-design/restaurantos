import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { SCHEMA_MIGRATIONS, schemaMigrationsStatus } from '@/lib/schema-migrations'
import { POST as issue3POST } from '../migrate-issue3/route'
import { POST as issue4POST } from '../migrate-issue4/route'
import { POST as issue1s6POST } from '../migrate-issue1-s6/route'
import { POST as issue1s7POST } from '../migrate-issue1-s7/route'
import { POST as issue10POST } from '../migrate-issue10/route'
import { POST as issue11POST } from '../migrate-issue11/route'
import { POST as issue12POST } from '../migrate-issue12/route'
import { POST as issue13POST } from '../migrate-issue13/route'
import { POST as haccpPlansPOST } from '../migrate-haccp-plans/route'
import { POST as stroskiKategorijePOST } from '../migrate-stroski-kategorije/route'
import { POST as cleanerRolePOST } from '../migrate-cleaner-role/route'
import { POST as paylinkPOST } from '../migrate-paylink/route'
import { POST as paylinkSplitPOST } from '@/app/api/admin/migrate-paylink-split/route'

/**
 * Task 65 (v1.63.0) — Migracijska konzola: status + en klik za vse DDL korake.
 *
 * Do zdaj je centralna vloga morala vsak produkcijski DDL korak izvesti ročno
 * (9 rut /api/admin/migrate-*). Konzola združi:
 *  - GET  — status vsake migracije (idempotentne probe iz src/lib/schema-migrations.ts)
 *  - POST — uporabi eno ({id}) ali vse čakajoče (brez body): za VSAKO delegira na
 *           obstoječo migrate rutо (ENAK DDL vir + ENAK audit chain — tukaj se DDL
 *           NE podvaja). Napaka ene migracije ne ustavi ostalih (rezultat po posamezni).
 *
 * Samo za centralne vloge (requireCentralRole — DB vloga owner/admin; N4 audit P1).
 * Audit: SCHEMA_MIGRATION_CONSOLE (delegirane rute pišejo svoje SCHEMA_MIGRATION_*).
 */

const HANDLERS: Record<string, (req: NextRequest) => Promise<Response>> = {
  'issue3': issue3POST,
  'issue4': issue4POST,
  'issue1-s6': issue1s6POST,
  'issue1-s7': issue1s7POST,
  'issue10': issue10POST,
  'issue11': issue11POST,
  'issue12': issue12POST,
  'issue13': issue13POST,
  'haccp-plans': haccpPlansPOST,
  'stroski-kategorije': stroskiKategorijePOST,
  'cleaner-role': cleanerRolePOST,
  'paylink': paylinkPOST,
  'paylink-split': paylinkSplitPOST,
}

interface ConsoleResult {
  id: string
  ok: boolean
  status: number
  detail?: string
}

export async function GET(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const status = await schemaMigrationsStatus()
  return ok({
    migrations: SCHEMA_MIGRATIONS.map((m) => {
      const s = status.find((x) => x.id === m.id)
      return { id: m.id, descKey: m.descKey, endpoint: m.endpoint, applied: s?.applied ?? false, error: s?.error }
    }),
    pending: status.filter((s) => !s.applied).length,
    allApplied: status.every((s) => s.applied),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  let target: string | null = null
  try {
    const body = (await req.json()) as { id?: string } | null
    target = body?.id ?? null
  } catch { /* brez body = vse čakajoče */ }
  if (target !== null && !HANDLERS[target]) {
    return fail(`Neznana migracija: ${String(target).slice(0, 60)}`, 400)
  }

  const status = await schemaMigrationsStatus()
  const appliedMap = new Map(status.map((s) => [s.id, s]))

  if (target !== null && appliedMap.get(target)?.applied) {
    return ok({ alreadyApplied: true, applied: [] as ConsoleResult[], pending: status.filter((s) => !s.applied).length })
  }

  const targets = SCHEMA_MIGRATIONS.filter((m) => (target === null || m.id === target) && !appliedMap.get(m.id)?.applied)

  // Delegacija na obstoječe rute — isti DDL vir, isti audit chain.
  // Nova Headers brez content-length/typa: notranja POST zahteva nima body-ja.
  const innerHeaders = new Headers(req.headers)
  innerHeaders.delete('content-length')
  innerHeaders.delete('content-type')

  const results: ConsoleResult[] = []
  for (const m of targets) {
    try {
      const inner = new NextRequest(req.url, { method: 'POST', headers: innerHeaders })
      const res = await HANDLERS[m.id](inner)
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      results.push({ id: m.id, ok: res.ok, status: res.status, detail: j.error })
    } catch (e) {
      results.push({ id: m.id, ok: false, status: 500, detail: (e as Error).message })
    }
  }

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_CONSOLE',
        entityType: 'Schema',
        entityId: target ?? 'all_pending',
        details: JSON.stringify({
          requested: target ?? 'all',
          targets: targets.map((t) => t.id),
          results,
        }),
      },
    })
    .catch(() => null)

  const fresh = await schemaMigrationsStatus()
  return ok({
    applied: results,
    pending: fresh.filter((s) => !s.applied).length,
    allApplied: fresh.every((s) => s.applied),
  })
}
