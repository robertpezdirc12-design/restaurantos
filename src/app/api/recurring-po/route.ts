import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, jstr } from '@/lib/map'
import { computeNextRun, parseRecurringConfig, clampRemindMinutes, RECURRING_PO_MARKER, type RecurringRule } from '@/lib/recurring-po'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OPS-9 val 2 (v1.75.0) — pravila ponavljajočih naročilnic (recurring PO rules).
 *
 * Persistence: Integration row (name='recurring-po', type='other', provider='internal'),
 * config JSON = { rules: RecurringRule[] } — ZERO DDL (vzorec: low-stock-state).
 *
 * GET    /api/recurring-po                → { rules } (inventory.manage — issue #41:
 *                                            prej requireAuth: vsak prijavljeni je videl
 *                                            ID-je dobaviteljev/artiklov + količine)
 * POST   /api/recurring-po                → novo pravilo { supplierId, items:[{inventoryItemId,qty}],
 *                                            weekdays:[0-6], hour:6-18, everyWeeks:1-4 }
 * PATCH  /api/recurring-po { id, active } → preklop aktivnosti (ob aktivaciji se nextRun
 *                                            znova izračuna od zdaj)
 * DELETE /api/recurring-po?id=            → bris pravila
 *
 * Pravice: kot purchase-orders — GET inventory.manage (issue #41), ostalo
 * inventory.manage. Obseg (issue #6 §E): pravila so platform-level konfiguracija
 * (Integration vrstica brez lokacijskih podatkov; dobavitelji so GLOBALNI katalog
 * brez locationId) — zato obseg določa PRAVICA, ne filter: imena/IBAN dobaviteljev
 * ščiti /api/suppliers (inventory.manage | reports.view), artikle /api/inventory,
 * količine/urnike pa ta ruta (samo inventory.manage).
 * Audit: RECURRING_PO_SAVED (POST/PATCH), RECURRING_PO_DELETED (DELETE).
 */

const MAX_RULES = 100
const MAX_ITEMS = 50

async function readConfig(): Promise<{ rowId: string | null; rules: RecurringRule[] }> {
  const row = await db.integration.findFirst({ where: { name: RECURRING_PO_MARKER, type: 'other' } })
  const rules = row ? parseRecurringConfig(row.config) : []
  return { rowId: row?.id ?? null, rules }
}

async function writeConfig(rowId: string | null, rules: RecurringRule[]): Promise<string> {
  const config = JSON.stringify({ rules })
  if (rowId) {
    await db.integration.update({ where: { id: rowId }, data: { config } })
    return rowId
  }
  const created = await db.integration.create({
    data: {
      id: `${RECURRING_PO_MARKER}-${Date.now().toString(36)}`,
      name: RECURRING_PO_MARKER,
      type: 'other',
      provider: 'internal',
      config,
      isActive: true,
      syncEnabled: false,
    },
  })
  return created.id
}

function sanitizeWeekdays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((w) => Math.trunc(Number(w))).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6))].sort((a, b) => a - b)
}

