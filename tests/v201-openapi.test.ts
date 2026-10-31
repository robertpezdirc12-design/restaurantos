/**
 * OSS-5 (v1.201.0) — ODPRTA API SPECIFIKACIJA (OpenAPI 3.0.3)
 * (docs/GAP-ANALIZA-odprtokodna-konkurenca.md — kandidat OSS-5, izvor
 * OrderRestro Swagger). Deterministično, brez novih odvisnosti — spec je
 * čisti TS modul + statična ruta GET /api/openapi.
 *
 * Merila:
 *  Č1 struktura spec-a: openapi 3.0.3, info (naslov, verzija = APP_VERSION),
 *     servers, tags, securitySchemes (6 mehanizmov javne površine).
 *  Č2 POKRITOST disk → spec: rekurziven pregled src/app/api/public + /api/health
 *     + /api/sync na DISKU (živ vir resnice) — vsaka najdena ruta/metoda MORA
 *     biti v spec.paths; če kdaj nastane nova javna ruta, ta test PADE, dokler
 *     ni dokumentirana (pokritost ni zaupanje, je merjenje).
 *  Č3 OBRATNO spec → disk: vsaka pot v spec-u obstaja na disku ({t} → [t]) —
 *     spec ne sme opisovati duhov.
 *  Č4 iskrenost: vsaka operacija ima summary + description + tags + responses;
 *     spec NE vsebuje skrivnosti (prefiksi žetonov ghp_/sk_live/whsec_/pk_live)
 *     in nima poti, ki ne bi bile javne (brez /api/admin, /api/enterprise …).
 *  Č5 ruta GET /api/openapi: 200 javno, telo = spec, Cache-Control 300,
 *     info.version = APP_VERSION.
 *  Č6 verzija pin.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { NextRequest } from 'next/server'
import { OPENAPI_VERSION, buildOpenApiSpec } from '../src/lib/openapi-spec'
import { GET as openapiGET } from '../src/app/api/openapi/route'
import { APP_VERSION } from '../src/lib/version'

const API_ROOT = 'src/app/api'

/** Rekurzivno zbere vse route.ts datoteke pod dir (deterministično urejeno). */
function routeFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...routeFiles(p))
    else if (name === 'route.ts') out.push(p)
  }
  return out
}

/** Datoteka route.ts → OpenAPI pot (/api/…, [token] → {token}). */
function fileToPath(f: string): string {
  const rel = f.replace(/^src\/app/, '').replace(/\/route\.ts$/, '')
  return rel.replace(/\[([^\]]+)\]/g, '{$1}')
}

