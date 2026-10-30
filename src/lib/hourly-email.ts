/**
 * OSS-8 (v1.206.0) — URNA RAZČLENITEV PRODAJE V DNEVNEM E-POŠTNEM DIGESTU.
 * docs/GAP-ANALIZA-odprtokodna-konkurenca.md — OrderRestro #13 („urni
 * poročila na SMTP NI").
 *
 * Čisti sloj (0 uvozov) po konvenciji cron-daily.ts: vhod je zbirka urnih
 * vedre (hour, revenue, orders — strukturno kompatiblena s SalesHourBucket
 * iz sales-by-hour.ts), izhod so besedilne vrstice sekcije. Nikoli ne meče:
 * e-poštni digest je nad urnim odsekom (fail-soft); prazno okno → brez
 * sekcije (princip 3 — nič se ne laže o podatkih).
 *
 * Meja (pošteno zapisana v GAP dokumentu): SAMODEJNI pošiljanji VSAKO uro
 * (OrderRestro #13 „urni pošiljanji") ostanejo B — Vercel cron ima en termin
 * (0 5 * * *); urna razčlenitev ZDAJ potuje z dnevnim digestom. Transport =
 * obstoječi SMTP (RestaurantSettings emailEnabled/emailSmtp*), konfiguracija
 * ostane lastnikova (razred B dokumenta).
 */

export interface HourlyEmailBucket {
  /** ura dneva 0–23 (lokalno, po času plačila) */
  hour: number
  /** vsota plačanih zneskov v vedru, 2 decimalki (z DDV) */
  revenue: number
  /** št. plačanih računov v vedru */
  orders: number
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Enaka denarna oblika kot daily-email.ts (toFixed 2 — točka, doslednost znotraj istega sporočila). */
const eur = (v: number): string => `${r2(v).toFixed(2)} EUR`

/** Slovenski plural računov: 1 račun, 2 računa, 3–4 računi, 5+ računov. */
export function orderWord(n: number): string {
  const k = Math.round(Number(n))
  if (!Number.isFinite(k) || k <= 0) return 'računov'
  return k === 1 ? 'račun' : k === 2 ? 'računa' : k <= 4 ? 'računi' : 'računov'
}

/**
 * Aktivne urne vedre: ne-finite/negativni prihodek preskočen (isti podatkovni
 * gard kot salesByHour), orders <= 0 preskočeno, ura mora biti cela številka
 * 0–23. Rezultat naraščajoče po uri, prihodek zaokrožen na 2 decimalki.
 */
export function activeHourlyBuckets(
  buckets: readonly HourlyEmailBucket[] | null | undefined,
): HourlyEmailBucket[] {
  return (buckets || [])
    .filter((b) => {
      if (!b) return false
      if (!Number.isFinite(b.hour) || !Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) return false
      if (!Number.isFinite(b.revenue) || b.revenue < 0) return false
      if (!Number.isFinite(b.orders) || b.orders <= 0) return false
      return true
    })
    .map((b) => ({ hour: b.hour, revenue: r2(b.revenue), orders: Math.round(b.orders) }))
    .sort((a, b) => a.hour - b.hour)
}

/**
 * Vrhunska vedra po prihodku (enakost → nižja ura — stabilna izbira brez
 * ugibanja). Brez aktivnih → null.
 */
export function peakHour(
  buckets: readonly HourlyEmailBucket[] | null | undefined,
): HourlyEmailBucket | null {
  const active = activeHourlyBuckets(buckets)
  if (active.length === 0) return null
  let best = active[0]
  for (const b of active) if (b.revenue > best.revenue) best = b
  return best
}

/**
 * Vrstice urnega odseka: naslov »Prodaja po urah:«, potem po vrsti ure z
 * aktivnostjo (naraščajoče): `  17:00 – 18:00 · 12 računov · 456.78 EUR`
 * (zgornja meja je vedno ura + 1 — 23. ura zapre dan ob 24:00). Pri ≥ 2
 * aktivnih urah se na konec doda vrsta vrhunca `  Vrhunec: 19:00 (...)` —
 * ena ura je svoj vrhunec, vrsta bi bila odvečno ponavljanje. Prazno okno →
 * [] (klicatelj NAPIŠE sekcijo — nič se ne laže o praznem dnevu).
 */
export function hourlyReportSection(
  buckets: readonly HourlyEmailBucket[] | null | undefined,
): string[] {
  const active = activeHourlyBuckets(buckets)
  if (active.length === 0) return []
  const lines = ['Prodaja po urah:']
  for (const b of active) {
    const from = String(b.hour).padStart(2, '0')
    const to = String(b.hour + 1).padStart(2, '0')
    lines.push(`  ${from}:00 – ${to}:00 · ${b.orders} ${orderWord(b.orders)} · ${eur(b.revenue)}`)
  }
  if (active.length >= 2) {
    const top = peakHour(active)
    if (top) lines.push(`  Vrhunec: ${String(top.hour).padStart(2, '0')}:00 (${eur(top.revenue)})`)
  }
  return lines
}
