/**
 * Čakalna lista (GitLab issue #1, triage ⑤) — čista logika (brez DB/IO).
 *
 * Kanonični tok: prijava gosta (status 'waiting', checkedInAt) → obvestilo
 * ('notified', notifiedAt) → usaditev ('seated', seatedAt + tableId +
 * actualWaitMinutes izračunan) ali odhod ('left', leftAt). Usaditev zaklene
 * mizo (Table.status='occupied') v isti transakciji.
 *
 * Zaprt seznam stanj z zaprtimi prehodi (brez shematskih sprememb, §18 —
 * model WaitlistEntry že obstaja; status je freeform String):
 *
 *   waiting ──→ notified ──→ seated
 *      │             │
 *      └────→ left ←─┘
 *
 * - 'seated' in 'left' sta terminalna (brez prehodov naprej).
 * - actualWaitMinutes = minute med checkedInAt in seatedAt (→ 0, če negativno).
 * - Idempotenca ni potrebna (prijava je človeški klik brez dvojnih vnosov
 *   prek onemogočenega gumba); varnost dajeta zahtevano ime + validacija.
 */

export const WAITLIST_STATUSES = ['waiting', 'notified', 'seated', 'left'] as const
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]

export const WAITLIST_STATUS_LABELS: Record<WaitlistStatus, string> = {
  waiting: 'Čaka',
  notified: 'Obveščen',
  seated: 'Usajen',
  left: 'Odhod',
}

/** Aktivni statusi (seznam, ki ga gost še zaseda) */
export const WAITLIST_ACTIVE_STATUSES: readonly WaitlistStatus[] = ['waiting', 'notified']

/** Terminalna stanja */
export function isTerminalWaitlistStatus(s: string): boolean {
  return s === 'seated' || s === 'left'
}

/** Zaprti prehodi: waiting/notified → seated/left; waiting → notified */
const TRANSITIONS: Record<string, readonly string[]> = {
  waiting: ['notified', 'seated', 'left'],
  notified: ['seated', 'left'],
  seated: [],
  left: [],
}

/** Ali je prehod dovoljen? */
export function canTransition(from: string, to: string): boolean {
  if (from === to) return false
  return (TRANSITIONS[from] ?? []).includes(to)
}

/** Napaka prehoda v slovenščini ali null, če je dovoljen */
export function transitionError(from: string, to: string): string | null {
  if (!WAITLIST_STATUSES.includes(to as WaitlistStatus)) return `Neznan status: ${to}.`
  if (!WAITLIST_STATUSES.includes(from as WaitlistStatus)) return `Neznano trenutno stanje: ${from}.`
  if (from === to) return `Vnos je že v stanju ${WAITLIST_STATUS_LABELS[from as WaitlistStatus]}.`
  if (!canTransition(from, to)) {
    if (isTerminalWaitlistStatus(from)) {
      return `Vnos je že zaključen (${WAITLIST_STATUS_LABELS[from as WaitlistStatus]}) — prehod ni mogoč.`
    }
    return `Prehod ${WAITLIST_STATUS_LABELS[from as WaitlistStatus]} → ${WAITLIST_STATUS_LABELS[to as WaitlistStatus]} ni dovoljen.`
  }
  return null
}

// ── Validacija vnosa ─────────────────────────────────────────────────────────

export interface WaitlistInput {
  guestName: string
  guestPhone?: string
  partySize: number
  quotedWaitMinutes?: number
  preferredArea?: string
  specialNeeds?: string
  notes?: string
}

export interface ValidatedWaitlistInput {
  guestName: string
  guestPhone: string
  partySize: number
  quotedWaitMinutes: number
  preferredArea: string
  specialNeeds: string
  notes: string
}

const MAX_NAME = 120
const MAX_TEXT = 300
const MAX_PARTY = 30
const MAX_QUOTE = 600

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max)

