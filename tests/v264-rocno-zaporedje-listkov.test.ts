/**
 * v1.264.0 — ROČNO ZAPOREDJE LISTKOV NA KDS
 * (docs/PRIMERJAVA-VMESNIKOV-2026 §38; Square Vol 16 | 5. 11. 2026 | v7.32
 * »Draggable ticket reordering on KDS« — prvi odkljukani kandidat §37,
 * prvi SREDNJE-VELIK val od §32: nosilec, ki ga Order ni imel).
 *
 * Merjena semantika (Square dobesedno, §37 izmera): vlečenje listkov na
 * Prep + Expo zaslonih; vrstni red »Manual« PER NAPRAVA; sekvenca se
 * SHRANI in sinhronizira na druge KDS naprave iste lokacije z istim
 * načinom. Naša določitev Ž9: Order.ticketSequence INTEGER NULL (ena
 * globalna sekvenca per lokacija), način Default/Manual v localStorage
 * (Issue #74 družina), Manual sort = sekvenca ASC → brez mesta konec po
 * createdAt; velja SAMO na aktivni izmeni (osnutki/zastareli obdržijo
 * svoj red); polna zamenjava sekvence (ne-podani aktivni ZA podanimi);
 * dve interakciji (ročaj pointer-drag + tipki ↑/↓ — touch ne sproži
 * HTML5 DnD); pre-DDL vrsta enaka default + PATCH 503; SSE podpis se
 * NAMERNO ne dvigne (reorder ni vsebinska sprememba — lažni utrip NOV).
 *
 *  Č1 · ČISTI SLOJ (kds-ticket-order.ts, 0 uvozov): sekvenca ASC;
 *    NULL/undefined konec po createdAt; NaN/Infinity defenzivno konec;
 *    izenačitve po času; stabilnost popolne izenačitve; vhod nedotaknjen;
 *    overload privzetih dostopnikov; prazna/samo-1 ista vsebina;
 *    parseReorderPayload (pravilen/prazen/ne-array/duplikat/ne-string/
 *    dolžina mej/500 limit/null telo).
 *  Č2 · API + DDL + MONTAŽA: GET enrichment (mapa samo vpisanih + DDL
 *    zastavica, graceful pre-DDL); PATCH reorder veja (validacija 409,
 *    transakcijsko pisanje, audit KDS_TICKET_REORDER, 503 pre-DDL,
 *    idempotenca already); DDL ruta (stavek, centralna vloga, audit,
 *    alreadyApplied); register 42 + konzola handler; UI montaža (uvoz,
 *    ro_kds_ticket_order, ročaj regija, drop tarče, preklop, tipke);
 *    KdsStationBoard brez vlečenja (iskrena meja); SSE brez publishEvent
 *    v reorder veji (dokazljiva koda).
 *  Ž · REGISTRI: verzija 1.264.0, mirror DA / main NE, drift matcher
 *    dvosmerno strogo SAMO Order.ticketSequence, i18n pariteta
 *    4133/4133 (+8 ključev), dokument §38 + AUDIT POSODOBITEV,
 *    worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { applyManualTicketOrder, parseReorderPayload } from '../src/lib/kds-ticket-order'
import {
  resetKdsTicketSequenceProbe,
  readTicketSequences,
  writeTicketSequences,
  kdsTicketSequenceAvailable,
} from '../src/lib/kds-ticket-sequence'
import { APP_VERSION } from '../src/lib/version'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { isKdsTicketSequenceStatement } from '../scripts/drift-check'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

/** Kandidat listka za čiste teste. */
interface TicketT {
  id: string
  ticketSequence: number | null | undefined
  createdAt: string
}
const mk = (id: string, seq: number | null | undefined, iso: string): TicketT => ({ id, ticketSequence: seq, createdAt: iso })
const ids = (ts: TicketT[]): string[] => ts.map((t) => t.id)

// ── Č1) ČISTI SLOJ ──

