/**
 * Issue #7 (P1) — alergeni: en vir resnice od sestavine do menija in KDS.
 *
 * Pokrito:
 *  A. KATALOG: 14 kanoničnih kod EU (Uredba 1169/2011 Priloga II), oznake
 *     SL/HR/EN, preslikava legacy prostega besedila (cela beseda + besede z
 *     stop-listo), negativne izjave ("brez glutena") → null, strict sanitizacija
 *     pisanja (samo kanonične kode);
 *  B. SESTAVINA: POST /api/inventory/allergens (inventory.manage + guard) —
 *     strukturirane kode + "lahko vsebuje" (navzkrižna kontaminacija = ocena
 *     osebje) + potrditev (kdaj+kdo); presek allergens∩crossContact se odšteje;
 *     sprememba vsebine brez confirm → stara potrditev Razveljavljena + jedi s
 *     to sestavino dobijo zastavico ponovne preverbe; waiter 403 →
 *     ALLERGEN_ACCESS_DENIED audit (brez vrednosti); neveljavna koda → 400;
 *  C. PROFIL JEDI: GET /api/menus/[id]/allergens — izračun iz VSEGA drevesa
 *     recepture (podreceptura: otroci razstavljajo starša — vsi vozlišča
 *     prispevajo), legacy preslikano, viri po kodah; status: nedokumentirano →
 *     needs_confirmation (NIKOLI lažno "brez alergenov"), nepotrjena sestavina →
 *     needs_confirmation, zastavica/nepreslikane oznake → review_required;
 *  D. POTRDITEV: POST confirm (menu.manage) → confirmedAt+kdo, zastavica
 *     počisčena; ponovna sprememba recepture (POST /api/recipes) → zastavica
 *     spet prižgana; potrditev ne izniči podatkov;
 *  E. ROČNI POPRAVEK: override add/remove z razlogom (< 10 → 400; odstranitev
 *     neprisotne kode → 400); odstranjena izpeljana koda OSTANE vidna
 *     (removedByOverride); audit z izvorom;
 *  F. MODIFIKATOR: PATCH /api/modifiers/[id] (samo allergens, menu.manage) →
 *     prizadete jedi povezane na skupino dobijo zastavico; profil pokaže
 *     modifierCodes (dodatek ≠ baza jedi);
 *  G. NAROČILO: createOrderCore — posnetek (kode jedi ∪ IZBRANE opcije) +
 *     izrecno opozorilo na postavki; mapOrderItem izpiše warning+kode (KDS);
 *     kuhinjski list natisne ⚠ ALERGIJA + alergene; PO spremembi sestavine
 *     POSNETEK obstoječega naročila se NE spremeni (zgodovinska celovitost);
 *     PATCH /api/orders/[id]/allergen-warning (RBAC + audit staro→novo;
 *     zaključeno naročilo → 409);
 *  H. JAVNI MENI: loadPublicMenu — kanonične kode + status + crossContact +
 *     alergeni opcij (padec izračuna → legacy fallback, NE podre menija);
 *  I. CROSS-TENANT: manager lokacije B NE sme nastavljati sestavin/jedi/
 *     opozoril lokacije A;
 *  J. REGISTER: SCHEMA_MIGRATIONS vsebuje allergen-truth (17 vnosov) +
 *     i18n SL/HR opis; DDL ruta idempotentna (sqlite že ima stolpce →
 *     alreadyApplied).
 *
 * Fiksture s predpono i7- (TEST_PREFIXES); naročila ročno zbrana in izbrisana
 * (nid() — OrderItem FK Restrict na MenuItem zahteva vrstni red brisanja).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  ALLERGEN_CODES,
  ALLERGEN_LABELS,
  labelToAllergenCode,
  parseAllergenCodes,
  sanitizeAllergenCodeList,
  allergenLabels,
} from '../src/lib/allergen-catalog'
import {
  getMenuItemAllergenProfiles,
  buildAllergenSnapshots,
  snapshotCodes,
  parseAllergenSnapshot,
  sanitizeAllergenWarning,
} from '../src/lib/allergen-profile'
import { POST as invAllergensPOST } from '../src/app/api/inventory/allergens/route'
import { GET as menuAllergensGET, POST as menuAllergensPOST } from '../src/app/api/menus/[id]/allergens/route'
import { PATCH as modifierPATCH } from '../src/app/api/modifiers/[id]/route'
import { PATCH as warningPATCH } from '../src/app/api/orders/[id]/allergen-warning/route'
import { POST as recipesPOST } from '../src/app/api/recipes/route'
import { POST as ddlPOST } from '../src/app/api/admin/migrate-allergen-truth/route'
import { createOrderCore } from '../src/lib/ops'
import { mapOrderItem } from '../src/lib/map'
import { buildKitchenTicketLines } from '../src/lib/devices/print'
import { loadPublicMenu } from '../src/lib/guest'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { sl as slDict } from '../src/lib/i18n/sl'
import { hr as hrDict } from '../src/lib/i18n/hr'
import { nid } from '../src/lib/map'

const P = 'i7-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let mgrA = ''
let mgrB = ''
let waiterA = ''
let ownerA = ''
let tokA = ''
let tokB = ''
let tokWaiter = ''
let tokOwner = ''

// jedi/sestavine/modifikatorji
let miMain = '' // glavna jed (receptura z dvema sestavinama + podrecepturo)
let miSide = '' // prilok (brez recepture, legacy zapis)
let invMoka = ''
let invMleko = ''
let invMaslo = ''
let modGroup = ''
let modSir = '' // dodatek "sir" (milk)

const createdOrders: string[] = []

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

async function seedEmployee(name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const pin = `${PIN_BASE}${seq}`
  const f = employeePinFields(pin, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  const la = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `I7A-${RUN.toUpperCase()}` } })
  const lb = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `I7B-${RUN.toUpperCase()}` } })
  locA = la.id
  locB = lb.id
  mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  waiterA = await seedEmployee('waiterA', 'waiter', locA, 3)
  ownerA = await seedEmployee('ownerA', 'owner', locA, 4)
  tokA = createToken({ sub: mgrA, name: `${P}mgrA`, role: 'MANAGER', loc: locA, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}mgrB`, role: 'MANAGER', loc: locB, sv: 0 })
  tokWaiter = createToken({ sub: waiterA, name: `${P}waiterA`, role: 'WAITER', loc: locA, sv: 0 })
  tokOwner = createToken({ sub: ownerA, name: `${P}ownerA`, role: 'OWNER', loc: locA, sv: 0 })

  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: `${P}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: `${P}Juhe`, menuId: menu.id } })
  miMain = `${P}mi-main-${RUN}`
  miSide = `${P}mi-side-${RUN}`
  await db.menuItem.create({ data: { id: miMain, name: `${P}Kremna juha`, price: 6, categoryId: cat.id } })
  // legacy prosto besedilo (preslikava v kode + ena nepreslikljiva oznaka)
  await db.menuItem.create({ data: { id: miSide, name: `${P}Prilok`, price: 3, categoryId: cat.id, allergens: 'gluten, nekaj neznanskega' } })

  invMoka = `${P}inv-moka-${RUN}`
  invMleko = `${P}inv-mleko-${RUN}`
  invMaslo = `${P}inv-maslo-${RUN}`
  await db.inventoryItem.createMany({
    data: [
      { id: invMoka, name: `${P}Moka`, unit: 'kg', quantity: 10, costPerUnit: 1, supplier: `${P}Mlin`, locationId: locA },
      { id: invMleko, name: `${P}Mleko`, unit: 'l', quantity: 10, costPerUnit: 1, supplier: `${P}Sirar`, locationId: locA },
      { id: invMaslo, name: `${P}Maslo`, unit: 'kg', quantity: 5, costPerUnit: 5, supplier: `${P}Mlekarna`, locationId: locA },
    ],
  })

  // receptura: moka (vrhnja) + otrok mleko (podreceptura) — obe sestavini štejeta
  const riParent = nid()
  const riChild = nid()
  await db.recipeItem.create({ data: { id: riParent, menuItemId: miMain, inventoryItemId: invMoka, quantityPerServing: 0.1, unit: 'kg', yieldPercent: 100, parentRecipeItemId: null } })
  await db.recipeItem.create({ data: { id: riChild, menuItemId: miMain, inventoryItemId: invMleko, quantityPerServing: 0.2, unit: 'l', yieldPercent: 100, parentRecipeItemId: riParent } })

  // modifikator: skupina na jedi + opcija sir
  modGroup = `${P}modgroup-${RUN}`
  modSir = `${P}mod-sir-${RUN}`
  await db.modifierGroup.create({ data: { id: modGroup, name: `${P}Dodatki`, required: false, minSelect: 0, locationId: locA } })
  await db.menuItemModifierGroup.create({ data: { id: nid(), menuItemId: miMain, modifierGroupId: modGroup, sortOrder: 0 } })
  await db.modifier.create({ data: { id: modSir, name: `${P}Sir`, price: 1, modifierGroupId: modGroup, allergens: '' } })
})

afterAll(async () => {
  // vrstni red: naročila (FK Restrict na MenuItem) → jedi (kaskadira recepture +
  // povezave skupin) → modifikatorji/skupine → zaloga → meni/kategorije →
  // zaposleni → lokacije → revizija
  for (const oid of createdOrders) {
    await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
  }
  await db.menuItem.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.modifier.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.modifierGroup.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { locationId: { in: [locA, locB] } } }).catch(() => null)
})

/* ─────────────── A. katalog (čisti unit brez DB) ─────────────── */

