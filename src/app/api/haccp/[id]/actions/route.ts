import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, jstr, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { parseRuleSnapshot, thresholdText, evalMeasurement, haccpOpsColumnsReady, numStrict } from '@/lib/haccp-ops'
import { isManagerialRole } from '@/lib/exception-approval'

/**
 * Issue #20 (P1/P2, v1.109.0) — revizijski dogodki HACCP zapisa.
 *
 * POST /api/haccp/:id/actions  { kind: 'corrective' | 'verify', … }
 *
 * 1) KOREKTIVNI UKREP (kind=corrective): ob odstopanju ZAHTEVA opis ukrepa
 *    (≥ 10 znakov — obravnava prizadetega živila/serije po postopku lokala),
 *    izvajalca in čas. Prehod stanja:
 *      deviation → requiresVerification ? awaiting_verification : closed
 *    Brez verifikacije (kadar načrt ne zahteva) se odstopanje zapre SAMLIVO
 *    z zapisanim ukrepom; kadar zahteva — ostane odprto do verifikacije
 *    (issue: "ne dovoli zaprtja brez izvedene in zabeležene verifikacije").
 *
 * 2) VERIFIKACIJA (kind=verify):
 *    - method='recheck': ponovna NUMERIČNA meritev, ocenjena proti POSNETKU
 *      pravil zapisa (issue: "Sprememba načrta ne spremeni zgodovinske meje,
 *      po kateri je bila pretekla meritev ocenjena"). Uspeh → closed;
 *      neuspeh → odstopanje ostane (outcome 'failed', potreben nov ukrep).
 *    - method='approval': vodstvena potrditev (isManagerialRole — manager/
 *      owner/admin) → closed. Izvajalec ne more potrditi lastnega popravka
 *      BREZ vodstvene vloge (403).
 *
 * APPEND-ONLY revizijska sled: dogodek se ZAPIŠE (HaccpAction + audit
 * veriga), meritve originala se NIKOLI ne prepisujejo. Legacy zapisi (brez
 * planId): dogodek se zapiše v zgodovino, stanja NI (nimajo cikla).
 *
 * Dovoljenja: haccp.execute; approval dodatno zahteva vodstveno vlogo.
 * Tenant sloj: locationScope (tuja lokacija → 404, fail-closed).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'haccp.execute')
  if (isResponse(user)) return user
  if (!(await haccpOpsColumnsReady())) {
    return fail('Revizijski dogodki še niso aktivirani — zahtevajo DDL korak na strežniku (/api/admin/migrate-haccp-ops).', 503)
  }

  const { id } = await params
  const body = await req.json().catch(() => null)
  const kind = String(body?.kind ?? '').toLowerCase()

  // tenant sloj: zapis MORA biti v uporabnikovem obsegu (404 = fail-closed)
  const entry = await db.haccpEntry.findFirst({ where: { id, ...(await locationScope(user)) } })
  if (!entry) return fail('Zapis ne obstaja.', 404)

  const governed = Boolean(entry.planId) // novi cikel velja samo za governed zapise
  const rule = parseRuleSnapshot(entry.ruleSnapshot)
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : ''

  /* ─────────── 1) KOREKTIVNI UKREP ─────────── */
  if (kind === 'corrective') {
    if (note.length < 10) return fail('Opis korektivnega ukrepa je obvezen (najmanj 10 znakov — obravnava prizadetega živila/serije).', 400)
    if (governed) {
      if (entry.entryState === 'done') return fail('Zapis je v redu — korektivni ukrep ni potreben.', 409)
      if (entry.entryState === 'closed') return fail('Odstopanje je že zaprto.', 409)
      if (entry.entryState === 'awaiting_verification') return fail('Korektivni ukrep je že zabeležen — čaka verifikacijo.', 409)
    } else if (entry.status === 'ok') {
      return fail('Zapis je v redu — korektivni ukrep ni potreben.', 409)
    }

    const requiresVerification = rule?.requiresVerification ?? true
    const newState = governed ? (requiresVerification ? 'awaiting_verification' : 'closed') : entry.entryState
    const closedAt = governed && !requiresVerification ? new Date() : null

    const actionId = nid()
    await db.haccpAction.create({
      data: {
        id: actionId,
        entryId: entry.id,
        locationId: entry.locationId,
        kind: 'corrective',
        method: '',
        note,
        outcome: governed ? newState : 'recorded',
        performedById: user.sub,
        performedByName: user.name || '',
        managerial: isManagerialRole(user.role),
      },
    })
    if (governed) {
      await db.haccpEntry.update({ where: { id: entry.id }, data: { entryState: newState, closedAt } })
    }
    await writeAudit(db, {
      userId: user.sub,
      action: 'HACCP_CORRECTIVE',
      entityType: 'HaccpEntry',
      entityId: entry.id,
      details: jstr({
        planName: entry.planName,
        note,
        state: entry.entryState,
        newState: governed ? newState : '(legacy — samo zapis)',
        requiresVerification,
      }),
      locationId: entry.locationId,
    })
    return ok({ action: { id: actionId, kind: 'corrective', note }, entryState: governed ? newState : entry.entryState, closedAt })
  }

  /* ─────────── 2) VERIFIKACIJA ─────────── */
  if (kind === 'verify') {
    const method = String(body?.method ?? '').toLowerCase()
    if (method !== 'recheck' && method !== 'approval') return fail("Metoda verifikacije je obvezna ('recheck' | 'approval').", 400)
    if (entry.entryState === 'done') return fail('Zapis je v redu — verifikacija ni potrebna.', 409)
    if (entry.entryState === 'closed') return fail('Odstopanje je že zaprto.', 409)

    let outcome = ''
    let managerial = false

    if (method === 'recheck') {
      // ponovni odčitek: NUMERIČNA meritev proti POSNETKU pravil (ne trenutnemu
      // načrtu!) — zgodbinski pomen zapisa ostaja nespremenjen
      if (!rule) return fail('Zapis nima posnetka pravil — ponovna meritev ni mogoča (legacy zapis).', 409)
      if (rule.measureKind !== 'number') {
        return fail('Ponovni odčitek je mogoč samo pri numeričnih kontrolah — uporabite potrditev vodje.', 400)
      }
      const v = numStrict(body?.numericValue)
      if (v === null) return fail('Ponovna meritev (numericValue) je obvezna.', 400)
      const severity = evalMeasurement(rule, v)
      outcome = severity === 'ok' ? 'ok' : 'failed'

      const actionId = nid()
      await db.haccpAction.create({
        data: {
          id: actionId,
          entryId: entry.id,
          locationId: entry.locationId,
          kind: 'verify',
          method: 'recheck',
          note,
          outcome,
          recheckValue: v,
          performedById: user.sub,
          performedByName: user.name || '',
          managerial: isManagerialRole(user.role),
        },
      })
      if (governed) {
        if (outcome === 'ok') {
          await db.haccpEntry.update({ where: { id: entry.id }, data: { entryState: 'closed', closedAt: new Date() } })
        } else {
          // neuspešna meritev: odstopanje OSTANE odprto (nov korektivni ukrep)
          await db.haccpEntry.update({ where: { id: entry.id }, data: { entryState: 'deviation' } })
        }
      }
      await writeAudit(db, {
        userId: user.sub,
        action: 'HACCP_VERIFIED',
        entityType: 'HaccpEntry',
        entityId: entry.id,
        details: jstr({
          method: 'recheck',
          value: v,
          unit: rule.unit,
          outcome,
          threshold: thresholdText(rule),
          planVersion: rule.planVersion,
          newState: governed ? (outcome === 'ok' ? 'closed' : 'deviation') : '(legacy)',
        }),
        locationId: entry.locationId,
      })
      return ok({ action: { id: actionId, kind: 'verify', method: 'recheck', outcome, value: v }, entryState: governed ? (outcome === 'ok' ? 'closed' : 'deviation') : entry.entryState, outcome })
    }

    // method === 'approval' — vodstvena potrditev (issue: "odobritev vodje")
    if (!isManagerialRole(user.role)) {
      return fail('Potrditev vodje zahteva vodstveno vlogo (manager/owner/admin).', 403)
    }
    managerial = true

    const actionId = nid()
    await db.haccpAction.create({
      data: {
        id: actionId,
        entryId: entry.id,
        locationId: entry.locationId,
        kind: 'verify',
        method: 'approval',
        note,
        outcome: 'ok',
        performedById: user.sub,
        performedByName: user.name || '',
        managerial,
      },
    })
    if (governed) {
      await db.haccpEntry.update({ where: { id: entry.id }, data: { entryState: 'closed', closedAt: new Date() } })
    }
    await writeAudit(db, {
      userId: user.sub,
      action: 'HACCP_VERIFIED',
      entityType: 'HaccpEntry',
      entityId: entry.id,
      details: jstr({ method: 'approval', outcome: 'ok', approver: user.name, newState: governed ? 'closed' : '(legacy)' }),
      locationId: entry.locationId,
    })
    return ok({ action: { id: actionId, kind: 'verify', method: 'approval', outcome: 'ok' }, entryState: governed ? 'closed' : entry.entryState, outcome: 'ok' })
  }

  return fail("kind je obvezen ('corrective' | 'verify').", 400)
}
