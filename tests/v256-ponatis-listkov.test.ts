/**
 * v1.256.0 — PONATIS LISTKOV ZAPRTIH NAROČIL (docs/PRIMERJAVA-
 * VMESNIKOV-2026 §30; Lightspeed maj 2026 »Reprint orders« —
 * »reprint kitchen tickets for CLOSED orders, with a selection of
 * production centers«; kandidat z evidence liste §22 D).
 *
 * Merjena situacija: ponatis kuhinjskega/bar lista je obstajal SAMO
 * na KDS plošči (aktivna naročila). Plačano naročilo je živelo naprej
 * samo kot račun (Print fiskalnega izstavka + Storno) — listka ni bilo
 * mogoče rekonstruirati ob sporu (»gost pravi, da jed ni prispela«).
 *
 *  A · ČISTI SLOJ (print.ts): filterTicketItems (iskrenost — ponatis
 *    nosi SAMO produkcijo, ki je nastala: voided/cancelled IZPUSTI) +
 *    buildKitchenTicketLines reprint kontekst (glava PONATIS, izvirni
 *    čas naročija, vrstica ponatisnika; brez konteksta je izhod
 *    NESPREMENJEN — KDS pot pinta obstoječe obnašanje).
 *  B · RUTA (reprint-ticket): vrata (reports.sales ALI kitchen.update),
 *    lokacijski varuh, stroga station validacija, revizija
 *    ORDER_TICKET_REPRINT, BREZ spremembe stanja (brez publishEvent).
 *  Ž · MONTAŽA + REGISTRI: gumb na obeh površinah računov (seznam +
 *    rezultati skeniranja), dialog izbire središča s števci, POST →
 *    tisk po uspehu, i18n pariteta, 0 DDL dokaz.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  buildKitchenTicketLines,
  filterTicketItems,
} from '../src/lib/devices/print'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

const pageSrc = read('src/app/dashboard/page.tsx')
const routeSrc = read('src/app/api/orders/[id]/reprint-ticket/route.ts')
const printSrc = read('src/lib/devices/print.ts')

// ── A) ČISTI SLOJ ──

describe('v1.256.0 A1 — filterTicketItems: iskrenost ponatisa', () => {
  test('A1a: voided in cancelled/voided-status postavke se IZPUSTIJO', () => {
    const items = [
      { name: 'Juha', qty: 1, status: 'served', voided: false },
      { name: 'Zrezek', qty: 2, status: 'CANCELLED', voided: false },
      { name: 'Pivo', qty: 1, status: 'fired', voided: true },
      { name: 'Solata', qty: 1, status: 'voided', voided: false },
    ]
    const live = filterTicketItems(items)
    expect(live.map((i) => i.name)).toEqual(['Juha'])
  })

  test('A1b: defenzivno — manjkajoč status/voided je AKTIVNA postavka (neznano ≠ preklicano)', () => {
    const items = [
      { name: 'Juha', qty: 1 },
      { name: 'Pivo', qty: 1, status: undefined, voided: undefined },
      { name: 'Kava', qty: 1, status: null, voided: null },
    ]
    expect(filterTicketItems(items).length).toBe(3)
  })

  test('A1c: defenzivno — ne-seznam vrne prazen seznam (ne explode)', () => {
    expect(filterTicketItems(null as unknown as [])).toEqual([])
    expect(filterTicketItems(undefined as unknown as [])).toEqual([])
  })

  test('A1d: velike/male črke statusa (CANCELLED/cancelled/Cancelled)', () => {
    expect(filterTicketItems([{ status: 'Cancelled', voided: false }]).length).toBe(0)
    expect(filterTicketItems([{ status: 'cancelled', voided: false }]).length).toBe(0)
    expect(filterTicketItems([{ status: 'Served', voided: false }]).length).toBe(1)
  })
})

describe('v1.256.0 A2 — reprint glava: PONATIS je VIDNO označen', () => {
  const baseOrder = {
    orderNumber: 42,
    tableName: 'Miza 3',
    type: 'DINE_IN',
    createdAt: '2026-11-05T18:30:00.000Z',
    employeeName: 'Ana',
    items: [{ name: 'Juha', qty: 1, note: null, station: 'KITCHEN', allergenWarning: null, allergenCodes: [], modifiers: [] }],
  }

  test('A2a: glava nosi PONATIS predpono pri vseh treh središčih', () => {
    expect(buildKitchenTicketLines(baseOrder, 'KITCHEN', { by: 'Vodja' })[0].text)
      .toBe('=== PONATIS · KUHINJSKI LIST ===')
    expect(buildKitchenTicketLines(baseOrder, 'BAR', { by: 'Vodja' })[0].text)
      .toBe('=== PONATIS · BAR LIST ===')
    expect(buildKitchenTicketLines(baseOrder, undefined, { by: 'Vodja' })[0].text)
      .toBe('=== PONATIS · KUHINJA ===')
  })

  test('A2b: izvirni čas naročila je na listku (prej ga je builder ignoriral)', () => {
    const lines = buildKitchenTicketLines(baseOrder, 'KITCHEN', { by: 'Vodja' })
    const orig = lines.find((l) => l.text.startsWith('Izvirno naročilo:'))
    expect(orig).toBeTruthy()
    expect(orig!.text).toContain('5. 11. 2026') // dan.mesec.leto izvirnega naročila
  })

  test('A2c: vrstica ponatisnika z imenom (revizijska identiteta na papirju)', () => {
    const lines = buildKitchenTicketLines(baseOrder, 'KITCHEN', { by: '  Ana Novak  ' })
    const by = lines.find((l) => l.text.startsWith('Ponatis:'))
    expect(by).toBeTruthy()
    expect(by!.text).toBe('Ponatis: Ana Novak · ' + by!.text.split(' · ')[1]) // trim
    expect(by!.bold).toBe(true)
  })

  test('A2d: defenzivno — napačen datum izvirnika ne razbije listka (vrstica izpuščena)', () => {
    const lines = buildKitchenTicketLines({ ...baseOrder, createdAt: 'not-a-date' }, 'KITCHEN', { by: 'Vodja' })
    expect(lines.find((l) => l.text.startsWith('Izvirno naročilo:'))).toBeUndefined()
    // ostala struktura ostane cela
    expect(lines[0].text).toBe('=== PONATIS · KUHINJSKI LIST ===')
    expect(lines.find((l) => l.text.includes('Naročilo #42'))).toBeTruthy()
  })

  test('A2e: prazen/manjkajoč ponatisnik → brez vrstice (ne gol Ponatis:)', () => {
    expect(buildKitchenTicketLines(baseOrder, 'KITCHEN', {}).find((l) => l.text.startsWith('Ponatis:'))).toBeUndefined()
    expect(buildKitchenTicketLines(baseOrder, 'KITCHEN', { by: '   ' }).find((l) => l.text.startsWith('Ponatis:'))).toBeUndefined()
    // glava PONATIS ostane tudi brez imena — listek je še vedno označen kot ponatis
    expect(buildKitchenTicketLines(baseOrder, 'KITCHEN', {})[0].text).toBe('=== PONATIS · KUHINJSKI LIST ===')
  })
})

describe('v1.256.0 A3 — nazajkompatibilnost: KDS pot je NESPREMENJENA', () => {
  test('A3a: brez reprint konteksta je glava IDENTIČNA predhodnji (=== KUHINJSKI LIST ===)', () => {
    expect(buildKitchenTicketLines({ orderNumber: 1, items: [] }, 'KITCHEN')[0].text)
      .toBe('=== KUHINJSKI LIST ===')
    expect(buildKitchenTicketLines({ orderNumber: 1, items: [] }, 'BAR')[0].text)
      .toBe('=== BAR LIST ===')
    expect(buildKitchenTicketLines({ orderNumber: 1, items: [] })[0].text)
      .toBe('=== KUHINJA ===')
  })

  test('A3b: brez reprint konteksta NI izvirnega časa NE ponatisnika (pin obstoječe obnašanje)', () => {
    const lines = buildKitchenTicketLines({
      orderNumber: 7, tableName: 'Miza 1', type: 'DINE_IN',
      createdAt: '2026-11-05T18:30:00.000Z', employeeName: 'Ana',
      items: [],
    }, 'KITCHEN')
    expect(lines.find((l) => l.text.startsWith('Izvirno naročilo:'))).toBeUndefined()
    expect(lines.find((l) => l.text.startsWith('Ponatis:'))).toBeUndefined()
  })

  test('A3c: station filter dela enako pri ponatisu (kuhinja vidi samo KITCHEN postavke)', () => {
    const order = {
      orderNumber: 9, tableName: null, type: 'DINE_IN', createdAt: '2026-11-05T18:30:00.000Z',
      items: [
        { name: 'Juha', qty: 1, note: null, station: 'KITCHEN', allergenWarning: null, allergenCodes: [], modifiers: [] },
        { name: 'Pivo', qty: 2, note: null, station: 'BAR', allergenWarning: null, allergenCodes: [], modifiers: [] },
      ],
    }
    const bar = buildKitchenTicketLines(order, 'BAR', { by: 'V' })
    expect(bar.find((l) => l.text.includes('Pivo'))).toBeTruthy()
    expect(bar.find((l) => l.text.includes('Juha'))).toBeUndefined()
  })
})

// ── B) RUTA ──

describe('v1.256.0 B — POST /api/orders/[id]/reprint-ticket', () => {
  test('B1: vrata — reports.sales ALI kitchen.update (površina računov + lastnik produkcije)', () => {
    expect(routeSrc).toContain("requireAnyPermission(req, ['reports.sales', 'kitchen.update'])")
  })

  test('B2: lokacijski varuh + stroga station validacija (neznana vrednost ZAVRNEJNA, ne fallback)', () => {
    expect(routeSrc).toContain('guardResource(user, order.locationId)')
    expect(routeSrc).toContain("station !== 'KITCHEN' && station !== 'BAR' && station !== 'ALL'")
    expect(routeSrc).toContain("station je obvezen in mora biti 'KITCHEN', 'BAR' ali 'ALL'.", )
  })

  test('B3: revizija ORDER_TICKET_REPRINT nosi središče + števec + identiteto', () => {
    expect(routeSrc).toContain("action: 'ORDER_TICKET_REPRINT'")
    expect(routeSrc).toContain('entityType: \'Order\'')
    expect(routeSrc).toContain('itemCount')
    expect(routeSrc).toContain('by: user.name')
  })

  test('B4: ruta NE spremeni stanja — brez klica publishEvent/update (samo revizija + branje; omenjek v dokumentacijskem komentarju je opis PRAVILA, ne klic)', () => {
    expect(routeSrc).not.toContain('await publishEvent(')
    expect(routeSrc).not.toContain('await db.order.update')
    expect(routeSrc).not.toContain('.updateMany(')
    expect(routeSrc).not.toContain('await db.table.update')
  })

  test('B5: strežniški števec šteje ISTO množico kot filterTicketItems (revizija ne laže)', () => {
    expect(routeSrc).toContain("st !== 'cancelled' && st !== 'voided'")
    expect(routeSrc).toContain('if (it.voided) return false')
    expect(routeSrc).toContain('stationToUI')
  })
})

// ── Ž) MONTAŽA + REGISTRI ──

describe('v1.256.0 Ž — montaža + registri', () => {
  test('Ž1: verzija 1.257.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.279.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.279.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.279.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+13 rcpt.reprint* + print.simAll)', () => {
    for (const k of [
      'rcpt.reprintBtn', 'rcpt.reprintBtnTitle', 'rcpt.reprintTitle', 'rcpt.reprintHint',
      'rcpt.reprintStation', 'rcpt.reprintKitchen', 'rcpt.reprintBar', 'rcpt.reprintAll',
      'rcpt.reprintItems', 'rcpt.reprintNone', 'rcpt.reprintConfirm', 'rcpt.reprintNoOrder',
      'rcpt.reprintLoadFail', 'print.simAll',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    const slCount = Object.keys(sl).length
    const hrCount = Object.keys(hr).length
    expect(slCount).toBe(4324)
    expect(hrCount).toBe(4324)
  })

  test('Ž3: montaža — gumb na OBEH površinah računov, dialog središč, POST → tisk', () => {
    // gumb na vrstici računa: seznam receiptsInRange + rezultati skeniranja — OBA
    // kličeta openReprint(r) GATED na r.orderId
    expect(pageSrc.match(/\{r\.orderId && \(/g)?.length).toBe(2)
    expect(pageSrc.match(/void openReprint\(r\)/g)?.length).toBe(2)
    expect(pageSrc).toContain("t('rcpt.reprintBtn')")
    // dialog: lastni data-region + radiogroup s tremi središči + števci
    expect(pageSrc).toContain('data-region="reprint-ticket-dialog"')
    expect(pageSrc).toContain('role="radiogroup"')
    expect(pageSrc).toContain("['KITCHEN', 'BAR', 'ALL'] as const")
    expect(pageSrc).toContain('reprintCounts[st]')
    // potrditev gre čez revizijska vrata (POST) in šele NATO tiska
    expect(pageSrc).toContain('reprint-ticket', )
    expect(pageSrc).toContain('body: JSON.stringify({ station: reprintStation })')
    expect(pageSrc).toContain('filterTicketItems(o.items)')
    expect(pageSrc).toContain('{ by: user?.name || null }')
    // simulator toast po središču (VSE ima svoj ključ)
    expect(pageSrc).toContain("t('print.simAll')")
    // dostopnost: 44 px izbire (min-h-11), aria-checked radiogroup
    expect(pageSrc).toContain('aria-checked={active}')
    expect(pageSrc).toContain('min-h-11 w-full rounded-lg border px-3 py-2')
    // račun BREZ naročila ne odpre dialoga — iskreno sporočilo
    expect(pageSrc).toContain("t('rcpt.reprintNoOrder')")
  })

  test('Ž4: dokumenta — PRIMERJAVA §30 + AUDIT POSODOBITEV + števci', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 30.')
    expect(doc).toContain('Reprint orders')
    expect(doc).toContain('ORDER_TICKET_REPRINT')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('v1.256.0')
    expect(auditDoc).toContain('- 4324 ključev SL in 4324 HR')
  })

  test('Ž5: 0 DDL dokaz — print lib brez db; schema brez novih modelov/ stolpcev tega vala', () => {
    // print.ts ostaja ČIST klientni modul (KDS pot ga deli z dashboardom)
    expect(printSrc).not.toContain("from '@/lib/db'")
    expect(printSrc).not.toContain('prisma')
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('ReprintTicket')
    expect(schema).not.toContain('TicketReprint')
  })

  test('Ž6: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.279.0-revizija-produkcije')
  })
})
