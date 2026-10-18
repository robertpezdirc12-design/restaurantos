/**
 * ISSUE #73 (v1.136.0) — odloženi sklopi, 1. prioritete: audit-19 + audit-26.
 *
 * Pure source-guard tests (brez DB):
 *  - audit-19 (nastavitve): sledenje neshranjenih sprememb (dirtyKeys) +
 *    lepljiva vrstica + Prekliči (revert) + Shrani po razdelku (sectionSave);
 *  - audit-26 (push matrika): predloga PO VLOGI pokriva VSE PUSH_EVENT_TYPES
 *    (noben dogodek ne ostane na »Vsi« hrupu), vloge so iz NOTIF_ROLES nabora,
 *    applyRoleTemplate je povezan z gumbom v UI.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PUSH_EVENT_TYPES } from '../src/lib/push-events'

const read = (p: string) => readFileSync(p, 'utf-8')
const nast = read('src/components/tabs/nastavitve-tab.tsx')
const ops = read('src/components/tabs/ops-cards.tsx')

/* ─────────── audit-19: shranjevanje po razdelku ─────────── */

describe('issue73 audit-19: nastavitve — neshranjene spremembe niso več tihe', () => {
  test('dirtyKeys sledi razliki form ↔ settings (števec, ne občutek)', () => {
    expect(nast).toContain('const dirtyKeys = useMemo(')
    expect(nast).toContain("String(a ?? '') !== String(b ?? '')")
  })
  test('lepljiva vrstica NESHRANJENE SPREMEMBE (N) z aria-live', () => {
    expect(nast).toContain('set.unsaved')
    expect(nast).toContain('sticky top-20')
    expect(nast).toContain('aria-live="polite"')
  })
  test('jasen izhod: Prekliči (revert) obnovi zadnje shranjeno', () => {
    expect(nast).toContain('const revert = () => { setForm(settings)')
    expect(nast).toContain("set.reverted")
  })
  test('Shrani na koncu vsakega razdelka (4 sectionSave vložki)', () => {
    expect(nast).toContain('const sectionSave = (')
    const n = (nast.match(/\{sectionSave\}/g) || []).length
    expect(n).toBe(4)
  })
})

/* ─────────── audit-26: predloga po vlogi ─────────── */

describe('issue73 audit-26: push matrika — predloga po vlogi', () => {
  test('NOTIF_ROLE_TEMPLATE pokriva VSE PUSH_EVENT_TYPES (brez »Vsi« ostankov)', () => {
    // izlušči telo predloge iz vira
    const m = ops.match(/const NOTIF_ROLE_TEMPLATE: Record<string, readonly string\[\]> = \{([\s\S]*?)\n\}/)
    expect(m).not.toBeNull()
    const body = m![1]
    const covered = new Set(
      [...body.matchAll(/^\s*([A-Z_]+):/gm)].map((x) => x[1]),
    )
    for (const ev of PUSH_EVENT_TYPES) {
      expect(covered.has(ev)).toBe(true)
    }
    expect(covered.size).toBe(PUSH_EVENT_TYPES.length)
  })
  test('vloga v predlogi je iz veljavnega NOTIF_ROLES nabora (fail-safe manager)', () => {
    const m = ops.match(/const NOTIF_ROLE_TEMPLATE: Record<string, readonly string\[\]> = \{([\s\S]*?)\n\}/)
    const roles = new Set(
      [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    )
    const valid = new Set(['waiter', 'bar', 'kitchen', 'chef', 'staff', 'manager', 'warehouse', 'accounting', 'admin'])
    for (const r of roles) expect(valid.has(r)).toBe(true)
    // vsak dogodek ima vsaj eno vlogo (ne prazna vrstica)
    expect(roles.size).toBeGreaterThan(3)
  })
  test('applyRoleTemplate: en klik → mode roles za vse dogodke + gumb v UI', () => {
    expect(ops).toContain('const applyRoleTemplate = () => {')
    expect(ops).toContain("mode: 'roles' as NotifMode, roles: [...(NOTIF_ROLE_TEMPLATE[ev] || ['manager'])]")
    expect(ops).toContain("onClick={applyRoleTemplate}")
    expect(ops).toContain("notif.templateBtn")
  })
  test('kuhinja dobi naročila, skladišče zaloge, računovodstvo finance (smiselnost)', () => {
    const m = ops.match(/ORDER_NEW: \[([^\]]+)\]/)
    expect(m![1]).toContain("'kitchen'")
    const m2 = ops.match(/LOW_STOCK: \[([^\]]+)\]/)
    expect(m2![1]).toContain("'warehouse'")
    const m3 = ops.match(/AP_NEW: \[([^\]]+)\]/)
    expect(m3![1]).toContain("'accounting'")
    const m4 = ops.match(/MANAGER_CALL: \[([^\]]+)\]/)
    expect(m4![1]).toContain("'manager'")
  })
})
