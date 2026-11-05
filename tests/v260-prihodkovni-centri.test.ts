/**
 * v1.260.0 — PRIHODKOVNI CENTRI (docs/PRIMERJAVA-VMESNIKOV-2026 §34;
 * Square Vol 13 september 2026 »Create revenue centers to group and
 * compare sales« — »A revenue center is one part of a business — a
 * bar, a patio, or a delivery channel«).
 *
 * Merjena vrzel: poročila niso grupirala prodaje po NIČEMER
 * prostorskem/kanalnem (edini groupBy v poročilih: vatRate +
 * zaposleni) — lastnik je videl EN sam skupni promet, katera cona
 * (Bar/Terasa/Glavna dvorana) oziroma kanal (odnes/dostava) nosi
 * dan pa ni bilo odgovorljivo. RevenueCenter model sicer obstaja
 * (enterprise štetje), a brez CRUD/vezav — Order.revenueCenterId se
 * nikoli ne piše.
 *
 *  A · STREŽNIK: izpeljava center = cona mize (Table.area) ali
 *    kanal (Order.type) OB BRANJU — groupBy type+tableId nad
 *    plačanimi naročili okna, pravice reports.sales + locationScope,
 *    from/to validacija, prazne cone + oba kanala vedno prisotna,
 *    neto = bruto − DDV, delež neto, razvrstitev neto ↓.
 *  A · KARTICA: tabela v zavihku Računi z deležnimi vrsticami,
 *    obdobje nadzoruje zavihek (Issue #94), kanala pozivata
 *    obstoječa order.type.* ključa, data-regioni, stanja
 *    (skeleton/napaka/prazno), odzivni stolpci.
 *  Ž · REGISTRI: verzija 1.260.0 + compose, i18n pariteta
 *    4121/4121 (+16 rc.*), dokumenta §34 + AUDIT, 0 DDL dokaz,
 *    read-only dokaz, worklog.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

const rcRoute = read('src/app/api/reports/revenue-centers/route.ts')
const rcCard = read('src/components/tabs/revenue-centers-card.tsx')
const dashSrc = read('src/app/dashboard/page.tsx')

// ── A1) STREŽNIK: IZPELJAVA OB BRANJU ──

describe('v1.260.0 A1 — strežniška ruta: izpeljava centrov iz obstoječih podatkov', () => {
  test('A1a: pravice + lokacijski obseg (vzor vseh poročil)', () => {
    expect(rcRoute).toContain("requirePermission(req, 'reports.sales')")
    expect(rcRoute).toContain('await locationScope(user)')
  })

  test('A1b: SAMO plačana naročila okna — isti diskont kot financial/sales-by-hour', () => {
    expect(rcRoute).toContain("paymentStatus: 'paid'")
    expect(rcRoute).toContain('paidAt: { gte: from, lte: to }')
    // preklicana/odprta naročila v vpogled uspešnosti ne sejejo
    expect(rcRoute).not.toContain("paymentStatus: 'unpaid'")
  })

  test('A1c: from/to validacija (pars vzorec export rute)', () => {
    expect(rcRoute).toContain('Neveljaven datum (pričakovano YYYY-MM-DD).')
    expect(rcRoute).toContain('Datum "from" je za datumom "to".')
    // privzeto okno = današnji dan
    expect(rcRoute).toContain('d.setHours(0, 0, 0, 0)')
  })

  test('A1d: groupBy po (vrsta, miza) BREZ joina — miza je stolpec na Order', () => {
    expect(rcRoute).toContain("by: ['type', 'tableId']")
    expect(rcRoute).toContain('_sum: { total: true, tax: true, tip: true }')
    // preslikava miza → cona prek tabele (izpeljava, ne shranjevanje)
    expect(rcRoute).toContain('new Map(tables.map((t) => [t.id, t.area')
  })

  test('A1e: kanala po vrsti naročila; DINE_IN po coni mize; robni »Brez mize« samo če neprazen', () => {
    expect(rcRoute).toContain("type === 'takeaway'")
    expect(rcRoute).toContain("type === 'delivery'")
    expect(rcRoute).toContain("zone:${area || '?'}")
    expect(rcRoute).toContain("r.kind !== 'none' || r.orders > 0")
  })

  test('A1f: vse cone + oba kanala VEDNO prisotni (prazno območje je informacija — Square izrise vse centre)', () => {
    expect(rcRoute).toContain("distinct: ['area']")
    expect(rcRoute).toContain("bucket('takeaway', 'takeaway', null)")
    expect(rcRoute).toContain("bucket('delivery', 'delivery', null)")
  })

  test('A1g: neto = bruto − DDV; delež neto; povprečni račun; razvrstitev neto ↓ (cone pred kanali)', () => {
    expect(rcRoute).toContain('const net = gross - num(g._sum.tax)')
    expect(rcRoute).toContain('r.share = totalNet > 0 ? Math.round((r.net / totalNet) * 1000) / 10 : 0')
    expect(rcRoute).toContain('r.avgCheck = r.orders > 0 ? Math.round((r.gross / r.orders) * 100) / 100 : 0')
    expect(rcRoute).toContain('(b.net - a.net) || (kindOrder[a.kind] - kindOrder[b.kind])')
  })

  test('A1h: read-only — 0 mutacij, 0 revizij (bralno poročilo, §32 B6 odločitev)', () => {
    expect(rcRoute).not.toContain('writeAudit')
    expect(rcRoute).not.toContain('.create(')
    expect(rcRoute).not.toContain('.update(')
    expect(rcRoute).not.toContain('.delete(')
    expect(rcRoute).toMatch(/export async function GET\(/)
    expect(rcRoute).not.toMatch(/export async function (POST|PATCH|PUT|DELETE)\(/)
  })

  test('A1i: 0 DDL — RevenueCenter tabela NI dotaknjena (izpeljava namesto upravne plasti)', () => {
    expect(rcRoute).not.toContain('db.revenueCenter')
    // Order.revenueCenterId se NE piše (odpovedana alternativa §34 B1) —
    // negativna trditev cilja ZAPIS oblike polja/priloga, ne omembe v
    // komentarju (vzorec v258: ciljno ime nosilca, ne beseda)
    expect(rcRoute).not.toMatch(/revenueCenterId\s*[:=]/)
    expect(rcRoute).not.toMatch(/\brevenueCenterId:\s*\w+/)
  })
})

// ── A2) KARTICA: PRIKAZ V ZAVIHKU RAČUNI ──

describe('v1.260.0 A2 — kartica: tabela centrov z deleži v zavihku Računi', () => {
  test('A2a: montaža v racuni zavihku takoj za portalom, gating reports.sales', () => {
    expect(dashSrc).toContain('<RevenueCentersCard from={rcptFrom} to={rcptTo} />')
    const idx = dashSrc.indexOf('<AccountingPortalCard from={rcptFrom}')
    const idxRc = dashSrc.indexOf('<RevenueCentersCard from={rcptFrom}')
    expect(idx).toBeGreaterThan(0)
    expect(idxRc).toBeGreaterThan(idx)
    const gateSeg = dashSrc.slice(idxRc - 160, idxRc)
    expect(gateSeg).toContain("hasPerm('reports.sales')")
  })

  test('A2b: obdobje NADZORUJE zavihek — kartica nima lastnih datumov (Issue #94 vzorec)', () => {
    expect(rcCard).toContain('from: string')
    expect(rcCard).toContain('to: string')
    expect(rcCard).not.toContain("type=\"date\"")
    expect(rcCard).not.toContain('useState(firstOfMonth)')
  })

  test('A2c: data-regioni + stanja (skeleton/napaka/prazno)', () => {
    expect(rcCard).toContain('data-region="revenue-centers-card"')
    expect(rcCard).toContain('data-region="rc-row"')
    expect(rcCard).toContain('data-region="rc-total-row"')
    expect(rcCard).toContain('data-region="rc-empty"')
    expect(rcCard).toContain('data-region="rc-error"')
    expect(rcCard).toContain('data-region="rc-skeleton"')
  })

  test('A2d: kanala pozivata OBSTOJEČA order.type.* ključa (en vir resnice — 0 duplikatov prevodov)', () => {
    expect(rcCard).toContain("t('order.type.TAKEAWAY')")
    expect(rcCard).toContain("t('order.type.DELIVERY')")
    // lastni ključi so SAMO oznake kartice (rc.*), ne pa imen kanalov
    expect(rcCard).not.toContain("'rc.takeaway'")
    expect(rcCard).not.toContain("'rc.delivery'")
  })

  test('A2e: deležne vrstice — cona emerald, kanal amber, brez mize stone; sr-only delež', () => {
    expect(rcCard).toContain('bg-emerald-700')
    expect(rcCard).toContain('bg-amber-700')
    expect(rcCard).toContain('bg-stone-400')
    expect(rcCard).toContain("t('rc.ariaShare'")
  })

  test('A2f: vrstni red = strežnikov (neto ↓) — kartica NE razvršča sama (ena resnica)', () => {
    expect(rcCard).toContain('const rows = data?.rows || []')
    expect(rcCard).not.toContain('.sort(')
  })

  test('A2g: odzivni stolpci + tabular-nums + osveževanje z aria', () => {
    expect(rcCard).toContain('hidden sm:table-cell')
    expect(rcCard).toContain('hidden md:table-cell')
    expect(rcCard).toContain('tabular-nums')
    expect(rcCard).toContain("aria-label={t('common.refresh')}")
  })

  test('A2h: izvoz barrelja + i18n opis kartice', () => {
    expect(read('src/components/dashboard-tabs.tsx')).toContain("export { RevenueCentersCard } from './tabs/revenue-centers-card'")
    expect(rcCard).toContain("t('rc.title')")
    expect(rcCard).toContain("t('rc.desc')")
  })
})

// ── Ž) REGISTRI ──

describe('v1.260.0 Ž — registri', () => {
  test('Ž1: verzija 1.260.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.260.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.260.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.260.0')
  })

  test('Ž2: i18n pariteta SL/HR 4121/4121 (+16 rc.*)', () => {
    for (const k of [
      'rc.title', 'rc.desc', 'rc.zone', 'rc.channel', 'rc.none',
      'rc.colCenter', 'rc.colOrders', 'rc.colGross', 'rc.colNet',
      'rc.colTips', 'rc.colAvg', 'rc.colShare', 'rc.total',
      'rc.empty', 'rc.loadErr', 'rc.ariaShare',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    const slCount = Object.keys(sl).length
    const hrCount = Object.keys(hr).length
    expect(slCount).toBe(4121)
    expect(hrCount).toBe(4121)
  })

  test('Ž3: dokumenta — PRIMERJAVA §34 + AUDIT POSODOBITEV + števci', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 34.')
    expect(doc).toContain('PRIHODKOVNI CENTRI v1.260.0')
    // citat je v dokumentu prelomljen čez vrstice — regex odporen na prelom
    expect(doc).toMatch(/Create\s+revenue\s+centers\s+to\s+group\s+and\s+compare\s+sales/)
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('v1.260.0')
    expect(auditDoc).toContain('- 4121 ključev SL in 4121 HR')
    expect(auditDoc).toContain('(4105 → 4121)')
  })

  test('Ž4: 0 DDL + read-only — izpeljava ob branju, obstoječe poti nedotaknjene', () => {
    const schema = read('prisma/schema.prisma')
    // modeli/stolpci PREDHODNO obstajajo in ostajajo neizkoriščeni
    // (RevenueCenter/Order.revenueCenterId/Table.revenueCenterId so že od prej)
    expect(schema).toContain('model RevenueCenter')
    expect(schema).toContain('revenueCenterId')
    // nova ruta je edina dotična datoteka API plasti — X/Z (export) nedotaknjen
    const exportRoute = read('src/app/api/reports/export/route.ts')
    expect(exportRoute).not.toContain('revenueCenter')
    // obstoječa poročila brez pojma centrov (tempo ostaja po mizi — status quo)
    const tempoRoute = read('src/app/api/reports/tempo/route.ts')
    expect(tempoRoute).not.toContain('revenueCenter')
  })

  test('Ž5: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.260.0-finalna-verifikacija')
  })
})