/** Validacija prijave — napake v slovenščini; ok → normalizirana vrednost. */
export function validateEntryInput(
  input: unknown,
): { ok: true; value: ValidatedWaitlistInput } | { ok: false; error: string } {
  const b = (input ?? {}) as Record<string, unknown>
  const guestName = clean(b.guestName, MAX_NAME)
  if (!guestName) return { ok: false, error: 'Ime gosta je obvezno.' }

  const partySize = Number(b.partySize)
  if (!Number.isInteger(partySize) || partySize < 1) return { ok: false, error: 'Število oseb mora biti celo število vsaj 1.' }
  if (partySize > MAX_PARTY) return { ok: false, error: `Število oseb presega dovoljeno mejo (${MAX_PARTY}).` }

  const rawQuote = b.quotedWaitMinutes
  let quoted = 0
  if (rawQuote !== undefined && rawQuote !== null && rawQuote !== '') {
    quoted = Math.round(Number(rawQuote))
    if (!Number.isFinite(quoted) || quoted < 0) return { ok: false, error: 'Napovedani čas čakanja mora biti ne negativno število minut.' }
    if (quoted > MAX_QUOTE) return { ok: false, error: `Napovedani čas presega dovoljeno mejo (${MAX_QUOTE} min).` }
  }

  return {
    ok: true,
    value: {
      guestName,
      guestPhone: clean(b.guestPhone, 40),
      partySize,
      quotedWaitMinutes: quoted,
      preferredArea: clean(b.preferredArea, 60),
      specialNeeds: clean(b.specialNeeds, MAX_TEXT),
      notes: clean(b.notes, MAX_TEXT),
    },
  }
}

// ── Čas čakanja ──────────────────────────────────────────────────────────────

/** Dejanske minute čakanja med prijavo in usaditvijo (→ 0, če negativno/neveljavno). */
export function actualWaitMinutes(checkedInAt: Date | string, seatedAt: Date | string): number {
  const a = new Date(checkedInAt).getTime()
  const s = new Date(seatedAt).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(s) || s <= a) return 0
  return Math.floor((s - a) / 60_000)
}

/** Koliko minut je gost že v čakanju (za živ prikaz). */
export function minutesWaiting(checkedInAt: Date | string, now: Date = new Date()): number {
  return actualWaitMinutes(checkedInAt, now)
}

/** Oznaka prekoračitve: dejanjsko čakanje presega napovedani čas */
export function isOverQuoted(minutesWaiting: number, quotedWaitMinutes: number): boolean {
  return Number.isFinite(minutesWaiting) && Number.isFinite(quotedWaitMinutes)
    && quotedWaitMinutes > 0 && minutesWaiting > quotedWaitMinutes
}

// ── Slovenske oznake ─────────────────────────────────────────────────────────

/** N-tev "oseba": 1 oseba, 2 osebi, 3/4 osebe, 5+ oseb */
export function partySizeLabel(n: number): string {
  const v = Math.max(0, Math.floor(n))
  if (v === 1) return '1 oseba'
  if (v === 2) return '2 osebi'
  if (v === 3 || v === 4) return `${v} osebe`
  return `${v} oseb`
}

/** Oznaka napovedanega časa: "≈ 15 min" (0 → brez napovedi) */
export function quoteLabel(minutes: number): string {
  const v = Math.max(0, Math.floor(minutes))
  return v > 0 ? `≈ ${v} min` : '—'
}

/** Kratek prikaz trajanja: 65 min → "1 h 5 min" */
export function durationLabel(minutes: number): string {
  const v = Math.max(0, Math.floor(minutes))
  if (v < 60) return `${v} min`
  return `${Math.floor(v / 60)} h ${v % 60} min`
}

// ── Statistika ───────────────────────────────────────────────────────────────

export interface WaitlistStatsRow {
  status: string
  partySize: number
  actualWaitMinutes: number
}

export interface WaitlistStats {
  waiting: number
  notified: number
  seated: number
  left: number
  waitingParty: number
  /** povprečno dejansko čakanje usajenih (minute, zaokroženo) — 0, če ni usajenih */
  avgActualWait: number
  /** najdaljše dejansko čakanje (minute) */
  maxActualWait: number
}

