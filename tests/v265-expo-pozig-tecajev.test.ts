/**
 * v1.265.0 — EXPO POŽIG ZADRŽANIH TEČAJEV S KDS
 * (docs/PRIMERJAVA-VMESNIKOV-2026 §39; Square Vol 16 | 5. 11. 2026 | v7.32
 * »Fire held courses from an Expo KDS« — drugi odkljukani kandidat §37).
 *
 * Merjena semantika (Square dobesedno, §37 izmera): tap glave tečaja na
 * Expo KDS → odštevanje → drugi tap prekliče; nastavitev per lokacija
 * »Allow Firing from Expo KDS«. Naša določitev Ž10: Location.kdsExpoFireEnabled
 * BOOLEAN NOT NULL DEFAULT FALSE (per-lokacijska pristojnostna odločitev —
 * pri Square ekspeditor kuha, pri nas natakar); fire ruta dovoli
 * orders.create (POS, nespremenjeno) ALI kitchen.update + nastavitev
 * VKLOPLJENA na lokaciji naročila; dvotapna potrditev 3 s (KDS_EXPO_FIRE_
 * COUNTDOWN_MS) na glavah PENDING tečajev ŽIVIH listkov; pre-DDL mapa
 * expoFireLocations prazna (graceful — požig s KDS povsod izklopljen);
 * KdsStationBoard brez požiga (po-stajni FIFO ostaja, iskrena meja).
 *
 *  Č1 · ČISTI SLOJ (kds-courses.ts aditivno, 0 uvozov): odštevanje
 *    3→2→1; potek/negativni remain → 0; NaN/Infinity defenzivno 0;
 *    konstanti (3000 ms countdown, 250 ms tick).
 *  Č2 · API + DDL + MONTAŽA: fire ruta dvojna avtorizacija
 *    (requireAnyPermission orders.create|kitchen.update) + KDS veja
 *    (403 izklopljeno, source:'kds' auditExtra, POS pot brez polja);
 *    GET /api/kitchen expoFireLocations + graceful isMissingSchemaError;
 *    locations PATCH veja (boolean validacija, raw write, 503 pre-DDL,
 *    revizija) + GET (kdsExpoFireEnabled per vrstico + DDL zastavica);
 *    DDL ruta (stavek, centralna vloga, audit, alreadyApplied);
 *    register 43 + konzola handler; UI montaža (gumb na glavi tečaja,
 *    aria/title, countdown regija, avto-preklic, viewOnly/draft/stale
 *    izključitve, dialog preklop + DDL nasvet); KdsStationBoard brez
 *    požiga (iskrena meja).
 *  Ž · REGISTRI: verzija 1.265.0, mirror DA / main NE, drift matcher
 *    dvosmerno strogo SAMO Location.kdsExpoFireEnabled, i18n pariteta
 *    4320/4320 (+9 ključev), dokument §39 + AUDIT POSODOBITEV,
 *    worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { KDS_EXPO_FIRE_COUNTDOWN_MS, KDS_EXPO_FIRE_TICK_MS, expoFireCountdownSeconds } from '../src/lib/kds-courses'
import { resetKdsExpoFireProbe, kdsExpoFireAvailable, expoFireEnabledFor, writeKdsExpoFire, DEFAULT_KDS_EXPO_FIRE_ENABLED } from '../src/lib/kds-expo-fire'
import { APP_VERSION } from '../src/lib/version'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { isKdsExpoFireStatement } from '../scripts/drift-check'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) ČISTI SLOJ (kds-courses.ts — client-safe aditivi §39) ──

describe('v1.265.0 Č1 — expoFireCountdownSeconds + konstanti (čisti sloj)', () => {
  test('Č1a: odštevanje v CELIH sekundah 3 → 2 → 1 (ceil, ne floor)', () => {
    const until = 10_000
    expect(expoFireCountdownSeconds(until, 7_000)).toBe(3)
    expect(expoFireCountdownSeconds(until, 7_999)).toBe(3)
    expect(expoFireCountdownSeconds(until, 8_000)).toBe(2)
    expect(expoFireCountdownSeconds(until, 9_001)).toBe(1)
    expect(expoFireCountdownSeconds(until, 9_999)).toBe(1)
  })

  test('Č1b: potek in negativni preostanek → 0 (nula ni »še čas«)', () => {
    expect(expoFireCountdownSeconds(10_000, 10_000)).toBe(0)
    expect(expoFireCountdownSeconds(10_000, 10_500)).toBe(0)
    expect(expoFireCountdownSeconds(10_000, 99_999)).toBe(0)
  })

  test('Č1c: NaN/Infinity defenzivno → 0 (§36 disciplina — kar ne znamo izmeriti, ne odštevamo)', () => {
    expect(expoFireCountdownSeconds(Number.NaN, 1_000)).toBe(0)
    expect(expoFireCountdownSeconds(10_000, Number.NaN)).toBe(0)
    expect(expoFireCountdownSeconds(Number.POSITIVE_INFINITY, 1_000)).toBe(0)
    expect(expoFireCountdownSeconds(10_000, Number.POSITIVE_INFINITY)).toBe(0)
  })

  test('Č1d: konstanti odštevanja — 3 s potrditev, 250 ms tick (4×/s)', () => {
    expect(KDS_EXPO_FIRE_COUNTDOWN_MS).toBe(3_000)
    expect(KDS_EXPO_FIRE_TICK_MS).toBe(250)
  })

  test('Č1e: privzetek nastavitve je IZKLOPLJENO (požig s KDS nemogoč brez izrecnega vklopa)', () => {
    expect(DEFAULT_KDS_EXPO_FIRE_ENABLED).toBe(false)
  })
})

// ── Č2) API + DDL + MONTAŽA ──

describe('v1.265.0 Č2 — dvojna avtorizacija + DDL + UI montaža', () => {
  test('Č2a: fire ruta — requireAnyPermission orders.create | kitchen.update (OR logika P0-B)', () => {
    const route = read('src/app/api/orders/[id]/fire/route.ts')
    expect(route).toContain("requireAnyPermission(req, ['orders.create', 'kitchen.update'])")
    // KDS veja: klicatelj BREZ orders.create potrebuje nastavitev lokacije naročila
    expect(route).toContain("expoFireEnabled(order.locationId)")
    expect(route).toContain('Požig s KDS je za to lokacijo izklopljen')
    // audit: KDS pot nosi source:'kds' (POS pot byte-identična — brez polja)
    expect(route).toContain("auditExtra: { source: 'kds' }")
    expect(route).toContain("...(kdsSource ? { auditExtra: { source: 'kds' } } : {})")
  })

  test('Č2b: GET /api/kitchen — aditivni expoFireLocations (lokacije iz vrste, graceful pre-DDL)', () => {
    const route = read('src/app/api/kitchen/route.ts')
    expect(route).toContain('expoFireLocations: Record<string, boolean> = {}')
    expect(route).toContain('expoFireEnabledFor(locIds)')
    expect(route).toContain('const locIds = [...new Set(queue.map((o) => o.locationId)')
    // graceful: isMissingSchemaError se propagira kot resnica, ne maskirana praznina
    expect(route).toContain('if (!isMissingSchemaError(e)) throw e')
    // SSE: OrderFired ostaja iz fireOrderCore (obstoječi dogodek — BREZ novega)
    expect(route).not.toContain("publishEvent('ExpoFire")
  })

  test('Č2c: kds-expo-fire sloj — pre-DDL read {} / write napaka s potjo konzole (nikoli tiha odpoved)', async () => {
    resetKdsExpoFireProbe(false)
    const map = await expoFireEnabledFor(['loc-1', 'loc-2'])
    expect(map).toEqual({})
    const err = await writeKdsExpoFire('loc-1', true)
    expect(typeof err).toBe('string')
    expect(err).toContain('kds-expo-fire')
    // boolean-only validacija
    const bad = await writeKdsExpoFire('loc-1', 'da' as unknown as boolean)
    expect(typeof bad).toBe('string')
    expect(bad).toContain('true/false')
    // probe override ostane dokler ga test ne počisti (izolacija naslednjih)
    resetKdsExpoFireProbe()
    await expect(kdsExpoFireAvailable()).resolves.toBeTruthy()
  })

  test('Č2d: DDL ruta — natančen stavek, idempotenca, centralna vloga, audit', () => {
    const route = read('src/app/api/admin/migrate-kds-expo-fire/route.ts')
    expect(route).toContain('ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "kdsExpoFireEnabled" BOOLEAN NOT NULL DEFAULT FALSE')
    expect(route).toContain('requireCentralRole')
    expect(route).toContain('SCHEMA_MIGRATION_KDS_EXPO_FIRE')
    expect(route).toContain('alreadyApplied')
    expect(route).toContain('Tabela Location ne obstaja')
  })

  test('Č2e: register SCHEMA_MIGRATIONS 42 → 43 (kds-expo-fire) + konzola HANDLERS', () => {
    expect(SCHEMA_MIGRATIONS).toHaveLength(44)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'kds-expo-fire')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-kds-expo-fire')
    expect(m!.descKey).toBe('mig.kdsExpoFire.desc')
    const consoleRoute = read('src/app/api/admin/migrations/route.ts')
    expect(consoleRoute).toContain("import { POST as kdsExpoFirePOST } from '../migrate-kds-expo-fire/route'")
    expect(consoleRoute).toContain("'kds-expo-fire': kdsExpoFirePOST")
  })

  test('Č2f: locations PATCH veja — boolean validacija, 503 pre-DDL, revizija, sveža vrednost', () => {
    const route = read('src/app/api/locations/[id]/route.ts')
    expect(route).toContain('kdsExpoFireEnabled mora biti true/false.')
    expect(route).toContain('writeKdsExpoFire(id, body.kdsExpoFireEnabled)')
    expect(route).toContain('return fail(err, 503)')
    // revizija LOCATION_UPDATE nosi spremembo (dokazljiva sled)
    expect(route).toContain('kdsExpoFireEnabled: kdsExpoFireChanged')
    // samo-nastavitev (brez naslovnih polj) ne potrebuje Prisma update klica
    expect(route).toContain('if (Object.keys(data).length > 0)')
  })

  test('Č2g: locations GET — kdsExpoFireEnabled per vrstica + kdsExpoFireDdlActive', () => {
    const route = read('src/app/api/locations/route.ts')
    expect(route).toContain('kdsExpoFireEnabled: kdsExpoFire[l.id] === true')
    expect(route).toContain('kdsExpoFireDdlActive')
    expect(route).toContain('kdsExpoFireAvailable()')
  })

  test('Č2h: UI montaža — gumb na glavi tečaja, aria/title, countdown, izključitve, dialog', () => {
    const page = read('src/app/dashboard/page.tsx')
    // uvoz čistega sloja + arm stanje
    expect(page).toContain("KDS_EXPO_FIRE_COUNTDOWN_MS, KDS_EXPO_FIRE_TICK_MS, expoFireCountdownSeconds")
    expect(page).toContain('kdsFireArm')
    expect(page).toContain('setKdsFireArm({ orderId: o.id, courseId: expoCourseId, label: g.label, until: Date.now() + KDS_EXPO_FIRE_COUNTDOWN_MS })')
    // glava tečaja = gumb z a11y (aria-label + title) + countdown regija
    expect(page).toContain("data-region=\"kds-expo-fire-countdown\"")
    expect(page).toContain("t('kds.expoFireArm', { name: g.label })")
    expect(page).toContain("t('kds.expoFireArmed', { s: remainSec })")
    expect(page).toContain("t('kds.expoFireHint')")
    // izključitve: osnutki §32, zastareli #70, zaklep §18 B, že poslani tečaji
    expect(page).toContain('!draft && !stale && !kdsViewOnly && !g.fired')
    // dostop: orders.create ALI kitchen.update + nastavitev lokacije (strežnik avtoritativen)
    expect(page).toContain("perms.includes('orders.create') || (perms.includes('kitchen.update') && kdsExpoFireLocs[o.locationId ?? ''] === true)")
    // avto-preklic: tečaj med odštevanjem preide v fired → arm ugasne (brez 409)
    expect(page).toContain("c.status !== 'pending'")
    // poll preslika mapo (nastavitev drugih naprav/lokacij se vidi v 15 s)
    expect(page).toContain('setKdsExpoFireLocs(k.expoFireLocations ?? {})')
    // potek = POST fire {courseId} + toast potrditev + load('hot')
    expect(page).toContain("JSON.stringify({ courseId })")
    expect(page).toContain("t('kds.expoFireDone', { name: label, n: d.firedCount })")
    // dialog lokacije: preklop + DDL nasvet (migrBox v1.197) + pošiljanje SAMO ob spremembi
    expect(page).toContain("t('loc.kdsExpoFire')")
    expect(page).toContain("t('loc.kdsExpoFireDdl')")
    expect(page).toContain('kdsExpoFireDdlActive && locKdsExpoFire !== (locEditing.kdsExpoFireEnabled === true)')
    // gumb urejanja lokacije prevzame trenutno vrednost
    expect(page).toContain('setLocKdsExpoFire(l.kdsExpoFireEnabled === true)')
  })

  test('Č2i: KdsStationBoard BREZ požiga (iskrena meja §39 — po-stajni FIFO ostaja)', () => {
    const board = read('src/components/kds-station-board.tsx')
    expect(board).not.toContain('kdsFireArm')
    expect(board).not.toContain('expoFire')
  })

  test('Č2j: SSE meja — požig s KDS ne uvaja NOVEGA dogodka (OrderFired iz fireOrderCore že pokriva)', () => {
    const fire = read('src/lib/order-fire.ts')
    expect(fire).toContain("publishEvent('OrderFired'")
    const fireRoute = read('src/app/api/orders/[id]/fire/route.ts')
    expect(fireRoute).not.toContain("publishEvent('Kds")
  })
})

// ── Ž) REGISTRI ──

describe('v1.265.0 Ž — registri', () => {
  test('Ž1: verzija 1.265.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.285.0')
    expect(read('src/lib/version.ts')).toContain("'1.285.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.285.0')
  })

  test('Ž2: i18n pariteta SL/HR 4324/4324 (+4 ključi v1.279.0)', () => {
    for (const k of [
      'kds.expoFireArm', 'kds.expoFireHint', 'kds.expoFireArmed',
      'kds.expoFireCancel', 'kds.expoFireDone',
      'loc.kdsExpoFire', 'loc.kdsExpoFireHint', 'loc.kdsExpoFireDdl',
      'mig.kdsExpoFire.desc',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('Ž3: SQLite mirror nosi stolpec, MAIN shema GA NE (P2022 disciplina)', () => {
    expect(read('prisma/schema.sqlite.prisma')).toContain('kdsExpoFireEnabled          Boolean                 @default(false)')
    const main = read('prisma/schema.prisma')
    expect(main).not.toContain('kdsExpoFireEnabled')
  })

  test('Ž4: drift matcher — dvosmerno strogo SAMO Location.kdsExpoFireEnabled', () => {
    expect(isKdsExpoFireStatement('ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "kdsExpoFireEnabled" BOOLEAN NOT NULL DEFAULT FALSE')).toBe(true)
    expect(isKdsExpoFireStatement('ALTER TABLE "Location" DROP COLUMN "kdsExpoFireEnabled"')).toBe(true)
    // tuji stolpec na Location = hard fail (kamuflaža izključena)
    expect(isKdsExpoFireStatement('ALTER TABLE "Location" ADD COLUMN "prepPriority" INTEGER')).toBe(false)
    expect(isKdsExpoFireStatement('ALTER TABLE "Location" ADD COLUMN "kdsExpoFireEnabled", ADD COLUMN "notes2" TEXT')).toBe(false)
    // druga tabela = ni ta vnos
    expect(isKdsExpoFireStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "kdsExpoFireEnabled" BOOLEAN')).toBe(false)
    expect(isKdsExpoFireStatement('ALTER TABLE "Order" ADD COLUMN "ticketSequence" INTEGER')).toBe(false)
  })

  test('Ž5: dokument §39 + AUDIT POSODOBITEV v1.265.0', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 39.')
    expect(doc).toContain('EXPO POŽIG ZADRŽANIH TEČAJEV S KDS v1.265.0')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('POSODOBITEV (v1.265.0, PRIMERJAVA-VMESNIKOV-2026 §39)')
  })

  test('Ž6: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.285.0-sweep-gotovina-gostje')
  })
})
