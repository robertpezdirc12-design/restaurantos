/**
 * v1.262.0 — ZAPOREDJE MODIFIKATORJEV NA TISKU (docs/PRIMERJAVA-
 * VMESNIKOV-2026 §36; Square Vol 12 (10. 9. 2026) »zaporedje
 * modifikatorjev na tisku« — zadnji neizvedeni Vol 12 P3 iz
 * evidence §31 po zaključku §35 sedežev).
 *
 * Merjena situacija: OrderItemModifier.sortOrder se je pisal kot
 * idx = vrstni red NATAKARJEVIH klikov (oba pisalca), bralcev
 * polja NI bilo — tisk/KDS/urejevalnik so izrisovali opcije v
 * vrstnem redu vnosa. ISTA jed je lahko natisnila »+ slanina /
 * + 0,5 L« ali »+ 0,5 L / + slanina« glede na to, kaj je bilo
 * kliknjeno prej — velikost, ki jo variantni dialog pokaže PRVO
 * (ModifierGroup.sortOrder → Modifier.sortOrder, orderBy
 * [sortOrder, name] na /api/modifier-groups), je bila na listku
 * včasih ZADNJA.
 *
 *  Č1 · ČISTI SLOJ (modifiers.ts orderModifiersForSnapshot):
 *    kanonski posnetek — stabilna ureditev po (groupSort,
 *    groupName, modSort, name); defenzivno NaN/undefined → 0;
 *    permutacijska neodvisnost (klikni v kakršnemkoli redu,
 *    posnetek je ENAK).
 *  Č2 · SERIALIZACIJA (map.ts mapOrderItem): stabilna ureditev
 *    po vrstičnem sortOrder — manjkajoč izbor (stare poti) → ?? 0
 *    → vhodni red (byte-identično zgodovini).
 *  Ž · MONTAŽA + REGISTRI: oba pisalca kanonizirata, 5 select
 *    mest nosi sortOrder, 0 DDL dokaz, verzija 1.262.0,
 *    dokument §36 + AUDIT 0 ključev, worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  orderModifiersForSnapshot,
  validateItemModifiers,
  type ModifierGroupRule,
  type ModifierRow,
  type ResolvedModifierOut,
} from '../src/lib/modifiers'
import { mapOrderItem } from '../src/lib/map'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

const opsSrc = read('src/lib/ops.ts')
const orderRouteSrc = read('src/app/api/orders/[id]/route.ts')
const kitchenSrc = read('src/app/api/kitchen/route.ts')
const mapSrc = read('src/lib/map.ts')
const modifiersSrc = read('src/lib/modifiers.ts')

/** Kratek konstruktor resolvane opcije (prekrižani kliki = vhodni vrstni red). */
function r(name: string, group: string, groupSort: number, modSort: number): ResolvedModifierOut {
  return { modifierId: `id-${name}`, name, price: 0.5, groupName: group, modifierGroupId: `g-${group}`, groupSort, modSort }
}

// ── Č1) ČISTI SLOJ ──