export function waitlistStats(rows: WaitlistStatsRow[]): WaitlistStats {
  const s: WaitlistStats = { waiting: 0, notified: 0, seated: 0, left: 0, waitingParty: 0, avgActualWait: 0, maxActualWait: 0 }
  let sum = 0
  for (const r of rows ?? []) {
    const st = String(r.status || '')
    if (st === 'waiting') {
      s.waiting += 1
      s.waitingParty += Math.max(0, Math.floor(Number(r.partySize) || 0))
    } else if (st === 'notified') s.notified += 1
    else if (st === 'seated') {
      s.seated += 1
      const w = Math.max(0, Math.floor(Number(r.actualWaitMinutes) || 0))
      sum += w
      if (w > s.maxActualWait) s.maxActualWait = w
    } else if (st === 'left') s.left += 1
  }
  if (s.seated > 0) s.avgActualWait = Math.round(sum / s.seated)
  return s
}

/* ─────────────────────────── SMS opomnik (v1.188.0, P2-14) ───────────────────────────
 *
 * Prehod waiting → notified POSKUŠA poslati SMS »vaša miza je prosta« na
 * guestPhone. Pogoji in fail-soft semantika:
 *  - brez (veljavne) številke → 'no_phone' (ni poskusa);
 *  - brez SMS konfiguracije lokacije → 'sms_unconfigured' (ni poskusa);
 *  - pošiljanje spodleti → 'failed' — prehod na 'notified' VEDNO uspe (usaditev
 *    gosta je primarno dejanje, SMS je le pomočnik; napaka SMTP/SMS ponudnika
 *    NE sme blokirati gostinca);
 *  - uspeh → 'sent'.
 * GDPR: številka je pridobljena IZKLJUČNO za ta namen ob prijavi na čakalno
 * vrsto — sporočilo je izvedba zahtevane storitve (enkratno obvestilo o mizi),
 * NE tržna komunikacija; v revizijo zapisujemo SAMO status, nikoli številko
 * ali vsebino sporočila. */

export const WAITLIST_NOTIFY_STATUSES = ['', 'sent', 'no_phone', 'sms_unconfigured', 'failed'] as const
export type WaitlistNotifyStatus = (typeof WAITLIST_NOTIFY_STATUSES)[number]

/**
 * Ali je številka uporabna za SMS? (digits ≥ 6 — ista prag pragov kot
 * sendSms v src/lib/reminders.ts; presledki/ločila so dovoljeni vnos.)
 */
export function canSmsWaitlist(phone: string): boolean {
  const digits = String(phone ?? '').replace(/\D/g, '')
  return digits.length >= 6
}

/**
 * Besedilo SMS obvestila. Lokacija določa jezik (sl privzeto; hr za HR
 * postaje — isto pravilo kot localeForLocation v crm.ts). Ime gosta je
 * vključeno, če obstaja; številka mize SAMO, če je že dodeljena (pri prehodu
 * notified mize še ni — funkcija je pripravljena tudi za ponovno pošiljanje
 * po usaditvi).
 */
export function waitlistSmsText(
  input: { guestName?: string | null; tableNumber?: number | null },
  locale: 'sl' | 'hr' = 'sl',
): string {
  const name = String(input?.guestName ?? '').trim()
  const table = Math.max(0, Math.floor(Number(input?.tableNumber) || 0))
  if (locale === 'hr') {
    const who = name ? ` ${name}` : ''
    const where = table > 0 ? ` (stol ${table})` : ''
    return `Poštovani,${who}! Vaš stol je slobodan${where}. Dobrodošli!`
  }
  const whoSl = name ? ` ${name}` : ''
  const whereSl = table > 0 ? ` (miza ${table})` : ''
  return `Pozdravljeni,${whoSl}! Vaša miza je prosta${whereSl}. Lepo vabljeni!`
}
