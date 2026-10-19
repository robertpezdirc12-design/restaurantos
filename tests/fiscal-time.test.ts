/**
 * Audit 2026-10 #2 (v1.143.0) — branje koledarskih delov datuma v LOKALNI coni
 * fiskalnega dokumenta. Strežnik (Vercel) teče v UTC, zato `toISOString()`/
 * `getFullYear()` nista enaka lokalnemu datumu izdaje; FURS in HR Porezna pa v
 * kanoničnem nizu, SOAP datumu in številki računa pričakujeta lokalni čas.
 *
 * Testi so fiksirani na cono Europe/Ljubljana (CET +1 / CEST +2), da niso
 * odvisni od časovnega pasu sistema, na katerem se suite poganja.
 */
import { describe, expect, test } from 'bun:test'
import {
  hrLocalDateTime,
  hrLocalDateTimeT,
  isoLocal,
  localParts,
  localYearMonth,
} from '@/lib/fiscal-time'

const TZ = 'Europe/Ljubljana'

describe('isoLocal — lokalni čas izdaje namesto UTC', () => {
  test('zimski čas (CET, UTC+1): 12:30:45Z → 13:30:45', () => {
    expect(isoLocal(new Date('2026-01-15T12:30:45Z'), TZ)).toBe('2026-01-15T13:30:45')
  })

  test('poletni čas (CEST, UTC+2): 04:05:06Z → 06:05:06', () => {
    expect(isoLocal(new Date('2026-07-01T04:05:06Z'), TZ)).toBe('2026-07-01T06:05:06')
  })

  test('prehod čez polnoč: 23:00Z → 00:00 NASEDNJI dan (brez končnice Z in milisekund)', () => {
    expect(isoLocal(new Date('2026-01-15T23:00:00Z'), TZ)).toBe('2026-01-16T00:00:00')
  })

  test('Zagreb ima enak offset kot Ljubljana (HR lokacija ne sme dobiti drugega datuma)', () => {
    const d = new Date('2026-11-29T23:15:00Z')
    expect(isoLocal(d, 'Europe/Zagreb')).toBe(isoLocal(d, TZ))
  })

  test('brez cone → sistemski lokalni čas (nazaj-kompatibilno za obstoječe klice)', () => {
    const d = new Date('2026-01-15T12:30:45')
    const p = localParts(d)
    expect(p.year).toBe(d.getFullYear())
    expect(p.month).toBe(d.getMonth() + 1)
    expect(p.day).toBe(d.getDate())
    expect(p.hour).toBe(d.getHours())
    expect(isoLocal(d)).toBe(isoLocal(d, undefined))
    expect(isoLocal(d)).toBe(isoLocal(d, null))
    expect(isoLocal(d)).toBe(isoLocal(d, ''))
  })

  test('neveljavna cona (tipkanje v nastavitvah lokacije) → Europe/Ljubljana, NE UTC', () => {
    expect(isoLocal(new Date('2026-01-15T12:30:45Z'), 'Mars/Olympus_Mons')).toBe('2026-01-15T13:30:45')
  })
})

describe('localYearMonth — številka računa mora slediti lokalnemu datumu', () => {
  test('lokalni prehod v novo leto: 31.12.2026 23:30Z je v Ljubljani 1.1.2027', () => {
    // Bistvo #2: računi izdani med 23:00Z in 24:00Z zadnji dan v mesecu so bili
    // oštevilčeni s PREJŠNJIM mesecem (UTC), oddani pa z lokalnim datumom novega.
    expect(localYearMonth(new Date('2026-12-31T23:30:00Z'), TZ)).toEqual({ y: 2027, m: 1 })
    expect(localYearMonth(new Date('2026-12-31T22:30:00Z'), TZ)).toEqual({ y: 2026, m: 12 })
  })

  test('mesec se spremeni ob 00:00 lokalno, ne ob 00:00 UTC', () => {
    expect(localYearMonth(new Date('2026-01-31T23:00:00Z'), TZ)).toEqual({ y: 2026, m: 2 })
  })

  test('neveljavna cona → Ljubljana (iste ure kot zgoraj)', () => {
    expect(localYearMonth(new Date('2026-12-31T23:30:00Z'), 'Bad/Zone')).toEqual({ y: 2027, m: 1 })
  })
})

describe('hrLocalDateTime / hrLocalDateTimeT — oblika za HR Porezno', () => {
  test('ZKI niz: dd.MM.yyyy HH:mm:ss, ničlo-padded (pinned vektor tests/cis-client.test.ts)', () => {
    expect(hrLocalDateTime(new Date('2026-10-10T19:10:34Z'), TZ)).toBe('10.10.2026 21:10:34')
  })

  test('SOAP niz: dd.MM.yyyyTHH:mm:ss', () => {
    expect(hrLocalDateTimeT(new Date('2025-12-31T23:05:09Z'), TZ)).toBe('01.01.2026T00:05:09')
  })

  test('enaka ura v obeh oblikah (razlika je samo ločilo)', () => {
    const d = new Date('2026-03-08T14:23:45Z')
    expect(hrLocalDateTimeT(d, TZ).replace('T', ' ')).toBe(hrLocalDateTime(d, TZ))
  })
})