describe('v1.264.0 Č1 — applyManualTicketOrder / parseReorderPayload (čisti sloj)', () => {
  test('Č1a: sekvenca NARAŠČAJOČE (2 pred 5 pred 9, neodvisno od časa)', () => {
    const out = applyManualTicketOrder(
      [mk('a', 5, '2026-11-08T10:05:00Z'), mk('b', 2, '2026-11-08T10:02:00Z'), mk('c', 9, '2026-11-08T10:00:00Z')],
      (t) => t.ticketSequence,
      (t) => t.createdAt,
    )
    expect(ids(out)).toEqual(['b', 'a', 'c'])
  })

  test('Č1b: brez mesta (null/undefined) → KONEC po izpeljanem redu (createdAt)', () => {
    const out = applyManualTicketOrder(
      [mk('novo2', null, '2026-11-08T10:09:00Z'), mk('rocno', 0, '2026-11-08T10:05:00Z'), mk('novo1', undefined, '2026-11-08T10:07:00Z')],
      (t) => t.ticketSequence,
      (t) => t.createdAt,
    )
    // ročno razvrščen PRVI; nova naročila za njim po času vnosa (Square: novi
    // prihajajo ZA ročno razvrščenimi)
    expect(ids(out)).toEqual(['rocno', 'novo1', 'novo2'])
  })

  test('Č1c: NaN/Infinity defenzivno = ODSOTNO (konec, kar ne znamo izmeriti ne razvrščamo)', () => {
    const out = applyManualTicketOrder(
      [mk('a', Number.NaN, '2026-11-08T10:00:00Z'), mk('b', 1, '2026-11-08T10:01:00Z'), mk('c', Number.POSITIVE_INFINITY, '2026-11-08T10:02:00Z')],
      (t) => t.ticketSequence,
      (t) => t.createdAt,
    )
    expect(ids(out)).toEqual(['b', 'a', 'c'])
  })

  test('Č1d: izenačene sekvence → ČAS odloča (starejši prvi)', () => {
    const out = applyManualTicketOrder(
      [mk('pozneje', 3, '2026-11-08T10:05:00Z'), mk('prej', 3, '2026-11-08T10:01:00Z')],
      (t) => t.ticketSequence,
      (t) => t.createdAt,
    )
    expect(ids(out)).toEqual(['prej', 'pozneje'])
  })

  test('Č1e: popolna izenačitev (sekvenca + čas) → STABILNO vhodno (ES2019 stabilni sort)', () => {
    const src = [mk('x', null, '2026-11-08T10:00:00Z'), mk('y', null, '2026-11-08T10:00:00Z'), mk('z', null, '2026-11-08T10:00:00Z')]
    const out = applyManualTicketOrder(src, (t) => t.ticketSequence, (t) => t.createdAt)
    expect(ids(out)).toEqual(['x', 'y', 'z'])
  })

  test('Č1f: vhod ostane NEDOTAKNJEN (čista kopija — mutacija izključena)', () => {
    const src = [mk('a', 5, '2026-11-08T10:05:00Z'), mk('b', 2, '2026-11-08T10:02:00Z')]
    applyManualTicketOrder(src, (t) => t.ticketSequence, (t) => t.createdAt)
    expect(ids(src)).toEqual(['a', 'b'])
  })

  test('Č1g: prazen vhod → prazen izhod; samo-1 → ista vsebina', () => {
    expect(applyManualTicketOrder([], (t) => (t as TicketT).ticketSequence, (t) => (t as TicketT).createdAt)).toEqual([])
    const one = [mk('solo', null, '2026-11-08T10:00:00Z')]
    expect(ids(applyManualTicketOrder(one, (t) => t.ticketSequence, (t) => t.createdAt))).toEqual(['solo'])
  })

  test('Č1h: OVERLOAD privzetih dostopnikov (t.ticketSequence / t.createdAt brez dodatkov)', () => {
    // privzeto branje strukturnih polj (bez eksplicitnih dostopnikov)
    const out = applyManualTicketOrder<TicketT>([mk('b', null, '2026-11-08T10:01:00Z'), mk('a', 7, '2026-11-08T10:05:00Z')])
    expect(ids(out)).toEqual(['a', 'b'])
  })

  test('Č1i: parseReorderPayload — pravilen seznam gre skozi', () => {
    const r = parseReorderPayload({ reorder: ['o1', 'o2', 'o3'] })
    expect('orderIds' in r && r.orderIds).toEqual(['o1', 'o2', 'o3'])
  })

  test('Č1j: parseReorderPayload — zavrnjene oblike (prazno/ne-array/duplikat/ne-string/dolžina/limit/null)', () => {
    expect('error' in parseReorderPayload({ reorder: [] })).toBe(true)
    expect('error' in parseReorderPayload({ reorder: 'o1' })).toBe(true)
    expect('error' in parseReorderPayload({ reorder: ['o1', 'o1'] })).toBe(true)
    expect('error' in parseReorderPayload({ reorder: ['o1', 42] })).toBe(true)
    expect('error' in parseReorderPayload({ reorder: [''] })).toBe(true)
    expect('error' in parseReorderPayload({ reorder: ['x'.repeat(65)] })).toBe(true)
    expect('error' in parseReorderPayload({ reorder: Array.from({ length: 501 }, (_, i) => `o${i}`) })).toBe(true)
    expect('error' in parseReorderPayload(null)).toBe(true)
    expect('error' in parseReorderPayload({})).toBe(true)
  })
})

