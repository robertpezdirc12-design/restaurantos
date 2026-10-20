/**
 * REGISTRA: v1.129.0, razširjeno v1.130.0
 *
 * SQLite shema ne pozna enumeratov (`Reservation.status` je tam `String`), zato
 * `bun test` ne more videti neveljavne vrednosti enuma; na Postgresu Prisma tak
 * pogovor zavrne. `tsc` v quality-gate-u teče s SQLite-generiranim clientom in
 * te napake ne vidi; `next build` (brez `ignoreBuildErrors` od v1.150.0) in
 * `production-typecheck` jo vidita šele s Postgres clientom. Ta test jo ujame
 * že pod SQLite clientom in brez baze. (Seed skripte pokriva
 * `tests/seed-enum-validity.test.ts` — ta test pregleduje samo `src/`.)
 *
 * Ta test bere prisma/schema.prisma in src/ zato, da ujame ravno ta razred.
 *
 * POKRITO: `db|client|tx.<model>.<metoda>({ ... })`, kjer je ključ na ravnini
 * znotraj `where`/`data`/`update`/`create`/`AND`/`OR`/`NOT` enum-tipsko polje
 * POKLICANEGA modela (model poznamo iz prejemnika, zato ni dvoumnosti).
 *
 * NI POKRITO (zavestno, da ne proizvede lažnih pozitivov, ki bi blokiral CI):
 *  - gnezdene filtre relacij (`where: { items: { some: { status: ... } } }`) —
 *    tam modela ne poznamo brez tipiziranega AST-ja;
 *  - `Prisma.<Enum>_enum.VREDNOST` in spremenljivke — slednjih sweeper ne
 *    razčlenjuje; luknja je zdaj delno zamašena drugače (v1.130.0): koda sme
 *    imeti lasten nabor SAMO za `EmployeeRole`, enakega preveri drugi blok spodaj.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EMPLOYEE_ROLE_VALUES, buildSubscriptionWhere } from '@/lib/push'

const ROOT = join(import.meta.dir, '..')
const SRC = join(ROOT, 'src')

/* ── 1. shema: enumerati in enum-tipska polja modelov ───────────────── */

function parseEnums(schema: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const m of schema.matchAll(/^enum\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/gm)) {
    const members = new Set<string>()
    for (const line of m[2].split('\n')) {
      const id = line.trim().match(/^([A-Za-z_]\w*)/)
      if (id) members.add(id[1])
    }
    if (members.size) out.set(m[1], members)
  }
  return out
}

/** lowercamel(prejemnik) → { polje → clenovi enuma } */
function parseModelFields(schema: string, enums: Map<string, Set<string>>): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>()
  for (const m of schema.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, Set<string>>()
    for (const raw of m[2].split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue
      const f = line.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?\??[\s@]/)
      if (!f || f[3]) continue
      const members = enums.get(f[2])
      if (members) fields.set(f[1], members)
    }
    if (fields.size) out.set(m[1][0].toLowerCase() + m[1].slice(1), fields)
  }
  return out
}

/* ── 2. bralnik objektnih ravnin (brez AST, a ravensko točen) ────────── */

const isQuote = (c: string) => c === "'" || c === '"' || c === '`'

function skipStringsAndComments(text: string, i: number): number {
  const c = text[i]
  if (isQuote(c)) {
    let j = i + 1
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue }
      if (text[j] === c) return j + 1
      j++
    }
    return j
  }
  if (c === '/' && text[i + 1] === '/') { const n = text.indexOf('\n', i); return n < 0 ? text.length : n }
  if (c === '/' && text[i + 1] === '*') { const n = text.indexOf('*/', i + 2); return n < 0 ? text.length : n + 2 }
  return i
}

/** Preskoči prazen prostor in komentarje — NAMENOMA NE stringov (sicer bi požrl
 *  prav tiste literale, ki jih hočemo prebrati). */
function skipSpace(text: string, i: number): number {
  let j = i
  while (j < text.length) {
    if (/\s/.test(text[j])) { j++; continue }
    if (text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) { j = skipStringsAndComments(text, j); continue }
    break
  }
  return j
}