/** Iz datoteke prebere izvožene HTTP handlerje (živ vir resnice). */
function methodsOf(f: string): string[] {
  const src = readFileSync(f, 'utf8')
  const m = src.match(/export (?:async )?function (GET|POST|PATCH|PUT|DELETE)\(/g) || []
  return m.map((s) => (s.match(/(GET|POST|PATCH|PUT|DELETE)\(/) as string[])[1])
}

const SPEC = buildOpenApiSpec(APP_VERSION)
const PATHS = SPEC.paths as Record<string, Record<string, unknown>>

describe('v1.201.0 OSS-5 OpenAPI spec — Č1 struktura', () => {
  it('openapi 3.0.3, naslov, verzija = APP_VERSION, server same-origin', () => {
    expect(SPEC.openapi).toBe('3.0.3')
    expect(OPENAPI_VERSION).toBe('3.0.3')
    expect((SPEC.info as Record<string, unknown>).title).toBe('RestaurantOS Public API')
    expect((SPEC.info as Record<string, unknown>).version).toBe(APP_VERSION)
    expect(((SPEC.servers as Array<Record<string, unknown>>)[0]).url).toBe('/')
  })

  it('šest avtentikacijskih mehanizmov javne površine (QR/naprava/portal/pay/Stripe/seja)', () => {
    const schemes = (SPEC.components as Record<string, Record<string, unknown>>).securitySchemes
    for (const k of ['QrToken', 'DeviceToken', 'PortalToken', 'PayLinkToken', 'StripeSignature', 'SessionAuth']) {
      expect(schemes[k]).toBeDefined()
    }
  })
})

describe('v1.201.0 OSS-5 — Č2 pokritost disk → spec (vsaka javna ruta dokumentirana)', () => {
  it('vsaka javna ruta + metoda na disku je v spec.paths', () => {
    const files = [
      ...routeFiles(join(API_ROOT, 'public')),
      join(API_ROOT, 'health/route.ts'),
      join(API_ROOT, 'sync/route.ts'),
    ]
    expect(files.length).toBeGreaterThanOrEqual(14)
    let checked = 0
    for (const f of files) {
      const path = fileToPath(f)
      const entry = PATHS[path]
      expect({ path, defined: entry !== undefined }).toEqual({ path, defined: true })
      for (const m of methodsOf(f)) {
        expect({ path, method: m.toLowerCase(), defined: entry?.[m.toLowerCase()] !== undefined }).toEqual({
          path,
          method: m.toLowerCase(),
          defined: true,
        })
        checked++
      }
    }
    // resnična globina: 14 datotek nosi 19 handlerjev (16 javnih + health GET + sync GET/POST)
    expect(checked).toBe(19)
  })

  it('noče tihega krčenja: spec pokriva vsaj 14 poti', () => {
    expect(Object.keys(PATHS).length).toBeGreaterThanOrEqual(14)
  })
})

describe('v1.201.0 OSS-5 — Č3 obratno spec → disk (brez duhov)', () => {
  it('vsaka pot v spec-u obstaja kot route.ts na disku', () => {
    for (const path of Object.keys(PATHS)) {
      // pot v spec-u je apsolutna (/api/…) — disk pot je src/app + pot s [token] mapami
      const file = join('src/app', path.replace(/\{([^}]+)\}/g, '[$1]'), 'route.ts')
      expect({ path, exists: existsSync(file) }).toEqual({ path, exists: true })
    }
  })
})

describe('v1.201.0 OSS-5 — Č4 iskrenost in brez skrivnosti', () => {
  it('vsaka operacija ima summary, description, tags in vsaj en odgovor', () => {
    for (const [path, entry] of Object.entries(PATHS)) {
      for (const [method, op] of Object.entries(entry)) {
        const o = op as Record<string, unknown>
        expect(`${path}:${method} summary`).toBe(`${path}:${method} ${typeof o.summary === 'string' && o.summary.length > 3 ? 'summary' : 'MISSING'}`)
        expect(`${path}:${method} description`).toBe(`${path}:${method} ${typeof o.description === 'string' && (o.description as string).length > 3 ? 'description' : 'MISSING'}`)
        expect(Array.isArray(o.tags) && (o.tags as string[]).length > 0).toBe(true)
        expect(Object.keys(o.responses as Record<string, unknown>).length).toBeGreaterThan(0)
      }
    }
  })

  it('spec ne vsebuje skrivnosti (samo IMENA parametrov, nikoli vrednosti)', () => {
    const raw = JSON.stringify(SPEC)
    for (const secret of ['ghp_', 'sk_live', 'whsec_', 'pk_live', 'shpat_']) {
      expect(raw.includes(secret)).toBe(false)
    }
  })

  it('obseg je ZAKLENJEN na javno površino (brez admin/enterprise/integracijskih notranjih rut)', () => {
    for (const path of Object.keys(PATHS)) {
      expect(path.startsWith('/api/admin')).toBe(false)
      expect(path.startsWith('/api/enterprise')).toBe(false)
      expect(path.startsWith('/api/settings')).toBe(false)
    }
  })
})

describe('v1.201.0 OSS-5 — Č5 ruta GET /api/openapi', () => {
  it('200 javno, telo = spec, Cache-Control 300, verzija = APP_VERSION', async () => {
    const req = new NextRequest('http://localhost:3000/api/openapi')
    const res = await openapiGET(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.openapi).toBe('3.0.3')
    expect((body.info as Record<string, unknown>).version).toBe(APP_VERSION)
    expect(Object.keys(body.paths as Record<string, unknown>).length).toBeGreaterThanOrEqual(14)
  })
})

describe('v1.201.0 — Č6 verzija', () => {
  it('APP_VERSION je 1.210.0', () => {
    expect(APP_VERSION).toBe('1.210.0')
  })
})
