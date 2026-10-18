/**
 * ISSUE #73 (v1.139.0) — zadnja dva odložena sklopa: audit-22 + audit-33.
 *
 * Pure source-guard tests (brez DB):
 *  - audit-22 (KDS vrstica kot tap-karta): vrstica = tarča za NAPREDEK
 *    (KdsTapCard: klik/Enter → onAdvance), sekundarna dejanja (86) v DOLG
 *    PRITISK (drift varovalka + zatrt sledilni klik), naslednji korak je
 *    NAJVIDNEJŠI predmet vrstice (kds-next-chip, min-h-11) — ne trije
 *    enakovredni gumbi; tiskanje ostaja v glavi listka;
 *  - audit-33 (inline pomoč): TermTip tooltipi za vseh 6 izrazov
 *    (FEFO, GRN, AP, izdajna postaja, eskalacija, karantena/odpoklic),
 *    ModuleIntro (prvi vhod v modul, odpoved v localStorage, mount-gated),
 *    rezervacijski widget ima namestitveno navodilo s primerom (iframe).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { t } from '../src/lib/i18n'
import { KDS_LONG_PRESS_MS } from '../src/components/kds-tap-card'

const read = (p: string) => readFileSync(p, 'utf-8')
const dash = read('src/app/dashboard/page.tsx')
const board = read('src/components/kds-station-board.tsx')
const tapCard = read('src/components/kds-tap-card.tsx')
const termTip = read('src/components/term-tip.tsx')
const moduleIntro = read('src/components/module-intro.tsx')
const ops = read('src/components/tabs/ops-cards.tsx')
const nabava = read('src/components/tabs/nabava-tab.tsx')
const finance = read('src/components/tabs/finance-tab.tsx')
const calls = read('src/components/tabs/manager-calls-card.tsx')
const prep = read('src/components/tabs/prep-stations-card.tsx')
const widget = read('src/components/tabs/reservation-widget-card.tsx')

/* ─────────── audit-22: KDS vrstica kot tap-karta ─────────── */

describe('issue73 audit-22 — vrstica = tap-karta, sekundarna dejanja umaknjena', () => {
  test('KdsTapCard: vrstica ima vlogo gumba + tipkovnico + 44 px tarčo', () => {
    expect(tapCard).toContain('role="button"')
    expect(tapCard).toContain("e.key === 'Enter' || e.key === ' '")
    expect(tapCard).toContain('min-h-11')
    expect(tapCard).toContain('aria-disabled')
    expect(tapCard).toContain('touch-manipulation')
  })

  test('dolg pritisk: časovnik + preklic ob drsenju + zatrt sledilni klik', () => {
    expect(tapCard).toContain(`setTimeout(longFire, KDS_LONG_PRESS_MS)`)
    expect(tapCard).toContain('DRIFT_CANCEL_PX')
    expect(tapCard).toContain('onPointerMove')
    expect(tapCard).toContain('suppressClickRef')
    expect(KDS_LONG_PRESS_MS).toBeGreaterThanOrEqual(400)
    expect(KDS_LONG_PRESS_MS).toBeLessThanOrEqual(1000)
  })

  test('dashboard legacy vrsta: napredek na dotik (PENDING→PREPARING, PREPARING→READY)', () => {
    expect(dash).toContain('<KdsTapCard')
    expect(dash).toContain("if (it.status === 'PENDING') setItemStatus(it.id, 'PREPARING')")
    expect(dash).toContain('else bumpReady(it, o)')
    expect(dash).toContain("t('kds.tapAria', { q: it.qty, name: it.name")
  })

  test('86 (razprodano) je prestavljen na dolg pritisk + povratna informacija', () => {
    // gumb 86 znotraj vrstice je umaknjen — dejanje je onLongPress
    expect(dash).toContain('onLongPress={can86')
    expect(dash).toContain('void kdsToggleAvailable(mi)')
    expect(dash).toContain("t(mi.available ? 'kds.86Done' : 'kds.86Back', { name: it.name })")
    expect(dash).toContain("longPressHint={can86 ? t('kds.tapHint') : undefined}")
    // stara gumba »Začni«/»Pripravljeno« v vrstici ni več
    expect(dash).not.toContain("{t('kitchen.start')}")
    expect(dash).not.toContain("onClick={() => bumpReady(it, o)}>{t('status.PREPARED')}")
  })

  test('naslednji korak je najvidnejši predmet vrstice (čip min-h-11, ne gumb)', () => {
    expect(dash).toContain('data-region="kds-next-chip"')
    expect(dash).toContain('min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-bold')
    // tiskanje ostaja v GLAVI listka (issue #69 lega)
    expect(dash).toContain("onClick={() => void printKitchenTicket(o, 'KITCHEN')}")
  })

  test('postajna plošča: vrstice nalog so tap-karte, izdaja ostaja gumb', () => {
    expect(board).toContain('<KdsTapCard')
    expect(board).toContain("void act(task, task.status === 'pending' ? 'start' : 'ready')")
    expect(board).toContain('data-region="kds-next-chip"')
    // izdaja (expo) ima blocker logiko na strežniku → ostaja izrecen gumb
    expect(board).toContain("onClick={() => void act(task, 'issue')}")
  })

  test('naloge v postajnem toku so inertne (brez 409 iz legacy poglede)', () => {
    expect(dash).toContain('const itInteractive = itemTasks.length === 0 && (it.status === \'PENDING\' || it.status === \'PREPARING\')')
    expect(board).toContain("const tapActive = (task.status === 'pending' || task.status === 'preparing') && !busy")
  })
})