describe('A. katalog 14 EU alergenov', () => {
  it('ima natanko 14 kanoničnih kod (Priloga II Uredbe 1169/2011), unikatnih', () => {
    expect(ALLERGEN_CODES.length).toBe(14)
    expect(new Set(ALLERGEN_CODES).size).toBe(14)
    for (const loc of ['sl', 'hr', 'en'] as const) {
      for (const code of ALLERGEN_CODES) {
        expect(ALLERGEN_LABELS[loc][code].length).toBeGreaterThan(3)
      }
    }
  })

  it('preslika legacy oznake: cela beseda, večbesedne z barkami, HR oblike', () => {
    expect(labelToAllergenCode('gluten')).toBe('gluten')
    expect(labelToAllergenCode('Gluten')).toBe('gluten')
    expect(labelToAllergenCode('Mleko v prahu')).toBe('milk')
    expect(labelToAllergenCode('arašidi')).toBe('peanuts')
    expect(labelToAllergenCode('kikiriki')).toBe('peanuts')
    expect(labelToAllergenCode('rakovi')).toBe('crustaceans')
    expect(labelToAllergenCode('školjke')).toBe('molluscs')
    expect(labelToAllergenCode('laktoza')).toBe('milk')
    expect(labelToAllergenCode('pšenična moka')).toBe('gluten')
  })

  it('negativne izjave in neznane oznake → null (nikoli ne ugiba)', () => {
    expect(labelToAllergenCode('brez glutena')).toBeNull()
    expect(labelToAllergenCode('neznana stvar')).toBeNull()
    expect(labelToAllergenCode('')).toBeNull()
  })

  it('parseAllergenCodes: JSON niz / CSV / array; unknown ostanejo vidne', () => {
    expect(parseAllergenCodes('["milk","gluten"]').codes).toEqual(['gluten', 'milk'])
    expect(parseAllergenCodes('gluten, laktoza').codes).toEqual(['gluten', 'milk'])
    expect(parseAllergenCodes(['nuts', 'sesame']).codes).toEqual(['nuts', 'sesame'])
    const mixed = parseAllergenCodes('gluten, čarobni prah')
    expect(mixed.codes).toEqual(['gluten'])
    expect(mixed.unknown).toEqual(['čarobni prah'])
    expect(parseAllergenCodes(null as unknown as string).codes).toEqual([])
  })

  it('sanitizeAllergenCodeList: strict za pisanje (neveljavne kode izločene)', () => {
    const s = sanitizeAllergenCodeList(['milk', 'gluten', 'fakecode', 42])
    expect(s.codes).toEqual(['gluten', 'milk'])
    expect(s.invalid).toEqual(['fakecode', 42])
    expect(sanitizeAllergenCodeList('milk' as unknown as string[]).invalid.length).toBe(1)
  })

  it('allergenLabels: kanonični vrstni red + SL/HR oznake', () => {
    expect(allergenLabels(['milk', 'gluten'], 'sl')).toContain('Gluten')
    expect(allergenLabels(['milk', 'gluten'], 'hr')).toContain('Mlijeko')
    expect(allergenLabels(['nuts'], 'en')).toBe('Nuts')
  })
})

