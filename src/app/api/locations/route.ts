import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr, nid } from '@/lib/map'
import { validateLocationInput, codeCandidateFromName } from '@/lib/multilocation'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Več poslovalnic (GitLab issue #1, triage ⑧).
 *
 * GET   — seznam lokacij: centralne vloge (OWNER/ADMIN) vidijo vse,
 *         ostali SAMO svojo lokacijo (fail-closed, usklajeno z /api/locations/stats, issue #4 §1)
 * POST  — nova lokacija (settings.manage) — brez tega 2. poslovalnice ni mogoče ustvariti
 */

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const locations = await db.location.findMany({
    // Issue #4 §1 + triage ⑧: non-central ne sme videti drugih poslovalnic
    where: isCentralRole(user) ? {} : { id: user.loc || '__no_location__' },
    orderBy: { name: 'asc' },
  })
  return ok({ locations })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const v = validateLocationInput(body)
  if (!v.ok) return fail(v.error, 400)

  // koda: iz telesa ali kandidat iz imena; ob koliziji uskladi z zaporedjem
  let code = v.value.code || codeCandidateFromName(v.value.name) || 'LOKACIJA'
  const taken = async (c: string) => (await db.location.findUnique({ where: { code: c }, select: { id: true } })) !== null
  if (await taken(code)) {
    let n = 2
    while (n < 100 && (await taken(`${code.slice(0, 18)}-${n}`))) n += 1
    code = `${code.slice(0, 18)}-${n}`
  }

  if (v.value.premisesId) {
    const dupPremises = await db.location.findUnique({ where: { premisesId: v.value.premisesId }, select: { id: true } })
    if (dupPremises) return fail('FURS poslovni prostor s to oznako že obstaja.', 409)
  }

  try {
    const row = await db.location.create({
      data: {
        id: nid(),
        name: v.value.name,
        code,
        address: v.value.address,
        city: v.value.city,
        postCode: v.value.postCode,
        country: v.value.country,
        phone: v.value.phone,
        email: v.value.email,
        premisesId: v.value.premisesId || null, // Task 44: nullable — FURS oznaka je opcijska (dodana ob registraciji proračuna)
        timezone: v.value.timezone,
        currency: v.value.currency,
        type: 'restaurant',
      },
    })

    const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'LOCATION_CREATE', entityType: 'Location', entityId: row.id, details: jstr({ name: row.name, code: row.code, country: row.country, currency: row.currency, premisesId: row.premisesId || null }), id: __aId2 })
    await db.auditLog.create({
      data: { ...__chain2,
        id: __aId2, userId: user.sub, action: 'LOCATION_CREATE', entityType: 'Location', entityId: row.id,
        details: jstr({ name: row.name, code: row.code, country: row.country, currency: row.currency, premisesId: row.premisesId || null }),
      },
    }).catch(() => null)

    return ok({ location: row }, 201)
  } catch (e: unknown) {
      // Task 42 + 44: natančno P2002 razlikovanje (meta.target) — zavajajoče splošno
      // sporočilo zamenja akcijsko; pokrije race okno med taken()/dupPremises()
      // preverjanjem in create(). premisesId je od Task 44 nullable ('' → NULL).
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === 'P2002') {
      const meta = (e as { meta?: { target?: string[] | string } }).meta?.target
      const fields = Array.isArray(meta) ? meta.join(',') : String(meta || '')
      if (fields.includes('premisesId')) {
        // Task 44: prazne oznake so NULL (unique indeks dovoljuje več NULL) —
        // kolizija je torej ZOREZ pravi dupliciran FURS poslovni prostor.
        return fail('FURS poslovni prostor s to oznako že obstaja — preverite oznako poslovnega prostora.', 409)
      }
      return fail('Koda lokacije že obstaja — poskusite z drugo kodo.', 409)
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Unique')) return fail('Koda ali FURS poslovni prostor že obstaja.', 409)
    return fail(`Ustvarjanje ni uspelo: ${msg}`, 500)
  }
}
