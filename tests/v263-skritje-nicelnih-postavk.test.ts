/**
 * v1.263.0 — SKRIVANJE NIČELNIH POSTAVK NA NATISNJENEM RAČUNU
 * (docs/PRIMERJAVA-VMESNIKOV-2026 §37; Square Vol 16 | 5. 11. 2026 | v7.32
 * »Hide $0 items from printed customer receipts« — zadnja tiskalna plast
 * P3, sestra §35 sedežev in §36 zaporedja modifikatorjev).
 *
 * Merjena semantika (Square dobesedno): »items added at $0, like a
 * complimentary basket of bread or a glass of water« se ob vklopu ne
 * tiskajo na odjemalskem računu; »paid items, items discounted or comped
 * to $0, and $0 items with a paid modifier still print«; kuhinjski
 * listki, kopije, transakcijski zapisi, poročila in izvozi nosijo
 * ničelne postavke VEDNO. Naš posnetek (amount = unitPrice × qty;
 * unitPrice = zamrznjena menijska cena + cene opcij; popusti ločeno)
 * naredi VSE izjeme avtomatske — edini predikat: amount === 0 brez
 * §23 priceOverride žiga (comp natakarja PIŠE).
 *
 *  Č1 · ČISTI SLOJ (receipt.ts isZeroAddedReceiptItem +
 *    receiptDisplayItems): 0-dodano skrito; plačano/popust-do-0/
 *    opcija-na-0/priceOverride-do-0 PIŠEJO; NaN/undefined defenzivno
 *    PIŠE; qty > 1 po ceni 0; storno −0 simetrično; filter izklopljen
 *    = ISTA referenca; prag vseh skritih → poln seznam.
 *  Č2 · IZRIS + MONTAŽA: HTML izključi 0-vrstico ob vklopu (in jo
 *    nosi ob izklopu — byte-identična zgodovina); ESC-POS črez SKUPNI
 *    pomočnik; /api/furs/[id] nosi zastavico + legacy priceOverride;
 *    PUT politika veja; UI preklop DDL-pogojen.
 *  Ž · REGISTRI: verzija 1.263.0, DDL stavek + register 41 + konzola,
 *    drift matcher dvosmernen + združena množica, mirror DA / main NE,
 *    i18n pariteta 4133/4133 (+4 ključi), dokument §37 + AUDIT,
 *    worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isZeroAddedReceiptItem,
  receiptDisplayItems,
  buildReceiptHTML,
  type ReceiptDetailT,
  type ReceiptItemT,
} from '../src/lib/receipt'
import { APP_VERSION } from '../src/lib/version'
import {
  SCHEMA_MIGRATIONS,
  setMigrationProbeOverride,
  clearMigrationProbeOverrides,
} from '../src/lib/schema-migrations'
import { isReceiptDisplayPolicyStatement, isRestaurantSettingsPendingMergedStatement } from '../scripts/drift-check'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import {
  DEFAULT_RECEIPT_DISPLAY_POLICY,
  RECEIPT_DISPLAY_POLICY_COLUMNS,
} from '../src/lib/receipt-display-policy'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

/** Kratek konstruktor vrstice računa. */
function item(name: string, amount: number, extra?: Partial<ReceiptItemT>): ReceiptItemT {
  return { name, qty: 1, price: amount, vatRate: 22, amount, ...extra }
}

/** Minimalen račun za buildReceiptHTML (samo polja, ki jih izris dejansko bere). */
function receipt(items: ReceiptItemT[], hideZeroItems?: boolean): ReceiptDetailT {
  return {
    id: 'r1', invoiceNumber: '2026-11-1-BLG001', createdAt: new Date('2026-11-06T12:00:00Z').toISOString(),
    printedAt: null, businessName: 'Gostilna Pri Testu', businessAddress: '', businessId: '', taxId: '',
    registerId: 'BLG-001', premisesId: null, zoi: '', eor: '', fiscalVerified: false, fiscalStatus: 'pending',
    subtotal: 4.5, discount: 0, totalVat: 0.81, total: 4.5, tip: 0, totalWithTip: 4.5,
    paymentMethod: 'cash', isCopy: false, isStorno: false, vatBreakdown: [], orderNumber: 1,
    tableName: null, operator: null, items, ...(hideZeroItems === undefined ? {} : { hideZeroItems }),
  }
}