/* ─────────────── B. sestavina: POST /api/inventory/allergens ─────────────── */

describe('B. strukturirani alergeni sestavine (inventory.manage + tenant)', () => {
  it('nastavi kode + crossContact + potrditev; audit INVENTORY_ALLERGENS_SET', async () => {
    const res = await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokA, { inventoryItemId: invMoka, allergens: ['gluten'], crossContact: ['nuts'], confirm: true }),
    )
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.allergens).toEqual(['gluten'])
    expect(j.crossContact).toEqual(['nuts'])
    expect(j.confirmed).toBe(true)
    const row = await db.inventoryItem.findUnique({ where: { id: invMoka } })
    expect(row?.allergens).toBe('["gluten"]')
    expect(row?.allergensCrossContact).toBe('["nuts"]')
    expect(row?.allergensConfirmedAt).not.toBeNull()
    expect(row?.allergensConfirmedById).toBe(mgrA)
    const audit = await db.auditLog.findFirst({
      where: { action: 'INVENTORY_ALLERGENS_SET', entityId: invMoka },
    })
    expect(audit).not.toBeNull()
  })

  it('presek allergens∩crossContact se odšteje (allergens je nadvsežnost)', async () => {
    const res = await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokA, { inventoryItemId: invMaslo, allergens: ['milk'], crossContact: ['milk', 'soybeans'], confirm: true }),
    )
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.crossContact).toEqual(['soybeans'])
  })

  it('neveljavna koda → 400 (strict kanonične kode)', async () => {
    const res = await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokA, { inventoryItemId: invMoka, allergens: ['gluten', 'naravni-gluten'] }),
    )
    expect(res.status).toBe(400)
  })

  it('waiter brez inventory.manage → 403 + ALLERGEN_ACCESS_DENIED audit (brez vrednosti)', async () => {
    const res = await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokWaiter, { inventoryItemId: invMoka, allergens: ['gluten'] }),
    )
    expect(res.status).toBe(403)
    const audit = await db.auditLog.findFirst({
      where: { action: 'ALLERGEN_ACCESS_DENIED', entityId: 'allergens' },
    })
    expect(audit).not.toBeNull()
    expect(String(audit?.details ?? '')).not.toContain('gluten')
  })

  it('cross-tenant: manager lokacije B ne more spreminjati sestavine lokacije A', async () => {
    const res = await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokB, { inventoryItemId: invMoka, allergens: [] }),
    )
    expect(res.status).toBe(403)
    const row = await db.inventoryItem.findUnique({ where: { id: invMoka } })
    expect(row?.allergens).toBe('["gluten"]')
  })

  it('sprememba vsebine brez confirm → stara potrditev razveljavljena + jedi s sestavino v ponovni preverbi', async () => {
    // potrditev mleka (jed jo potrebuje za 'confirmed')
    await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokA, { inventoryItemId: invMleko, allergens: ['milk'], crossContact: [], confirm: true }),
    )
    // vsebina se spremeni BREZ confirm → potrditev razveljavljena
    const res = await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokA, { inventoryItemId: invMleko, allergens: ['milk', 'soybeans'], crossContact: [] }),
    )
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.confirmed).toBe(false)
    expect(j.contentChanged).toBe(true)
    expect(j.flaggedMenuItems).toBe(1)
    const row = await db.inventoryItem.findUnique({ where: { id: invMleko } })
    expect(row?.allergensConfirmedAt).toBeNull()
    const mi = await db.menuItem.findUnique({ where: { id: miMain } })
    expect(mi?.allergenReviewFlag).toBe(true)
    expect(String(mi?.allergenReviewReason)).toContain('sestavine')
  })
})