describe('v1.262.0 Č1 — orderModifiersForSnapshot (čisti sloj)', () => {
  test('Č1a: prazna tabela → prazna (brez eksplozije)', () => {
    expect(orderModifiersForSnapshot([])).toEqual([])
  })

  test('Č1b: en element → ista vsebina (nič za urediti)', () => {
    const one = [r('Slanina', 'Dodatki', 1, 0)]
    expect(orderModifiersForSnapshot(one)).toEqual(one)
  })

  test('Č1c: ureditev po SKUPINAH — velikost (groupSort 0) pred dodatki (1) ne glede na vrstni red klikov', () => {
    // natakar je kliknil NAJPREJ dodatek, POL velikost — meni pravi obratno
    const klik = [r('Slanina', 'Dodatki', 1, 5), r('0,5 L', 'Velikost', 0, 0)]
    const out = orderModifiersForSnapshot(klik)
    expect(out.map((x) => x.name)).toEqual(['0,5 L', 'Slanina'])
  })

  test('Č1d: znotraj skupine po modSort — prekrižan vhod uredi po meniju', () => {
    const klik = [
      r('Avokado', 'Dodatki', 1, 2),
      r('Slanina', 'Dodatki', 1, 0),
      r('Čebula', 'Dodatki', 1, 1),
    ]
    const out = orderModifiersForSnapshot(klik)
    expect(out.map((x) => x.name)).toEqual(['Slanina', 'Čebula', 'Avokado'])
  })

  test('Č1e: izenačitev groupSort → ime skupine odloči (dialogovo urejanje [sortOrder, name])', () => {
    const klik = [r('X', 'Zrezki', 2, 0), r('Y', 'Dodatki', 2, 0)]
    const out = orderModifiersForSnapshot(klik)
    expect(out.map((x) => x.groupName)).toEqual(['Dodatki', 'Zrezki'])
  })

  test('Č1f: izenačitev modSort znotraj skupine → ime opcije odloči', () => {
    const klik = [r('Bolonjka', 'Omaka', 0, 3), r('Alfo', 'Omaka', 0, 3)]
    const out = orderModifiersForSnapshot(klik)
    expect(out.map((x) => x.name)).toEqual(['Alfo', 'Bolonjka'])
  })

  test('Č1g: popolna izenačitev ključev → STABILNO (vhodni red ostane — iskren fallback)', () => {
    const klik = [
      { ...r('Dvojnik', 'Dodatki', 1, 0), modifierId: 'prvi' },
      { ...r('Dvojnik', 'Dodatki', 1, 0), modifierId: 'drugi' },
    ]
    const out = orderModifiersForSnapshot(klik)
    expect(out.map((x) => x.modifierId)).toEqual(['prvi', 'drugi'])
  })

  test('Č1h: defenzivno — NaN/Infinity/undefined/niz v ključih → 0 (ne explode)', () => {
    const klik = [
      { ...r('A', 'GA', Number.NaN, 0) },
      { ...r('B', 'GB', 1, Number.POSITIVE_INFINITY) },
      { ...r('C', 'GC', 'x' as unknown as number, 0) },
      { ...r('D', 'GD', 2, 0) },
    ]
    const out = orderModifiersForSnapshot(klik)
    // NaN/niz → 0: A in C v skupini 0 (med seboj po imenu skupine GA < GC);
    // B ima VELJAVEN groupSort 1 (njen Infinity modSort → 0 ne vpliva na skupino);
    // D (2) zadnja
    expect(out.map((x) => x.name)).toEqual(['A', 'C', 'B', 'D'])
  })

  test('Č1i: permutacijska neodvisnost — 4 permutacije istih izbir dajejo ENAK posnetek', () => {
    const velikost = r('0,5 L', 'Velikost', 0, 0)
    const nivo = r('Pikantno', 'Nivo', 1, 0)
    const dodatek1 = r('Slanina', 'Dodatki', 2, 1)
    const dodatek2 = r('Avokado', 'Dodatki', 2, 0)
    const expected = ['0,5 L', 'Pikantno', 'Avokado', 'Slanina']
    for (const perm of [[dodatek1, dodatek2, nivo, velikost], [nivo, velikost, dodatek1, dodatek2], [dodatek2, velikost, dodatek1, nivo], [velikost, dodatek2, nivo, dodatek1]]) {
      expect(orderModifiersForSnapshot(perm).map((x) => x.name)).toEqual(expected)
    }
  })
})

// ── Č2) SERIALIZACIJA ──

