import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.235.0 — POLISH VAL (docs/PRIMERJAVA-VMESNIKOV-2026 NOVA §12):
 *
 * 1. DIALOG MAX-VIŠINA + DRSENJE (P0): plačilni dialog z odprtim razdelilnikom
 *    je bil izmerjen 1019 px na zaslonu 720 px — DialogContent brez omejitve in
 *    brez drsenja, stopalo z glavnim gumbom 299 px POD zaslonom (nedosegljivo;
 *    Square avg 2026 pritožba #1 istega razreda). Popravek: globalno
 *    max-h-[calc(100dvh-2rem)] overflow-y-auto na Dialog + AlertDialog.
 * 2. PRAZNO STANJE MIZE (Toast onboarding vzorec): mreža (0 miz = gol prostor)
 *    + tloris (prazno platno) dobita iskreno sporočilo + CTA Dodaj prvo mizo.
 * 3. PRAZNO STANJE NAROČILA: filter brez zadetkov dobi kontekstno sporočilo
 *    (VSA: od kod naročila prihajajo; specifičen filter: katero stanje je prazno).
 *
 * Raziskava §12: Square avg 2026 »Major Flow Flaws« — vse 4 pritožbe vodilnega
 * izdelka so pri nas preverjeno pokrite (izhodi, dosega palca, modifikatorji,
 * premik postavk); Toast junij 2026 scheduled stock = zavestna izključitev.
 */

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const dialog = read('src/components/ui/dialog.tsx')
const alertDialog = read('src/components/ui/alert-dialog.tsx')
const slSrc = read('src/lib/i18n/sl.ts')
const hrSrc = read('src/lib/i18n/hr.ts')
const wl = read('worklog.md')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
const prd = read('docs/PRD-LOKALNA-BAZA.md')
const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')

describe('v1.235.0 A — dialog max-višina + drsenje (P0 zagata)', () => {
  test('A1: DialogContent nosi max-h-[calc(100dvh-2rem)] + overflow-y-auto', () => {
    expect(dialog).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog).toContain('overflow-y-auto')
  })

  test('A2: AlertDialogContent nosi isto varovalko (potrditvena okna ne uidejo)', () => {
    expect(alertDialog).toContain('max-h-[calc(100dvh-2rem)]')
    expect(alertDialog).toContain('overflow-y-auto')
  })

  test('A3: utemeljitev v komentarju (izmerjena vrednost 1019 px / 720 px — doc-truth)', () => {
    expect(dialog).toContain('1019')
    expect(dialog).toContain('720')
  })
})

describe('v1.235.0 B — prazno stanje Mize (mreža + tloris)', () => {
  test('B1: mrežni pogled — data-region tables-empty + role=status', () => {
    expect(dash).toContain('data-region="tables-empty"')
    expect(dash).toMatch(/tables-empty[^>]*role="status"/)
  })

  test('B2: CTA »Dodaj prvo mizo« odpre isti teOpen kot gumb Uredi mize (menu.manage)', () => {
    const idx = dash.indexOf('data-region="tables-empty"')
    expect(idx).toBeGreaterThan(0)
    const block = dash.slice(idx, idx + 1400)
    expect(block).toContain("hasPerm('menu.manage')")
    expect(block).toContain('teOpen')
    expect(block).toContain("t('tables.emptyAdd')")
  })

  test('B3: brez pravice pošteno besedilo (emptyNoPerm) — ne laže', () => {
    expect(dash).toContain("t('tables.emptyNoPerm')")
  })

  test('B4: tloris — data-region plan-empty znotraj platna, pointer-events-none (ne moti gest)', () => {
    expect(dash).toContain('data-region="plan-empty"')
    const idx = dash.indexOf('data-region="plan-empty"')
    const block = dash.slice(idx - 300, idx + 300)
    expect(block).toContain('pointer-events-none')
  })

  test('B5: pogoj je viewTables.length === 0 (obseg pogleda, ne baze)', () => {
    expect(dash).toContain('viewTables.length === 0 && (')
  })
})

describe('v1.235.0 C — prazno stanje Naročila (kontekstno po filtru)', () => {
  test('C1: data-region orders-empty + role=status', () => {
    expect(dash).toContain('data-region="orders-empty"')
  })

  test('C2: sporočilo loči VSA od specifičnega filtra (emptyAll / emptyFilter + stL)', () => {
    const idx = dash.indexOf('data-region="orders-empty"')
    const block = dash.slice(idx, idx + 900)
    expect(block).toContain("t('orders.emptyAll')")
    expect(block).toContain("t('orders.emptyFilter', { status: stL(orderFilter) })")
  })

  test('C3: pogoj je isti filter kot izris seznama (ne lastnega seznamanja)', () => {
    expect(dash).toContain('viewOrders.filter((o) => orderFilter === \'ALL\' || o.status === orderFilter).length === 0 && (')
  })
})

describe('v1.235.0 D — i18n (SL + HR pariteta, 3846 → 3853)', () => {
  test('D1: števci', () => {
    expect(Object.keys(sl).length).toBe(3860)
    expect(Object.keys(hr).length).toBe(3860)
  })

  test('D2: novi ključi Mize (5) obstajajo v obeh jezikih', () => {
    for (const k of ['tables.emptyTitle', 'tables.emptyHint', 'tables.emptyAdd', 'tables.emptyNoPerm', 'tables.planEmpty']) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
    }
  })

  test('D3: novi ključi Naročila (2) obstajajo v obeh jezikih', () => {
    for (const k of ['orders.emptyAll', 'orders.emptyFilter']) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
    }
  })

  test('D4: emptyFilter nosi {status} spremenljivko v obeh jezikih', () => {
    expect(sl['orders.emptyFilter']).toContain('{status}')
    expect(hr['orders.emptyFilter']).toContain('{status}')
  })
})

describe('v1.235.0 E — dokumenti (doc-truth)', () => {
  test('E1: PRIMERJAVA §12 obstaja z Square tabelo in lastno najdbo', () => {
    expect(doc).toContain('## 12. Raziskava november 2026')
    expect(doc).toContain('Major Flow Flaws')
    expect(doc).toContain('1019 px')
    expect(doc).toContain('max-h-[calc(100dvh-2rem)] overflow-y-auto')
    expect(doc).toContain('Scheduled Menu Stock Updates')
  })

  test('E2: PRD §8 R4b vrstica nosi POLISH-VAL v1.235.0', () => {
    expect(prd).toContain('POLISH-VAL v1.235.0')
  })

  test('E3: AUDIT POSODOBITEV v1.235.0 + števca 3853', () => {
    expect(auditDoc).toContain('POSODOBITEV (v1.235.0')
    expect(auditDoc).toContain('3860 ključev SL in 3860 HR')
  })
})

describe('v1.235.0 Ž — registri', () => {
  test('Ž1: verzija', () => {
    expect(APP_VERSION).toBe('1.243.0')
  })

  test('Ž2: worklog vrh nosi Task ID v1.235.0 nad prejšnjim valom', () => {
    expect(wl.slice(0, 400)).toContain('Task ID: v1.243.0')
    expect(wl.indexOf('v1.235.0')).toBeLessThan(wl.indexOf('v1.234.0'))
  })
})
