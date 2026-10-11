/**
 * Testi offline odpornosti gostujočih naprav (Task 53 — display/kiosk 24/7).
 *
 * Zidni display in kiosk sta 24/7 napravi: ob odpovedi omrežja NE smeta
 * zamrzniti tiho. Statična regresija (vzorec Task 50/52) pin:
 *  - display: povratni odmik (backoff), zastarel indikator, `online` listener,
 *    ločnica 4xx (poslovna napaka, brez zastaranja) vs 5xx/omrežje;
 *  - kiosk: samodejni ponovni poskusi menija (omejeni), `online` listener,
 *    ustavitev poskusov ob poslovni napaki;
 *  - i18n: novi ključi v OBAH slovarjih (SL + HR pariteta, neprazni);
 *  - QR stran (m/[token]) — obstoječa robustnost ostane (regresija).
 *
 * Vzorec: branje izvorne kode (statično) — nasporedno vedenje ( časovniki)
 * ni deterministično v testnem runnerju; logika je pinana na prisotnost
 * konstruktov + tipovna čistost (tsc) + živa browser verifikacija.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = join(import.meta.dir, '..')
const display = readFileSync(join(ROOT, 'src/app/display/page.tsx'), 'utf-8')
const kiosk = readFileSync(join(ROOT, 'src/app/kiosk/page.tsx'), 'utf-8')
const qr = readFileSync(join(ROOT, 'src/app/m/[token]/page.tsx'), 'utf-8')

describe('display — offline odpornost (Task 53)', () => {
  test('povratni odmik: eksponentni backoff z zgornjo mejo', () => {
    expect(display).toContain('MAX_BACKOFF_MS')
    expect(display).toContain('2 ** Math.min(')
    // vrednosti: 2000 · 2^min(n,3), zgornja meja 15000
    expect(display).toMatch(/POLL_MS = 2000/)
    expect(display).toMatch(/MAX_BACKOFF_MS = 15000/)
    expect(display).toMatch(/STALE_AFTER = 3/)
  })

  test('zastarel indikator: banner nad podatki, ne lažno stanje', () => {
    // catch NE briše zadnjih podatkov (state ostane) — samo poveča zaporedje
    expect(display).toContain('failStreak.current += 1')
    expect(display).toContain('setStale(true)')
    // banner: aria-live + ključ stale
    expect(display).toContain('aria-live="polite"')
    expect(display).toContain("t('guest.display.stale')")
    // uspeh povrne: streak reset + stale false
    expect(display).toContain('failStreak.current = 0')
    expect(display).toContain('setStale(false)')
  })

  test('ločnica poslovnih napak: 4xx NE šteje kot zastaranje', () => {
    // 5xx → zaporedje; 4xx → samo sporočilo
    expect(display).toContain('res.status >= 500')
  })

  test('dogodek online: takojšnja obnovitev + zaščita pred dvojno zanko', () => {
    expect(display).toContain("window.addEventListener('online'")
    expect(display).toContain("window.removeEventListener('online'")
    // generacijska varovalka — online med letom ne sme podvojiti pollanja
    expect(display).toContain('gen !== my')
    // cleanup v unmount
    expect(display).toMatch(/cancelled = true/)
  })
})

describe('kiosk — samodejni ponovni poskus menija (Task 53)', () => {
  test('omejeni samodejni poskusi ob odpovedi omrežja', () => {
    expect(kiosk).toMatch(/RETRY_MS = 5000/)
    expect(kiosk).toMatch(/MAX_RETRIES = 6/)
    expect(kiosk).toContain('retryAttempts.current = attempt')
    expect(kiosk).toContain('setTimeout(() => loadMenu(tok), RETRY_MS)')
    // ključ za samodejni poskus uporabljen v sporočilu
    expect(kiosk).toContain("t('guest.kiosk.autoRetry')")
  })

  test('poslovna napaka ustavi poskuse (brez ponavljanja)', () => {
    // !res.ok → stopRetry() (kiosk ni aktiviran — ponavljanje ne pomaga)
    expect(kiosk).toContain('stopRetry()')
    expect(kiosk).toMatch(/function stopRetry/)
  })

  test('dogodek online: takojšen poskus, če meni še ni naložen', () => {
    expect(kiosk).toContain("window.addEventListener('online'")
    expect(kiosk).toContain("window.removeEventListener('online'")
    // poskus samo, če meni NI naložen (ne zabliska že delujoč kiosk)
    expect(kiosk).toContain('if (tok && !menu)')
    // cleanup: časovnik + listener
    expect(kiosk).toMatch(/clearTimeout\(retryTimer\.current\)/)
  })
})

describe('i18n — ključi offline odpornosti (SL + HR pariteta)', () => {
  const KEYS = ['guest.display.stale', 'guest.kiosk.autoRetry'] as const

  test('ključi obstajajo v obeh slovarjih, neprazni, HR se razlikuje od SL', () => {
    for (const k of KEYS) {
      const slV = (sl as Record<string, string>)[k]
      const hrV = (hr as Record<string, string>)[k]
      expect(typeof slV).toBe('string')
      expect(typeof hrV).toBe('string')
      expect(slV!.trim().length).toBeGreaterThan(0)
      expect(hrV!.trim().length).toBeGreaterThan(0)
      expect(hrV).not.toBe(slV)
    }
  })

  test('pariteta sekcij guest.* ohranjena (novi ključi v obeh setih)', () => {
    const pref = (d: Record<string, string>) =>
      Object.keys(d).filter((k) => k.startsWith('guest.')).sort()
    expect(pref(hr as Record<string, string>)).toEqual(pref(sl as Record<string, string>))
  })
})

describe('QR stran — obstoječa offline robustnost (regresija, Task 53 ne poslabša)', () => {
  test('m/[token] še ima online/offline poslušalca + tiho ponavljanje statusa', () => {
    expect(qr).toContain("window.addEventListener('online'")
    expect(qr).toContain("window.addEventListener('offline'")
    expect(qr).toContain("t('guest.error.unreachableRetry')")
  })
})
