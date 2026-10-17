/**
 * ISSUE #72 (v1.133.0) — P0 model dovoljenj regresijski varovalki.
 *
 * A. KLJUČI pomenijo točno to, kar piše (D1/D2/D3/D4):
 *   - storno rute varuje 'receipts.storno' (ne 'furs.issue')
 *   - izdaja e-računa varuje 'einvoices.issue' (ne 'inventory.manage' — skladiščnik!)
 *   - CRM varuje 'guests.read', napitnine 'reports.labour', poročila 'reports.sales'
 *   - phantom 'orders.discount' in stari 'reports.view'/'furs.issue' so ODSTRANJENI
 * B. C1/C2/C3 (ravni in stropovi):
 *   - manager NIMA settings.manage/receipts.storno/einvoices.issue po vlogi
 *   - ustvarjanje MANAGER vloge + dodeljevanje stropov = centralno-only (rute)
 *   - denarna politika PUT /api/settings = centralno-only
 * C. B1/B2 (lokacija):
 *   - operativne vloge ZAHTEVAJOJO lokacijo ob ustvarjanju (route varovalka)
 *   - UI banner obstaja (page.tsx) za uporabnika brez lokacije
 * D. A1/A2 (efektivni nabor):
 *   - dialog izrisuje brane pravice vloge (disabled) + odstranljive dodatke
 *   - besedilo additivnosti obstaja (i18n SL/HR)
 * E. A3/A4 (enoten vzorec):
 *   - ukazna paleta uporablja isManagerialRole (OWNER vključen!)
 *   - finance-tab vsebino gradi hasPerm (ne seznam vlog) — prek page.tsx props
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(import.meta.dir, p), 'utf-8')
const dash = () => read('../src/app/dashboard/page.tsx')
const perms = () => read('../src/lib/permissions.ts')

describe('issue #72 D — ključi pomenijo to, kar piše (rute)', () => {
  test('D1: storno rute varuje receipts.storno (ne furs.issue)', () => {
    const r = read('../src/app/api/receipts/[id]/storno/route.ts')
    expect(r).toContain("requirePermission(req, 'receipts.storno')")
    expect(r).not.toContain("'furs.issue'")
  })

  test('D2: izdaja e-računa varuje einvoices.issue (skladiščnik NE sme izdati fiskalnega dokumenta)', () => {
    const r = read('../src/app/api/einvoices/issue/route.ts')
    expect(r).toContain("requirePermission(req, 'einvoices.issue')")
    expect(r).not.toContain("requirePermission(req, 'inventory.manage')")
  })

  test('D3: CRM gostov varuje guests.read; napitnine reports.labour; finance reports.sales', () => {
    expect(read('../src/app/api/crm/guests/route.ts')).toContain("requirePermission(req, 'guests.read')")
    expect(read('../src/app/api/crm/segments/route.ts')).toContain("requirePermission(req, 'guests.read')")
    expect(read('../src/app/api/tips/route.ts')).toContain("requirePermission(req, 'reports.labour')")
    expect(read('../src/app/api/reports/financial/route.ts')).toContain("requirePermission(req, 'reports.sales')")
    expect(read('../src/app/api/reports/labor-cost/route.ts')).toContain("requirePermission(req, 'reports.labour')")
    // TAB_PERM: crm → guests.read, napitnine → reports.labour, racuni → reports.sales
    const tp = read('../src/lib/tab-permissions.ts')
    expect(tp).toContain("crm: 'guests.read'")
    expect(tp).toContain("napitnine: 'reports.labour'")
    expect(tp).toContain("racuni: 'reports.sales'")
  })

  test('D4: phantom ključi so odstranjeni iz kanonskega seznama (samo CANONICAL blok, ne dokumentacija)', () => {
    const p = perms()
    const a = p.indexOf('export const CANONICAL_PERMISSIONS = [')
    const b = p.indexOf('] as const', a)
    const block = p.slice(a, b)
    expect(block).not.toContain("'orders.discount'")
    expect(block).not.toContain("'furs.issue'")
    expect(block).not.toContain("'reports.view'")
  })
})

describe('issue #72 C1/C2/C3 — ravni vlog in stropovi (rute)', () => {
  test('C1: MANAGER nima settings.manage, receipts.storno, einvoices.issue po vlogi', () => {
    // permissions-core.test.ts pokriva nabor unitno; tu SOURCE varovalka matrice
    const p = perms()
    const m = p.indexOf('manager: [')
    const seg = p.slice(m, p.indexOf('],', m))
    expect(seg).not.toContain('settings.manage')
    expect(seg).not.toContain('receipts.storno')
    expect(seg).not.toContain('einvoices.issue')
  })

  test('C2: ustvarjanje MANAGER vloge je centralno-only (POST + PATCH)', () => {
    const post = read('../src/app/api/employees/route.ts')
    expect(post).toContain("const PRIVILEGED_ROLES = ['OWNER', 'ADMIN', 'MANAGER', ...ENTERPRISE_ROLES]")
    const patch = read('../src/app/api/employees/[id]/route.ts')
    expect(patch).toContain("if (role === 'MANAGER' && !isCentralRole(user))")
    expect(patch).toContain("Dodeljevanje dovoljenj employees.manage in settings.manage je rezervirano")
  })

  test('C2: dodeljevanje stropov (employees.manage/settings.manage) = ODVZEM dovoljen, DODATEK centralno', () => {
    const patch = read('../src/app/api/employees/[id]/route.ts')
    expect(patch).toContain("const addingPrivileged = valid.some((p) =>")
    expect(patch).toContain("!targetExisting.includes(p)")
  })

  test('C3: denarna politika (tolerance/izjeme/blagajna) = centralno-only na PUT /api/settings', () => {
    const r = read('../src/app/api/settings/route.ts')
    expect(r).toContain('const POLICY_COLUMNS = new Set<string>([')
    expect(r).toContain('touchesPolicy && !isCentralRole(user)')
    expect(r).toContain('rezervirano za OWNER ali ADMIN')
  })
})

describe('issue #72 B — lokacija ni tiha praznina', () => {
  test('B2: operativne vloge zahtevajo lokacijo ob ustvarjanju (route varovalka)', () => {
    const r = read('../src/app/api/employees/route.ts')
    expect(r).toContain("const OPERATIVE_ROLES = ['WAITER', 'BAR', 'KITCHEN', 'CHEF', 'CLEANER', 'MANAGER']")
    expect(r).toContain('Operativna vloga zahteva dodeljeno lokacijo')
  })

  test('B1: UI banner za uporabnika brez lokacije (page.tsx)', () => {
    const d = dash()
    expect(d).toContain('data-region="no-location-banner"')
    expect(d).toContain("t('emp.noLocTitle')")
    expect(d).toContain('role="alert"')
  })

  test('B4: neznana vloga = fail-closed PRAZEN nabor (padec na staff je odstranjen)', () => {
    const p = perms()
    expect(p).toContain('return ROLE_DEFAULTS[(role || \'\').toLowerCase()] ?? []')
    expect(p).not.toContain('ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.staff')
  })
})

describe('issue #72 A1/A2 — efektivni nabor v dialogu zaposlenih', () => {
  test('A1: dialog ločena vira — pravice vloge ZAKLENJENE, dodatki odstranljivi', () => {
    const d = dash()
    expect(d).toContain('(empEffective.fromRole as readonly string[]).includes(perm)')
    expect(d).toContain('disabled={fromRole || cantGrant}')
    expect(d).toContain("t('emp.permFromRoleTag')")
    expect(d).toContain("t('emp.permsSummary'")
  })

  test('A2: besedilo additivnosti obstaja v SL in HR', () => {
    const sl = read('../src/lib/i18n/sl.ts')
    expect(sl).toContain("'emp.permsSummary'")
    expect(sl).toContain('pravic vloge ni mogoče odvzeti')
    const hr = read('../src/lib/i18n/hr.ts')
    expect(hr).toContain("'emp.permsSummary'")
    expect(hr).toContain('prava uloge nije moguće oduzeti')
  })
})

describe('issue #72 A3/A4 — enoten vzorec presoje', () => {
  test('A4: ukazna paleta uporablja isManagerialRole iz permissions (OWNER vključen)', () => {
    const cp = read('../src/components/command-palette.tsx')
    expect(cp).toContain("const canManage = (role?: string) => isManagerialRole(role)")
    expect(cp).toContain("import { isManagerialRole } from '@/lib/permissions'")
    expect(cp).not.toContain("role === 'ADMIN' || role === 'MANAGER'")
  })

  test('A4: en vir resnice — exception-approval re-izvaža permissions.ts', () => {
    const ea = read('../src/lib/exception-approval.ts')
    expect(ea).toContain("from '@/lib/permissions'")
    expect(ea).not.toContain("'MANAGER', 'ADMIN', 'OWNER', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER',\n] as const")
  })

  test('A3: ShiftsTab vsebino gradi hasPerm(cash.manage), ne seznam vlog', () => {
    const d = dash()
    expect(d).toContain("<ShiftsTab shifts={shifts} financial={financial} canManage={hasPerm('cash.manage')}")
    // C1: canManage je centralen (OWNER/ADMIN); manager vidi zavihke SKOZ pravice
    expect(d).toContain('const canManage = isCentralUIRole(user?.role)')
    expect(d).toContain('const hasPerm = (p?: string) => !!p && perms.includes(p)')
  })
})

describe('issue #72 E5 — seznam zaposlenih: manjkajoča lokacija je RDEČA', () => {
  test('E5: brez lokacije = vidna rdeča oznaka, ne tiha praznina', () => {
    const d = dash()
    expect(d).toContain("t('emp.noLocation')")
    expect(d).toContain('text-red-600 flex items-center gap-0.5 font-medium')
  })
})
