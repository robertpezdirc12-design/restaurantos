import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/lib/version'
import { aggregateStaffPerformance, type StaffPerfSample } from '../src/lib/staff-performance'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.233.0 — BENCHMARK VAL 5 (docs/PRIMERJAVA-VMESNIKOV-2026 §4 + NOVA §11):
 *
 * 1. UREDJEVALNIK CON (§4 — zadnja vrzel restavracije 21/22 → 22/22;
 *    Toast/TouchBistro cone kot samostojen objekt): POST /api/tables/zones —
 *    updateMany vseh miz cone + revizija ZONE_RENAME; dialog v Mize.
 * 2. UČINKOVITOST NATAKARJEV (§11; Lightspeed nov 2025 »staff performance
 *    insights« / Toast »server scorecards«): čista knjižnica + poročilo +
 *    kartica v Analitiki.
 * 3. KDS VRSTA (§11; Toast julij 2026 »Start Queue«): predogled naročil, ki
 *    še niso poslana v pripravo (vse postavke PENDING), nad aktivnimi listki.
 */

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const zonesRoute = read('src/app/api/tables/zones/route.ts')
const spRoute = read('src/app/api/reports/staff-performance/route.ts')
const spLib = read('src/lib/staff-performance.ts')
const analitika = read('src/components/tabs/analitika-tab.tsx')
const dtabs = read('src/components/dashboard-tabs.tsx')
const slSrc = read('src/lib/i18n/sl.ts')
const hrSrc = read('src/lib/i18n/hr.ts')
const wl = read('worklog.md')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
const prd = read('docs/PRD-LOKALNA-BAZA.md')
const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')

describe('v1.233.0 A — urejevalnik con (ruta + dashboard)', () => {
  test('A1: ruta POST /api/tables/zones — menu.manage + updateMany + revizija ZONE_RENAME', () => {
    expect(zonesRoute).toContain("requirePermission(req, 'menu.manage')")
    expect(zonesRoute).toContain('updateMany')
    expect(zonesRoute).toContain("action: 'ZONE_RENAME'")
    expect(zonesRoute).toContain('from, to, count')
  })

  test('A2: lokacijska disciplina enaka POST /api/tables (requireUserLocation + assertOrgScope)', () => {
    expect(zonesRoute).toContain('requireUserLocation')
    expect(zonesRoute).toContain('assertOrgScope')
  })

  test('A3: validacija — from/to obvezna, ≤ 40 znakov, from ≠ to, 404 brez miz', () => {
    expect(zonesRoute).toContain('Novo ime cone je obvezno')
    expect(zonesRoute).toContain('največ 40 znakov')
    expect(zonesRoute).toContain('Novo ime je enako staremu')
    expect(zonesRoute).toContain('Cona ne obstaja (ali nima miz).', )
    expect(zonesRoute).toContain('404')
  })

  test('A4: dashboard — gumb (zones-edit-btn) ob urejevalniku miz, samo menu.manage', () => {
    expect(dash).toContain('data-region="zones-edit-btn"')
    expect(dash).toContain("t('zones.edit')")
    const btnBlock = dash.slice(dash.indexOf('zones-edit-btn') - 400, dash.indexOf('zones-edit-btn'))
    expect(btnBlock).toContain("hasPerm('menu.manage')")
  })

  test('A5: dialog — vrstica po coni (zone-row), PREIMENUJ + ZDRUŽI (Select ciljne cone)', () => {
    expect(dash).toContain('data-region="zone-row"')
    expect(dash).toContain("t('zones.renameBtn')")
    expect(dash).toContain("t('zones.mergeBtn')")
    expect(dash).toContain("t('zones.pickTarget')")
    // obe dejanji kličeta ISTO zeApply — ena operacija na strežniku
    expect(dash).toContain('void zeApply(z.zone, zeRename[z.zone] ?? z.zone)')
    expect(dash).toContain('void zeApply(z.zone, zeMerge[z.zone])')
  })

  test('A6: zeZones izpeljava iz viewTables (isti obseg kot teOpen) + prazna cona poštena vrstica', () => {
    expect(dash).toContain('const zeZones = () => {')
    expect(dash).toContain('for (const tb of viewTables)')
    expect(dash).toContain("const z = tb.zone || ''")
  })
})

