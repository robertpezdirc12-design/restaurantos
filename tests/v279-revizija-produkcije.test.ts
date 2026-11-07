import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { fmtStampSI, fmtEUR } from '../src/lib/fmt'
import { isStaleKdsTicket, staleTicketHours, KDS_STALE_THRESHOLD_MIN } from '../src/lib/kds-delays'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.279.0 — REVIZIJA PRODUKCIJE v1.278.0 (metoda issue #71: samo-branje,
 * demo prijava, 12+ zaslonov, 0 konzolnih napak). DVE najdbi A-razreda:
 *
 * NAJDBA 1 (a11y, WCAG 4.1.2): 61 ikonskih gumbov BREK dostopnega imena —
 * meni 55 (Pencil/Trash2/Plus v menu-modifiers-card, OSS-10 v1.209 — nikoli
 * niso dobili imen), pregled 2 + menu-analiza 3 (RefreshCw v analitika-tab,
 * kartice z Obdobje izbirniki), nabava 1 (Trash2 pravila). Isti razred kot
 * v1.177 (kiosk gumba za količino) in v1.219 #89 (94 vnosnih polj).
 *
 * NAJDBA 2 (UX, doktrina issue #70 §2 razširitev): zastarela demo naročila
 * so na KDS-ju v loči ZASTARELO od v1.121.0, a Mize ploščica in Naročila
 * kartica sta ju kazali kot živa: »⏱ 9450 min« (~6,6 dneva živi števec) in
 * »#716 · 07:28« (sama ura — 6 dni staro naročilo izgleda današnje).
 *
 *  · Č1 — vedenje čistih funkcij: fmtStampSI (danes = HH:MM, prejšnji dan =
 *    DD. MM. HH:MM, mesecna/mejna datuma, padding, deterministični now),
 *    isStaleKdsTicket/staleTicketHours referenca ( prag 8 h — KDS konstanta)
 *  · Č2 — pini vseh spremenjenih mest (page.tsx mize/naročila, menu-modifiers,
 *    analitika, nabava, i18n ključi, re-izvoz client.ts)
 *  · Č3 — negativni sken: 0 ikonskih gumbov brek aria-label v popravljenih
 *    datotekah + i18n pariteta novih ključev
 *  · Ž · REGISTRI: verzija 1.279.0, worklog vrh Task ID, i18n 4324/4324,
 *    0 DDL, fmt.ts čisti sloj 0 uvozov
 */

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) VEDENJE — čiste funkcije ──

describe('v279 Č1: fmtStampSI — časovni žig kartice naročila', () => {
  const NOW = new Date('2026-11-07T20:30:00')

  test('današnje naročilo = SAMO ura (»07:28« — nespremenjena oblika prej)', () => {
    expect(fmtStampSI('2026-11-07T07:28:00', NOW)).toBe('07:28')
    expect(fmtStampSI('2026-11-07T23:59:00', NOW)).toBe('23:59')
    expect(fmtStampSI('2026-11-07T00:01:00', NOW)).toBe('00:01')
  })

  test('prejšnji dan = DATUM + ura (»31. 10. 07:28« — najdba 2: 6 dni staro demo naročilo)', () => {
    expect(fmtStampSI('2026-10-31T07:28:00', NOW)).toBe('31. 10. 07:28')
    expect(fmtStampSI('2026-11-06T23:00:00', NOW)).toBe('06. 11. 23:00')
  })

  test('padding enomestnih vrednosti (deterministično — lekcija v1.276 CI-fix: ročna konstrukcija, ne toLocaleString/ICU)', () => {
    expect(fmtStampSI('2026-11-07T09:05:00', NOW)).toBe('09:05')
    expect(fmtStampSI('2026-01-02T08:07:00', NOW)).toBe('02. 01. 08:07')
  })

  test('mejni primer: 23:59 včerajšnjega dne je že »drug dan« (toDateString primerjava)', () => {
    expect(fmtStampSI('2026-11-06T23:59:59', NOW)).toBe('06. 11. 23:59')
    // 00:00 danes je danes
    expect(fmtStampSI('2026-11-07T00:00:00', NOW)).toBe('00:00')
  })

  test('now privzetek: brez parametra teče (živi klic iz page.tsx brez now)', () => {
    const out = fmtStampSI(new Date().toISOString())
    expect(out).toMatch(/^(\d{2}:\d{2}|\d{2}\. \d{2}\. \d{2}:\d{2})$/)
  })

  test('fmtEUR referenca ostaja (ista datoteka čistega sloja, ena funkcija = ena oblika)', () => {
    expect(fmtEUR(4)).toBe('4,00\u00A0€')
  })
})

