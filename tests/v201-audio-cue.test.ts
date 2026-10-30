/**
 * OSS-15 (v1.201.0) — ZVOČNA POTRDITEV PLAČILA
 * (docs/GAP-ANALIZA-odprtokodna-konkurenca.md — kandidat OSS-15, izvor
 * OrderRestro UPI-UX). Stalno pravilo projekta: BREZ AI modelov — čista,
 * deterministična WebAudio skripta z injektiranimi odvisnostmi.
 *
 * Merila:
 *  Č1 razpored tonov (PURE): dva NARAŠČAJOČA tona (E5 880 → E6 1318.51),
 *     drugi ton začne šele po koncu prvega, glasnosti v (0,1], deterministično
 *     (dva klica globoko enaka) — jasno razločljiv od KDS enojnega 880 Hz piska.
 *  Č2 nastavitev na napravi: privzeto VKLOPLJENO (prazno/neznano/neveljavno),
 *     izklop je izrecen '0', set zapiše '1'/'0', metajoča shramba NE meče
 *     (zvok ni kritičen — fail-open na vklopljeno).
 *  Č3 predvajanje z INJEKTIRANIM audio kontekstom: izklopljeno → false in
 *     tovarna NE poklicana; vklopljeno → true, dva oscilatorja z pravimi
 *     frekvencami, povezana veriga osc→gain→destination, start/stop v pravem
 *     vrstnem redu, resume ob 'suspended', zaključek konteksta prek
 *     injektiranega razporejevalnika; tovarna null / meče → false (nikoli ne
 *     meče); brez tovarne v Node (brez window) → false.
 *  Č4 UI žice + verzija: dashboard page vsebuje klic playPaymentCue() + toggle
 *     (payment.cueOn/cueOff), i18n ključi SL/HR paritetno, verzija pin.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import {
  PAYMENT_CUE_LS_KEY,
  getPaymentCueEnabled,
  paymentCueSchedule,
  playPaymentCue,
  setPaymentCueEnabled,
  type CueAudioContextLike,
  type CueStorage,
} from '../src/lib/audio-cue'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/** Deterministična fake shramba (Map) — vzorec drugih testov z localStorage. */
function fakeStorage(initial: Record<string, string> = {}): CueStorage & { dump(): Record<string, string> } {
  const m = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  }
}

/** Fake WebAudio kontekst — zabeleži vse dele (frekvence, verige, start/stop). */
interface FakeOsc { freq: number; started: number | null; stopped: number | null }
function fakeContext() {
  const oscs: FakeOsc[] = []
  const connects: string[] = []
  let closed = false
  let resumed = false
  const ctx: CueAudioContextLike & { oscs: FakeOsc[]; connects: string[]; isClosed(): boolean; isResumed(): boolean } = {
    currentTime: 100.5,
    state: 'running',
    destination: 'DEST',
    createOscillator: () => {
      const rec: FakeOsc = { freq: 0, started: null, stopped: null }
      oscs.push(rec)
      return {
        frequency: {
          get value() { return rec.freq },
          set value(v: number) { rec.freq = v },
        },
        connect: (node: unknown) => void connects.push(`osc→${String(node)}`),
        start: (t?: number) => { rec.started = t ?? -1 },
        stop: (t?: number) => { rec.stopped = t ?? -1 },
      }
    },
    createGain: () => ({
      gain: {
        get value() { return (ctx as { _gain?: number })._gain ?? 0 },
        set value(v: number) { (ctx as { _gain?: number })._gain = v },
      },
      connect: (node: unknown) => void connects.push(`gain→${String(node)}`),
    }),
    resume: () => { resumed = true },
    close: () => { closed = true },
    oscs,
    connects,
    isClosed: () => closed,
    isResumed: () => resumed,
  }
  return ctx
}

describe('v1.201.0 OSS-15 zvočna potrditev plačila — Č1 razpored tonov (čisti sloj)', () => {
  it('dva tona, naraščajoči frekvenci E5→E6, drugi začne šele po koncu prvega', () => {
    const tones = paymentCueSchedule()
    expect(tones.length).toBe(2)
    expect(tones[0].freq).toBe(880)
    expect(tones[1].freq).toBeGreaterThan(tones[0].freq)
    // drugi ton ne sme prekrivati prvega (jasen "di-dii", ne akord)
    expect(tones[1].at).toBeGreaterThanOrEqual(tones[0].at + tones[0].dur)
    for (const t of tones) {
      expect(t.dur).toBeGreaterThan(0)
      expect(t.gain).toBeGreaterThan(0)
      expect(t.gain).toBeLessThanOrEqual(1)
    }
  })

  it('razpored je determinističen (dva klica globoko enaka) in kratek (< 0,5 s)', () => {
    const a = paymentCueSchedule()
    const b = paymentCueSchedule()
    expect(a).toEqual(b)
    const end = Math.max(...a.map((t) => t.at + t.dur))
    expect(end).toBeLessThan(0.5)
  })
})