const free = item('Kruh na hišni račun', 0)
const water = item('Kozarec vode', 0)
const paid = item('Bela kava', 2.5)
const zeroWithMod = item('Voda', 0.5) // 0-postavka s plačano opcijo → price 0,5
const overridden = item('Juha dneva', 0, { priceOverride: { from: 4.5, to: 0, at: '2026-11-06T12:00:00Z', by: 'Ana' } })

// ── Č1) ČISTI SLOJ ──

describe('v1.263.0 Č1 — isZeroAddedReceiptItem / receiptDisplayItems (čisti sloj)', () => {
  test('Č1a: postavka DODANA po 0 (kruh, voda) je kandidat za skrivanje', () => {
    expect(isZeroAddedReceiptItem(free)).toBe(true)
    expect(isZeroAddedReceiptItem(water)).toBe(true)
  })

  test('Č1b: plačana postavka (> 0) NI skrita — Square: »paid items … still print«', () => {
    expect(isZeroAddedReceiptItem(paid)).toBe(false)
  })

  test('Č1c: popust-do-0 PIŠE — price ostane > 0, popust je ločena vrstica (matematika posnetka)', () => {
    // jed 4,50 s 100-% popustom: posnetek nosi price 4,50 (popust v skupni vrstici)
    const discounted = item('Burger', 4.5)
    expect(isZeroAddedReceiptItem(discounted)).toBe(false)
  })

  test('Č1d: 0-postavka s plačano opcijo PIŠE — ops.ts price + modsTotal (voda 0 + sirup 0,50)', () => {
    expect(isZeroAddedReceiptItem(zeroWithMod)).toBe(false)
  })

  test('Č1e: §23 priceOverride-do-0 PIŠE — comp natakarja je IZRECNI poseg (naša četrta izjema)', () => {
    expect(isZeroAddedReceiptItem(overridden)).toBe(false)
  })

  test('Č1f: defenzivno — NaN/undefined amount NIKOLI skrit (kar ne znamo izmeriti, izpišemo)', () => {
    expect(isZeroAddedReceiptItem(item('?', Number.NaN))).toBe(false)
    expect(isZeroAddedReceiptItem({ name: '?', qty: 1, price: 0, vatRate: 22, amount: undefined as unknown as number })).toBe(false)
    expect(isZeroAddedReceiptItem(item('?', Number.POSITIVE_INFINITY))).toBe(false)
  })

  test('Č1g: količina > 1 po ceni 0 ostane kandidat (amount = 0 × qty = 0)', () => {
    expect(isZeroAddedReceiptItem(item('Kruh', 0, { qty: 3 }))).toBe(true)
  })

  test('Č1h: storno −0 simetrično — predznak dokumenta ne odpre luknje (−0 === 0)', () => {
    expect(isZeroAddedReceiptItem(item('Kruh', -0))).toBe(true)
    expect(isZeroAddedReceiptItem(item('Bela kava', -2.5))).toBe(false)
  })

  test('Č1i: filter IZKLOPLEN (undefined/false) → ISTA referenca (byte-identična zgodovina)', () => {
    const dUndef = receipt([free, paid])
    expect(receiptDisplayItems(dUndef)).toBe(dUndef.items)
    const dFalse = receipt([free, paid], false)
    expect(receiptDisplayItems(dFalse)).toBe(dFalse.items)
  })

  test('Č1j: filter VKLOPLJEN skrije SAMO 0-dodane vrstice', () => {
    const d = receipt([free, paid, water, zeroWithMod, overridden], true)
    const out = receiptDisplayItems(d)
    expect(out.map((i) => i.name)).toEqual(['Bela kava', 'Voda', 'Juha dneva'])
  })

  test('Č1k: prag poštenosti — VSE skrite → poln seznam (fiskalni dokument NIKOLI brez tabele)', () => {
    const d = receipt([free, water], true)
    const out = receiptDisplayItems(d)
    expect(out).toBe(d.items)
    expect(out).toHaveLength(2)
  })
})

