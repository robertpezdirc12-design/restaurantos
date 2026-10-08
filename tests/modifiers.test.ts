/**
 * Issue #4 §11 — unit testi za validateItemModifiers (src/lib/modifiers.ts).
 * ČISTA funkcija — brez DB, brez omrežja (fixture-ji so Map-based).
 *
 * Pokrite pravilo: relacija artikel→skupina→modifier, required, minSelect,
 * maxSelect, podvojeni modifier, neznan modifier, neaktiven modifier,
 * DB cene/imeni (client vrednosti se ignorirajo).
 */
import { describe, expect, test } from 'bun:test'
import {
  validateItemModifiers,
  type ModifierGroupRule,
  type ModifierRow,
} from '@/lib/modifiers'

function groupEntry(
  id: string,
  over: Partial<ModifierGroupRule> = {},
): [string, ModifierGroupRule] {
  return [
    id,
    { id, name: `Skupina ${id}`, required: false, minSelect: 0, maxSelect: 0, ...over },
  ]
}

function modEntry(
  id: string,
  modifierGroupId: string,
  over: Partial<ModifierRow> = {},
): [string, ModifierRow] {
  return [
    id,
    { id, name: `Opcija ${id}`, price: 1.5, modifierGroupId, isAvailable: true, ...over },
  ]
}

function ctx(
  groups: [string, ModifierGroupRule][],
  mods: [string, ModifierRow][],
  allowedGroupIds: string[],
) {
  return {
    allowedGroupIds,
    groupById: new Map(groups),
    modById: new Map(mods),
  }
}

describe('validateItemModifiers', () => {
  test('(a) veljaven modifier → ok, cena/ime IZ DB fixture-ja', () => {
    const r = validateItemModifiers({
      ...ctx([groupEntry('g1')], [modEntry('m1', 'g1', { price: 0.8, name: 'Mleko iz DB' })], ['g1']),
      chosenIds: ['m1'],
    })
    expect(r.ok).toBe(true)
    expect(r.error).toBeNull()
    expect(r.resolved).toHaveLength(1)
    expect(r.resolved[0].modifierId).toBe('m1')
    expect(r.resolved[0].price).toBe(0.8) // DB cena, ne client
    expect(r.resolved[0].name).toBe('Mleko iz DB')
    expect(r.resolved[0].groupName).toBe('Skupina g1')
  })

  test('(b) modifier druge skupine (ni v allowedGroupIds) → error', () => {
    const r = validateItemModifiers({
      ...ctx([groupEntry('g1')], [modEntry('m2', 'g2')], ['g1']),
      chosenIds: ['m2'],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Opcija ni na voljo za ta artikel.')
    expect(r.resolved).toEqual([])
  })

  test('(c) required skupina brez izbora → error', () => {
    const r = validateItemModifiers({
      ...ctx([groupEntry('g1', { required: true })], [modEntry('m1', 'g1')], ['g1']),
      chosenIds: [],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('obvezna')
  })

  test('(d) minSelect premalo izborov → error', () => {
    const r = validateItemModifiers({
      ...ctx(
        [groupEntry('g1', { minSelect: 2 })],
        [modEntry('m1', 'g1'), modEntry('m3', 'g1')],
        ['g1'],
      ),
      chosenIds: ['m1'],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('vsaj 2')
  })

  test('(e) maxSelect preveč izborov → error', () => {
    const r = validateItemModifiers({
      ...ctx(
        [groupEntry('g1', { maxSelect: 1 })],
        [modEntry('m1', 'g1'), modEntry('m3', 'g1')],
        ['g1'],
      ),
      chosenIds: ['m1', 'm3'],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('največ 1')
  })

  test('(f) podvojen modifier → error', () => {
    const r = validateItemModifiers({
      ...ctx([groupEntry('g1')], [modEntry('m1', 'g1')], ['g1']),
      chosenIds: ['m1', 'm1'],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Podvojena opcija')
  })

  test('(g) neznan modifier (ni v DB fixture) → error', () => {
    const r = validateItemModifiers({
      ...ctx([groupEntry('g1')], [modEntry('m1', 'g1')], ['g1']),
      chosenIds: ['neobstaja'],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Opcija ni več na voljo.')
  })

  test('(h) neaktiven modifier (isAvailable false) → error', () => {
    const r = validateItemModifiers({
      ...ctx([groupEntry('g1')], [modEntry('m1', 'g1', { isAvailable: false })], ['g1']),
      chosenIds: ['m1'],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Opcija ni več na voljo.')
  })

  test('brez modifierjev in brez required skupin → ok z praznim resolved', () => {
    const r = validateItemModifiers({
      ...ctx([groupEntry('g1')], [modEntry('m1', 'g1')], ['g1']),
      chosenIds: [],
    })
    expect(r.ok).toBe(true)
    expect(r.resolved).toEqual([])
  })
})