describe('v1.201.0 OSS-15 — Č2 nastavitev na napravi (ro_payment_cue)', () => {
  it('privzeto VKLOPLJENO (prazna shramba), izklop je izrecen 0', () => {
    const st = fakeStorage()
    expect(getPaymentCueEnabled(st)).toBe(true)
    setPaymentCueEnabled(false, st)
    expect(st.dump()[PAYMENT_CUE_LS_KEY]).toBe('0')
    expect(getPaymentCueEnabled(st)).toBe(false)
    setPaymentCueEnabled(true, st)
    expect(st.dump()[PAYMENT_CUE_LS_KEY]).toBe('1')
    expect(getPaymentCueEnabled(st)).toBe(true)
  })

  it('neznana/neveljavna vrednost pomeni vklopljeno (fail-open), metajoča shramba ne meče', () => {
    expect(getPaymentCueEnabled(fakeStorage({ [PAYMENT_CUE_LS_KEY]: 'junk' }))).toBe(true)
    expect(getPaymentCueEnabled(fakeStorage({ [PAYMENT_CUE_LS_KEY]: '' }))).toBe(true)
    const throwing: CueStorage = {
      getItem: () => { throw new Error('disk') },
      setItem: () => { throw new Error('disk') },
    }
    expect(getPaymentCueEnabled(throwing)).toBe(true)
    expect(() => setPaymentCueEnabled(false, throwing)).not.toThrow()
  })
})

describe('v1.201.0 OSS-15 — Č3 predvajanje (injektiran audio kontekst)', () => {
  it('izklopljeno → false in tovarna NE poklicana (zvok se sploh ne pripravi)', () => {
    let factoryCalls = 0
    const res = playPaymentCue({
      storage: fakeStorage({ [PAYMENT_CUE_LS_KEY]: '0' }),
      factory: () => { factoryCalls++; return null },
      schedule: () => undefined,
    })
    expect(res).toBe(false)
    expect(factoryCalls).toBe(0)
  })

  it('vklopljeno → true: dva oscilatorja z pravimi frekvencami, veriga povezana, start/stop v vrsti, close prek razporejevalnika', () => {
    const ctx = fakeContext()
    let scheduled: Array<[() => void, number]> = []
    const res = playPaymentCue({
      factory: () => ctx,
      storage: fakeStorage(),
      schedule: (fn, ms) => void scheduled.push([fn, ms]),
    })
    expect(res).toBe(true)
    expect(ctx.oscs.length).toBe(2)
    expect(ctx.oscs[0].freq).toBe(880)
    expect(ctx.oscs[1].freq).toBe(1318.51)
    // veriga: vsak osc → gain → destination (4 povezave)
    expect(ctx.connects.filter((c) => c.startsWith('osc→')).length).toBe(2)
    expect(ctx.connects.filter((c) => c === 'gain→DEST').length).toBe(2)
    // start/stop: oba začeta po t0 (currentTime + 0.02), drugi pozneje, vsak ustavljen po startu
    expect(ctx.oscs[0].started).not.toBeNull()
    expect(ctx.oscs[0].started as number).toBeGreaterThan(ctx.currentTime)
    expect(ctx.oscs[1].started as number).toBeGreaterThan(ctx.oscs[0].started as number)
    expect(ctx.oscs[0].stopped as number).toBeGreaterThan(ctx.oscs[0].started as number)
    expect(ctx.oscs[1].stopped as number).toBeGreaterThan(ctx.oscs[1].started as number)
    // zaključek konteksta je razporejen PO zadnjem tonu (ms > 360) in se izvede
    expect(scheduled.length).toBe(1)
    expect(scheduled[0][1]).toBeGreaterThan(360)
    scheduled[0][0]()
    expect(ctx.isClosed()).toBe(true)
  })

  it('suspended kontekst dobi resume (varovalka po prijavnem kliku)', () => {
    const ctx = fakeContext()
    ctx.state = 'suspended'
    const res = playPaymentCue({ factory: () => ctx, storage: fakeStorage(), schedule: () => undefined })
    expect(res).toBe(true)
    expect(ctx.isResumed()).toBe(true)
  })

  it('tovarna vrne null ali meče → false; brez tovarne v Node (brez window) → false; NIKOLI ne meče', () => {
    expect(playPaymentCue({ factory: () => null, storage: fakeStorage(), schedule: () => undefined })).toBe(false)
    expect(playPaymentCue({ factory: () => { throw new Error('audio pokvarjen') }, storage: fakeStorage(), schedule: () => undefined })).toBe(false)
    // bun test teče v Node-kompaktnem okolju brez window → privzeta tovarna je null
    expect(playPaymentCue({ storage: fakeStorage(), schedule: () => undefined })).toBe(false)
  })
})

describe('v1.201.0 OSS-15 — Č4 UI žice, i18n pariteta, verzija', () => {
  const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')

  it('dashboard klice playPaymentCue ob uspešnem plačilu in ima toggle na plačilnem dialogu', () => {
    expect(page.includes('playPaymentCue()')).toBe(true)
    expect(page.includes('getPaymentCueEnabled')).toBe(true)
    expect(page.includes('setPaymentCueEnabled')).toBe(true)
    expect(page.includes('payment.cueOn')).toBe(true)
    expect(page.includes('payment.cueOff')).toBe(true)
  })

  it('i18n ključi (integ.openapi.* + payment.cue*) obstajajo v SL in HR, neprazni in paritetni', () => {
    const keys = ['integ.openapi.title', 'integ.openapi.desc', 'integ.openapi.btn', 'payment.cueOn', 'payment.cueOff']
    for (const k of keys) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(((sl as Record<string, string>)[k] || '').length).toBeGreaterThan(3)
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
      expect(((hr as Record<string, string>)[k] || '').length).toBeGreaterThan(3)
    }
  })

  it('verzija je 1.201.0', () => {
    expect(APP_VERSION).toBe('1.201.0')
  })
})