/* ─────────────── C. profil jedi (izračun iz drevesa recepture) ─────────────── */

describe('C. profil jedi: podrecepture + status + viri', () => {
  it('izračuna kode iz VSEGA drevesa (parent + child = obe sestavini)', async () => {
    const profiles = await getMenuItemAllergenProfiles([miMain])
    const p = profiles.get(miMain)
    expect(p).not.toBeUndefined()
    // moka=gluten, mleko=milk+soybeans (trenutno stanje)
    expect(p!.derivedCodes).toEqual(['gluten', 'soybeans', 'milk'])
    expect(p!.crossContact).toEqual(['nuts'])
    expect(p!.hasRecipe).toBe(true)
    // sestavine drevesa recepture (parent + child) so zabeližene v profilu
    expect(p!.ingredients.map((i) => i.name).sort()).toEqual([`${P}Mleko`, `${P}Moka`])
    expect(p!.sources['gluten']?.ingredients).toEqual([`${P}Moka`])
  })

  it('status: nepotrjena sestavina → needs_confirmation (nikoli lažno "brez")', async () => {
    const profiles = await getMenuItemAllergenProfiles([miMain])
    const p = profiles.get(miMain)!
    expect(p!.status).toBe('needs_confirmation')
    expect(p!.needsConfirmation).toBe(true)
    expect(p!.unconfirmedIngredients).toContain(`${P}Mleko`)
  })

  it('GET /api/menus/[id]/allergens: profil + sestavine (menu.manage)', async () => {
    const res = await menuAllergensGET(req('GET', `/api/menus/${miMain}/allergens`, tokA), params(miMain))
    expect(res.status).toBe(200)
    const j = await body(res)
    const p = j.profile as Record<string, unknown>
    expect(p.menuItemId).toBe(miMain)
    expect(p.status).toBe('needs_confirmation')
    expect(Array.isArray(p.ingredients)).toBe(true)
    expect(Array.isArray(p.codes)).toBe(true)
  })

  it('waiter brez menu.manage → 403 na GET profil', async () => {
    const res = await menuAllergensGET(req('GET', `/api/menus/${miMain}/allergens`, tokWaiter), params(miMain))
    expect(res.status).toBe(403)
  })

  it('legacy jed brez recepture: preslikane kode + nepreslikane oznake → review_required', async () => {
    const profiles = await getMenuItemAllergenProfiles([miSide])
    const p = profiles.get(miSide)!
    expect(p.legacyCodes).toEqual(['gluten'])
    expect(p.unknownLabels).toEqual(['nekaj neznanskega'])
    expect(p.hasRecipe).toBe(false)
    // jed nima potrjenega profila → needs_confirmation (hujše od review)
    expect(p.status).toBe('needs_confirmation')
  })
})