/** Ujemanje oklepaja za `open` (poljuben `'({[`). */
function matchOpen(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    if (isQuote(text[i]) || (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))) { i = skipStringsAndComments(text, i); continue }
    if ('({['.includes(text[i])) depth++
    else if (')}]'.includes(text[i])) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

type Entry = { key: string; kind: 'string' | 'object' | 'array' | 'other'; value: string }

/** Kljuci+vrste na RAVNI 1 objektnega telesa (brez gnezdenih ravni). */
function entries(body: string): Entry[] {
  const out: Entry[] = []
  let i = skipSpace(body, 0)
  while (i < body.length) {
    const keyMatch = body.slice(i).match(/^(?:([A-Za-z_$][\w$]*)|'([^']*)'|("([^"]*)"))\s*:/)
    if (!keyMatch) {
      // presledek, razsiri `{`-podrejo ali vrednost brez kljuca — preskoci celotno vrednost
      const v = skipStringsAndComments(body, i)
      if (v !== i) { i = skipSpace(body, v); continue }
      const close = matchOpen(body, i)
      i = skipSpace(body, close > 0 ? close + 1 : i + 1)
      continue
    }
    const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[4]
    let j = skipSpace(body, i + keyMatch[0].length)
    const c = body[j]
    if (isQuote(c)) {
      const end = skipStringsAndComments(body, j)
      const raw = body.slice(j, end)
      if (c !== '`') out.push({ key, kind: 'string', value: raw.slice(1, -1) })
      j = end
    } else if (c === '{' || c === '[') {
      const close = matchOpen(body, j)
      out.push({ key, kind: c === '{' ? 'object' : 'array', value: close > 0 ? body.slice(j + 1, close) : '' })
      j = close > 0 ? close + 1 : body.length
    } else {
      let k = j
      let depth = 0
      while (k < body.length) {
        if (isQuote(body[k]) || (body[k] === '/' && (body[k + 1] === '/' || body[k + 1] === '*'))) { k = skipStringsAndComments(body, k); continue }
        if ('({['.includes(body[k])) depth++
        else if (')}]'.includes(body[k])) depth--
        else if (depth === 0 && (body[k] === ',' || body[k] === '\n')) break
        k++
      }
      out.push({ key, kind: 'other', value: body.slice(j, k) })
      j = k
    }
    i = skipSpace(body, j + (body[j] === ',' ? 1 : 0))
  }
  return out
}

/** Nizovni literali v array telesu (identifikatorji se ignorira). */
function stringsInArray(inner: string): string[] {
  const found: string[] = []
  let i = skipSpace(inner, 0)
  while (i < inner.length) {
    if (isQuote(inner[i])) {
      const end = skipStringsAndComments(inner, i)
      const raw = inner.slice(i, end)
      if (inner[i] !== '`') found.push(raw.slice(1, -1))
      i = skipSpace(inner, end)
      continue
    }
    const close = matchOpen(inner, i)
    i = skipSpace(inner, close > 0 ? close + 1 : i + 1)
  }
  return found
}

const CONTAINERS = new Set(['where', 'data', 'update', 'create', 'AND', 'OR', 'NOT'])
const FILTER_OPS = new Set(['in', 'notIn', 'set', 'equals', 'not'])

/* ── 3. poizvedbe v izvorni kodi ─────────────────────────────────────── */

const PRISMA_METHODS = 'findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany'
const CALL_RE = new RegExp(`\\b(?:db|client|tx)\\.([a-z]\\w*)\\.(${PRISMA_METHODS})\\s*(?:<[^<>()]*>)?\\s*\\(`, 'g')

type Hit = { file: string; line: number; model: string; field: string; value: string; allowed: string[] }