describe('v1.233.0 B — učinkovitost natakarjev (lib + poročilo + kartica)', () => {
  test('B1: aggregateStaffPerformance — grupiranje, padajoče po prihodku, delež vsot', () => {
    const samples: StaffPerfSample[] = [
      { employeeId: 'e1', employeeName: 'Ana', total: 100, tip: 5 },
      { employeeId: 'e2', employeeName: 'Bine', total: 300, tip: 10 },
      { employeeId: 'e1', employeeName: 'Ana', total: 100, tip: 5 },
    ]
    const r = aggregateStaffPerformance(samples)
    expect(r.rows.length).toBe(2)
    expect(r.rows[0].name).toBe('Bine') // 300 > 200
    expect(r.rows[0].revenue).toBe(300)
    expect(r.rows[0].share).toBe(0.6)
    expect(r.rows[1].orders).toBe(2)
    expect(r.rows[1].avgTicket).toBe(100)
    expect(r.totals.revenue).toBe(500)
    expect(r.totals.avgTicket).toBeCloseTo(166.666, 2)
  })

  test('B2: naročila BREZ natakarja ostanejo v lastni vrstici (employeeId null); prvo znano ime zmaga', () => {
    const r = aggregateStaffPerformance([
      { employeeId: null, employeeName: null, total: 50, tip: 0 },
      { employeeId: 'e1', employeeName: null, total: 20, tip: 0 },
      { employeeId: 'e1', employeeName: 'Cilka', total: 30, tip: 0 },
    ])
    expect(r.rows.length).toBe(2)
    const un = r.rows.find((x) => x.employeeId === null)
    expect(un).toBeDefined()
    expect(un!.revenue).toBe(50)
    const e1 = r.rows.find((x) => x.employeeId === 'e1')
    expect(e1!.name).toBe('Cilka') // kasnejši null ni povozi, znano ime da
    expect(e1!.orders).toBe(2)
  })

  test('B3: prazen vhod — 0 vrstic, deljenje z 0 varno (share 0)', () => {
    const r = aggregateStaffPerformance([])
    expect(r.rows.length).toBe(0)
    expect(r.totals.revenue).toBe(0)
    expect(r.totals.avgTicket).toBe(0)
  })

  test('B4: ruta — reports.sales, PLAČANA naročila (paidAt), ime prek relacije, clamp dni', () => {
    expect(spRoute).toContain("requirePermission(req, 'reports.sales')")
    expect(spRoute).toContain('paidAt: { gte: since }')
    expect(spRoute).toContain('Employee_Order_employeeIdToEmployee: { select: { name: true } }')
    expect(spRoute).toContain('Math.min(90, Math.max(1, n))')
    expect(spRoute).toContain('locationScope(user)')
  })

  test('B5: kartica v analitika-tab + izvoz skozi dashboard-tabs + render v Pregledu (reports.sales gate)', () => {
    expect(analitika).toContain('export function StaffPerformanceCard')
    expect(analitika).toContain('data-region="staff-performance-card"')
    expect(analitika).toContain('/api/reports/staff-performance?days=')
    expect(analitika).toContain("data-region=\"sp-row\"")
    expect(dtabs).toContain('StaffPerformanceCard')
    expect(dash).toContain("hasPerm('reports.sales') && <StaffPerformanceCard />")
  })

  test('B6: knjižnica je ČISTA (0 uvozov — konvencija cron-daily/kds-courses)', () => {
    expect(spLib).not.toContain("from '")
  })
})

