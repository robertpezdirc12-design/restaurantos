import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { AUTO86_CONFIG_MARKER, parseAuto86Config } from '@/lib/auto-86'

/**
 * v1.230.0 — konfiguracija samodejnega 86 (docs/PRIMERJAVA-VMESNIKOV-2026.md §5).
 *
 * GET  /api/auto86 → trenutna konfiguracija ({ enabled, mode }); brez vrstice →
 *                   privzeta (direct, vklopljeno) — odgovor vedno vsebuje OBEMA
 *                   polji v kanonični obliki (fiksni nabor, ne preslikava DB).
 * PUT  /api/auto86 { enabled: boolean, mode: 'direct' | 'recipe' }
 *                   → upsert Integration vrstice (0 DDL, isti vzorec kot
 *                     low-stock-state / notification-rules) + revizija.
 *
 * Pravice: inventory.manage (skladiščnik/vodja/podjetje — isti lastnik zaloge).
 * 'direct' = samo neposredno povezani artikli (InventoryItem.menuItemId —
 * pakirane pijače, varno privzeto); 'recipe' = tudi vsi potrošniki po recepturi
 * (Toast »86 when ingredients run out« — opt-in, zahteva disciplinirane recepte).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const row = await db.integration.findFirst({ where: { name: AUTO86_CONFIG_MARKER, type: 'other' } })
  return ok({ config: parseAuto86Config(row?.config) })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const enabled = body?.enabled
  const mode = body?.mode
  if (typeof enabled !== 'boolean') return fail('Polje "enabled" (boolean) je obvezno.', 400)
  if (mode !== 'direct' && mode !== 'recipe') return fail('Polje "mode" mora biti "direct" ali "recipe".', 400)

  const existing = await db.integration.findFirst({ where: { name: AUTO86_CONFIG_MARKER, type: 'other' }, select: { id: true, config: true } })
  const prev = parseAuto86Config(existing?.config)
  const config = { enabled, mode } as const
  const configJson = JSON.stringify(config)

  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: configJson } })
  } else {
    await db.integration.create({
      data: {
        id: `auto86-config-${Date.now().toString(36)}`,
        name: AUTO86_CONFIG_MARKER,
        type: 'other',
        provider: 'internal',
        config: configJson,
        isActive: true,
        syncEnabled: false,
      },
    })
  }

  await writeAudit(db, {
    userId: user.sub,
    action: 'AUTO86_CONFIG_UPDATED',
    entityType: 'Integration',
    entityId: existing?.id || AUTO86_CONFIG_MARKER,
    details: jstr({ from: prev, to: config, by: user.name }),
  })
  return ok({ config })
}