/* ─────────── audit-33: inline pomoč ─────────── */

describe('issue73 audit-33 — TermTip: izrazi razloženi na mestu uporabe', () => {
  test('komponenta: tooltip z dostopom s tipkovnice (focus) in dotika', () => {
    expect(termTip).toContain('TooltipTrigger')
    expect(termTip).toContain('aria-label={t(tipKey)}')
    expect(termTip).toContain('decoration-dotted')
  })

  test('vseh 6 izrazov ima tooltip na mestu uporabe', () => {
    // FEFO + karantena/odpoklic (serije)
    expect(ops).toContain('tipKey="term.fefoTip"')
    expect(ops).toContain('tipKey="term.quarTip"')
    // GRN (prevzemi v nabavi)
    expect(nabava).toContain('tipKey="term.grnTip"')
    // AP (stroški/obveznosti)
    expect(finance).toContain('tipKey="term.apTip"')
    // izdajna postaja (KDS postajna plošča + nastavitve postaj)
    expect(board).toContain('tipKey="term.expoTip"')
    expect(prep).toContain('tipKey="term.expoTip"')
    // eskalacija (klici vodje)
    expect(calls).toContain('tipKey="term.escTip"')
  })

  test('razlage so v OBEH slovarjih, hrvaški prevodi niso slovenske kopije', () => {
    const TIPS = ['term.fefoTip', 'term.grnTip', 'term.apTip', 'term.expoTip', 'term.escTip', 'term.quarTip']
    for (const k of TIPS) {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
      expect(hr[k]).not.toBe(sl[k])
      expect(t('sl', k)).not.toBe(k)
      expect(t('hr', k)).not.toBe(k)
    }
    const LABELS = ['term.fefo', 'term.grn', 'term.ap', 'term.esc', 'term.quar']
    for (const k of LABELS) {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
    }
  })
})

describe('issue73 audit-33 — ModuleIntro: kratka pomoč ob prvem vhodu v modul', () => {
  test('komponenta: odpoved se zapomni (localStorage), hidratacijska varovalka brez setState-in-effect', () => {
    expect(moduleIntro).toContain('ro_intro_')
    expect(moduleIntro).toContain('localStorage.getItem')
    expect(moduleIntro).toContain('localStorage.setItem')
    // useSyncExternalStore hidratacijska vrata (SSR=null → po hidrataciji vrednost)
    expect(moduleIntro).toContain('useSyncExternalStore')
    expect(moduleIntro).toContain('() => false,')
    expect(moduleIntro).not.toContain('useState')
    expect(moduleIntro).toContain("t('intro.dismiss')")
  })

  test('5 modulov ima uvod (KDS, serije, nabava, AP, klici vodje)', () => {
    expect(dash).toContain('module="kds"')
    expect(ops).toContain('module="lots"')
    expect(nabava).toContain('module="proc"')
    expect(finance).toContain('module="ap"')
    expect(calls).toContain('module="calls"')
  })

  test('KDS intro razloži gesti (dotik = napredek, dolg pritisk = 86)', () => {
    expect(dash).toContain('titleKey="intro.kds.title"')
    const body = sl['intro.kds.body'] ?? ''
    expect(body).toContain('86')
    expect(body.toLowerCase()).toContain('dolg pritisk')
  })

  test('vsak intro je v OBEH slovarjih z neprazno vsebino', () => {
    for (const k of ['intro.kds', 'intro.lots', 'intro.proc', 'intro.ap', 'intro.calls']) {
      expect(sl[`${k}.title`]).toBeTruthy()
      expect(sl[`${k}.body`]).toBeTruthy()
      expect(hr[`${k}.title`]).toBeTruthy()
      expect(hr[`${k}.body`]).toBeTruthy()
    }
    expect(sl['intro.dismiss']).toBeTruthy()
    expect(hr['intro.dismiss']).toBeTruthy()
  })
})

describe('issue73 audit-33 — rezervacijski widget: namestitveno navodilo s primerom', () => {
  test('oddelek Namestitev z iframe primerom in kopiranjem', () => {
    expect(widget).toContain('data-region="resv-widget-install"')
    expect(widget).toContain('<iframe src=')
    expect(widget).toContain('embedSnippet')
    expect(widget).toContain('copyEmbed')
  })

  test('nasvet o rotaciji povezave (vdelana koda zastara)', () => {
    expect(widget).toContain("t('resv.wid.installRotateNote')")
  })

  test('navodilo je v OBEH slovarjih', () => {
    for (const k of ['resv.wid.installTitle', 'resv.wid.installHint', 'resv.wid.installCopy', 'resv.wid.installCopied', 'resv.wid.installRotateNote', 'resv.wid.installFrameTitle']) {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
    }
  })
})