describe('v279 Č1: zastarelost — KDS prag 8 h (referenca, doktrina issue #70 §2)', () => {
  test('isStaleKdsTicket: pod pragom NE, nad pragom DA (STROGO > 480 min — 8 h meja je še sveča)', () => {
    expect(KDS_STALE_THRESHOLD_MIN).toBe(480)
    expect(isStaleKdsTicket(479)).toBe(false)
    expect(isStaleKdsTicket(480)).toBe(false) // meja sama še NI zastarela (> ne >=)
    expect(isStaleKdsTicket(481)).toBe(true)
    expect(isStaleKdsTicket(9450)).toBe(true)
  })

  test('staleTicketHours: 9450 min → 157 h (ura, ne minute — »⏱ 9450 min« je zavajalo)', () => {
    expect(staleTicketHours(9450)).toBe(157)
    expect(staleTicketHours(480)).toBe(8)
  })
})

// ── Č2) PINI — vsa spremenjena mesta ──

describe('v279 Č2: pini najdbe 2 — Mize ploščica + Naročila kartica (page.tsx)', () => {
  const src = read('src/app/dashboard/page.tsx')

  test('mize ploščica: tileStale izračun nad ploščico (isStaleKdsTicket + kdsMinutes)', () => {
    expect(src).toContain('const tileStale = aoTile ? isStaleKdsTicket(kdsMinutes(aoTile.createdAt)) : false')
  })

  test('mize ploščica: črtkani sivi rob + zamolklost pri zastarelem (KDS vzorec sivi/črtkani)', () => {
    expect(src).toContain("outline-2 outline-dashed outline-stone-500/70")
    expect(src).toContain("tileStale ? ' opacity-80 outline-2 outline-dashed outline-stone-500/70' : ''")
  })

  test('mize ploščica: živi števec SAMO za sveča naročila (!tileStale varovalka)', () => {
    expect(src).toContain("{elapsed !== null && !tileStale && (")
    expect(src).toContain('⏱ {t(\'tables.elapsedMin\', { m: elapsed })}')
  })

  test('mize ploščica: zastarelo → starost v URAH + title z oznako (kds.stale/kds.staleHours, vzorec KDS pila)', () => {
    expect(src).toContain("{elapsed !== null && tileStale && (")
    expect(src).toContain("⏱ {t('kds.staleHours', { h: staleTicketHours(elapsed) })}")
    expect(src).toContain('title={`${t(\'kds.stale\')} — ${t(\'tables.sinceOrder\', { m: elapsed })}`}')
  })

  test('naročila kartica: fmtStampSI namesto time-only toLocaleTimeString (datum pri prejšnjih dneh)', () => {
    expect(src).toContain("#{o.orderNumber ?? '?'} · {fmtStampSI(o.createdAt)}")
    // stara oblika v tej kartici je zamenjana (živ dokaz: vrstica z identical vzorcem ne obstaja več)
    expect(src).not.toContain("#{o.orderNumber ?? '?'} · {new Date(o.createdAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })}\n                          {o.employee?.name")
  })

  test('uvoz: fmtStampSI prihaja iz @/lib/client (re-izvoz čistega sloja, javni API nespremenjen)', () => {
    expect(src).toContain("fmtStampSI, getUser } from '@/lib/client'")
  })
})

describe('v279 Č2: pini najdbe 1 — aria-labeli (menu-modifiers/analitika/nabava)', () => {
  test('menu-modifiers-card: 4 ikonski gumbi z imeni (edit/delete skupina, delete opcija, dodaj)', () => {
    const src = read('src/components/tabs/menu-modifiers-card.tsx')
    expect(src).toContain("aria-label={t('modifiers.group.editAria', { name: g.name })}")
    expect(src).toContain("aria-label={t('modifiers.group.deleteAria', { name: g.name })}")
    expect(src).toContain("aria-label={t('modifiers.option.deleteAria', { name: m.name })}")
    expect(src).toContain("aria-label={t('modifiers.option.add')}")
  })

  test('analitika-tab: 3 RefreshCw gumbi z aria-label common.refresh', () => {
    const src = read('src/components/tabs/analitika-tab.tsx')
    expect(src.match(/aria-label=\{t\('common\.refresh'\)\}/g)?.length).toBe(3)
  })

  test('nabava-tab: Trash2 pravila z aria-label recurring.deleteAria (ime dobavitelja)', () => {
    const src = read('src/components/tabs/nabava-tab.tsx')
    expect(src).toContain("aria-label={t('recurring.deleteAria', { name: sup?.name || rule.supplierId })}")
  })

  test('client.ts re-izvozi fmtStampSI (pogodba čistega sloja, vzorec v1.277)', () => {
    expect(read('src/lib/client.ts')).toContain("export { fmtEUR, fmtNumSI, fmtFixedSI, fmtStampSI } from './fmt'")
  })
})

// ── Č3) NEGATIVNI SKEN — regresijski varuh ──

