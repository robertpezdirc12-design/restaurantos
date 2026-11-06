import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr, jparse } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import {
  KDS_STATION_PROFILE_MARKER,
  KDS_PROFILE_MAX_STATIONS,
  isValidProfileStationKey,
  sanitizeKdsStationProfile,
  sanitizeKdsProfileMap,
  type KdsStationProfile,
} from '@/lib/kds-station-profile'

/**
 * v1.267.0 (PRIMERJAVA §41, Lightspeed julij 2026 »Restore KDS stations in
 * seconds«) — STREŽNIŠKI PROFIL KDS POSTAJE.
 *
 * GET  /api/kitchen/profile → { profiles: { [stationKey]: profil } }
 *      (kanonično sanitizirano; brez vrstice → {})
 * PUT  /api/kitchen/profile → { station, profile } → SANITIZIRAJ (čisti
 *      sloj — neveljavna polja padejo na privzete) → MERGE ene postaje v
 *      obstoječi zemljevid (dve tablici, ki hkrati shranjujeta RAZLIČNI
 *      postaji, si ne povozieta vrstice) → revizija
 *      KDS_STATION_PROFILE_SAVED { station, from, to, by }.
 *
 * Pravice: kitchen.update (ista vrata kot GET /api/kitchen — profil vodi
 * kuhinja/šank/vodstvo, ki zaslon tudi bere; natakar nima KDS zaslona).
 *
 * NOSILEC: GLOBALNA Integration vrstica (name='kds-station-profile',
 * type='other', BREZ locationId — vzorec auto86 v1.230.0 / kiosk-upsell
 * v1.78.0). E2E najdba #1 (demo, 6. 11. 2026): KDS zaslon teče v org-
 * obsegu (»Vse lokacije« + ?station= brez lokacijske vezi — enako kot
 * GET /api/kitchen); pacing-vzorec (per lokacija + requireUserLocation)
 * je centralnemu uporabniku na 5 lokacijah vrnil 400 brez poti naprej.
 * Postaje (PrepStation.id, cuid) so globalno unikatne čez lokacije;
 * bucket ključi (ALL/KITCHEN/BAR) so privzetki ZASLONA, ne lokacije —
 * profil je lastnost postaje/zaslona, zato živi v eni globalni vrstici.
 *
 * 0 DDL (Integration tabela obstaja) · brez lokacijskega ugibanja.
 */

async function loadMap(): Promise<Record<string, KdsStationProfile>> {
  const row = await db.integration.findFirst({
    where: { name: KDS_STATION_PROFILE_MARKER, type: 'other' },
    select: { config: true },
  })
  // E2E najdba #2: config stolpec je NIZ (JSON tekst) — sanitize zavrže ne-objekt,
  // zato MORA razčleniti najprej (vzorec jparse v kiosk-upsell / parsePacingConfig).
  return sanitizeKdsProfileMap(jparse<unknown>(row?.config, null))
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user
  return ok({ profiles: await loadMap() })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as { station?: unknown; profile?: unknown } | null
  if (!body || typeof body !== 'object') return fail('Manjkajoči ali neveljaven JSON.', 400)

  // validacija postaje (ista regularnost kot ?station= inicializator)
  if (!isValidProfileStationKey(body.station)) {
    return fail('Neveljaven ključ postaje (ALL/KITCHEN/BAR ali id poimenovane postaje).', 400)
  }
  if (!body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile)) {
    return fail('Polje "profile" (objekt) je obvezno.', 400)
  }

  const station = body.station
  const existing = await loadMap()
  const prev = existing[station] ?? null
  if (prev === null && Object.keys(existing).length >= KDS_PROFILE_MAX_STATIONS) {
    return fail(`Dosežena zgornja meja profilov postaj (${KDS_PROFILE_MAX_STATIONS}).`, 400)
  }
  const next: KdsStationProfile = sanitizeKdsStationProfile(
    body.profile,
    new Date().toISOString(),
    user.name || 'kuhinja',
  )
  const merged = { ...existing, [station]: next }
  const configJson = JSON.stringify(merged)

  const row = await db.integration.findFirst({
    where: { name: KDS_STATION_PROFILE_MARKER, type: 'other' },
    select: { id: true },
  })
  if (row) {
    await db.integration.update({ where: { id: row.id }, data: { config: configJson } })
  } else {
    await db.integration.create({
      data: {
        id: `kds-profile-${Date.now().toString(36)}`,
        name: KDS_STATION_PROFILE_MARKER,
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
    action: 'KDS_STATION_PROFILE_SAVED',
    entityType: 'Integration',
    entityId: row?.id || KDS_STATION_PROFILE_MARKER,
    details: jstr({ station, from: prev, to: next, by: user.name }),
  }).catch(() => null)
  return ok({ profiles: merged })
}
