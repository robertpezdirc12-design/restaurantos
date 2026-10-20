import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { en } from '../src/lib/i18n/en'

/**
 * v1.155.0 — doc-truth: docs/RESTAURANTOS-AUDIT.md mora opisovati DEJANSKO stanje.
 *
 * Audit je bil pisan 2026-10-09; od takrat so Task 31-a/33-a/33-b/35/36/38/49 in
 * v1.86.0 zaprli več vrstic, dokument pa je ponekod še vedno trdil "MISSING",
 * "PARTIAL" ali "ni odjemalca". Test vsako trditev preveri proti kodi (obstoj
 * rut, UI klicev, odjemalcev) in proti štetju v shemah/slovarjih — dokument ne
 * more tiho zaostati za implementacijo.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const exists = (p: string) => existsSync(join(ROOT, p))
const DOC = read('docs/RESTAURANTOS-AUDIT.md')

function section(start: string, end: string): string {
  const i = DOC.indexOf(start)
  expect(i).toBeGreaterThan(-1)
  const j = DOC.indexOf(end, i + start.length)
  expect(j).toBeGreaterThan(i)
  return DOC.slice(i, j)
}

function row(sectionText: string, firstCell: string): string {
  const line = sectionText.split('\n').find((l) => l.startsWith(`| ${firstCell} |`))
  expect(line).toBeDefined()
  return line!
}

const schema = read('prisma/schema.prisma')
const sqliteSchema = read('prisma/schema.sqlite.prisma')
const migration = read('prisma/migrations/00000000000000_init/migration.sql')
const count = (src: string, re: RegExp) => [...src.matchAll(re)].length
const prodModels = count(schema, /^model\s+\w+\s*\{/gm)
const prodEnums = count(schema, /^enum\s+\w+\s*\{/gm)
const sqliteModels = count(sqliteSchema, /^model\s+\w+\s*\{/gm)
const baselineTables = count(migration, /^CREATE TABLE "\w+"/gm)

describe('§2 — shema in infrastruktura', () => {
  test('dual-schema števci v dokumentu ustrezajo obema shemama', () => {
    expect(prodModels).toBe(135)
    expect(prodEnums).toBe(20)
    expect(sqliteModels).toBe(prodModels)
    const s2 = section('## 2.', '## 3.')
    expect(s2).toContain(`${prodModels} modelov/${prodEnums} enumov`)
    expect(s2).toContain(`${sqliteModels} modelov`)
    expect(s2).toContain('0 enumov')
    expect(s2).not.toContain('117 modelov')
  })

  test('baseline šteje vse tabele — 117 je zastarelo', () => {
    expect(baselineTables).toBe(prodModels)
    const s2 = section('## 2.', '## 3.')
    expect(s2).toContain(`${baselineTables} tabel`)
    expect(s2).not.toContain('117 tabel')
  })

  test('prod-smoke in Neon backup nista več odprta blockerja', () => {
    const s2 = section('## 2.', '## 3.')
    expect(s2).toContain('prod-smoke.yml')
    expect(s2).toContain('neon-backup.yml')
    expect(s2).not.toContain('BLOCKER za avtomatske produkcijske smoke teste')
    expect(s2).not.toContain('ni urnika')
  })
})

describe('§1 — CI status', () => {
  test('GitLab CI je opisan kot ponovno aktiven, ne kot disabled', () => {
    const s1 = section('## 1.', '## 2.')
    expect(s1).toContain('ponovno aktiven')
    expect(s1).toContain('pipeline')
  })
})

describe('§3 — zemljevid toka', () => {
  test('selitev/združevanje miz je DONE in kaže na obstoječe rute + UI', () => {
    const s3 = section('## 3.', '## 4.')
    const r = row(s3, '3')
    expect(r).not.toContain('MISSING')
    expect(r).toContain('orders/[id]/move/route.ts')
    expect(r).toContain('orders/[id]/merge/route.ts')
    expect(exists('src/app/api/orders/[id]/move/route.ts')).toBe(true)
    expect(exists('src/app/api/orders/[id]/merge/route.ts')).toBe(true)
    expect(exists('tests/orders-move-merge-fire.test.ts')).toBe(true)
    const dashboard = read('src/app/dashboard/page.tsx')
    expect(dashboard).toContain('/move`')
    expect(dashboard).toContain('/merge`')
  })

  test('gostujoči i18n ni več PARTIAL — SL/HR/EN je dejansko stanje', () => {
    const r = row(section('## 3.', '## 4.'), '14')
    expect(r).not.toContain('PARTIAL')
    expect(r).toContain('SL/HR/EN')
  })
})

describe('§5 — race/lastnosti', () => {
  test('R10 kaže na dejanski fiskalni storno, ne na MISSING', () => {
    const r = row(section('## 5.', '## 6.'), 'R10')
    expect(r).not.toContain('storno ostaja MISSING')
    expect(r).toContain('/api/receipts/[id]/storno')
    expect(exists('src/app/api/receipts/[id]/storno/route.ts')).toBe(true)
  })
})

describe('§7 — funkcijska matrika', () => {
  test('kiosk ni več SL-only', () => {
    const r = row(section('## 7.', '## 8.'), 'Kiosk (veliki gumbi, aktivacija kodo)')
    expect(r).not.toContain('SL-only')
    expect(r).toContain('SL/HR/EN')
  })
})

describe('§8 — lokalizacija', () => {
  test('števci ključev ustrezajo slovarjem (SL/HR polna, EN gostujoča podmnožica)', () => {
    const slKeys = Object.keys(sl).length
    const hrKeys = Object.keys(hr).length
    const enKeys = Object.keys(en).length
    expect(slKeys).toBe(hrKeys)
    const s8 = section('## 8.', '## 9.')
    expect(s8).not.toContain('1.073 ključev')
    expect(s8).toContain(`${slKeys} ključev`)
    expect(s8).toContain(`${hrKeys}`)
    expect(s8).toContain(`${enKeys} ključev`)
  })
})

describe('§9 — fiskalizacija', () => {
  const s9 = section('## 9.', '## 10.')

  test('odjemalca SI in HR sta implementirana (prejšnja trditev je zastarela)', () => {
    expect(s9).not.toContain('noben SOAP/REST klic')
    expect(s9).toContain('src/lib/furs/client.ts')
    expect(s9).toContain('src/lib/cis/client.ts')
    expect(exists('src/lib/furs/client.ts')).toBe(true)
    expect(exists('src/lib/cis/client.ts')).toBe(true)
    expect(read('src/lib/furs/client.ts')).toContain("createSign('RSA-SHA256')")
  })

  test('ZOI opis ustreza kodi — RSA-SHA256, ne RSA-SHA512', () => {
    expect(s9).toContain('RSA-SHA256')
    expect(s9).not.toContain('RSA-SHA512')
  })

  test('storno računa ni več med neimplementiranim', () => {
    expect(s9).not.toContain('ni storno/nadomestnega računa')
    expect(s9).toContain('/api/receipts/[id]/storno')
  })

  test('SI QR ostaja pošteno označen kot neimplementiran, HR QR obstaja', () => {
    expect(s9).toContain('SI QR na računu ni implementiran')
    expect(read('src/lib/receipt.ts')).toContain('receipt.hrCheck')
  })

  test('certifikat je opisan kot preostali človeški korak, pending brez njega', () => {
    expect(s9).toContain('FURS-CERT-RUNBOOK.md')
    expect(s9).toContain('certifikat')
    expect(s9).toContain('pending')
  })
})