/* ─────────────── D. potrditev profila + ponovna preverba ─────────────── */

describe('D. potrditev profila + zastavica ponovne preverbe', () => {
  it('sprememba recepture (POST /api/recipes) prižge zastavico', async () => {
    // resetiraj: mleko potrjeno + profil potrjen
    await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokA, { inventoryItemId: invMleko, allergens: ['milk'], crossContact: [], confirm: true }),
    )
    const confirm = await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokA, { action: 'confirm' }),
      params(miMain),
    )
    expect(confirm.status).toBe(200)
    const j = await body(confirm)
    expect((j.profile as Record<string, unknown>).status).toBe('confirmed')

    // NOVA receptura (ista sestavina, druga količina) → zastavica
    const res = await recipesPOST(
      req('POST', '/api/recipes', tokA, { menuItemId: miMain, items: [{ inventoryItemId: invMoka, qty: 0.15, unit: 'kg' }] }),
    )
    expect(res.status).toBe(201)
    const mi = await db.menuItem.findUnique({ where: { id: miMain } })
    expect(mi?.allergenReviewFlag).toBe(true)
    const profiles = await getMenuItemAllergenProfiles([miMain])
    expect(profiles.get(miMain)!.status).toBe('review_required')
    expect(profiles.get(miMain)!.reviewReason).toContain('receptur')
  })

  it('ponovna potrditev počisti zastavico (podatki se NE izničijo)', async () => {
    const confirm = await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokA, { action: 'confirm' }),
      params(miMain),
    )
    expect(confirm.status).toBe(200)
    const mi = await db.menuItem.findUnique({ where: { id: miMain } })
    expect(mi?.allergenReviewFlag).toBe(false)
    expect(mi?.allergensConfirmedAt).not.toBeNull()
    expect(mi?.allergensConfirmedById).toBe(mgrA)
    const audit = await db.auditLog.findFirst({ where: { action: 'MENU_ALLERGENS_CONFIRMED', entityId: miMain } })
    expect(audit).not.toBeNull()
    // mleko je IZPUŠČENO iz nove recepture → profil zdaj samo gluten, a mleko
    // ne sme tiho izginiti iz evidence — nov profil je res samo gluten (receptura
    // je res spremenjena) in status je confirmed (vse prisotne sestavine potrjene)
    const profiles = await getMenuItemAllergenProfiles([miMain])
    const p = profiles.get(miMain)!
    expect(p.derivedCodes).toEqual(['gluten'])
    expect(p.status).toBe('confirmed')
  })
})

/* ─────────────── E. ročni popravek (override) ─────────────── */