export async function GET(req: NextRequest) {
  // Issue #41 (P1): pravila ponavljajočih nabavnih naročil so NABAVNI podatki
  // (dobavitelji, artikli, količine, urniki) — prej requireAuth, torej jih je videl
  // vsak prijavljeni (kuhinja, čistilka …). Zdaj: inventory.manage (enako
  // purchase-orders in operativnemu delu /api/suppliers).
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { rules } = await readConfig()
  return ok({ rules })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const supplierId = String(body.supplierId || '').trim()
  if (!supplierId) return fail('Dobavitelj je obvezen.', 400)
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true } })
  if (!supplier) return fail('Dobavitelj ne obstaja.', 404)

  const rawItems = Array.isArray(body.items) ? body.items : []
  if (rawItems.length === 0) return fail('Pravilo potrebuje vsaj en artikel.', 400)
  if (rawItems.length > MAX_ITEMS) return fail(`Pravilo ima lahko največ ${MAX_ITEMS} artiklov.`, 400)
  const items: { inventoryItemId: string; qty: number }[] = []
  const seen = new Set<string>()
  for (const [idx, it] of rawItems.entries()) {
    const inventoryItemId = String(it?.inventoryItemId || '').trim()
    const qty = num(it?.qty)
    if (!inventoryItemId) return fail(`Artikel ${idx + 1}: manjka artikel.`, 400)
    if (seen.has(inventoryItemId)) return fail(`Artikel ${idx + 1}: artikel je naveden večkrat.`, 400)
    if (!(qty > 0)) return fail(`Artikel ${idx + 1}: količina mora biti večja od 0.`, 400)
    const inv = await db.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { id: true } })
    if (!inv) return fail(`Artikel ${idx + 1}: inventarni artikel ne obstaja.`, 400)
    seen.add(inventoryItemId)
    items.push({ inventoryItemId, qty })
  }

  const weekdays = sanitizeWeekdays(body.weekdays)
  if (weekdays.length === 0) return fail('Izberi vsaj en dan v tednu (0–6).', 400)

  const hour = Math.trunc(num(body.hour, 8))
  if (hour < 6 || hour > 18) return fail('Ura mora biti med 6 in 18.', 400)

  const everyWeeks = Math.trunc(num(body.everyWeeks, 1))
  if (everyWeeks < 1 || everyWeeks > 4) return fail('Interval mora biti med 1 in 4 tedni.', 400)

  // OPS-10 val 3: optional reminder lead time (clamped 0-1440; absent → parser default 60)
  const remindMinutesBefore = clampRemindMinutes(body.remindMinutesBefore)

  const { rowId, rules } = await readConfig()
  if (rules.length >= MAX_RULES) return fail(`Doseženo je največje število pravil (${MAX_RULES}).`, 409)

  const now = new Date()
  const draft: RecurringRule = {
    id: nid(),
    supplierId,
    items,
    weekdays,
    hour,
    everyWeeks,
    active: true,
    lastRun: null,
    nextRun: computeNextRun({ weekdays, hour, everyWeeks }, now)?.toISOString() ?? null,
    ...(remindMinutesBefore !== undefined ? { remindMinutesBefore } : {}),
  }
  const effectiveRowId = await writeConfig(rowId, [...rules, draft])

  await writeAudit(db, { userId: user.sub, action: 'RECURRING_PO_SAVED', entityType: 'Integration', entityId: effectiveRowId, details: jstr({
        ruleId: draft.id,
        supplierId,
        supplierName: supplier.name,
        items: items.length,
        weekdays,
        hour,
        everyWeeks,
        nextRun: draft.nextRun,
      }) })

  return ok({ rule: draft }, 201)
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)
  const ruleId = String(body.id || '').trim()
  if (!ruleId) return fail('Manjka ID pravila.', 400)
  if (typeof body.active !== 'boolean') return fail('Manjka aktivnost (active).', 400)

  const { rowId, rules } = await readConfig()
  const idx = rules.findIndex((r) => r.id === ruleId)
  if (idx < 0) return fail('Pravilo ne obstaja.', 404)

  const now = new Date()
  const rule = rules[idx]
  const next: RecurringRule = {
    ...rule,
    active: body.active,
    // re-arm the schedule from now on activation; keep it frozen while paused
    nextRun: body.active ? computeNextRun(rule, now)?.toISOString() ?? null : rule.nextRun,
  }
  const nextRules = [...rules]
  nextRules[idx] = next
  const effectiveRowId = await writeConfig(rowId, nextRules)

  await writeAudit(db, { userId: user.sub, action: 'RECURRING_PO_SAVED', entityType: 'Integration', entityId: effectiveRowId, details: jstr({ ruleId, active: next.active, nextRun: next.nextRun }) })

  return ok({ rule: next })
}

export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const ruleId = req.nextUrl.searchParams.get('id') || ''
  if (!ruleId) return fail('Manjka ID pravila.', 400)

  const { rowId, rules } = await readConfig()
  const nextRules = rules.filter((r) => r.id !== ruleId)
  if (nextRules.length === rules.length) return fail('Pravilo ne obstaja.', 404)
  const effectiveRowId = await writeConfig(rowId, nextRules)

  await writeAudit(db, { userId: user.sub, action: 'RECURRING_PO_DELETED', entityType: 'Integration', entityId: effectiveRowId, details: jstr({ ruleId }) })

  return ok({ deleted: ruleId })
}
