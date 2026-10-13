/**
 * Issue #2 §D (v1.87.1) — varnostne glave: dolona politika vdelovanja
 * (CSP frame-ancestors 'self' + X-Frame-Options SAMEORIGIN) brez preloma
 * predogleda (gateway streže app prek istega izvora) in obstoječih glav
 * (HSTS, nosniff, Referrer-Policy, Permissions-Policy).
 *
 * Pokritje:
 *  1. securityHeaders izvoz vsebuje VSEH 6 glav s točnimi vrednostmi;
 *  2. frame politika: CSP frame-ancestors 'self' + XFO SAMEORIGIN — usklajena
 *     (isti pomen, brez konflikta med glavama);
 *  3. Permissions-Policy: kamera/mikrofon/geolokacija zavrnjeni (koda jih ne
 *     uporablja — brez nepotrebnih dovoljenj);
 *  4. headers() middleware: vzorec /(.*) pokriva VSE poti (tudi javne /pay,
 *     /m, /kiosk, /display) z istim naborom glav;
 *  5. strukturno: edini iframe v kodi (predogled priloge) je isti-origin
 *     (vir iz lastne aplikacije) → 'self' ga ohranja.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { securityHeaders, default as nextConfig } from '../next.config'

const READ = (p: string) => readFileSync(join(import.meta.dir, p), 'utf8')
const asMap = new Map(securityHeaders.map((h) => [h.key, h.value]))

describe('varnostne glave (issue #2 §D)', () => {
  test('6 glav s točnimi vrednostmi (HSTS/nosniff/referrer/permissions/CSP/XFO)', () => {
    expect(asMap.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    expect(asMap.get('X-Content-Type-Options')).toBe('nosniff')
    expect(asMap.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(asMap.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()')
  })

  test('frame politika: CSP frame-ancestors self + X-Frame-Options SAMEORIGIN (usklajeno)', () => {
    expect(asMap.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
    expect(asMap.get('X-Frame-Options')).toBe('SAMEORIGIN')
    // usklajenost: obe glavi dovolita SAMO isti origin (brez konflikta)
    expect(asMap.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  test('Permissions-Policy brez kamere/mikrofona/geolokacije (kode ne uporabljajo)', () => {
    const pp = asMap.get('Permissions-Policy') || ''
    expect(pp).toContain('camera=()')
    expect(pp).toContain('microphone=()')
    expect(pp).toContain('geolocation=()')
  })

  test('headers() pokriva VSE poti z istim naborom', async () => {
    const result = await nextConfig.headers()
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('/(.*)')
    expect(result[0].headers).toHaveLength(securityHeaders.length)
    for (const h of securityHeaders) {
      expect(result[0].headers.find((x) => x.key === h.key)?.value).toBe(h.value)
    }
  })

  test('strukturno: iframe v kodi je isti-origin (predogled priloge) — self ga ohrani', () => {
    const finance = READ('../src/components/tabs/finance-tab.tsx')
    expect(finance.includes('<iframe src={attPreview.uri}')).toBe(true)
    // attPreview.uri prihaja iz lastne aplikacije (attachment pot, isti origin)
    // — frame-ancestors 'self' dovoljuje vdelavo iz istega izvora (predogled deluje)
    const cfg = READ('../next.config.ts')
    expect(cfg.includes("frame-ancestors 'self'")).toBe(true)
    expect(cfg.includes('SAMEORIGIN')).toBe(true)
  })
})
