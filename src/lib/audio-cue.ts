/**
 * OSS-15 (v1.201.0) — Zvočna potrditev plačila (OrderRestro UPI-UX vzorec,
 * glej docs/GAP-ANALIZA-odprtokodna-konkurenca.md): ko je plačilo POTRJENO
 * (fiskalni račun izdan), naprava osebja odigra kratek "di-dii" — natakar
 * sliši potrditev brez gledanja v zaslon (gostilna je hrupna).
 *
 * Hišna vzporednica: OPS-4 KDS zvok ob novem čakajočem artiklu (enojni 880 Hz
 * pisk v dashboard page — inline, brez lib). Ta modul je LOČEN in ČIST:
 *  - brez uvozov (varen za client bundle — vzorec floor-plan.ts),
 *  - vse stranske odvisnosti so INJEKTIRANE (audio tovarna, shramba,
 *    razporejevalnik) → deterministično testaben brez pravega WebAudio-ja,
 *  - konfiguracija na NAPRAVO (localStorage `ro_payment_cue`) — zvok je
 *    želja naprave, ne vloge; privzeto VKLOPLJEN.
 *
 * Deterministično pravilo: zvok je NIKOLI kritičen — vsaka napaka se pogoltne
 * (return false); plačilni tok ne sme pasti zaradi zvoka.
 */

/** localStorage ključ nastavitve na napravi ('1' = vklopljeno, '0' = izklopljeno). */
export const PAYMENT_CUE_LS_KEY = 'ro_payment_cue'

/** En ton znaka: frekvenca (Hz), začetek (s od t0), trajanje (s), glasnost (0–1). */
export interface CueTone {
  freq: number
  at: number
  dur: number
  gain: number
}

/**
 * Dva NARAŠČAJOČA tona ("di-dii", E5 → E6) — po koncu plačila jasno razločljiv
 * od KDS enojnega 880 Hz piska (padajoča ločljivost: kuhinja ≠ blagajna).
 * Skupni zaključek ≈ 0,36 s — kratek, ne nadležen ob ponavljanju.
 */
export function paymentCueSchedule(): CueTone[] {
  return [
    { freq: 880, at: 0, dur: 0.12, gain: 0.08 },
    { freq: 1318.51, at: 0.16, dur: 0.2, gain: 0.08 },
  ]
}

/** Minimalen vmesnik shrambe (localStorage združljiv) — injektiraj v testih. */
export interface CueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Ali je zvočna potrditev na tej napravi vklopljena? Privzeto TRUE (prazna /
 * manjkajoča / neveljavna vrednost / brez shrambe = vklopljeno — izklop je
 * izrecno dejanje '0').
 */
export function getPaymentCueEnabled(storage?: CueStorage): boolean {
  const ls = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!ls) return true
  try {
    const raw = ls.getItem(PAYMENT_CUE_LS_KEY)
    if (raw === null) return true
    return raw !== '0'
  } catch {
    return true
  }
}

/** Shrani nastavitev na napravi (neuspeh = tiho — zvok ni kritičen). */
export function setPaymentCueEnabled(enabled: boolean, storage?: CueStorage): void {
  const ls = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!ls) return
  try {
    ls.setItem(PAYMENT_CUE_LS_KEY, enabled ? '1' : '0')
  } catch {
    /* brez shrambe — velja do osvežitve */
  }
}

/** Minimalen WebAudio kontekst (prava implementacija ga zadovolji; fake v testih). */
export interface CueAudioContextLike {
  currentTime: number
  state?: string
  resume?: () => Promise<void> | void
  destination: unknown
  createOscillator(): {
    frequency: { value: number }
    connect(node: unknown): void
    start(when?: number): void
    stop(when?: number): void
  }
  createGain(): {
    gain: { value: number }
    connect(node: unknown): void
  }
  close(): Promise<void> | void
}

export type CueAudioFactory = () => CueAudioContextLike | null

export interface PlayPaymentCueOptions {
  /** Tovarna audio konteksta (privzeto window.AudioContext / webkitAudioContext). */
  factory?: CueAudioFactory
  /** Shramba za nastavitev (privzeto localStorage). */
  storage?: CueStorage
  /** Razporejevalnik zaključka (privzeto setTimeout — testi ga zamenjajo z takojšnjim). */
  schedule?: (fn: () => void, ms: number) => void
}

/** Privzeta tovarna iz brskalnika — null v Node/SSR (tam zvok ni možen). */
function defaultAudioFactory(): CueAudioFactory | null {
  if (typeof window === 'undefined') return null
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  return () => new Ctx() as unknown as CueAudioContextLike
}

/**
 * Predvajaj zvočno potrditev plačila na tej napravi.
 * Vrne true, če je znak res predvajan (vklopljeno + audio na voljo); v nasprotnem
 * primeru false — NIKOLI ne meče napake (plačilni tok je nad zvokom).
 */
export function playPaymentCue(opts: PlayPaymentCueOptions = {}): boolean {
  if (!getPaymentCueEnabled(opts.storage)) return false
  const factory = opts.factory ?? defaultAudioFactory()
  let ctx: CueAudioContextLike | null = null
  try {
    ctx = factory ? factory() : null
  } catch {
    return false
  }
  if (!ctx) return false
  try {
    if (ctx.state === 'suspended' && ctx.resume) {
      // prvi uporabniški klik (prijava) je kontekst že odprl; resume je le varovalka
      void ctx.resume()
    }
    const t0 = ctx.currentTime + 0.02
    let lastEnd = 0
    for (const tone of paymentCueSchedule()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = tone.freq
      gain.gain.value = tone.gain
      osc.start(t0 + tone.at)
      osc.stop(t0 + tone.at + tone.dur)
      lastEnd = Math.max(lastEnd, tone.at + tone.dur)
    }
    const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    schedule(() => {
      try {
        void ctx?.close()
      } catch {
        /* nič kritičnega */
      }
    }, Math.ceil((0.02 + lastEnd) * 1000) + 40)
    return true
  } catch {
    return false
  }
}