describe('v1.262.0 Č2 — mapOrderItem bralna ureditev (serializacija)', () => {
  type ModRow = { name: string; sortOrder?: number | string }

  function itemWith(mods: ModRow[]) {
    return {
      id: 'item-1',
      menuItemName: 'Burger',
      quantity: 1,
      price: 9.9,
      vatRate: 22,
      status: 'pending',
      notes: '',
      allergenSnapshot: '{}',
      OrderItemModifier: mods as unknown[],
    }
  }

  test('Č2a: vrstice se uredijo po vrstičnem sortOrder (2,0,1 → kanonično 0,1,2)', () => {
    const out = mapOrderItem(itemWith([
      { name: 'Slanina', sortOrder: 2 },
      { name: '0,5 L', sortOrder: 0 },
      { name: 'Čebula', sortOrder: 1 },
    ])) as { modifiers?: string[] }
    expect(out.modifiers).toEqual(['0,5 L', 'Čebula', 'Slanina'])
  })

  test('Č2b: manjkajoč izbor (stare poti brez select sortOrder) → ?? 0 → STABILEN vhodni red', () => {
    const out = mapOrderItem(itemWith([
      { name: 'Slanina' },
      { name: '0,5 L' },
    ])) as { modifiers?: string[] }
    // vse ?? 0 → enaki ključi → stabilno = vhodni red (byte-identično prejšnjemu)
    expect(out.modifiers).toEqual(['Slanina', '0,5 L'])
  })

  test('Č2c: duplikatni sortOrder → stabilno (vhodni red znotraj ključa)', () => {
    const out = mapOrderItem(itemWith([
      { name: 'Prvi', sortOrder: 1 },
      { name: 'Drugi', sortOrder: 1 },
      { name: 'Ničti', sortOrder: 0 },
    ])) as { modifiers?: string[] }
    expect(out.modifiers).toEqual(['Ničti', 'Prvi', 'Drugi'])
  })

  test('Č2d: nesmiselne vrednosti (niz/NaN) → 0 defenzivno; PRAZNA imena izpadejo', () => {
    const out = mapOrderItem(itemWith([
      { name: 'Niz', sortOrder: 'x' },
      { name: 'Število', sortOrder: 1 },
      { name: '', sortOrder: 0 },
    ])) as { modifiers?: string[] }
    // 'x' → 0 (prvi po stabilnosti), število 1 za njim; PRAZNO ime (length 0) se filtrira (obstoječe pravilo OSS-10)
    expect(out.modifiers).toEqual(['Niz', 'Število'])
  })

  test('Č2e: brez relacije → undefined (aditivno — stare poti byte-identične)', () => {
    const out = mapOrderItem({ id: 'i', menuItemName: 'Kava', quantity: 1, price: 2, vatRate: 22, status: 'pending', notes: '' }) as { modifiers?: string[] }
    expect(out.modifiers).toBeUndefined()
  })
})

// ── Ž) MONTAŽA + REGISTRI ──