// ── Č2) API + DDL + MONTAŽA ──

describe('v1.264.0 Č2 — API reorder veja + DDL + montaža', () => {
  test('Č2a: GET /api/kitchen nosi aditivni polji (mapa samo vpisanih + DDL zastavica, graceful)', () => {
    const route = read('src/app/api/kitchen/route.ts')
    expect(route).toContain('ticketSequences: Record<string, number> = {}')
    expect(route).toContain('ticketSequenceDdlActive')
    expect(route).toContain('readTicketSequences(queue.map((o) => o.id))')
    // graceful: isMissingSchemaError se propagira kot resnica, ne maskirana praznina
    expect(route).toContain('if (!isMissingSchemaError(e)) throw e')
  })

  test('Č2b: PATCH reorder veja — polna zamenjava, 409 tuji/ne-aktiven, audit, 503 pre-DDL, idempotenca', () => {
    const route = read('src/app/api/kitchen/route.ts')
    expect(route).toContain('parseReorderPayload(body)')
    expect(route).toContain('Listka ni v aktivni vrsti te lokacije')
    expect(route).toContain('writeTicketSequences(entries)')
    expect(route).toContain('KDS_TICKET_REORDER')
    // idempotenca: replay istega vrstnega reda → 200 already (brez pisanja)
    expect(route).toContain('if (unchanged) return ok({ reordered: 0, already: true })')
    // pre-DDL: write vrne sporočilo s potjo konzole → fail(..., 503)
    expect(route).toContain('if (writeErr) return fail(writeErr, 503)')
  })

  test('Č2c: writeTicketSequences pre-DDL → napaka s potjo konzole (nikoli tiha odpoved)', async () => {
    resetKdsTicketSequenceProbe(false)
    const err = await writeTicketSequences([{ orderId: 'o1', sequence: 0 }])
    expect(typeof err).toBe('string')
    expect(err).toContain('kds-ticket-sequence')
    // readTicketSequences pre-DDL → prazna mapa (graceful — vrsta enaka default)
    const seqs = await readTicketSequences(['o1', 'o2'])
    expect(seqs).toEqual({})
    // probe override ostane dokler ga test ne počisti (izolacija naslednjih)
    resetKdsTicketSequenceProbe()
    await expect(kdsTicketSequenceAvailable()).resolves.toBeTruthy()
  })

  test('Č2d: DDL ruta — natančen stavek, idempotenca, centralna vloga, audit', () => {
    const route = read('src/app/api/admin/migrate-kds-ticket-sequence/route.ts')
    expect(route).toContain('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "ticketSequence" INTEGER')
    expect(route).toContain('requireCentralRole')
    expect(route).toContain('SCHEMA_MIGRATION_KDS_TICKET_SEQUENCE')
    expect(route).toContain('alreadyApplied')
    expect(route).toContain('Tabela Order ne obstaja')
  })

  test('Č2e: register SCHEMA_MIGRATIONS 41 → 42 (kds-ticket-sequence) + konzola HANDLERS', () => {
    expect(SCHEMA_MIGRATIONS).toHaveLength(44)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'kds-ticket-sequence')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-kds-ticket-sequence')
    expect(m!.descKey).toBe('mig.kdsTicketSequence.desc')
    const consoleRoute = read('src/app/api/admin/migrations/route.ts')
    expect(consoleRoute).toContain("import { POST as kdsTicketSequencePOST } from '../migrate-kds-ticket-sequence/route'")
    expect(consoleRoute).toContain("'kds-ticket-sequence': kdsTicketSequencePOST")
  })

  test('Č2f: UI montaža — preklop načina, ročaj, tipke, drop tarče, persist', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("import { applyManualTicketOrder } from '@/lib/kds-ticket-order'")
    expect(page).toContain("ro_kds_ticket_order")
    expect(page).toContain('data-region="kds-ticket-reorder"')
    expect(page).toContain('data-region="kds-active-list"')
    expect(page).toContain('kdsTicketPointerDown')
    expect(page).toContain('kdsTicketMove')
    expect(page).toContain("kdsPersist('ro_kds_ticket_order', m)")
    expect(page).toContain('t(\'kds.orderModeDefault\')')
    expect(page).toContain('t(\'kds.orderModeManual\')')
    expect(page).toContain('t(\'kds.moveUp\')')
    expect(page).toContain('t(\'kds.reorderPending\')')
    // GET odgovor preslika v stanje (poll prinese sekvence drugih naprav)
    expect(page).toContain('setKdsSequences(k.ticketSequences ?? {})')
    expect(page).toContain('setKdsSeqDdlActive(k.ticketSequenceDdlActive === true)')
    // zaklep zaslona blokira tudi reorder (dosledno z §18 B bumpi)
    expect(page).toContain('const kdsTicketDragAllowed = !kdsViewOnly && kdsSeqDdlActive')
  })

  test('Č2g: KdsStationBoard BREZ vlečenja (iskrena meja §38 — FIFO požiga ostaja)', () => {
    const board = read('src/components/kds-station-board.tsx')
    expect(board).not.toContain('ticketSequence')
    expect(board).not.toContain('kdsTicketPointerDown')
  })

  test('Č2h: SSE meja — reorder veja NE objavi publishEvent (lažni utrip NOV izključen)', () => {
    const route = read('src/app/api/kitchen/route.ts')
    const branch = route.slice(route.indexOf('ROČNO ZAPOREDJE LISTKOV — {reorder'), route.indexOf('── A) postajna naloga'))
    expect(branch).toContain('reorder')
    expect(branch).not.toContain('publishEvent')
  })
})