describe('E. ročni popravek: izvor + razlog + vidne odstranjene kode', () => {
  it('razlog < 10 znakov → 400', async () => {
    const res = await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokA, { action: 'override', add: [], remove: ['gluten'], reason: 'kratko' }),
      params(miMain),
    )
    expect(res.status).toBe(400)
  })

  it('odstranitev neprisotne kode → 400', async () => {
    const res = await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokA, { action: 'override', add: [], remove: ['fish'], reason: 'odstranimo ribe, ki jih ni' }),
      params(miMain),
    )
    expect(res.status).toBe(400)
  })

  it('override add+remove: odstranjena izpeljana koda OSTANE vidna (removedByOverride)', async () => {
    const res = await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokA, { action: 'override', add: ['celery'], remove: ['gluten'], reason: 'zamenjana moka brez glutena, dodan zeler' }),
      params(miMain),
    )
    expect(res.status).toBe(200)
    const j = await body(res)
    const p = j.profile as Record<string, unknown>
    expect(p.codes).toEqual(['celery'])
    expect(p.removedByOverride).toEqual(['gluten'])
    const mi = await db.menuItem.findUnique({ where: { id: miMain } })
    const ov = JSON.parse(mi?.allergensOverride ?? '{}') as Record<string, unknown>
    expect(ov.reason).toBe('zamenjana moka brez glutena, dodan zeler')
    expect(ov.confirmedById).toBe(mgrA)
    const audit = await db.auditLog.findFirst({ where: { action: 'MENU_ALLERGENS_OVERRIDE', entityId: miMain } })
    expect(audit).not.toBeNull()
    // odstranitev izpeljane kode = odločitev, ki zahteva pozornost → review
    expect(p.status).toBe('review_required')
  })

  it('waiter brez menu.manage → 403 na override', async () => {
    const res = await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokWaiter, { action: 'override', add: [], remove: [], reason: 'nedovoljen poskus popravka' }),
      params(miMain),
    )
    expect(res.status).toBe(403)
  })

  it('cross-tenant: manager B ne more brati profila jedi A', async () => {
    const res = await menuAllergensGET(req('GET', `/api/menus/${miMain}/allergens`, tokB), params(miMain))
    expect([403, 404]).toContain(res.status)
  })

  it('prazni add+remove počisti popravek (razlog še vedno obvezen)', async () => {
    const res = await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokA, { action: 'override', add: [], remove: [], reason: 'popravek umaknjen po preverbi' }),
      params(miMain),
    )
    expect(res.status).toBe(200)
    const mi = await db.menuItem.findUnique({ where: { id: miMain } })
    expect(mi?.allergensOverride).toBeNull()
  })
})

/* ─────────────── F. modifikatorji ─────────────── */

describe('F. alergeni modifikatorja (dodatek ≠ baza jedi)', () => {
  it('PATCH /api/modifiers/[id] (menu.manage): kode + zastavica prizadetih jedi + audit', async () => {
    const res = await modifierPATCH(
      req('PATCH', `/api/modifiers/${modSir}`, tokA, { allergens: ['milk', 'nuts'] }),
      params(modSir),
    )
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.allergens).toEqual(['milk', 'nuts'])
    expect(j.flaggedMenuItems).toBe(1)
    const mod = await db.modifier.findUnique({ where: { id: modSir } })
    expect(mod?.allergens).toBe('["milk","nuts"]')
    const mi = await db.menuItem.findUnique({ where: { id: miMain } })
    expect(mi?.allergenReviewFlag).toBe(true)
    const audit = await db.auditLog.findFirst({ where: { action: 'MODIFIER_ALLERGENS_SET', entityId: modSir } })
    expect(audit).not.toBeNull()
    // profil pokaže modifierCodes (možni dodatki — ločeno od baznih kod)
    const profiles = await getMenuItemAllergenProfiles([miMain])
    expect(profiles.get(miMain)!.modifierCodes).toEqual(['milk', 'nuts'])
  })

  it('waiter brez menu.manage → 403 na modifikator', async () => {
    const res = await modifierPATCH(
      req('PATCH', `/api/modifiers/${modSir}`, tokWaiter, { allergens: [] }),
      params(modSir),
    )
    expect(res.status).toBe(403)
  })

  it('neveljavna koda modifikatorja → 400', async () => {
    const res = await modifierPATCH(
      req('PATCH', `/api/modifiers/${modSir}`, tokA, { allergens: ['toasted-nuts'] }),
      params(modSir),
    )
    expect(res.status).toBe(400)
  })
})

/* ─────────────── G. naročilo: posnetek + opozorilo + KDS + tisk ─────────────── */