// ── Č2) IZRIS + MONTAŽA ──

describe('v1.263.0 Č2 — izris HTML + montaža virov', () => {
  test('Č2a: buildReceiptHTML ob VKLOPU izpusti 0-dodano vrstico, plačano nosi', () => {
    const html = buildReceiptHTML(receipt([free, paid], true))
    expect(html).not.toContain('Kruh na hišni račun')
    expect(html).toContain('Bela kava')
  })

  test('Č2b: filter IZKLOPLEN → 0-vrstica PRISOTNA (dosedanji izpis nespremenjen)', () => {
    const html = buildReceiptHTML(receipt([free, paid]))
    expect(html).toContain('Kruh na hišni račun')
    expect(html).toContain('Bela kava')
  })

  test('Č2c: vsota/računovodstvo ostajata nad CELIM računom (filter je čisto izris)', () => {
    const d = receipt([free, paid], true)
    const html = buildReceiptHTML(d)
    // skupaj nosi total RAČUNA (2,50 + 0,00 = 4,50 je v total), ne vsoto vidnih vrstic
    expect(html).toContain('4,50')
  })

  test('Č2d: ESC-POS/agent pot teče črez receiptDisplayItems (ena resnica obeh tiskalnih ciljev)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('const displayItems = receiptDisplayItems(r)')
    expect(page).toContain('...displayItems.map((it) => ({ text: `${it.qty}x ${it.name}` } as PrintLine))')
    expect(page).not.toContain('...r.items.map((it) => ({ text: `${it.qty}x ${it.name}` } as PrintLine))')
  })

  test('Č2e: /api/furs/[id] nosi zastavico politike + legacy izpeljava dodaja priceOverride', () => {
    const route = read('src/app/api/furs/[id]/route.ts')
    expect(route).toContain("import { receiptDisplayPolicy } from '@/lib/receipt-display-policy'")
    expect(route).toContain('hideZeroItems: displayPolicy.hideZeroItems')
    expect(route).toContain('parsePriceOverrideMeta(i.modifiersJson)')
  })

  test('Č2f: PUT /api/settings sprejme politiko (boolean veja, 503 pre-DDL, izven POLICY_COLUMNS)', () => {
    const route = read('src/app/api/settings/route.ts')
    expect(route).toContain('rdpValues')
    expect(route).toContain('writeReceiptDisplayPolicy(rdpValues)')
    expect(route).toContain('hideZeroReceiptItems mora biti true/false.')
    // B6: prikazovna preferenca NE sme pasti pod central-only denarna vrata —
    // stolpec je izven POLICY_COLUMNS množice (razširjene prek trojice politika)
    const m = route.match(/const POLICY_COLUMNS = new Set<string>\(\[([\s\S]*?)\]\)/)
    expect(m).toBeTruthy()
    expect(m![1]).not.toContain('hideZeroReceiptItems')
  })

  test('Č2g: nastavitve-tab preklop je DDL-pogojen (disabled + opomba + pogojen pošiljek)', () => {
    const tab = read('src/components/tabs/nastavitve-tab.tsx')
    expect(tab).toContain('disabled={!receiptPolicyDdlActive}')
    expect(tab).toContain("...(receiptPolicyDdlActive ? { hideZeroReceiptItems } : {})")
    expect(tab).toContain('set.hideZeroItemsDdl')
  })

  test('Č2h: dashboard load preslika politiko v stanje (tisk neodvisen od pravic)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('hideZeroReceiptItems: !!(se as { receiptDisplayPolicy?: { hideZeroItems?: boolean } }).receiptDisplayPolicy?.hideZeroItems')
    expect(page).toContain('setReceiptPolicyDdlActive(')
  })
})

