/**
 * P2-10b (v1.187.0) — ROJSTNODNEVNI KUPONI (čisti sloj, brez db importov).
 *
 * Tržna vrzel (docs/TRZNA-VRZELI-2026.md §4 P2 #10): »Loyalty kampanje +
 * e-mail marketing: rojstnodnevni kupon, win-back.« Kampanje z segmentom
 * 'inactive' (win-back) so zaprte že v v1.126.0 (issue #11); ta izdaja zapre
 * zadnji del vrzeli — samodejni osebni rojstnodnevni kupon.
 *
 * Odločitve (dokumentirane, zato deterministično testirljive):
 *  - Pojavljanje rojstnega dne 29. 2. v NE-prestopnem letu = 28. 2.
 *    (dan PRED 1. 3. — gost praznuje še vedno v februarju; izbrano pred
 *    alternativo 1. 3., ker je običajna gostinska navada in ker okno izdaje
 *    tako nikoli ne zdrsne v naslednji mesec).
 *  - Okno izdaje: 3 dni PRED pojavljanjem (vključno z dnevom pojavljanja) —
 *    kupon pride v roke, GOST lahko načrtuje obisk; idempotenca je vseeno
 *    stroga: en kupon na (gost, 'birthday', leto pojavljanja).
 *  - Privzeti odstotek 15 % = pod pragom odobritve (issue #19: 15 %) —
 *    uporaba kupona na POS ne sproži obvezne odobritve (brez trenja).
 *  - Koda: BD{YY}-{8 znakov} iz abecede brez zamenljivih znakov (brez
 *    O/0/I/1 — težave pri diktiranju po telefonu). Unikatnost zagotavlja
 *    @@unique(code) + ponovna generacija v strežniškem sloju.
 *  - Odkup gre SKOZI kanonično popustno jedro (discount ruta), NI lastne
 *    fiskalne/denarne logike — enako načelo kot paylink (v1.185.0) in
 *    labor-forecast (v1.186.0): en sam obračun.
 */

/** Veljavni razlogi izdaje (razširljivo: 'winback' ko bo potreben). */
export const COUPON_REASONS = ['birthday', 'manual'] as const
export type CouponReason = (typeof COUPON_REASONS)[number]

/** Življenjski cikli kupona. 'expired' NI shranjeno stanje — izpeljano ob odkupu. */
export const COUPON_STATUSES = ['issued', 'redeemed', 'void'] as const
export type CouponStatus = (typeof COUPON_STATUSES)[number]

/** Okno izdaje rojstnodnevnega kupona (dni PRED pojavljanjem, vključno z njim). */
export const BIRTHDAY_WINDOW_DAYS = 3

/** Rok veljavnosti rojstnodnevnega kupona (dni od dneva pojavljanja). */
export const BIRTHDAY_VALID_DAYS = 30

/** Privzeti odstotek rojstnodnevnega kupona — pod pragom odobritve (15 %, #19). */
export const BIRTHDAY_COUPON_PERCENT = 15

/** Privzeta veljavnost ročno izdanega kupona (dni od izdaje), če izdajatelj ne poda. */
export const MANUAL_COUPON_DEFAULT_DAYS = 30

/** Abeceda kod — brez zamenljivih znakov (O≈0, I≈1, L≈1 pri diktiranju). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Pojavljanje rojstnega dne `birthday` v koledarskem letu `year`.
 * 29. 2. v ne-prestopnem letu → 28. 2. Vrača podneven datum (12:00 lokalno),
 * da primerjave po dnevu niso občutljive na časovni pas ob robovih.
 */
export function birthdayInYear(birthday: Date, year: number): Date {
  const m = birthday.getMonth()
  const d = birthday.getDate()
  if (m === 1 && d === 29 && !isLeapYear(year)) return new Date(year, 1, 28, 12, 0, 0, 0)
  return new Date(year, m, d, 12, 0, 0, 0)
}

/** Dan (polnoč) datuma — stabilna primerjava po koledarskem dnevu. */
function dayFloor(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * Naslednje pojavljanje rojstnega dne glede na `now` (vključno z dnevom `now`
 * — če je danes rojstni dan, je pojavljanje DANES). */
export function nextBirthday(birthday: Date, now: Date): Date {
  const thisYear = birthdayInYear(birthday, now.getFullYear())
  if (dayFloor(thisYear).getTime() >= dayFloor(now).getTime()) return thisYear
  return birthdayInYear(birthday, now.getFullYear() + 1)
}

/**
 * Ali naslednje pojavljanje rojstnega dne pade v okno
 * [danes, danes + windowDays] (vključno z robovoma).
 */
export function birthdayInWindow(birthday: Date, now: Date, windowDays: number = BIRTHDAY_WINDOW_DAYS): boolean {
  const occ = dayFloor(nextBirthday(birthday, now))
  const start = dayFloor(now)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + Math.max(0, windowDays))
  return occ.getTime() >= start.getTime() && occ.getTime() <= end.getTime()
}

/**
 * Koda kupona: `BD{YY}-{8 znakov iz CODE_ALPHABET}`. `rng` je vbrizgan za
 * deterministične teste; privzet je Math.random. Unikatnost zagotavlja baza.
 */
export function generateCouponCode(year: number, rng: () => number = Math.random): string {
  let tail = ''
  for (let i = 0; i < 8; i++) tail += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)]
  return `BD${String(((year % 100) + 100) % 100).padStart(2, '0')}-${tail}`
}

/** Normalizacija vnesene kode (POS vnosi: trim + velike črke). */
export function normalizeCouponCode(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().slice(0, 40)
}

export interface CouponValue {
  percent: number | null
  fixedAmount: number
}

/**
 * Znesek popusta kupona na osnovi (ne-voided) postavk — ISTA semantika kot
 * discountAmountOf v billing.ts: odstotek in fiksni znesek sta OMEJENA na
 * osnovo (kupon nikoli ne poveča računa), zaokroženo na 2 decimalki.
 * percent = null → fiksni znesek; sicer odstotek.
 */
export function couponAmountOf(coupon: CouponValue, subtotal: number): number {
  const base = Math.max(0, subtotal)
  if (coupon.percent != null) {
    const p = Math.min(100, Math.max(0, coupon.percent))
    return Math.round(Math.min((base * p) / 100, base) * 100) / 100
  }
  return Math.round(Math.min(Math.max(0, coupon.fixedAmount), base) * 100) / 100
}

/**
 * Izpeljana veljavnost ob odkupu: shranjeno stanje 'issued' z pretečenim
 * expiresAt je za odkup IZPELJANO 'expired' (brez cron zapisa — odločitev
 * ob branju je vedno pravilna tudi, če cron ne teče). Ostala stanja passthrough.
 */
export function couponStatusAt(
  coupon: { status: string; expiresAt: Date },
  now: Date,
): 'issued' | 'redeemed' | 'void' | 'expired' {
  if (coupon.status !== 'issued') return coupon.status as 'redeemed' | 'void'
  return coupon.expiresAt.getTime() >= now.getTime() ? 'issued' : 'expired'
}

/** Poteče rojstnodnevnega kupona: dan pojavljanja + BIRTHDAY_VALID_DAYS. */
export function birthdayCouponExpiry(occurrence: Date, validDays: number = BIRTHDAY_VALID_DAYS): Date {
  return new Date(occurrence.getFullYear(), occurrence.getMonth(), occurrence.getDate() + validDays, 23, 59, 59, 0)
}
