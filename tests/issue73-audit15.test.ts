/**
 * ISSUE #73 audit-15 (v1.137.0) — podvojena prikazna imena artiklov.
 *
 * Problem iz revizije: 436 ploščic hitre prodaje z golimi imeni prilagodb
 * (»Z gobami«) brez starša in podvojenimi imeni z različnima cenama
 * (»Bolognese 10,90 €« / »12,50 €«). Napačen tap v naglici = izgubljen račun.
 *
 * Pokritost:
 *  A. MOTOR (menu-dup.ts, brez DB): normItemName (trim + collapse + lowercase),
 *     findDuplicateDisplayName (ujemanje, normalizirana ujemanja, excludeId),
 *     dupItemNameMessage (ime + cena z vejico).
 *  B. VNOSNA VAROVALKA (API, dev SQLite): POST podvojeno prikazno ime v isti
 *     kategoriji → 409 (tudi z drugačno velikostjo črk/presledki); isto ime v
 *     DRUGI kategoriji → 201 (dovoljeno po zasnovi — ploščica razloči s
 *     kontekstom); PATCH preimenovanje na sestrsko ime → 409; PATCH na lastno
 *     ime (excludeId) in PATCH brez imena (samo cena) → 200.
 *  C. POŠILJAVNA PLAST (dashboard, source-guard): mešani pogled (Vse
 *     kategorije / iskanje) → overline kategorija na ploščici (jed ·
 *     različica · velikost), iskanje ujame kategorija·ime, košara razloči
 *     dvoumna imena (−1 na napačni vrstici = izgubljen račun).
 *
 * Fiksture s predpono i73a- (lokacija, manager z menu.manage, meni + 2
 * kategoriji, 3 artikli). Cleanup v afterAll prek sweepTestFixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { normItemName, findDuplicateDisplayName, dupItemNameMessage } from '../src/lib/menu-dup'
import { POST as menuPOST } from '../src/app/api/menus/route'
import { PATCH as menuIdPATCH } from '../src/app/api/menus/[id]/route'

const P = 'i73a-'
const RUN = Date.now().toString(36)

const read = (p: string) => readFileSync(p, 'utf-8')
const dash = read('src/app/dashboard/page.tsx')

function req(url: string, token: string | null, method = 'GET', bodyData?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: bodyData === undefined ? undefined : JSON.stringify(bodyData),
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

let locId = ''
let mgrToken = ''
let catTestId = ''
let catOtherId = ''
let itemBologneseId = ''
let itemBareId = ''

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  locId = `${P}loc-${RUN}`
  await db.location.create({ data: { id: locId, code: `${P}LC${RUN.slice(-4)}`, name: `${P}Lokacija`, premisesId: `${P}prem-${RUN}` } })
  const mgrId = `${P}emp-${RUN}`
  const email = `${P}mgr-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({ data: { id: mgrId, name: `${P}vodja`, email, role: 'manager', status: 'active', locationId: locId, pin: f.pin, pinLookup: f.pinLookup } })
  mgrToken = createToken({ sub: mgrId, name: `${P}vodja`, role: 'MANAGER', loc: locId, sv: 0 })
  const menuId = `${P}menu-${RUN}`
  await db.menu.create({ data: { id: menuId, name: `${P}Meni`, locationId: locId } })
  catTestId = `${P}cat-test-${RUN}`
  catOtherId = `${P}cat-other-${RUN}`
  await db.category.create({ data: { id: catTestId, name: `${P}Testenine`, menuId } })
  await db.category.create({ data: { id: catOtherId, name: `${P}Pizze`, menuId } })
  itemBologneseId = `${P}mi-bolognese-${RUN}`
  await db.menuItem.create({ data: { id: itemBologneseId, name: 'Bolognese', price: 10.9, categoryId: catTestId } })
  itemBareId = `${P}mi-bare-${RUN}`
  await db.menuItem.create({ data: { id: itemBareId, name: 'Z gobami', price: 10.5, categoryId: catTestId } })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})

/* ─────────── A. motor: normalizacija + iskanje duplikata ─────────── */

describe('issue73 audit-15 A: menu-dup motor', () => {
  it('normItemName: trim + collapse presledkov + lowercase', () => {
    expect(normItemName('  Bolognese ')).toBe('bolognese')
    expect(normItemName('Z   gobami\tin\nšampinjoni')).toBe('z gobami in šampinjoni')
    expect(normItemName('OCVRTE  BUČKE')).toBe('ocvrte bučke')
    expect(normItemName('')).toBe('')
  })

  it('findDuplicateDisplayName: natančno, normalizirano in z izključitvijo', () => {
    const rows = [
      { id: 'a', name: 'Bolognese', price: 10.9 },
      { id: 'b', name: 'Ocvrte bučke', price: 4.9 },
    ]
    // natančno ujemanje
    expect(findDuplicateDisplayName(rows, 'Bolognese')?.id).toBe('a')
    // velikost črk in presledki so ISTO prikazno ime (revizija: »Bolognese 10,90/12,50«)
    expect(findDuplicateDisplayName(rows, '  bolognese ')?.id).toBe('a')
    // brez ujemanja
    expect(findDuplicateDisplayName(rows, 'Napoli')).toBeNull()
    // excludeId: PATCH na lastno ime ni kolizija
    expect(findDuplicateDisplayName(rows, 'Bolognese', 'a')).toBeNull()
    // prazen kandidat ni kolizija
    expect(findDuplicateDisplayName(rows, '   ')).toBeNull()
  })

  it('dupItemNameMessage: vsebuje ime, ceno z vejico in razlog', () => {
    const msg = dupItemNameMessage({ id: 'x', name: 'Bolognese', price: 12.5 })
    expect(msg).toContain('Bolognese')
    expect(msg).toContain('12,50')
    expect(msg).toContain('kategoriji')
    expect(msg).toContain('edinstveno')
  })
})