describe('v279 Č3: negativni sken — 0 ikonskih gumbov brek imena v popravljenih datotekah', () => {
  test('menu-modifiers-card: vsak Button z SAMO ikono ima aria-label (sken <Button…><Ikona/></Button>)', () => {
    const src = read('src/components/tabs/menu-modifiers-card.tsx')
    // najdi vse Button bloke; tisti brez besedila morajo imeti aria-label v atributih
    // (=> v atributih bi pokvaril indexOf('>') — puščice nevtralizirane pred iskanjem korena)
    const blocks = (src.match(/<Button[\s\S]{0,400}?<\/Button>/g) ?? []).map((b) => b.replace(/=>/g, '=='))
    const iconOnly = blocks.filter((b) => {
      const inner = b.slice(b.indexOf('>') + 1, b.lastIndexOf('</Button>'))
      // notranjost brez {} izrazov in brez besedila = samo ikona/pražno
      return inner.replace(/<[^>]+>/g, '').trim() === '' && !/\{t\(/.test(inner)
    })
    const unnamed = iconOnly.filter((b) => !b.includes('aria-label'))
    expect(unnamed).toEqual([])
    expect(iconOnly.length).toBe(4) // natanko 4 popravljena ikonska gumba
  })

  test('analitika-tab: noben Button s SAMO RefreshCw/Loader2 ikono brek aria-label', () => {
    const src = read('src/components/tabs/analitika-tab.tsx')
    const blocks = (src.match(/<Button[\s\S]{0,300}?<\/Button>/g) ?? []).map((b) => b.replace(/=>/g, '=='))
    const iconOnly = blocks.filter((b) => {
      const inner = b.slice(b.indexOf('>') + 1, b.lastIndexOf('</Button>'))
      return inner.replace(/<[^>]+>/g, '').trim() === '' && !/\{t\(/.test(inner)
    })
    expect(iconOnly.filter((b) => !b.includes('aria-label'))).toEqual([])
  })

  test('nabava-tab: noben Button s SAMO Trash2 ikono brek aria-label', () => {
    const src = read('src/components/tabs/nabava-tab.tsx')
    const blocks = (src.match(/<Button[\s\S]{0,300}?<\/Button>/g) ?? []).map((b) => b.replace(/=>/g, '=='))
    const trashOnly = blocks.filter((b) => b.includes('<Trash2') && b.slice(b.indexOf('>') + 1, b.lastIndexOf('</Button>')).replace(/<[^>]+>/g, '').trim() === '')
    expect(trashOnly.filter((b) => !b.includes('aria-label'))).toEqual([])
  })

  test('einvoice-card: RotateCcw osvežitev seznama z aria-label (DEJANSKA produkcija najdba — kartica živi v nabava zavihku)', () => {
    const src = read('src/components/tabs/einvoice-card.tsx')
    expect(src).toContain("onClick={load} aria-label={t('common.refresh')}")
    // noben ikonski RotateCcw gumb brek imena
    const blocks = (src.match(/<Button[\s\S]{0,300}?<\/Button>/g) ?? []).map((b) => b.replace(/=>/g, '=='))
    const rotOnly = blocks.filter((b) => b.includes('<RotateCcw') && b.slice(b.indexOf('>') + 1, b.lastIndexOf('</Button>')).replace(/<[^>]+>/g, '').trim() === '')
    expect(rotOnly.filter((b) => !b.includes('aria-label'))).toEqual([])
  })
})

// ── Ž) REGISTRI ──

describe('v279 Ž: registri', () => {
  test('verzija 1.279.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.279.0')
  })

  test('i18n števci 4324/4324 (+4 ključi v1.279.0) in pariteta novih ključev SL/HR', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    expect(sl['modifiers.group.editAria']).toBe('Uredi skupino {name}')
    expect(hr['modifiers.group.editAria']).toBe('Uredi grupu {name}')
    expect(sl['modifiers.group.deleteAria']).toBe('Izbriši skupino {name}')
    expect(hr['modifiers.group.deleteAria']).toBe('Izbriši grupu {name}')
    expect(sl['modifiers.option.deleteAria']).toBe('Izbriši opcijo {name}')
    expect(hr['modifiers.option.deleteAria']).toBe('Izbriši opciju {name}')
    expect(sl['recurring.deleteAria']).toBe('Izbriši pravilo {name}')
    expect(hr['recurring.deleteAria']).toBe('Izbriši pravilo {name}')
  })

  test('worklog vrh nosi Task ID vala (prevez 44 vrh-pinov)', () => {
    const wl = read('worklog.md').slice(0, 400)
    expect(wl).toContain('Task ID: v1.279.0-revizija-produkcije')
  })

  test('AUDIT doc-truth: živi števec 4324 + POSODOBITEV v1.279.0', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('- 4324 ključev SL in 4324 HR')
    expect(audit).toContain('**POSODOBITEV (v1.279.0):**')
  })

  test('0 DDL: shema nedotaknjena (val je čisto render/a11y — nič prisma)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('v1.279')
  })

  test('fmt.ts ostaja čisti sloj: 0 uvozov (vzorec v1.277/v1.278 A8)', async () => {
    const fmtSrc = read('src/lib/fmt.ts')
    expect(fmtSrc).not.toMatch(/^import /m)
    expect(fmtSrc).not.toMatch(/^export .* from /m)
    expect(fmtSrc).toContain('export function fmtStampSI')
  })
})
