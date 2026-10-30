/**
 * OSS-4 (v1.204.0) — HOLD/DRAFT NAROČILA (docs/GAP-ANALIZA-odprtokodna-konkurenca.md,
 * kandidat OSS-4, izvor OrderRestro "Hold/draft naročila — zadrži nedokončano naročilo
 * brez zaključka").
 *
 * Čisti sloj (0 uvozov — vzorec equipment.ts / documents.ts): pravila zadržanja so
 * deterministična in testabilna brez baze. Rute (hold/resume) + fire gard so edini
 * pisatelji; vse ostale poti so fail-closed prek obstoječih CAS-belih list
 * (ORDER_MUTABLE_STATUS / ORDER_MUTABLE_PAYMENT / ORDER_ACTIVE_DB / ORDER_PAYABLE_STATUS
 * v ops.ts + map.ts), ki statusa 'hold' NE poznajo — zadržanega naročila ni mogoče
 * urejati, plačati, premakniti, združiti, popustiti, preklicati (cancel), prevzeti
 * po postavkah (void) ali fiskalizirati, dokler ni nadaljevano.
 *
 * Pravilo zadržanja (zakaj tako ožje):
 *  - SAMO status 'open' + paymentStatus 'unpaid' + firedAt NULL.
 *    'sent'/'prepared' pomenita, da kuhinja že dela (postavke fired) — hrane ne smemo
 *    "izgubiti" s KDS zaslonov (kitchen ruta filtrira po ORDER_ACTIVE_DB, kamor 'hold'
 *    NE sodi). Z ožjim pravilom zadržano naročilo NIKOLI ni na KDS, ker nima ničesar
 *    poslano. Delna plačila ('partial') so izključena — zadrži se predplačilni osnutek,
 *    ne pol plačanega prisotka.
 *  - Nadaljevanje (resume) je edina pot ven: 'hold' → 'open'. Preklic zadržanega
 *    naročila = najprej nadaljuj, nato prekliči (UI skriva Prekliči med zadržanim;
 *    dvestopna pot je namerna — cancel ruta je fiskalno občutljiva R10/CAS koda in
 *    je NIMOČ nama pomešati z novim stanjem).
 *  - Offline vrsta (sync applyOp): 'order.addItems' gardira z ORDER_ACTIVE_DB →
 *    operacija nad zadržanim naročilom propade z 409 in ostane 'failed' v
 *    DeviceSyncOperation — po nadaljevanju se ista operacija uspešno ponovi (R7
 *    garancija: claim + aplikacija + zaključek ostanejo atomarni, nedotaknjeni).
 */

/** Nov status naročila: zadržano (String polje v DB — ni DDL, ni novega enuma). */
export const ORDER_STATUS_HOLD = 'hold'

/** Največja dolžina neobveznega razloga zadržanja (posnetek v reviziji). */
export const HOLD_REASON_MAX = 200

export interface HoldCheckInput {
  status: string
  paymentStatus: string
  firedAt: Date | string | null
}

export type HoldCheckResult = { ok: true } | { ok: false; error: string }

/**
 * Ali je naročilo mogoče zadržati? Vrstni red preverb je pomemben in pinan s testi:
 * obstoj → status → požgane postavke → plačila.
 */
export function canHoldOrder(o: HoldCheckInput | null | undefined): HoldCheckResult {
  if (!o) return { ok: false, error: 'Naročilo ne obstaja.' }
  if (o.status !== 'open') {
    return { ok: false, error: `Samo odprta naročila je mogoče zadržati (trenutno stanje: ${o.status}).` }
  }
  if (o.firedAt != null) {
    return { ok: false, error: 'Naročila s poslanimi postavkami ni mogoče zadržati — kuhinja že pripravlja.' }
  }
  if (o.paymentStatus !== 'unpaid') {
    return { ok: false, error: 'Naročila z že registriranimi plačili ni mogoče zadržati.' }
  }
  return { ok: true }
}

export type ResumeCheckInput = { status: string } | null | undefined

/** Ali je naročilo mogoče nadaljevati (samo iz 'hold')? */
export function canResumeOrder(o: ResumeCheckInput): HoldCheckResult {
  if (!o) return { ok: false, error: 'Naročilo ne obstaja.' }
  if (o.status !== ORDER_STATUS_HOLD) {
    return { ok: false, error: 'Naročilo ni zadržano.' }
  }
  return { ok: true }
}

/**
 * Neobvezni razlog zadržanja → sanitiziran posnetek za revizijo (trim, kontrolni
 * znaki ven, dolžina omejena). Prazen vnos → '' (razlog ni obvezen).
 */
export function sanitizeHoldReason(input: unknown): string {
  if (typeof input !== 'string') return ''
  const stripped = input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return stripped.slice(0, HOLD_REASON_MAX)
}