/** Vrne neveljavne literale za enum polja modela na pokritih ravninah. */
function collectBad(body: string, fields: Map<string, Set<string>>, hits: Hit[], file: string, text: string, at: number, depth = 0): void {
  if (depth > 3) return
  for (const e of entries(body)) {
    if (CONTAINERS.has(e.key)) {
      if (e.kind === 'object') collectBad(e.value, fields, hits, file, text, at, depth + 1)
      else if (e.kind === 'array') {
        let i = skipSpace(e.value, 0)
        while (i < e.value.length) {
          if (e.value[i] === '{') {
            const close = matchOpen(e.value, i)
            if (close < 0) break
            collectBad(e.value.slice(i + 1, close), fields, hits, file, text, at, depth + 1)
            i = skipSpace(e.value, close + 1)
            continue
          }
          const close = matchOpen(e.value, i)
          i = skipSpace(e.value, close > 0 ? close + 1 : i + 1)
        }
      }
      continue
    }
    const members = fields.get(e.key)
    if (!members) continue
    const values: string[] = []
    if (e.kind === 'string') values.push(e.value)
    else if (e.kind === 'object') {
      for (const op of entries(e.value)) {
        if (!FILTER_OPS.has(op.key)) continue
        if (op.kind === 'string') values.push(op.value)
        else if (op.kind === 'array') values.push(...stringsInArray(op.value))
      }
    }
    for (const value of values) {
      if (members.has(value)) continue
      hits.push({ file, line: text.slice(0, at).split('\n').length, model: '', field: e.key, value, allowed: [...members].sort() })
    }
  }
}