describe('v1.262.0 Ž — montaža + registri', () => {
  test('Ž1: OBA pisalca kanonizirata vrstni red pred mapom vrstic', () => {
    // createOrderCore (POS + sync + QR/kiosk + portal — vsi tečejo skoznjo)
    expect(opsSrc).toContain('const ordered = orderModifiersForSnapshot(v.resolved)')
    expect(opsSrc).toMatch(/const mods = ordered\.map\(\(m: ResolvedModifierOut, idx: number\) => \(/)
    // PATCH dodajanje postavk
    expect(orderRouteSrc).toMatch(/const mods = orderModifiersForSnapshot\(resolvedByIdx\[itemIdx\] \|\| \[\]\)\.map\(\(m, idx\) => \(/)
  })

  test('Ž2: 5 vključitvenih mest, ki napajajo serializacijo, izbere vrstični sortOrder', () => {
    // ops orderInclude + orders/[id] orderInclude
    expect(opsSrc).toContain('OrderItemModifier: { select: { name: true, sortOrder: true } }')
    expect(orderRouteSrc).toContain('OrderItemModifier: { select: { name: true, sortOrder: true } }')
    // kitchen: tip + 2 poizvedbi (vrsta + preklicane)
    const hits = kitchenSrc.match(/OrderItemModifier: \{ select: \{ name: true, sortOrder: true \} \}/g) ?? []
    expect(hits.length).toBe(3)
  })

  test('Ž3: validacija nosi menijske ključe iz DB vrstic (groupSort/modSort aditivno)', () => {
    // ResolvedModifierOut deklaracija
    expect(modifiersSrc).toMatch(/groupSort\?: number/)
    expect(modifiersSrc).toMatch(/modSort\?: number/)
    // loadModifierContext polni iz chosen vrstic (Modifier + ModifierGroup sortOrder)
    expect(modifiersSrc).toMatch(/sortOrder: typeof m\.sortOrder === 'number' && Number\.isFinite\(m\.sortOrder\) \? m\.sortOrder : 0/)
    expect(modifiersSrc).toMatch(/m\.ModifierGroup && typeof m\.ModifierGroup\.sortOrder === 'number'/)
    // validateItemModifiers prenaša ključe v resolved
    expect(modifiersSrc).toContain('groupSort: num0(m.groupSort),')
    expect(modifiersSrc).toContain('modSort: num0(m.sortOrder),')
  })

  test('Ž4: validateItemModifiers — resolved po novem nosi ključe (funkcijski dokaz nad čisto funkcijo)', () => {
    const g: [string, ModifierGroupRule][] = [['g1', { id: 'g1', name: 'Velikost', required: false, minSelect: 0, maxSelect: 0 }]]
    const m: [string, ModifierRow][] = [['m1', { id: 'm1', name: '0,5 L', price: 0.3, modifierGroupId: 'g1', isAvailable: true, sortOrder: 2, groupSort: 1 }]]
    const v = validateItemModifiers({ allowedGroupIds: ['g1'], groupById: new Map(g), modById: new Map(m), chosenIds: ['m1'] })
    expect(v.ok).toBe(true)
    expect(v.resolved[0].groupSort).toBe(1)
    expect(v.resolved[0].modSort).toBe(2)
  })

  test('Ž5: 0 DDL — vsa polja obstajajo od prej (OrderItemModifier.sortOrder / Modifier.sortOrder / ModifierGroup.sortOrder)', () => {
    const schema = read('prisma/schema.prisma')
    // OrderItemModifier.sortOrder obstaja (vpeljan z OSS-10 v1.209.0, ne v tem valu)
    const oim = schema.match(/model OrderItemModifier \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(oim).toMatch(/^  sortOrder\s+Int\s+@default\(0\)$/m)
    // brez novih polj: vrstični model ima NATANČNO obstoječo množico STOLPCEV (dokaz 0 DDL;
    // relacijski polji ModifierGroup/OrderItem izpustita — obe obstajata od prej
    const columns = [...oim.matchAll(/^  (\w+)\s+\w/gm)].map((x) => x[1]).filter((c) => c !== 'ModifierGroup' && c !== 'OrderItem')
    expect(columns.sort()).toEqual(['createdAt', 'id', 'modifierGroupId', 'modifierGroupName', 'name', 'orderItemId', 'price', 'quantity', 'sortOrder', 'updatedAt'].sort())
    // meni plast: obe sortOrder obstajata od prej
    const mg = schema.match(/model ModifierGroup \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(mg).toMatch(/^  sortOrder\s+Int\s+@default\(0\)$/m)
    const mo = schema.match(/model Modifier \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(mo).toMatch(/^  sortOrder\s+Int\s+@default\(0\)$/m)
  })

  test('Ž6: bralna invarianta je izrecna v map.ts (ne zanaša se na nedokumentiran vrstni red DB)', () => {
    expect(mapSrc).toContain('PRIMERJAVA §36 (v1.262.0): ZAPOREDJE MODIFIKATORJEV NA TISKU')
    expect(mapSrc).toMatch(/\.sort\(\(a, b\) => \{/)
    expect(mapSrc).toContain('// Array.sort je stabilen — enaki ključi ohranijo vhodni red')
  })

  test('Ž7: dokument §36 + AUDIT 0 ključev + verzija 1.262.0', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 36.')
    expect(doc).toContain('ZAPOREDJE MODIFIKATORJEV NA TISKU v1.262.0')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('POSODOBITEV (v1.262.0, PRIMERJAVA-VMESNIKOV-2026 §36)')
    expect(auditDoc).toContain('števci nespremenjeni (4121)')
    expect(APP_VERSION).toBe('1.302.0')
    expect(read('src/lib/version.ts')).toContain("'1.302.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.302.0')
  })

  test('Ž8: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.302.0-nadzorni-val-stabilnosti-iii')
  })
})
