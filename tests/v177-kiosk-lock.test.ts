/**
 * v1.177.0 — ZAKLEP KIOSKA: DVOTAPNI POGOJ (namesto `onDoubleClick`)
 *
 * Zakaj: WCAG 2.1.1 — funkcionalnost, dosegljiva samo z dvoklikom, za
 * tipkovnico ne obstaja (Enter/Space sprožita `click`, nikoli `dblclick`).
 * Enako velja za dotik: na zaslonu na dotik dvoklik ni zanesljiva poteza,
 * obstoječe besedilo gumba pa je obljubljalo TRETJI način (držen dotik), ki ga
 * v kodi ni. Prehod na dva ločena klika z jasnim vmesnim stanjem je edina
 * rešitev, ki hkrati deluje s tipkovnico, z miško in s prstom.
 *
 * Zakaj modul in ne logika v komponenti: repozitorij nima jsdom/RTL, zato
 * mehanizma ni mogoče testirati v renderju. Stanje zaklepa je zato čista
 * funkcija (state + od zunaj posredovan `now`), testira pa se brez štoparice
 * in brez brskalnika — in ravno to stanje nosi varnostno posledico (napaka v
 * dvokliku = napačno zaklenjen prodajni terminal).
 *
 * Merjeno pravilo v gate-u: tests/v177-guest-a11y.test.ts §A4 (2.1.1).
 */
import { describe, it, expect } from 'bun:test'
import { LOCK_ARM_WINDOW_MS, initialLockState, tapLock, isArmedExpired, type LockState } from '@/lib/kiosk-lock'

const T0 = 1_000_000

/** Drugi tap znotraj okna je tisti, ki zaklene. */
describe('v1.177.0 — kiosk zaklep (arm/confirm)', () => {
  it('prvi tap samo pripravi stanje in ne zaklene', () => {
    const { next, lock } = tapLock(initialLockState, T0)
    expect(lock).toBe(false)
    expect(next.phase).toBe('armed')
  })

  it('drugi tap znotraj okna zaklene in vrne v idle', () => {
    const armed = tapLock(initialLockState, T0).next
    const { next, lock } = tapLock(armed, T0 + 1_000)
    expect(lock).toBe(true)
    expect(next.phase).toBe('idle')
    expect(next.armedAt).toBeNull()
  })

  it('drugi tap tik pred potekom roka še zaklene', () => {
    const armed = tapLock(initialLockState, T0).next
    const { lock } = tapLock(armed, T0 + LOCK_ARM_WINDOW_MS)
    expect(lock).toBe(true)
  })

  it('tap po poteku roka NE zaklene — pripravi znova (gost je odšel in se vrnil)', () => {
    const armed = tapLock(initialLockState, T0).next
    const { next, lock } = tapLock(armed, T0 + LOCK_ARM_WINDOW_MS + 1)
    expect(lock).toBe(false)
    expect(next.phase).toBe('armed')
    expect(next.armedAt).toBe(T0 + LOCK_ARM_WINDOW_MS + 1)
  })

  it('ob poteku roka drugi tap ne zaklene — okno teče od zadnje priprave', () => {
    const first = tapLock(initialLockState, T0).next
    const second = tapLock(first, T0 + 4_000)                // čez rok → samo pripravi znova
    expect(second.lock).toBe(false)
    expect(tapLock(second.next, T0 + 5_000).lock).toBe(true) // 1 s po zadnji pripravi → zaklene
  })

  it('potek roka je izmerjen, ne ugiban', () => {
    const armed: LockState = { phase: 'armed', armedAt: T0 }
    expect(isArmedExpired(armed, T0 + LOCK_ARM_WINDOW_MS - 1)).toBe(false)
    expect(isArmedExpired(armed, T0 + LOCK_ARM_WINDOW_MS + 1)).toBe(true)
    expect(isArmedExpired({ phase: 'idle', armedAt: null }, T0 + 999_999)).toBe(true)
  })

  it('okno je med 2 in 5 s — dovolj dolgo za dva zaporedna klika, dovolj kratko, da pripravljenost ne visi na zaslonu', () => {
    expect(LOCK_ARM_WINDOW_MS).toBeGreaterThanOrEqual(2_000)
    expect(LOCK_ARM_WINDOW_MS).toBeLessThanOrEqual(5_000)
  })
})
