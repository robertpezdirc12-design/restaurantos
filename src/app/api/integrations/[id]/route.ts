import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jparse, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { stripMaskedConfig } from '@/lib/integration-mask'
import { safeIntegrationDto } from '@/lib/secret-dto'
import { guardIntegration } from '@/lib/tenant'

/**
 * Task 60 (audit §7 Integracije PARTIAL→DONE) — upravljanje posamezne povezave.
 *
 * PATCH: delne posodobitve (name/type/provider/baseUrl/syncEnabled/syncInterval/
 * isActive/locationId/config). Maskni sentinel: vrednosti '••••' v configu se
 * izpustijo — urednik brez pravic ne prepiše pravih skrivnosti z masko
 * (dopolnilni zapis: obstoječi config + novi ključi). Audit INTEGRATION_UPDATED.
 *
 * DELETE: MEHKO brisanje (isActive=false + syncEnabled=false +
 * connectionStatus='disconnected') — povezava ostane v evidenci; trdo brisanje
 * bi s FK Cascade izgubilo IntegrationLog zgodovino. Audit INTEGRATION_DISABLED.
 * Idempotentno: že neaktivna → 200 brez nove revizije.
 *
 * Issue #42 — tenant/lokacijski obseg na točkovnih poteh (prej samo findUnique po
 * ID-ju; settings.manage + znan ID je omogočal upravljanje TUJIH integracij):
 *  1. vir naložimo, nato guardIntegration(user, row.locationId): bound vir →
 *     guardResource (staff = izključno svoja lokacija; central = org meja) —
 *     ENAKO pravilo kot seznam;
 *  2. globalna integracija (locationId null) je IZRECNA platform-level
 *     operacija (guardGlobalResource): samo centralna vloga BREZ vezane org
 *     ali bootstrap; zavezana centralna vloga globalov ne vidi v seznamu
 *     (locationScope org allow-lista) in jih zato ne sme niti mutirati;
 *  3. premik na drug locationId preveri OBOJE: pravico nad trenutno povezavo IN
 *     pravico nad ciljno lokacijo (cilj orgB → 403 tudi za centralne vloge orgA);
 *  4. premik v globalno (null) je dovoljen samo centralnim vlogam.
 * Odgovori (PATCH/DELETE) vračajo varni DTO (#23 §3 — brez surovih
 * apiKey/apiSecret/config vrednosti).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const row = await db.integration.findUnique({ where: { id } })
  if (!row) return fail('Povezava ne obstaja.', 404)
  // #42 točka 1+2: obseg trenutnega vira (globalni vir = izrecno centralna operacija)
  const guard = await guardIntegration(user, row.locationId)
  if (guard) return guard
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Manjka telo zahtevka.', 400)

  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 120)
  if (typeof body.type === 'string') data.type = body.type.slice(0, 40)
  if (typeof body.provider === 'string') data.provider = body.provider.slice(0, 80)
  if (typeof body.baseUrl === 'string') {
    if (body.baseUrl && !/^https?:\/\//i.test(body.baseUrl)) return fail('BaseUrl mora začeti s http(s)://.', 400)
    data.baseUrl = body.baseUrl.trim().slice(0, 300)
  }
  if (typeof body.syncEnabled === 'boolean') data.syncEnabled = body.syncEnabled
  if (typeof body.isActive === 'boolean') data.isActive = body.isActive
  if (body.syncInterval !== undefined) {
    const n = Number(body.syncInterval)
    if (!Number.isFinite(n) || n < 30 || n > 86400) return fail('syncInterval mora biti med 30 in 86400 s.', 400)
    data.syncInterval = Math.round(n)
  }
  if (body.locationId !== undefined) {
    if (body.locationId === null || body.locationId === '') {
      // #42 točka 4: premik v GLOBALNO — izrecna platform-level operacija
      // (guardGlobalResource: non-central + zavezana centralna → 403)
      const gNull = await guardIntegration(user, null)
      if (gNull) return gNull
      data.locationId = null
    } else {
      const loc = await db.location.findUnique({ where: { id: String(body.locationId) } })
      if (!loc) return fail('Lokacija ne obstaja.', 400)
      // #42 točka 3: pravica nad CILJNO lokacijo (cilj tuje org → 403)
      const gTarget = await guardIntegration(user, loc.id)
      if (gTarget) return gTarget
      data.locationId = loc.id
    }
  }
  if (body.config !== undefined) {
    if (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config)) {
      return fail('Config mora biti objekt.', 400)
    }
    if (jstr(body.config).length > 8192) return fail('Config presega 8 kB.', 400)
    const prev = jparse<Record<string, unknown>>(row.config, {})
    const incoming = stripMaskedConfig(body.config as Record<string, unknown>)
    data.config = jstr({ ...prev, ...incoming })
  }

  const updated = await db.integration.update({ where: { id }, data: data as never })
  await writeAudit(db, { userId: user.sub, action: 'INTEGRATION_UPDATED', entityType: 'Integration', entityId: id, details: jstr({ fields: Object.keys(data), name: updated.name, by: user.name }), locationId: updated.locationId })
  await publishEvent('IntegrationUpdated', { entityType: 'Integration', entityId: id, payload: { fields: Object.keys(data) }, locationId: updated.locationId })
  // #23 §3: varni DTO — nikoli surov model
  return ok({ integration: safeIntegrationDto(updated, { central: isCentralRole(user) }) })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const row = await db.integration.findUnique({ where: { id } })
  if (!row) return fail('Povezava ne obstaja.', 404)
  // #42: obseg vira (enako pravilo kot PATCH/seznam; globalni = central-only)
  const guard = await guardIntegration(user, row.locationId)
  if (guard) return guard
  if (!row.isActive) return ok({ integration: safeIntegrationDto(row, { central: isCentralRole(user) }), disabled: true }) // idempotentno
  const updated = await db.integration.update({
    where: { id },
    data: { isActive: false, syncEnabled: false, connectionStatus: 'disconnected' },
  })
  await writeAudit(db, { userId: user.sub, action: 'INTEGRATION_DISABLED', entityType: 'Integration', entityId: id, details: jstr({ name: row.name, by: user.name }), locationId: updated.locationId })
  await publishEvent('IntegrationDisabled', { entityType: 'Integration', entityId: id, payload: { name: row.name }, locationId: updated.locationId })
  // #23 §3: varni DTO
  return ok({ integration: safeIntegrationDto(updated, { central: isCentralRole(user) }), disabled: true })
}