describe('v1.233.0 C — KDS vrsta / Start Queue (Toast julij 2026)', () => {
  test('C1: kdsIncoming — samo naročila, katerih postavke vedi so VSE PENDING', () => {
    /* v1.258.0 (§32): predikat je bil dvignjen na raven komponente (kdsIsDraftOrder) —
       isti pogoji (its.length > 0 + every PENDING), deljen med odsekom/praznim stanjem/all-day. */
    expect(dash).toContain('const kdsIncoming = kdsQueue.filter((o) => kdsIsDraftOrder(o))')
    expect(dash).toContain("its.every((it) => it.status === 'PENDING')")
    expect(dash).toContain('its.length > 0')
  })

  test('C2: trak nad aktivnimi listki — data-region kds-start-queue, iskreno izostane ob prazni', () => {
    expect(dash).toContain('data-region="kds-start-queue"')
    /* v1.258.0 (§32): pas je ZLOŽENI obraz oddelka OSNUTKI (kdsDraftIdSet.size > 0). */
    expect(dash).toContain('kdsDraftIdSet.size > 0 && (')
    expect(dash).toContain("t('kds.queueTitle')")
  })

  test('C3: čip — miza/tip, količina, starost po ISTEM viru barvnih razredov kot listki', () => {
    expect(dash).toContain('kdsAgePillCls(kdsAgeCls(qAge))')
    expect(dash).toContain('qItems.reduce((s, it) => s + (it.qty || 0), 0)')
    expect(dash).toContain('o.table?.name || orderTypeL(o.type)')
  })

  test('C4: ničelna regresija — listki ostanejo v glavni vrsti (v1.258.0: živi v kdsActiveLive)', () => {
    /* v1.258.0 (§32): aktivna vrsta izloči osnutke (kdsActiveLive); izris ostaja
       renderKdsTicket z izrecnim draft=false (živi) — mešani listki ostanejo v vrsti. */
    // v1.264.0 §38: izris aktivne vrste teče iz kdsManualList (§38 ročno zaporedje;
       //    default način = ISTA kdsActiveLive vsebina — listki ostanejo v glavni vrsti)
    expect(dash).toContain('const kdsManualList = kdsTicketOrder === \'manual\'')
    expect(dash).toContain('renderKdsTicket(o, false, i)')
    expect(dash).toContain('kdsStale.map((o) => renderKdsTicket(o, false))')
  })
})

describe('v1.233.0 Ž — verzija + dokumenti + registri', () => {
  test('Ž1: verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.277.0')
    expect(read('src/lib/version.ts')).toContain("'1.277.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.277.0')
  })

  test('Ž2: dokument PRIMERJAVA — §4 cona v1.233, presoja 22/22, NOVA §11 z valom', () => {
    expect(doc).toContain('Val v1.233.0')
    expect(doc).toContain('urejevalnik con → v1.233.0')
    expect(doc).toContain('restavracija **22/22 (polna pariteta)**')
    expect(doc).toContain('## 11. Sveža raziskava (oktober 2026)')
    expect(doc).toContain('Start Queue')
  })

  test('Ž3: PRD §8 R4b nosi BENCHMARK-VAL v1.233.0 vrstico (doc-truth)', () => {
    expect(prd).toContain('BENCHMARK-VAL v1.233.0')
  })

  test('Ž4: worklog vrh nosi Task ID v1.235.0 nad prejšnjim valom', () => {
    expect(wl.slice(0, 400)).toContain('Task ID: v1.277.0-backend-nizi')
    expect(wl.indexOf('Task ID: v1.239.0')).toBeLessThan(wl.indexOf('Task ID: v1.232.0'))
  })

  test('Ž5: i18n števci + novi ključi SL/HR (3846/3846, +28)', () => {
    expect(Object.keys(sl).length).toBe(4320)
    expect(Object.keys(hr).length).toBe(4320)
    for (const k of ['zones.edit', 'zones.editTitle', 'zones.renameBtn', 'zones.mergeBtn', 'zones.tablesCount', 'zones.updated', 'sp.title', 'sp.waiter', 'sp.avgTicket', 'sp.unassigned', 'sp.total', 'kds.queueTitle', 'kds.queueHint']) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    expect(auditDoc).toContain('4320 ključev SL in 4320 HR')
    expect(auditDoc).toContain('POSODOBITEV (v1.233.0')
  })
})