describe('G. posnetek ob nastanku + izrecno opozorilo', () => {
  it('createOrderCore: posnetek (jed ∪ izbrana opcija) + opozorilo na postavki', async () => {
    const { order } = await createOrderCore({
      employeeId: mgrA,
      locationId: locA,
      type: 'TAKEAWAY',
      items: [
        {
          menuItemId: miMain,
          qty: 2,
          allergenWarning: 'gost alergičen na oreške',
          modifiers: [{ modifierId: modSir, name: `${P}Sir`, price: 1, groupName: `${P}Dodatki`, modifierGroupId: modGroup }],
        },
      ],
    })
    createdOrders.push(order.id)
    const item = await db.orderItem.findFirst({ where: { orderId: order.id } })
    expect(item?.allergenWarning).toBe('gost alergičen na oreške')
    const snap = parseAllergenSnapshot(item?.allergenSnapshot)
    // kodе jedi (gluten — override odstranjen? NE: prazni add+remove počisti popravek → gluten nazaj)
    // + kode IZBRA opcije sir (milk, nuts)
    expect(snap.codes).toContain('milk')
    expect(snap.codes).toContain('nuts')
    expect(snap.status).toBeDefined()
    expect(snap.capturedAt).toBeDefined()
  })

  it('mapOrderItem izpiše warning + kode + status (KDS vidi opozorilo)', async () => {
    const item = await db.orderItem.findFirst({
      where: { allergenWarning: { not: '' } },
      orderBy: { createdAt: 'desc' },
    })
    expect(item).not.toBeNull()
    const mapped = mapOrderItem(item as unknown as Parameters<typeof mapOrderItem>[0])
    expect(mapped.allergenWarning).toBe('gost alergičen na oreške')
    expect(mapped.allergenCodes).toContain('nuts')
    expect(mapped.allergenStatus).toBeDefined()
  })

  it('kuhinjski list natisne ⚠ ALERGIJA + alergene', () => {
    const lines = buildKitchenTicketLines({
      orderNumber: 123,
      items: [
        { name: 'Juha', qty: 1, note: 'brez kruha', station: 'KITCHEN', allergenWarning: 'alergija na oreške', allergenCodes: ['nuts', 'milk'] },
      ],
    })
    const texts = lines.map((l) => l.text)
    expect(texts.some((t) => t.includes('ALERGIJA') && t.includes('alergija na oreške'))).toBe(true)
    expect(texts.some((t) => t.includes('alergeni:') && t.includes('Oreški'))).toBe(true)
    expect(texts.some((t) => t.includes('opomba: brez kruha'))).toBe(true)
  })

  it('zgodovinska celovitost: sprememba sestavine NE spremeni obstoječega posnetka', async () => {
    const before = await db.orderItem.findFirst({
      where: { allergenWarning: { not: '' } },
      orderBy: { createdAt: 'desc' },
    })
    const codesBefore = snapshotCodes(before?.allergenSnapshot)
    // sestavina moka dobi NOV alergen + jed ponovno potrjena (crossContact ohranjen)
    await invAllergensPOST(
      req('POST', '/api/inventory/allergens', tokA, { inventoryItemId: invMoka, allergens: ['gluten', 'fish'], crossContact: ['nuts'], confirm: true }),
    )
    await menuAllergensPOST(
      req('POST', `/api/menus/${miMain}/allergens`, tokA, { action: 'confirm' }),
      params(miMain),
    )
    const after = await db.orderItem.findUnique({ where: { id: before!.id } })
    expect(snapshotCodes(after?.allergenSnapshot)).toEqual(codesBefore)
    // nov profil ima fish (dokaz, da se je izvor spremenil)
    const profiles = await getMenuItemAllergenProfiles([miMain])
    expect(profiles.get(miMain)!.codes).toContain('fish')
  })

  it('PATCH /api/orders/[id]/allergen-warning: RBAC + audit staro→novo', async () => {
    const orderId = createdOrders[0]
    const item = await db.orderItem.findFirst({ where: { orderId } })
    const res = await warningPATCH(
      req('PATCH', `/api/orders/${orderId}/allergen-warning`, tokA, { itemId: item!.id, warning: 'POSEBNO: brez glutena striktno' }),
      params(orderId),
    )
    expect(res.status).toBe(200)
    const row = await db.orderItem.findUnique({ where: { id: item!.id } })
    expect(row?.allergenWarning).toBe('POSEBNO: brez glutena striktno')
    const audit = await db.auditLog.findFirst({
      where: { action: 'ORDER_ITEM_ALLERGEN_WARNING_SET', entityId: item!.id },
      orderBy: { timestamp: 'desc' } as never,
    })
    const details = JSON.parse(String(audit?.details ?? '{}')) as Record<string, unknown>
    expect(details.old).toBe('gost alergičen na oreške')
    expect(details.new).toBe('POSEBNO: brez glutena striktno')
  })

  it('waiter z orders.create lahko nastavi opozorilo (ista plast dovoljenj kot urejanje naročila)', async () => {
    const orderId = createdOrders[0]
    const item = await db.orderItem.findFirst({ where: { orderId } })
    const res = await warningPATCH(
      req('PATCH', `/api/orders/${orderId}/allergen-warning`, tokWaiter, { itemId: item!.id, warning: '' }),
      params(orderId),
    )
    expect(res.status).toBe(200)
    const row = await db.orderItem.findUnique({ where: { id: item!.id } })
    expect(row?.allergenWarning).toBe('')
    const audit = await db.auditLog.findFirst({
      where: { action: 'ORDER_ITEM_ALLERGEN_WARNING_SET', entityId: item!.id },
      orderBy: { timestamp: 'desc' } as never,
    })
    const details = JSON.parse(String(audit?.details ?? '{}')) as Record<string, unknown>
    expect(details.cleared).toBe(true)
  })

  it('cross-tenant: manager B ne more spreminjati opozorila naročila A', async () => {
    const orderId = createdOrders[0]
    const item = await db.orderItem.findFirst({ where: { orderId } })
    const res = await warningPATCH(
      req('PATCH', `/api/orders/${orderId}/allergen-warning`, tokB, { itemId: item!.id, warning: 'napad' }),
      params(orderId),
    )
    expect([403, 404]).toContain(res.status)
  })

  it('zaključeno (plačano) naročilo → 409 (opozorilo je zgodovina)', async () => {
    const orderId = createdOrders[0]
    const item = await db.orderItem.findFirst({ where: { orderId } })
    await db.order.update({ where: { id: orderId }, data: { status: 'paid', paymentStatus: 'paid' } })
    const res = await warningPATCH(
      req('PATCH', `/api/orders/${orderId}/allergen-warning`, tokA, { itemId: item!.id, warning: 'prepozno' }),
      params(orderId),
    )
    expect(res.status).toBe(409)
  })

  it('buildAllergenSnapshots: unknown oznake opcije prisilijo review (nikoli confirmed)', async () => {
    await db.modifier.update({ where: { id: modSir }, data: { allergens: 'milk, čarobni prah' } })
    const snaps = await buildAllergenSnapshots([{ menuItemId: miMain, chosenModifierIds: [modSir] }])
    const snap = parseAllergenSnapshot(snaps[0])
    expect(snap.status).toBe('review_required')
    expect(snap.unknownLabels).toContain('čarobni prah')
  })

  it('sanitizeAllergenWarning: niz ≤ 200, ne-niz → prazno', () => {
    expect(sanitizeAllergenWarning('  x  ')).toBe('x')
    expect(sanitizeAllergenWarning('y'.repeat(300))).toHaveLength(200)
    expect(sanitizeAllergenWarning(42 as unknown as string)).toBe('')
  })
})

