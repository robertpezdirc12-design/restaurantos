/**
 * REGISTRA: v1.152.1 — produkcijski build je padel šele na seed skriptah.
 *
 * Vsa lokalna vrata tečejo s SQLite-generiranim clientom, kjer so enum polja
 * `String`; `next build` pa si generira Postgres client in vidi prave enume.
 * Zato sta `source: 'web'` (ReservationSource) in `itemStatus` tipa `string`
 * (OrderItemStatus) ušla tsc-ju, lintu in testom ter podrla šele Vercel build.
 * `tests/schema-enum-literals.test.ts` te luknje ne pokriva — pregleduje samo
 * `src/`, ne pa `prisma/seed*.ts` in `scripts/`.
 *
 * Ta test bere PRODUKCIJSKO shemo in literalov ne uvaža iz clienta, zato teče
 * enako pod obema shemama.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const schema = read('prisma/schema.prisma')

function enumMembers(name: string): Set<string> {
  const m = new RegExp(`^enum\\s+${name}\\s*\\{([^}]*)\\}`, 'm').exec(schema)
  if (!m) throw new Error(`enum ${name} manjka v prisma/schema.prisma`)
  const members = m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => l.split(/\s+/)[0])
  if (members.length === 0) throw new Error(`enum ${name} je prazen`)
  return new Set(members)
}

const invalid = (values: string[], members: Set<string>): string[] => values.filter((v) => !members.has(v))

/** Vsi nizovni literali ob ključu `key` v danem besedilu. */
function literalsFor(text: string, key: string): string[] {
  return [...text.matchAll(new RegExp(`\\b${key}:\\s*'([^']+)'`, 'g'))].map((m) => m[1])
}

/** Tip polja `model.field` iz produkcijske sheme. */
function fieldType(model: string, field: string): string | null {
  const m = new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema)
  if (!m) return null
  for (const line of m[1].split('\n')) {
    const f = line.trim().match(new RegExp(`^${field}\\s+([A-Za-z_]\\w*)`))
    if (f) return f[1]
  }
  return null
}

describe('seed skripte — literali so člani PRODUKCIJSKIH enumov', () => {
  const reservationSource = enumMembers('ReservationSource')

  test('ReservationSource iz sheme ima znane člane (sidro, ne uvožen client)', () => {
    expect([...reservationSource].sort()).toEqual(['app', 'phone', 'walk_in', 'website'])
  })

  test('vsak `source:` v seed skriptah je član ReservationSource', () => {
    const files = ['prisma/seed.ts', 'prisma/seed-demo.ts']
    const found = files.flatMap((f) =>
      literalsFor(read(f), 'source').map((value) => ({ file: f, value })),
    )
    // pozitivna kontrola: če se regex pokvari, ta test ne sme tiho obrniti
    expect(found.length).toBeGreaterThanOrEqual(3)
    expect(found.filter((e) => !reservationSource.has(e.value)).map((e) => `${e.file}: '${e.value}'`)).toEqual([])
  })

  test('kontrolni literal, ki ga enum ne pozna, je res zaznan', () => {
    expect(invalid(['phone', 'web'], reservationSource)).toEqual(['web'])
  })
})

describe('demo naročila — SeedItemStatus mora biti natanko OrderItemStatus', () => {
  const itemStatus = enumMembers('OrderItemStatus')
  const src = read('scripts/seed-demo-orders.ts')

  function unionMembers(text: string): string[] {
    const m = /type SeedItemStatus\s*=\s*([^\n]+)/.exec(text)
    if (!m) return []
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }

  test('lokalna unija je enaka produkcijskemu enumu (ne le podmnožica)', () => {
    const union = unionMembers(src)
    expect(union.length).toBeGreaterThan(0)
    expect([...union].sort()).toEqual([...itemStatus].sort())
  })

  test('vsak literal ob `itemStatus` in privzeti status vrstice je član enuma', () => {
    const values = [
      ...literalsFor(src, 'itemStatus'),
      ...[...src.matchAll(/status:\s*j === 0 \? sp\.itemStatus : '([^']+)'/g)].map((m) => m[1]),
    ]
    expect(values.length).toBeGreaterThanOrEqual(5)
    expect(invalid(values, itemStatus)).toEqual([])
  })

  test('privzeti status `fired` v vrstici je iz enuma', () => {
    expect(src).toMatch(/status:\s*j === 0 \? sp\.itemStatus : 'fired'/)
    expect(itemStatus.has('fired')).toBe(true)
  })
})

describe('zakaj je unija sploh potrebna (pin obeh shem)', () => {
  test('produkcijska shema ima prava enuma, SQLite zrcalo pa String', () => {
    expect(fieldType('OrderItem', 'status')).toBe('OrderItemStatus')
    expect(fieldType('Reservation', 'source')).toBe('ReservationSource')
    const sqlite = read('prisma/schema.sqlite.prisma')
    const orderItem = /^model OrderItem \{([\s\S]*?)^\}/m.exec(sqlite)
    const reservation = /^model Reservation \{([\s\S]*?)^\}/m.exec(sqlite)
    expect(orderItem).not.toBeNull()
    expect(reservation).not.toBeNull()
    expect(orderItem![1]).toMatch(/^\s*status\s+String/m)
    expect(reservation![1]).toMatch(/^\s*source\s+String/m)
  })
})
