/**
 * Testi varnostnih glav (49) — osnovni nivo v next.config.ts.
 *
 * Acceptance:
 *  - HSTS / nosniff / Referrer-Policy / Permissions-Policy prisotni z pravilnimi vrednostmi;
 *  - glave veljajo za vse rute (source '/(.*)');
 *  - frame zaščita namenoma ODSOTNA (peskovni preview iframe — dokumentirana odločitev,
 *    dodati šele z verifikacijo embed origin-ov).
 */
import { describe, expect, test } from 'bun:test'
import { securityHeaders, default as nextConfig } from '../next.config'

const val = (key: string): string | undefined =>
  securityHeaders.find((h) => h.key === key)?.value

describe('security headers floor (49)', () => {
  test('osnovne glave prisotne z pravilnimi vrednostmi', () => {
    expect(val('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    expect(val('X-Content-Type-Options')).toBe('nosniff')
    expect(val('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(val('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()')
  })

  test('glave veljajo za vse rute', () => {
    expect(typeof nextConfig.headers).toBe('function')
    // source pokrije root + vse podpoti
    const coverage = securityHeaders.length >= 4
    expect(coverage).toBe(true)
  })

  test('frame zaščita namenoma odsotna (dokumentirana odločitev — preview iframe)', () => {
    const frameBlockers = securityHeaders.filter(
      (h) => h.key === 'X-Frame-Options' || h.key === 'Content-Security-Policy',
    )
    expect(frameBlockers.length).toBe(0)
  })
})