function findHits(models: Map<string, Map<string, Set<string>>>): Hit[] {
  const hits: Hit[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) { if (!name.startsWith('.') && name !== 'node_modules') walk(p); continue }
      if (!/\.(ts|tsx)$/.test(name) || name.endsWith('.d.ts')) continue
      const text = readFileSync(p, 'utf8')
      if (!text.includes('db.') && !text.includes('client.') && !text.includes('tx.')) continue
      const file = p.slice(SRC.length + 1).replace(/\\/g, '/')
      CALL_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = CALL_RE.exec(text))) {
        const fields = models.get(m[1])
        if (!fields) continue
        const open = m.index + m[0].length - 1
        const close = matchOpen(text, open)
        if (close < 0) continue
        const args = text.slice(open + 1, close)
        const first = skipSpace(args, 0)
        if (args[first] !== '{') continue
        const end = matchOpen(args, first)
        if (end < 0) continue
        collectBad(args.slice(first + 1, end), fields, hits, file, text, m.index)
        for (let i = hits.length - 1; i >= 0; i--) if (!hits[i].model) hits[i].model = m[1]
      }
    }
  }
  walk(SRC)
  const seen = new Set<string>()
  return hits.filter((h) => {
    const k = `${h.file}:${h.model}.${h.field}='${h.value}'`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const schemaText = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8')
const enums = parseEnums(schemaText)
const models = parseModelFields(schemaText, enums)
const hits = findHits(models)
const report = () => hits.map((h) => `src/${h.file}:${h.line} db.${h.model}.${h.field} = '${h.value}' (dovoljeni: ${h.allowed.join('|')})`)

/* ── 4 testi: literali v db.<model>.<metoda> klicih ──────────────────── */

describe('schema enum literal guard (SQLite ne validira enumeratov)', () => {
  test('razčlenjevalnik vidi ReservationStatus in Reservation.status kot enum polje', () => {
    expect([...enums.keys()]).toContain('ReservationStatus')
    expect([...(models.get('reservation')?.get('status') ?? [])].sort()).toEqual([
      'cancelled', 'completed', 'confirmed', 'no_show', 'seated',
    ])
    // kontrola: OrderItem.status ima drug členov nabor → ni dvoumnosti med modeloma
    expect([...(models.get('orderItem')?.get('status') ?? [])]).toContain('pending')
  })

  test('sweeper najde ravno to napako, ki jo je prijavila inšpekcija (pozitivna kontrola)', () => {
    const fields = new Map([['status', new Set(['confirmed', 'seated'])]])
    const probe: Hit[] = []
    const probeBody = ` where: { dateTime: { gte: now }, status: { in: ['confirmed', 'ghost'] } }, orderBy: { dateTime: 'asc' } `
    collectBad(probeBody, fields, probe, 'probe.ts', '', 0)
    expect(probe.map((h) => `${h.field}='${h.value}'`)).toEqual(["status='ghost'"])
    // a veljaven niz NE sme biti javljen
    const okProbe: Hit[] = []
    collectBad(` where: { status: { in: ['confirmed', 'seated'] }, reminderSent: false } `, fields, okProbe, 'probe.ts', '', 0)
    expect(okProbe).toEqual([])
    // gnezdeni filtri relacij so zavestno nepokriti
    const nested: Hit[] = []
    collectBad(` where: { items: { some: { status: 'ghost' } } } `, fields, nested, 'probe.ts', '', 0)
    expect(nested).toEqual([])
  })

  test('nobeno enum polje v src/ ne dobi literala, ki ga produkcijska shema ne pozna', () => {
    expect(report()).toEqual([])
  })

  test('rezervacijski opomniki smejo biti samo za status, ki ga enum pozna', () => {
    expect(hits.filter((h) => h.model === 'reservation' && h.field === 'status')).toEqual([])
  })
})

/* ── 5. REGISTRA v1.130.0: nabori, ki jih KODA deklarira sama ─────────── */

/**
 * Prejšnji štirje testi ujamejo literale v `db.<model>.<metoda>` klicih. Ostane
 * ena luknja: vrednosti, ki zlezejo v `string[]` spremenljivko in potem v filter
 * (`role: { in: target.roles }`). SQLite klient tega ne vidi, na Postgresu pa
 * Prisma neveljaven član zavrne — celoten push tiho pade v `try/catch`.
 *
 * Zato koda samega enuma NE citira iz spomina: `EMPLOYEE_ROLE_VALUES` mora biti
 * enak členom `enum EmployeeRole`, `buildSubscriptionWhere` pa pred poizvedbo
 * zavrže vse, ki jih shema ne pozna.
 */
describe('enum nabor, ki ga deklarira koda (push vloge)', () => {
  test('EMPLOYEE_ROLE_VALUES je natanko enum EmployeeRole iz produkcijske sheme', () => {
    const fromSchema = [...(enums.get('EmployeeRole') ?? [])].sort()
    expect(fromSchema.length).toBeGreaterThan(0)
    expect([...EMPLOYEE_ROLE_VALUES].sort()).toEqual(fromSchema)
  })

  test('buildSubscriptionWhere zavrže vloge, ki jih shema ne pozna', () => {
    const w = buildSubscriptionWhere({ roles: ['bar', 'kichen', 'chef'], locationId: 'loc1' })
    expect(w).not.toBeNull()
    expect(w!.Employee.role!.in).toEqual(['bar', 'chef'])
    expect(w!.Employee.locationId).toBe('loc1')
    expect(w!.isActive).toBe(true)
  })

  test('če po filtriranju ne ostane Nobena veljavna vloga, poizvedbe NI (noben ni obvesten)', () => {
    // admin matrica z vsemi napačnimi vlogami: varna odločitev je NE pošiljati
    // nikomur, ne pa zaliti cele lokacije — prazen seznam ni enak izpuščenemu filtru
    expect(buildSubscriptionWhere({ roles: ['kichen', 'ghost'], locationId: 'loc1' })).toBeNull()
  })

  test('brez vlog filter ostane samo lokacijski (obnašanje ostane kot prej)', () => {
    const loc = buildSubscriptionWhere({ locationId: 'loc1' })
    expect(loc).toEqual({ isActive: true, Employee: { locationId: 'loc1' } })
    expect(buildSubscriptionWhere({})).toEqual({ isActive: true, Employee: {} })
    const byIds = buildSubscriptionWhere({ employeeIds: ['e1', 'e2'], roles: ['bar'] })
    expect(byIds!.employeeId).toEqual({ in: ['e1', 'e2'] })
    expect(byIds!.Employee.role!.in).toEqual(['bar'])
  })
})
