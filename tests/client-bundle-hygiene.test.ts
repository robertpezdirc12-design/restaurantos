import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * OPS-2 (v1.66.0) — client bundle higiena.
 *
 * Incident: `dashboard/page.tsx` ('use client') je uvažal APP_VERSION iz
 * `@/lib/api` — strežniškega modula, ki prek uvozne verige api.ts → auth.ts v
 * produkciji (NODE_ENV=production) zawrel client bundle. auth.ts module-scope
 * fail-closed preverba (APP_SECRET, issue #4 §15) je v brskalniku vržla napako
 * že ob inicializaciji modula → error boundary "Ups — prišlo je do napake" za
 * VSE uporabnike takoj po prijavi (dev je delal, ker je tam APP_SECRET
 * fallback dovoljen — zato E2E na devu napake ni videl).
 *
 * Ta test zaklene razred napake statično (brez DB):
 *  1. Noben 'use client' modul ne sme uvažati strežniških libov
 *     (api/auth/tenant/db/audit-chain — vsi dosežejo Prisma db ali auth throw).
 *  2. APP_VERSION/APP_COMMIT živita izključno v client-safe '@/lib/version'
 *     (brez uvozov); api.ts ju samo pre-eksportira (server back-compat).
 *  3. dashboard/page.tsx uvaža APP_VERSION iz '@/lib/version'.
 */

const SRC = join(import.meta.dir, '..', 'src')

/** Strežniški libovi: module-scope throw (auth) ali Prisma db dostop. */
const FORBIDDEN_FOR_CLIENT = [
  '@/lib/api',
  '@/lib/auth',
  '@/lib/tenant',
  '@/lib/db',
  '@/lib/audit-chain',
]

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walkTs(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function isClientModule(src: string): boolean {
  return /^['"]use client['"]/m.test(src.slice(0, 300))
}

describe('OPS-2 client bundle higiena (sk68-)', () => {
  test('noben "use client" modul ne uvaža strežniških libov (api/auth/tenant/db/audit-chain)', () => {
    const offenders: string[] = []
    for (const file of walkTs(SRC)) {
      const src = readFileSync(file, 'utf8')
      if (!isClientModule(src)) continue
      for (const mod of FORBIDDEN_FOR_CLIENT) {
        const re = new RegExp(`from ['"]${mod}['"]`)
        if (re.test(src)) offenders.push(`${file.replace(SRC + '/', '')} → ${mod}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('APP_VERSION/APP_COMMIT živita izključno v client-safe version.ts (brez uvozov)', () => {
    const version = readFileSync(join(SRC, 'lib', 'version.ts'), 'utf8')
    expect(version).toMatch(/export const APP_VERSION = '\d+\.\d+\.\d+'/)
    expect(version).toMatch(/export const APP_COMMIT = /)
    // version.ts je client-safe: brez kakršnihkoli uvozov
    expect(version).not.toMatch(/^import /m)
    expect(version).not.toMatch(/from ['"]@\//)
  })

  test('api.ts ne definira več literalov — samo pre-eksport iz version.ts (server back-compat)', () => {
    const api = readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8')
    // literalna definicija je IZGINILA (prej: export const APP_VERSION = '…')
    expect(api).not.toMatch(/export const APP_VERSION =/)
    expect(api).not.toMatch(/export const APP_COMMIT =/)
    expect(api).toMatch(/export \{ APP_VERSION, APP_COMMIT \} from '@\/lib\/version'/)
  })

  test('dashboard/page.tsx (use client) uvaža APP_VERSION iz @/lib/version', () => {
    const dash = readFileSync(join(SRC, 'app', 'dashboard', 'page.tsx'), 'utf8')
    expect(dash).toMatch(/import \{ APP_VERSION \} from '@\/lib\/version'/)
    expect(dash).not.toMatch(/import \{ APP_VERSION \} from '@\/lib\/api'/)
  })

  test('health route (server) še vedno bere verzijo prek api.ts (server back-compat)', () => {
    const health = readFileSync(join(SRC, 'app', 'api', 'health', 'route.ts'), 'utf8')
    expect(health).toMatch(/from '@\/lib\/api'/)
  })
})
