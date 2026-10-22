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

/*
 * REGISTRA: v1.166.0 — izdaja je padla šele na Vercelu.
 *
 * `src/lib/demo-history.ts` je pisal `status: 'completed'`, SQLite zrcalo ima
 * `status String` (enumov ne pozna), zato je bil `tsc` lokalno zelen; produkcijski
 * `TimeEntryStatus` je unija treh členov, zato je `next build` na Vercelu padel.
 * `postinstall` izbere shemo glede na `DATABASE_URL`
 * (scripts/prisma-postinstall.cjs), tako da nobena lokalna vrata z SQLite klientom
 * te napake ne morejo videti — vidijo jo `bun run typecheck:cloud`, CI job
 * `typecheck-prod` in ta test, ki bere shemo in ne klienta.
 */
describe('demo izmene — TimeEntry literali so člani produkcijskih enumov (v1.166.0)', () => {
  const statusMembers = enumMembers('TimeEntryStatus')
  const typeMembers = enumMembers('TimeEntryType')
  const demoSrc = read('src/lib/demo-history.ts')
  const seedSrc = read('scripts/seed-demo-history.ts')

  /**
   * Blok predmeta/vmesnika je edini nedvoumen kraj: v demo datotekah `status:`
   * pomeni Order (`paid`), OrderItem (`served`) IN TimeEntry. Sidro je `clockIn` —
   * imajo ga samo TimeEntry bloki (`DemoHistoryEntry` vmesnik, `out.push` in
   * `db.timeEntry.create({ data: … })` literali).
   */
  function shiftObjects(raw: string): string[] {
    // interpolacije `${...}` pokvarijo štetje oklepajev (id v izmenah je template),
    // zato jih najprej zgladimo v navaden niz
    const text = raw.replace(/\$\{[^{}]*\}/g, '""')
    const found: string[] = []
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '{') continue
      let depth = 0
      let end = -1
      for (let j = i; j < text.length; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') {
          depth--
          if (depth === 0) { end = j; break }
        }
      }
      if (end < 0) continue
      const body = text.slice(i + 1, end)
      // Samo NOTRANJI oklepaj: zunanji bi vseboval vse `status:` hkrati in lažno
      // uvključil Order/OrderItem literale v TimeEntry primerjavo.
      if (body.includes('{')) continue
      if (!/\bclockIn\b/.test(body)) continue
      found.push(text.slice(i, end + 1))
    }
    return found
  }

  const objects = [...shiftObjects(demoSrc), ...shiftObjects(seedSrc)]
  const statusValues = objects.flatMap((o) => literalsFor(o, 'status'))
  const typeValues = objects.flatMap((o) => literalsFor(o, 'type'))

  test('TimeEntryStatus in TimeEntryType iz sheme imata znane člane (sidro, ne klient)', () => {
    expect([...statusMembers].sort()).toEqual(['active', 'approved', 'disputed'])
    expect([...typeMembers].sort()).toEqual(['holiday', 'overtime', 'regular', 'sick', 'vacation'])
  })

  test('produkcija tipira status kot enum, SQLite zrcalo kot String', () => {
    expect(fieldType('TimeEntry', 'status')).toBe('TimeEntryStatus')
    expect(fieldType('TimeEntry', 'type')).toBe('TimeEntryType')
    const sqlite = read('prisma/schema.sqlite.prisma')
    const entry = /^model TimeEntry \{([\s\S]*?)^\}/m.exec(sqlite)
    expect(entry).not.toBeNull()
    expect(entry![1]).toMatch(/^\s*status\s+String/m)
    expect(entry![1]).toMatch(/^\s*type\s+String/m)
  })

  test('iskalnik res najde izmene (pozitivna kontrola: brez njega test ne primerja ničesar)', () => {
    expect(objects.length).toBeGreaterThanOrEqual(2)
    expect(statusValues.length).toBeGreaterThanOrEqual(2)
    expect(typeValues.length).toBeGreaterThanOrEqual(2)
  })

  test('kontrolni literal, ki ga enum ne pozna, je res zaznan', () => {
    expect(invalid(['approved', 'completed'], statusMembers)).toEqual(['completed'])
  })

  test('vsak `status:` in `type:` ob izmeni je član produkcijskega enuma', () => {
    expect(invalid(statusValues, statusMembers)).toEqual([])
    expect(invalid(typeValues, typeMembers)).toEqual([])
  })
})