// ── Ž) REGISTRI ──

describe('v1.264.0 Ž — registri', () => {
  test('Ž1: verzija 1.264.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.275.0')
    expect(read('src/lib/version.ts')).toContain("'1.275.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.275.0')
  })

  test('Ž2: i18n pariteta SL/HR 4133/4133 (+8 ključev vala)', () => {
    for (const k of [
      'kds.orderModeDefault', 'kds.orderModeManual', 'kds.orderModeTitle',
      'kds.dragHandle', 'kds.moveUp', 'kds.moveDown', 'kds.reorderPending',
      'mig.kdsTicketSequence.desc',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    expect(Object.keys(sl).length).toBe(4320)
    expect(Object.keys(hr).length).toBe(4320)
  })

  test('Ž3: SQLite mirror nosi stolpec, MAIN shema GA NE (P2022 disciplina)', () => {
    expect(read('prisma/schema.sqlite.prisma')).toContain('ticketSequence                         Int?')
    const main = read('prisma/schema.prisma')
    expect(main).not.toContain('ticketSequence')
  })

  test('Ž4: drift matcher — dvosmerno strogo SAMO Order.ticketSequence', () => {
    expect(isKdsTicketSequenceStatement('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "ticketSequence" INTEGER')).toBe(true)
    expect(isKdsTicketSequenceStatement('ALTER TABLE "Order" DROP COLUMN "ticketSequence"')).toBe(true)
    // tuji stolpec na Order = hard fail (kamuflaža izključena)
    expect(isKdsTicketSequenceStatement('ALTER TABLE "Order" ADD COLUMN "prepPriority" INTEGER')).toBe(false)
    expect(isKdsTicketSequenceStatement('ALTER TABLE "Order" ADD COLUMN "ticketSequence", ADD COLUMN "notes2" TEXT')).toBe(false)
    // druga tabela = ni ta vnos
    expect(isKdsTicketSequenceStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "ticketSequence" INTEGER')).toBe(false)
  })

  test('Ž5: dokument §38 + AUDIT POSODOBITEV v1.264.0', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 38.')
    expect(doc).toContain('ROČNO ZAPOREDJE LISTKOV NA KDS v1.264.0')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('POSODOBITEV (v1.264.0, PRIMERJAVA-VMESNIKOV-2026 §38)')
  })

  test('Ž6: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.275.0-diakritike-payroll-izvoz')
  })
})
