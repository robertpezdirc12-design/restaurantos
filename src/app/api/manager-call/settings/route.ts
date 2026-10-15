import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import {
  isManagerCallType,
  parseManagerCallSettings,
  MIN_ACK_TIMEOUT_MINUTES,
  MAX_ACK_TIMEOUT_MINUTES,
  type ManagerCallType,
} from '@/lib/manager-call-registry'
import { loadManagerCallSettings, saveManagerCallSettings } from '@/lib/manager-call'

/**
 * Issue #21 (P1/P2, v1.111.0) — nastavitve klica vodje.
 *
 * GET /api/manager-call/settings — vsaka prijavljena vloga (dialog gumba
 *   "Klic vodje" rabi dovoljene vrste +timeout; brez občutljivih podatkov).
 * PUT /api/manager-call/settings — SAMO settings.manage (ISTA disciplina kot
 *   notification-rules): { ackTimeoutMinutes (1–60), allowedTypes (neprazen
 *   podnabor) } → Integration vrstica 'manager-call-settings' (brez DDL —
 *   enak vzorec shranjevanja kot notification-rules/push-vapid).
 *
 * Ciljne vloge prejemnikov se NE nastavljajo tukaj — to dela OBSTOJEČA
 * notifikacijska matrika (Nastavitve → Obvestila, vrstici MANAGER_CALL /
 * MANAGER_CALL_ESCALATED) — issue §1: "ne prek hardcoded prejemnikov".
 */

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const settings = await loadManagerCallSettings()
  return ok({ settings })
}

interface PutBody {
  ackTimeoutMinutes?: unknown
  allowedTypes?: unknown
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  let body: PutBody
  try {
    body = (await req.json()) as PutBody
  } catch {
    return fail('Neveljavno telo zahteve.', 400)
  }

  const t = Number(body.ackTimeoutMinutes)
  if (!Number.isFinite(t) || Math.floor(t) !== t || t < MIN_ACK_TIMEOUT_MINUTES || t > MAX_ACK_TIMEOUT_MINUTES) {
    return fail(`Čas eskalacije (minute) mora biti celo število med ${MIN_ACK_TIMEOUT_MINUTES} in ${MAX_ACK_TIMEOUT_MINUTES}.`, 400)
  }
  if (!Array.isArray(body.allowedTypes) || body.allowedTypes.length === 0) {
    return fail('Dovoljene vrste so obvezne (vsaj ena).', 400)
  }
  const types: ManagerCallType[] = []
  for (const v of body.allowedTypes) {
    if (!isManagerCallType(v)) return fail(`Neveljavna vrsta zahteve: ${String(v).slice(0, 40)}.`, 400)
    if (!types.includes(v)) types.push(v)
  }

  const settings = parseManagerCallSettings({ ackTimeoutMinutes: t, allowedTypes: types })
  await saveManagerCallSettings(settings)

  await writeAudit(db, {
    userId: user.sub,
    action: 'MANAGER_CALL_SETTINGS_UPDATED',
    entityType: 'Integration',
    entityId: 'manager-call-settings',
    details: jstr({ ackTimeoutMinutes: settings.ackTimeoutMinutes, allowedTypes: settings.allowedTypes, by: user.name }),
    locationId: user.loc ?? null,
  })

  return ok({ settings })
}
