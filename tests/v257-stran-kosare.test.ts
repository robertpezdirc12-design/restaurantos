/**
 * v1.257.0 — STRAN KOŠARE (docs/PRIMERJAVA-VMESNIKOV-2026 §31;
 * Square Vol 15, 22. 10. 2026 »Choose the cart's side of the
 * checkout screen« — »Sellers choose whether the cart sits on the
 * left or the right side of the checkout screen […]. Placing the
 * cart on the left gives right-handed staff easier access to the
 * item grid, while placing it on the right does the same for
 * left-handed staff.«).
 *
 * Merjena situacija: naša košara prodaje ima ZAPISANO ZGODOVINO
 * STRANI — v1.127 desna košara (Square), v1.141 KOŠARA LEVO (Toast
 * »left rail«). Razprava je naiščena v lastni kodi; Vol 15 jo
 * razreši odločitvijo NAPRAVE, ne sistema.
 *
 *  A · MONTAŽA VIRA: per-naprava persist ro_sale_cart_side
 *    (validacija vrednosti, tiha odpoved), segmentirana kontrola
 *    z aria-pressed + 44 px cilji, ZRCALJENJE predloge mreže in
 *    order-1/order-2 (obe veji statično v viru).
 *  Ž · REGISTRI: verzija 1.257.0 + compose, i18n pariteta
 *    4093/4093 (+5 sale.cartSide*), dokumenta §31 + AUDIT,
 *    0 DDL dokaz, mobilna (<md) neodvisnost, worklog.
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

const pageSrc = read('src/app/dashboard/page.tsx')

// ── A) MONTAŽA VIRA ──

describe('v1.257.0 A1 — stanje + persist po vzorcu ro_sale_view', () => {
  test('A1a: stanje z ozkim tipom levo/desno, privzeto LEVO (ohranja v1.141 status quo)', () => {
    expect(pageSrc).toContain("useState<'left' | 'right'>('left')")
  })

  test('A1b: persist ključ ro_sale_cart_side — obnova v mikrotaski z validacijo vrednosti (smeti ne sprejme)', () => {
    expect(pageSrc).toContain("localStorage.getItem('ro_sale_cart_side')")
    expect(pageSrc).toContain("if (v === 'left' || v === 'right') setSaleCartSide(v)")
    expect(pageSrc).toContain("localStorage.setItem('ro_sale_cart_side', v)")
  })

  test('A1c: obnova v queueMicrotask (enak vzorec kot ro_sale_view — ne sinhroni setState v telesu efekta)', () => {
    const idx = pageSrc.indexOf("localStorage.getItem('ro_sale_cart_side')")
    expect(idx).toBeGreaterThan(0)
    const before = pageSrc.slice(Math.max(0, idx - 400), idx)
    expect(before).toContain('queueMicrotask')
  })
})

describe('v1.257.0 A2 — segmentirana kontrola (dostopnost + cilji)', () => {
  test('A2a: skupina z lastnim data-region + aria-label', () => {
    expect(pageSrc).toContain('data-region="sale-cart-side"')
    expect(pageSrc).toContain("aria-label={t('sale.cartSide')}")
  })

  test('A2b: oba gumba nosita aria-pressed vezavo na stanje', () => {
    expect(pageSrc).toContain("aria-pressed={saleCartSide === 'left'}")
    expect(pageSrc).toContain("aria-pressed={saleCartSide === 'right'}")
  })

  test('A2c: polni aria opis + kratka oznaka gumba (ikona vedno, besedilo od lg — vzorec gostote)', () => {
    expect(pageSrc).toContain("aria-label={t('sale.cartSideLeft')}")
    expect(pageSrc).toContain("aria-label={t('sale.cartSideRight')}")
    expect(pageSrc).toContain("t('sale.cartSideLeftShort')")
    expect(pageSrc).toContain("t('sale.cartSideRightShort')")
    expect(pageSrc.match(/hidden lg:inline">\{t\('sale\.cartSide/g)?.length).toBe(2)
  })

  test('A2d: obe ikoni sta v uvozih lucide (PanelLeft/PanelRight)', () => {
    expect(pageSrc).toMatch(/import \{[^}]*PanelLeft[^}]*\} from 'lucide-react'/)
    expect(pageSrc).toMatch(/import \{[^}]*PanelRight[^}]*\} from 'lucide-react'/)
    expect(pageSrc).toContain('<PanelLeft className="w-4 h-4" aria-hidden />')
    expect(pageSrc).toContain('<PanelRight className="w-4 h-4" aria-hidden />')
  })

  test('A2e: 44 px dotik — px-2.5 py-2 skupine (enaka geometrija kot preklop gostote)', () => {
    expect(pageSrc.match(/rounded-md px-2\.5 py-2 text-xs font-semibold transition/g)?.length).toBeGreaterThanOrEqual(4)
  })
})

describe('v1.257.0 A3 — zrcaljenje postavitve (obe veji statično v viru)', () => {
  test('A3a: LEVO = sedanja predloga (17rem/21rem najprej) + mreža order-2 + košara order-1', () => {
    expect(pageSrc).toContain("'md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)]'")
    expect(pageSrc).toContain("'md:order-2'")
    expect(pageSrc).toContain("'md:order-1'")
  })

  test('A3b: DESNO = zrcaljena predloga (minmax najprej) — obe vrstici reda se zamenjata', () => {
    expect(pageSrc).toContain("'md:grid-cols-[minmax(0,1fr)_17rem] lg:grid-cols-[minmax(0,1fr)_21rem]'")
    // mreža: order-1 ko je desno; košara: order-2 ko je desno
    expect(pageSrc).toContain("${saleCartSide === 'left' ? 'md:order-2' : 'md:order-1'}")
    expect(pageSrc).toContain("${saleCartSide === 'left' ? 'md:order-1' : 'md:order-2'}")
  })

  test('A3c: predloga je VEZANA na stanje (pogojni izraz, ne fiksni razred)', () => {
    expect(pageSrc).toContain("${\n              saleCartSide === 'left'\n                ? 'md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)]'\n                : 'md:grid-cols-[minmax(0,1fr)_17rem] lg:grid-cols-[minmax(0,1fr)_21rem]'\n            }")
  })
})

// ── Ž) REGISTRI ──

describe('v1.257.0 Ž — registri', () => {
  test('Ž1: verzija 1.257.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.305.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.305.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.305.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+5 sale.cartSide*)', () => {
    for (const k of [
      'sale.cartSide', 'sale.cartSideLeft', 'sale.cartSideRight',
      'sale.cartSideLeftShort', 'sale.cartSideRightShort',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    const slCount = Object.keys(sl).length
    const hrCount = Object.keys(hr).length
    expect(slCount).toBe(4324)
    expect(hrCount).toBe(4324)
  })

  test('Ž3: dokumenta — PRIMERJAVA §31 + AUDIT POSODOBITEV + števci', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 31.')
    expect(doc).toContain("Choose the cart's side")
    expect(doc).toContain('ro_sale_cart_side')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('v1.257.0')
    expect(auditDoc).toContain('- 4324 ključev SL in 4324 HR')
  })

  test('Ž4: 0 DDL dokaz — čista klientna nastavitev brez strežnika (noben nov vir v api/ tega vala, schema brez CartSide)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('CartSide')
    expect(schema).not.toContain('cartSide')
    // nastavitev NE gre čez strežnik — samo localStorage
    const idx = pageSrc.indexOf('ro_sale_cart_side')
    expect(idx).toBeGreaterThan(0)
    // brez API klica v bližini stanja (persister je čist localStorage)
    const seg = pageSrc.slice(Math.max(0, idx - 200), idx + 600)
    expect(seg).not.toContain('fetch(')
  })

  test('Ž5: mobilna (<md) postavitev NEODVISNA — aside skrit pod md, fiksna vrstica nedotaknjena', () => {
    expect(pageSrc).toContain('hidden md:block ${saleCartSide')
    // fiksna mobilna vrstica košare ostaja izven zrcaljenja (v1.128 vzorec)
    expect(pageSrc).toContain('MOBILNI (<md)')
  })

  test('Ž6: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.305.0-nadzorni-val-stabilnosti-vi')
  })
})