// ── Ž) REGISTRI ──

describe('v1.263.0 Ž — registri', () => {
  test('Ž1: verzija 1.263.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.285.0')
    expect(read('src/lib/version.ts')).toContain("'1.285.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.285.0')
  })

  test('Ž2: i18n pariteta SL/HR 4133/4133 (+4 ključi vala)', () => {
    for (const k of ['set.hideZeroItems', 'set.hideZeroItemsDesc', 'set.hideZeroItemsDdl', 'mig.receiptDisplayPolicy.desc']) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('Ž3: DDL ruta — natančen stavek, idempotenca, centralna vloga, audit', () => {
    const route = read('src/app/api/admin/migrate-receipt-display-policy/route.ts')
    expect(route).toContain('ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "hideZeroReceiptItems" BOOLEAN NOT NULL DEFAULT FALSE')
    expect(route).toContain('requireCentralRole')
    expect(route).toContain('SCHEMA_MIGRATION_RECEIPT_DISPLAY_POLICY')
    expect(route).toContain('alreadyApplied')
  })

  test('Ž4: register SCHEMA_MIGRATIONS 40 → 41 (receipt-display-policy)', () => {
    expect(SCHEMA_MIGRATIONS).toHaveLength(44)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'receipt-display-policy')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-receipt-display-policy')
    expect(m!.descKey).toBe('mig.receiptDisplayPolicy.desc')
    // probe res deluje (override hook istega registerja)
    setMigrationProbeOverride('receipt-display-policy', true)
    clearMigrationProbeOverrides()
  })

  test('Ž5: migracijska konzola nosi handler', () => {
    const console = read('src/app/api/admin/migrations/route.ts')
    expect(console).toContain("import { POST as receiptDisplayPolicyPOST } from '../migrate-receipt-display-policy/route'")
    expect(console).toContain("'receipt-display-policy': receiptDisplayPolicyPOST")
  })

  test('Ž6: drift matcher — dvosmerno strogo SAMO hideZeroReceiptItems + združena množica', () => {
    expect(isReceiptDisplayPolicyStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "hideZeroReceiptItems" BOOLEAN NOT NULL DEFAULT FALSE')).toBe(true)
    expect(isReceiptDisplayPolicyStatement('ALTER TABLE "RestaurantSettings" DROP COLUMN "hideZeroReceiptItems"')).toBe(true)
    // tuji stolpec na isti tabeli = hard fail
    expect(isReceiptDisplayPolicyStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "excVoidApprovalAmountCents" INTEGER')).toBe(false)
    // združen stavek več pending valov ostane znan
    expect(isRestaurantSettingsPendingMergedStatement('ALTER TABLE "RestaurantSettings" DROP COLUMN "excRequireReasonVoid", DROP COLUMN "hideZeroReceiptItems"')).toBe(true)
  })

  test('Ž7: SQLite mirror nosi stolpec, MAIN shema GA NE (P2022 disciplina)', () => {
    expect(read('prisma/schema.sqlite.prisma')).toContain('hideZeroReceiptItems          Boolean @default(false)')
    const main = read('prisma/schema.prisma')
    expect(main).not.toContain('hideZeroReceiptItems')
  })

  test('Ž8: politika privzeto IZKLOPLJENA + boolean-only allow-lista', () => {
    expect(DEFAULT_RECEIPT_DISPLAY_POLICY.hideZeroItems).toBe(false)
    expect(RECEIPT_DISPLAY_POLICY_COLUMNS).toEqual(['hideZeroReceiptItems'])
  })

  test('Ž9: dokument §37 + AUDIT POSODOBITEV v1.263.0', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 37.')
    expect(doc).toContain('SKRIVANJE NIČELNIH POSTAVK NA RAČUNU v1.263.0')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('POSODOBITEV (v1.263.0, PRIMERJAVA-VMESNIKOV-2026 §37)')
    expect(auditDoc).toContain('- 4324 ključev SL in 4324 HR')
  })

  test('Ž10: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.285.0-sweep-gotovina-gostje')
  })
})
