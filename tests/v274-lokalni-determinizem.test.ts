/**
 * v1.274.0 — LOKALNI DETERMINIZEM: collation + formatiranje
 * (svež pregled po zaprtju tem množinske oblike (v1.268–v1.271) in
 *  diakritik (v1.272–v1.273) — naslednja površina po AKCIJI v1.271.0)
 *
 *  NAJDENIH IN POPRAVLJENIH 27 mest (v 17 datotekah):
 *    · COLLATION — 24 mest: gol (brez podanega jezika) localeCompare nad
 *      UPORABNIŠKO VIDNIM SL/HR besedilom (imena zaposlenih, imena
 *      artiklov, kategorije, vloge, cone, postaje, razlogi 86, oznake
 *      miz) → pripet 'sl' (VELJAVNA repozitorijeva konvencija:
 *      finance-tab/modifiers/table-autoassign/ops-checklists/
 *      accounting-portal/daily-email/table-combinations/expenses
 *      route so 'sl' že imele — ta val le zaključuje površino).
 *      DOKAZOVANO NAPAČNO VES ČAS, NE LE MED NAPRAVAMI: v privzetem
 *      (en-US) okolju gol localeCompare da 'Čebula' PRED 'Cvetje'
 *      (diakritik kot sekundarna razlika) — slovenska abeceda
 *      zahteva C < Č < D. 'sl' da pravilno.
 *      Nevarnost tudi: SSR (strežniški locale) vs brskalnik (uporabnikov
 *      locale) → vrstni red istega seznama se razlikuje med strežniškim
 *      izrisom in hidracijo (hydration mismatch) ter med napravami
 *      osebja.
 *    · FORMATIRANJE — 3 mest: gol toLocaleString()/toLocaleDateString()
 *      (zaloga zgodovina prevzemov, integracije zadnja sinhronizacija,
 *      dashboard sinhronska vrsta mrtvih poskusov) → 'sl-SI' (dominantna
 *      konvencija dashboarda — 11 sosednjih mest že 'sl-SI').
 *
 *  POŠTENI NEGATIVNI KONTROLI (NEVDNI — ostanejo goli):
 *    · NEODVISNI ključi (ASCII): datumi ISO, id-ji (UUID/entryId/
 *      distributionId/employeeId/itemId), uri 'HH:mm' — vrstni red je
 *      v VSEH collationih identičen, podan jezik ne bi ničesar spremenil
 *      (vzorčni primer: sales-by-hour, labor-cost, labor-coverage,
 *      openinghours, reports/export, seat-assignments,
 *      reservation-pacing, checks/guests, payroll entryId/distributionId);
 *    · NEPOBOTANE operandi v dotaknjenih vrsticah: poolDate/distributionId/
 *      employeeId/date/entryId ostanejo goli (repo konvencija iz
 *      ops-checklists:445-446 — pin SAMO občutljivi operand);
 *    · shadcn knjižnica: ui/chart.tsx + ui/calendar.tsx imata gola klica,
 *      a sta NEUPORABLJENA (0 uvozov po src) — ni uporabniško vidne
 *      površine; ostajata nedotaknjeni (vendored komponenti).
 *
 *  Č1 · COLLATION PINI: vseh 24 mest živih z ', 'sl'' v svojih
 *      datotekah + funkcionalni dokaz (sl abeceda C < Č < D, Ž po Z).
 *  Č2 · NEGATIVNI KONTROLI: neodvisni ključi ostanejo goli; knjižniški
 *      datoteki nedotaknjeni; neobčutljivi operandi v dotaknjenih
 *      vrsticah goli.
 *  Č3 · FORMATIRANJE: 3 mesta živa s 'sl-SI'; SKEN celega src (brez
 *      components/ui/) — 0 golih toLocale* klicev v app kodi.
 *  Ž · REGISTRI: verzija 1.274.0 (version.ts + compose + APP_VERSION
 *      vsebina), worklog vrh Task ID, AUDIT POSODOBITEV v1.274.0,
 *      zgodovinska veriga v1.273.0 ostaja.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) COLLATION — 24 mest živih z 'sl' pinom ──
describe('v1.274.0 Č1 — collation: 24 golih localeCompare nad SL/HR besedilom pripetih na \'sl\'', () => {
  test('kds-stats: 2 mesti (imena artiklov + razlogi 86)', () => {
    const src = read('src/lib/kds-stats.ts')
    expect(src).toContain("out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'sl'))")
    expect(src).toContain(".sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'sl'))")
  })

  test('staff-performance: imena zaposlenih', () => {
    const src = read('src/lib/staff-performance.ts')
    expect(src).toContain(".sort((a, b) => b.revenue - a.revenue || b.orders - a.orders || a.name.localeCompare(b.name, 'sl'))")
  })

  test('kds-station-routing: imena postaj', () => {
    const src = read('src/lib/kds-station-routing.ts')
    expect(src).toContain(".sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'sl'))[0]")
  })

  test('labor-coverage: imena del (job)', () => {
    const src = read('src/lib/labor-coverage.ts')
    expect(src).toContain("|| a.name.localeCompare(b.name, 'sl'))")
  })

  test('tempo-insights: oznake miz', () => {
    const src = read('src/lib/tempo-insights.ts')
    expect(src).toContain(".sort((a, b) => b.emptyMin - a.emptyMin || a.orders - b.orders || a.label.localeCompare(b.label, 'sl'))")
  })

  test('payroll: 4 mesta (zaposleni + dela ×2, zaposleni, zaposleni v izvozu, napitnine)', () => {
    const src = read('src/lib/payroll.ts')
    expect(src).toContain("(a, b) => a.employeeName.localeCompare(b.employeeName, 'sl') || a.jobName.localeCompare(b.jobName, 'sl'),")
    expect(src).toContain("return [...map.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'sl'))")
    expect(src).toContain("a.employeeName.localeCompare(b.employeeName, 'sl') ||")
    expect(src).toContain(".sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'sl') || a.distributionId.localeCompare(b.distributionId))")
  })

  test('payroll-surcharges: 2 mesti (zaposleni+dela, zaposleni po imenu)', () => {
    const src = read('src/lib/payroll-surcharges.ts')
    expect(src).toContain("(a, b) => a.employeeName.localeCompare(b.employeeName, 'sl') || a.jobName.localeCompare(b.jobName, 'sl'),")
    expect(src).toContain("(nameOf.get(a[0]) || a[0]).localeCompare(nameOf.get(b[0]) || b[0], 'sl')")
  })

  test('menu-engineering: 2 mesti (kategorije pragovnih vrednosti + kategorija/ime artiklov)', () => {
    const src = read('src/lib/menu-engineering.ts')
    expect(src).toContain("out.sort((a, b) => a.name.localeCompare(b.name, 'sl'))")
    expect(src).toContain("outItems.sort((a, b) => a.category.localeCompare(b.category, 'sl') || b.qtySold - a.qtySold || a.name.localeCompare(b.name, 'sl'))")
  })

  test('labor-cost: imena vlog', () => {
    const src = read('src/lib/labor-cost.ts')
    expect(src).toContain(".sort((a, b) => b.cost - a.cost || a.roleName.localeCompare(b.roleName, 'sl'))")
  })

  test('tips API: 2 mesti (zaposleni, vrstni red distribucije)', () => {
    const src = read('src/app/api/tips/route.ts')
    expect(src).toContain("const rows = Array.from(map.values()).sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'sl'))")
    expect(src).toContain(".sort((a, b) => a.row.employeeName.localeCompare(b.row.employeeName, 'sl') || a.row.employeeId.localeCompare(b.row.employeeId))")
  })

  test('payroll close/detail/export API: 3 mesta (napitnine po zaposlenem)', () => {
    for (const p of [
      'src/app/api/payroll/[id]/close/route.ts',
      'src/app/api/payroll/[id]/route.ts',
      'src/app/api/payroll/[id]/export/route.ts',
    ]) {
      const src = read(p)
      expect(src).toContain("(a, b) => a.poolDate.localeCompare(b.poolDate) || a.employeeName.localeCompare(b.employeeName, 'sl') || a.distributionId.localeCompare(b.distributionId),")
    }
  })

  test('dashboard: 4 mesta (KDF nadomestki, cone pregled, cone filter, KDS all-day)', () => {
    const src = read('src/app/dashboard/page.tsx')
    expect(src).toContain(".sort((a, b) => (a.station === mi.station ? 0 : 1) - (b.station === mi.station ? 0 : 1) || a.name.localeCompare(b.name, 'sl'))")
    expect(src).toContain("return [...m.values()].sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone, 'sl'))")
    expect(src).toContain("const zones = [...new Set(viewTables.map((t) => t.zone))].sort((a, b) => a.localeCompare(b, 'sl'))")
    expect(src).toContain("const rows = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'sl'))")
  })

  test('funkcionalni dokaz: sl abeceda C < Č < D in Ž po Z (gol/en da NAPAČEN vrstni red)', () => {
    const names = ['Žagar', 'Cvetje', 'Čebula', 'Špinaka', 'Drobnjak', 'Zelišče']
    const sl = [...names].sort((a, b) => a.localeCompare(b, 'sl'))
    // slovenska abeceda: C Č D ... S Š T ... Z Ž — Č ZA C, Ž ZA Z
    expect(sl).toEqual(['Cvetje', 'Čebula', 'Drobnjak', 'Špinaka', 'Zelišče', 'Žagar'])
    // gol klic v privzetem (en-US) okolju da Čebula PRED Cvetje — dokaz
    // da je bil gol vrstni red napačen VES ČAS, ne le med napravami
    const bare = [...names].sort((a, b) => a.localeCompare(b))
    expect(bare.indexOf('Čebula')).toBeLessThan(bare.indexOf('Cvetje'))
    // 'sl' popravi ravno to
    expect(sl.indexOf('Čebula')).toBeGreaterThan(sl.indexOf('Cvetje'))
  })

  test("funkcionalni dokaz: 'sl' === 'sl-SI' za collation (oblika oznake je brez pomena)", () => {
    const names = ['Žagar', 'Cvetje', 'Čebula', 'Špinaka', 'Drobnjak', 'Zelišče']
    const sl = [...names].sort((a, b) => a.localeCompare(b, 'sl'))
    const slSI = [...names].sort((a, b) => a.localeCompare(b, 'sl-SI'))
    expect(sl).toEqual(slSI)
  })
})

// ── Č2) NEGATIVNI KONTROLI — NEVDNI ostanejo goli ──
describe('v1.274.0 Č2 — negativni kontroli (neodvisni ključi + knjižnica)', () => {
  test('neodvisni ASCII ključi (datumi/id-ji/uri) ostanejo goli — pin ne bi ničesar spremenil', () => {
    // datumi: sales-by-hour, labor-cost, labor-coverage, openinghours, reports/export
    expect(read('src/lib/sales-by-hour.ts')).toContain('.sort(([a], [b]) => a.localeCompare(b))')
    expect(read('src/lib/labor-cost.ts')).toContain('.sort(([a], [b]) => a.localeCompare(b))')
    expect(read('src/lib/labor-coverage.ts')).toContain('.sort(([a], [b]) => a.localeCompare(b))')
    expect(read('src/lib/openinghours.ts')).toContain('return list.sort((x, y) => x.date.localeCompare(y.date))')
    const route = read('src/app/api/reports/export/route.ts')
    expect(route.split('.sort(([a], [b]) => a.localeCompare(b))').length - 1).toBe(2)
    // id-ji: seat-assignments itemIds, checks/guests id
    expect(read('src/lib/seat-assignments.ts')).toContain('unassignedItemIds: unassigned.sort((x, y) => x.localeCompare(y)),')
    expect(read('src/app/api/orders/[id]/checks/guests/route.ts')).toContain('return tb - ta || a.id.localeCompare(b.id)')
    // uri: reservation-pacing bucket start
    expect(read('src/lib/reservation-pacing.ts')).toContain('return [...buckets.values()].sort((a, b) => a.start.localeCompare(b.start))')
  })

  test('neobčutljivi operandi v DOTAKNJENIH vrsticah ostanejo goli (repo konvencija ops-checklists:445-446)', () => {
    const close = read('src/app/api/payroll/[id]/close/route.ts')
    expect(close).toContain('a.poolDate.localeCompare(b.poolDate) ||')
    expect(close).toContain('a.distributionId.localeCompare(b.distributionId),')
    const tips = read('src/app/api/tips/route.ts')
    expect(tips).toContain('a.row.employeeId.localeCompare(b.row.employeeId))')
    const payroll = read('src/lib/payroll.ts')
    expect(payroll).toContain('a.date.localeCompare(b.date) ||')
    expect(payroll).toContain('a.entryId.localeCompare(b.entryId),')
  })

  test('shadcn knjižni datoteki (chart/calendar) NEUPORABLJENI — 0 uvozov po src, ostajata nedotaknjeni', () => {
    // obe imata gol klic, a nista nikoli uvoženi — ni uporabniško vidne površine
    let imports = 0
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir))) {
        const p = join(dir, e)
        const st = statSync(join(ROOT, p))
        if (st.isDirectory()) { if (e !== 'node_modules' && e !== '.next') walk(p) }
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
          const s = read(p)
          if (p.includes('/components/ui/')) return // sami sebi ne štejeta
          if (s.includes('ui/chart') || s.includes('ui/calendar')) imports += 1
        }
      }
    }
    walk('src')
    expect(imports).toBe(0)
    expect(read('src/components/ui/chart.tsx')).toContain('{item.value.toLocaleString()}')
    expect(read('src/components/ui/calendar.tsx')).toContain('data-day={day.date.toLocaleDateString()}')
  })
})

// ── Č3) FORMATIRANJE — 3 mesta živa + sken celega app src ──
describe('v1.274.0 Č3 — formatiranje: 3 gola toLocale* pripeta na sl-SI', () => {
  test('zaloga-tab: zgodovina prevzemov', () => {
    expect(read('src/components/tabs/zaloga-tab.tsx')).toContain("{s.createdByName} · {new Date(s.createdAt).toLocaleDateString('sl-SI')}")
  })

  test('integracje-tab: zadnja sinhronizacija', () => {
    expect(read('src/components/tabs/integracje-tab.tsx')).toContain("d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString('sl-SI') : t('integ.never')")
  })

  test('dashboard: sinhronska vrsta mrtvih poskusov', () => {
    expect(read('src/app/dashboard/page.tsx')).toContain("{t('sync.deadAttempts', { n: o.attempts })} · {new Date(o.createdAt).toLocaleString('sl-SI')}")
  })

  test('SKEN: 0 golih toLocale* klicev v app kodi (src brez components/ui/)', () => {
    const bare = /\.toLocale(?:String|DateString|TimeString)\(\)/
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir))) {
        const p = join(dir, e)
        const st = statSync(join(ROOT, p))
        if (st.isDirectory()) { if (e !== 'node_modules' && e !== '.next') walk(p) }
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
          if (p.includes('/components/ui/')) continue // vendored knjižnica (neuporabljena)
          read(p).split('\n').forEach((line, i) => {
            if (bare.test(line)) hits.push(`${p}:${i + 1}`)
          })
        }
      }
    }
    walk('src')
    expect(hits).toEqual([])
  })

  test('SKEN: 0 golih localeCompare nad občutljivimi operandi (Name/name/label/reason/zone/category) v app kodi', () => {
    const sensitive = /\.(?:[A-Za-z0-9_]*(?:Name|name|label|reason|zone|category))\.localeCompare\(([^)]*)\)/
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir))) {
        const p = join(dir, e)
        const st = statSync(join(ROOT, p))
        if (st.isDirectory()) { if (e !== 'node_modules' && e !== '.next') walk(p) }
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
          if (p.includes('/components/ui/')) continue
          read(p).split('\n').forEach((line, i) => {
            const m = sensitive.exec(line)
            if (m && !m[1].includes("'sl'") && !m[1].includes("'sl-SI'") && !m[1].includes("'hr'")) hits.push(`${p}:${i + 1}`)
          })
        }
      }
    }
    walk('src')
    expect(hits).toEqual([])
  })
})

// ── Ž) REGISTRI ──
describe('v1.274.0 Ž — registri', () => {
  test('verzija 1.274.0 (version.ts + compose + APP_VERSION vsebina)', () => {
    expect(APP_VERSION).toBe('1.291.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.291.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.291.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.291.0-demo-login-nicla-rast')
  })

  test('AUDIT doc-truth: POSODOBITEV (v1.274.0, lokalni determinizem)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('POSODOBITEV (v1.274.0, lokalni determinizem — collation + formatiranje)')
    // prejšnji vnos ostaja (zgodovinska veriga doc-truth)
    expect(audit).toContain('POSODOBITEV (v1.273.0, diakritike II — izvozni API + tisk)')
  })

  test('i18n števci nespremenjeni (0 ključev — val je brez slovarjev)', () => {
    // val ne dodaja/spreminja i18n ključev: sortiranje in formatiranje sta
    // izven slovarjev; pariteta ostaja 4320/4320 (v272 Ž2 pin)
    const v272 = read('tests/v272-diakritike-csv.test.ts')
    expect(v272).toContain('4320')
  })
})