/* ─────────── B. vnosna varovalka: POST + PATCH 409 ─────────── */

describe('issue73 audit-15 B: vnos — prikazno ime je v kategoriji edinstveno', () => {
  it('POST: prvi vnos uspe (201)', async () => {
    const res = await menuPOST(req('/api/menus', mgrToken, 'POST', { categoryId: catTestId, name: 'Napoli', price: 9.9 }))
    expect(res.status).toBe(201)
    const j = await body(res)
    expect((j.item as { name: string }).name).toBe('Napoli')
  })

  it('POST: isto ime v ISTI kategoriji → 409 z razlogom', async () => {
    const res = await menuPOST(req('/api/menus', mgrToken, 'POST', { categoryId: catTestId, name: 'Bolognese', price: 12.5 }))
    expect(res.status).toBe(409)
    const j = await body(res)
    expect(String(j.error)).toContain('Bolognese')
    expect(String(j.error)).toContain('10,90')
    expect(String(j.error)).toContain('edinstveno')
  })

  it('POST: normalizirana ujemanja (velike črke, dvojni presledki) → 409', async () => {
    const r1 = await menuPOST(req('/api/menus', mgrToken, 'POST', { categoryId: catTestId, name: '  bolognese ', price: 12.5 }))
    expect(r1.status).toBe(409)
    const r2 = await menuPOST(req('/api/menus', mgrToken, 'POST', { categoryId: catTestId, name: 'BOLOGNESE', price: 12.5 }))
    expect(r2.status).toBe(409)
    const r3 = await menuPOST(req('/api/menus', mgrToken, 'POST', { categoryId: catTestId, name: 'Z  gobami', price: 12.5 }))
    expect(r3.status).toBe(409)
  })

  it('POST: isto ime v DRUGI kategoriji → 201 (dovoljeno po zasnovi — ploščica razloči)', async () => {
    const res = await menuPOST(req('/api/menus', mgrToken, 'POST', { categoryId: catOtherId, name: 'Bolognese', price: 12.5 }))
    expect(res.status).toBe(201)
  })

  it('PATCH: preimenovanje na sestrsko ime v isti kategoriji → 409', async () => {
    const res = await menuIdPATCH(req(`/api/menus/${itemBareId}`, mgrToken, 'PATCH', { name: 'Bolognese' }), { params: Promise.resolve({ id: itemBareId }) })
    expect(res.status).toBe(409)
    const j = await body(res)
    expect(String(j.error)).toContain('Bolognese')
  })

  it('PATCH: preimenovanje na lastno (isto) ime ni kolizija → 200', async () => {
    const res = await menuIdPATCH(req(`/api/menus/${itemBareId}`, mgrToken, 'PATCH', { name: 'Z gobami' }), { params: Promise.resolve({ id: itemBareId }) })
    expect(res.status).toBe(200)
  })

  it('PATCH: sprememba BREZ imena (samo cena) ni prizadeta → 200', async () => {
    const res = await menuIdPATCH(req(`/api/menus/${itemBareId}`, mgrToken, 'PATCH', { price: 11.5 }), { params: Promise.resolve({ id: itemBareId }) })
    expect(res.status).toBe(200)
  })
})

/* ─────────── C. pošiljevalna plast: ploščica + košara ─────────── */

describe('issue73 audit-15 C: dashboard — ploščica »jed · različica · velikost«', () => {
  it('mešani pogled (Vse kategorije ALI iskanje) sproži overline', () => {
    expect(dash).toContain('const saleMixed = saleCat === \'ALL\' || saleSearch.trim() !== \'\'')
    expect(dash).toContain('const catOverline = saleMixed ? saleCatNameOf(mi) : \'\'')
  })

  it('overline je na ploščici (jed · različica · velikost) in v aria-label', () => {
    expect(dash).toContain('catOverline && (')
    expect(dash).toContain('aria-label={`${catOverline ? `${catOverline} · ` : \'\'}${mi.name}')
    // overline je vidni kontekst, aria ga ne podvaja (ni v notranjosti gumba dvakrat)
    expect(dash.match(/aria-hidden="true"\s*>\{catOverline\}</)).not.toBeNull()
  })

  it('iskanje ujame tudi kombinacijo kategorija·ime (»pizze bolognese«)', () => {
    expect(dash).toContain('const saleQ = saleSearch.trim().toLowerCase()')
    expect(dash).toContain('const saleTokens = saleQ ? saleQ.split(/\\s+/).filter(Boolean) : []')
    // ŽETONI (vsaka beseda v imenu+kategoriji) — ne sosednji podniz: »pizze
    // bolognese« zadane tudi »Pizze« + »Bolognese« kljub ločilom v kategoriji
    expect(dash).toContain("saleTokens.every((tok) => `${mi.name} ${saleCatNameOf(mi)}`.toLowerCase().includes(tok))")
  })

  it('košara razloči dvoumna imena s kontekstom kategorije (−1 ne zadane napačne)', () => {
    expect(dash).toContain('const saleAmbiguous = useMemo(')
    expect(dash).toContain('normItemName(mi.name)')
    expect(dash).toContain('const saleCartName = (mi: MenuT): ReactNode =>')
    // obe vrstici košare (namizje + mobilni list) uporabljata razločeno ime
    expect(dash.match(/\{qty\}× \{saleCartName\(mi\)\}/g)?.length).toBe(2)
  })

  it('normalizacija UI ≡ API (isti vir resnice menu-dup)', () => {
    expect(dash).toContain("import { normItemName } from '@/lib/menu-dup'")
  })
})