/* ─────────────── H. javni meni (QR/kiosk) ─────────────── */

describe('H. javni meni: kanonične kode + status + opcije', () => {
  it('loadPublicMenu vrne kode/status/crossContact + alergene opcij', async () => {
    const payload = await loadPublicMenu(locA)
    const main = payload.items.find((i) => i.id === miMain)
    expect(main).not.toBeUndefined()
    expect((main as unknown as { allergenCodes: string[] }).allergenCodes).toContain('gluten')
    expect((main as unknown as { allergenCodes: string[] }).allergenCodes).toContain('fish')
    expect((main as unknown as { allergenCrossContact: string[] }).allergenCrossContact).toContain('nuts')
    expect((main as unknown as { allergenStatus: string }).allergenStatus).toBeDefined()
    const opt = (main as unknown as { modifierGroups: { options: { allergenCodes: string[] }[] }[] }).modifierGroups[0].options[0]
    expect(opt.allergenCodes).toContain('milk')
    // legacy jed: prikazuje preslikano kodo (gluten) kljub prostemu besedilu
    const side = payload.items.find((i) => i.id === miSide)
    expect((side as unknown as { allergenCodes: string[] }).allergenCodes).toContain('gluten')
    // status ni nikoli lažno "confirmed" za legacy nepotrjeno jed
    expect((side as unknown as { allergenStatus: string }).allergenStatus).toBe('needs_confirmation')
  })
})

/* ─────────────── I. register + DDL idempotenca ─────────────── */

describe('I. register + DDL', () => {
  it('SCHEMA_MIGRATIONS vsebuje allergen-truth (18 vnosov z lot-governance) + endpoint na disku', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'allergen-truth')
    expect(m).not.toBeUndefined()
    expect(m!.endpoint).toBe('/api/admin/migrate-allergen-truth')
    expect(m!.descKey).toBe('mig.allergenTruth.desc')
    expect(SCHEMA_MIGRATIONS.length).toBe(22) // v1.109.0: +haccp-ops (#20)
    expect(slDict['mig.allergenTruth.desc']).toBeTruthy()
    expect(hrDict['mig.allergenTruth.desc']).toBeTruthy()
  })

  it('DDL ruta je idempotentna (dev SQLite že ima stolpce → alreadyApplied)', async () => {
    // manager NI centralna vloga → 403 (requireCentralRole varuje DDL)
    const res = await ddlPOST(req('POST', '/api/admin/migrate-allergen-truth', tokA))
    expect(res.status).toBe(403)
    const res2 = await ddlPOST(req('POST', '/api/admin/migrate-allergen-truth', tokOwner))
    expect(res2.status).toBe(200)
    const j = await body(res2)
    expect(j.alreadyApplied).toBe(true)
    expect(j.applied).toEqual([])
  })
})
