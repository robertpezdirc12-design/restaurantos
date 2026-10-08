import { describe, expect, test } from 'bun:test'
import {
  codeCandidateFromName,
  describeLocationChanges,
  filterByLocation,
  isCentralUIRole,
  locationStatusLabel,
  locationSubtitle,
  MAX_CODE,
  normalizeLocationCode,
  validateLocationInput,
} from '../src/lib/multilocation'

describe('multilocation — normalizeLocationCode', () => {
  test('diakritike → ASCII + uppercase', () => {
    expect(normalizeLocationCode('Ljubljana Črnuče')).toBe('LJUBLJANA-CRNUCE')
    expect(normalizeLocationCode('ŠENTVID')).toBe('SENTVID')
    expect(normalizeLocationCode('Maribor ŽP')).toBe('MARIBOR-ZP')
  })

  test('dovoljeni znaki: A–Z, 0–9, pomišljaj', () => {
    expect(normalizeLocationCode('celje #2 / center')).toBe('CELJE-2-CENTER')
    expect(normalizeLocationCode('--kranj--')).toBe('KRANJ')
  })

  test('obrezanje na mejo', () => {
    expect(normalizeLocationCode('A'.repeat(40)).length).toBe(MAX_CODE)
  })

  test('prazno → prazen niz', () => {
    expect(normalizeLocationCode('')).toBe('')
    expect(normalizeLocationCode(null)).toBe('')
    expect(normalizeLocationCode('!!!')).toBe('')
  })

  test('kandidat iz imena (obrezan na mejo)', () => {
    expect(codeCandidateFromName('Kranj Center')).toBe('KRANJ-CENTER')
    expect(codeCandidateFromName('RestaurantOS Ljubljana')).toBe(MAX_CODE === 20 ? 'RESTAURANTOS-LJUBLJA' : 'RESTAURANTOS-LJUBLJANA')
  })
})

describe('multilocation — validateLocationInput', () => {
  test('samo ime → ostalo privzeto', () => {
    const v = validateLocationInput({ name: 'Bled' })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.value.name).toBe('Bled')
      expect(v.value.country).toBe('SI')
      expect(v.value.currency).toBe('EUR')
      expect(v.value.timezone).toBe('Europe/Ljubljana')
    }
  })

  test('brez imena → napaka', () => {
    expect(validateLocationInput({}).ok).toBe(false)
    expect(validateLocationInput({ name: '  ' }).ok).toBe(false)
  })

  test('koda se normalizira', () => {
    const v = validateLocationInput({ name: 'X', code: ' lj-zalogA ' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.code).toBe('LJ-ZALOGA')
  })

  test('prekratka koda → napaka', () => {
    expect(validateLocationInput({ name: 'X', code: 'A' }).ok).toBe(false)
  })

  test('neveljavna e-pošta → napaka', () => {
    expect(validateLocationInput({ name: 'X', email: 'ni.maila' }).ok).toBe(false)
    expect(validateLocationInput({ name: 'X', email: 'a@b.si' }).ok).toBe(true)
  })

  test('nepodprta država → napaka', () => {
    expect(validateLocationInput({ name: 'X', country: 'DE' }).ok).toBe(false)
    expect(validateLocationInput({ name: 'X', country: 'hr' }).ok).toBe(true)
  })

  test('telefon z nedovoljenimi znaki → napaka', () => {
    expect(validateLocationInput({ name: 'X', phone: '041 abc' }).ok).toBe(false)
    expect(validateLocationInput({ name: 'X', phone: '+386 41 123 456' }).ok).toBe(true)
  })

  test('besedilna polja se obrežejo', () => {
    const v = validateLocationInput({ name: 'X'.repeat(200), address: 'a'.repeat(300) })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.value.name.length).toBe(120)
      expect(v.value.address.length).toBe(160)
    }
  })
})

describe('multilocation — oznake', () => {
  test('stanje lokacije', () => {
    expect(locationStatusLabel(true)).toBe('Aktivna')
    expect(locationStatusLabel(false)).toBe('Neaktivna')
  })

  test('podpis lokacije', () => {
    expect(locationSubtitle({ city: 'Ljubljana', country: 'SI', currency: 'EUR' })).toBe('Ljubljana · SI · EUR')
    expect(locationSubtitle({ city: 'Ljubljana' })).toBe('Ljubljana')
    expect(locationSubtitle({})).toBe('')
  })
})

describe('multilocation — describeLocationChanges (audit)', () => {
  test('prepozna spremembe s staro/novo vrednostjo', () => {
    const changes = describeLocationChanges(
      { name: 'Staro ime', city: 'Ljubljana', isActive: true },
      { name: 'Novo ime', city: 'Ljubljana', isActive: false },
    )
    expect(changes).toContain('ime: »Staro ime« → »Novo ime«')
    expect(changes).toContain('stanje: Aktivna → Neaktivna')
    expect(changes).toHaveLength(2)
  })

  test('ni sprememb → prazen seznam', () => {
    expect(describeLocationChanges({ name: 'X' }, { name: 'X' })).toHaveLength(0)
  })

  test('nastavitev nove vrednosti iz prazne', () => {
    const changes = describeLocationChanges({ phone: '' }, { phone: '+386 1 234' })
    expect(changes).toContain('telefon: »—« → »+386 1 234«')
  })

  test('ignorira polja, ki jih patch ne pošlje', () => {
    expect(describeLocationChanges({ name: 'X' }, { phone: '123' })).toHaveLength(1)
  })
})

describe('multilocation — filterByLocation (pogledi)', () => {
  const rows = [
    { id: '1', locationId: 'locA' },
    { id: '2', locationId: 'locB' },
    { id: '3', locationId: null },
    { id: '4' },
  ]

  test('brez izbire → vse vrstice', () => {
    expect(filterByLocation(rows, null)).toHaveLength(4)
    expect(filterByLocation(rows, '')).toHaveLength(4)
    expect(filterByLocation(rows, undefined)).toHaveLength(4)
  })

  test('z izbiro → samo izbrana lokacija + globalni viri', () => {
    const out = filterByLocation(rows, 'locA')
    expect(out.map((r) => r.id)).toEqual(['1', '3', '4'])
  })

  test('undefined seznam → prazen', () => {
    expect(filterByLocation(undefined, 'locA')).toHaveLength(0)
  })

  test('ne mutira vhodnega seznama', () => {
    filterByLocation(rows, 'locA')
    expect(rows).toHaveLength(4)
  })
})

describe('multilocation — isCentralUIRole', () => {
  test('OWNER/ADMIN → centralni', () => {
    expect(isCentralUIRole('OWNER')).toBe(true)
    expect(isCentralUIRole('ADMIN')).toBe(true)
  })

  test('ostali → ne', () => {
    expect(isCentralUIRole('MANAGER')).toBe(false)
    expect(isCentralUIRole('WAITER')).toBe(false)
    expect(isCentralUIRole('KITCHEN')).toBe(false)
    expect(isCentralUIRole(null)).toBe(false)
    expect(isCentralUIRole(undefined)).toBe(false)
  })
})
