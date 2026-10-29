/**
 * P2-9 (v1.186.0) — AI insights (vpogledi): deterministični motor, čisti sloj.
 *
 * Brez DB in brez I/O. Ruta (/api/reports/ai-insights) vanj vlije agregate
 * (prodaja po artiklih, neto prodaja po dnevih, labor-% po dnevih, urni
 * profil) in dobi nazaj seznam VPOGLEDOV. Vsak vpogled nosi i18nKey + params —
 * LOKALIZACIJA se zgodi šele v UI (useI18n), strežnik nikoli ne sestavlja
 * besedil (vzorec guestStatusKey). Vsak klic rute se zapiše v obstoječo
 * (doslej neuporabljeno) tabelo AIConversation — prvi pisec te tabele v repu
 * (napovedano v TRZNA-VRZELI-2026.md §P2-9).
 *
 * Pravila (vse deterministične, brez LLM-ja — LLM naracija ostaja odprta
 * vrzel P2-9b, glej docs/TRZNA-VRZELI-2026.md):
 *   - deadItem:  aktiven artikel brez prodaje v oknu → opozorilo;
 *   - restock:   najhitreje se vrteči artikli → priporočen dnevni pripravljeni
 *                odmik (pv = količina/dni × 1,1 varnostni faktor, strop na dan);
 *   - peak:      2 najmočnejši (dan tedna × ura) okna po neto prodaji;
 *   - labor:     dnevi z labor-% nad ciljem + 5 t. točk → opozorilo.
 * Prazen rezultat NI prazen zaslon: vrne en 'info' vpogled ai.insight.none.
 */

/* ─────────────────────────── 1) Javne oblike ─────────────────────────── */

export interface InsightItemSales {
  menuItemId: string
  name: string
  /** prodane enote (ne-voided) v oknu */
  qty: number
  /** neto prihodek (količina × enotna cena, brez DDV razčlenitve) v centih */
  revenueCents: number
}

export interface InsightDeadCandidate {
  id: string
  name: string
}

export interface InsightDayNet {
  date: string
  netCents: number
}

export interface InsightDayLabor {
  date: string
  /** strošek dela / neto prodaja × 100; null ko neto = 0 (delitev z 0) */
  laborPct: number | null
}

export interface InsightHourCell {
  dow: number
  hour: number
  revenueCents: number
}

export type AiInsightKind = 'deadItem' | 'restock' | 'peak' | 'labor' | 'none'
export type AiInsightSeverity = 'info' | 'warning' | 'critical'

export interface AiInsight {
  kind: AiInsightKind
  severity: AiInsightSeverity
  /** i18n ključ ('ai.insight.*') — UI prevede; strežnik ne gradi besedil */
  i18nKey: string
  /** vrednosti za interpolacijo {var} v t() */
  params: Record<string, string | number>
  /** surove meritve (za UI prikaz, izvoz in prihodnji LLM kontekst) */
  values: Record<string, string | number>
}

export interface AiInsightsInput {
  /** dolžina zgodovinskega okna v dneh (merilo za restock enote/dan) */
  windowDays: number
  itemSales: InsightItemSales[]
  /** aktivni artikli BREZ prodaje v oknu (ruta jih izračuna iz Menu...isAvailable) */
  deadCandidates: InsightDeadCandidate[]
  dayNet: InsightDayNet[]
  dayLabor: InsightDayLabor[]
  hourProfile: InsightHourCell[]
  /** ciljni labor-% (isti benchmark kot LF_TARGET_LABOR_PCT) */
  targetLaborPct: number
}

export interface AiInsightsResult {
  insights: AiInsight[]
  /** številčni povzetek (ruta ga zapiše v AIConversation.userMessage) */
  summary: {
    windowDays: number
    itemsWithSales: number
    deadItems: number
    daysWithSales: number
    insightCount: number
  }
}

/* ─────────────────────── 2) Pragi in konstante ─────────────────────── */

/** Največ vpogledov na vrsto (da kartica ne postane dnevnik). */
export const AI_MAX_PER_KIND = 3

/** Nad ciljem + te točke (%) šteje kot anomalija (pas labor-coverage). */
export const AI_LABOR_ANOMALY_PCT = 5

/** Varnostni faktor restock priporočila. */
export const AI_RESTOCK_SAFETY = 1.1

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/* ───────────────────────── 3) Glavni motor ───────────────────────── */

export function aiInsights(input: AiInsightsInput): AiInsightsResult {
  const insights: AiInsight[] = []
  const windowDays = Math.max(1, Math.round(input.windowDays) || 1)

  // 1) Mrtvi artikli — aktivni, brez prodaje v celotnem oknu.
  for (const c of input.deadCandidates.slice(0, AI_MAX_PER_KIND)) {
    insights.push({
      kind: 'deadItem',
      severity: 'warning',
      i18nKey: 'ai.insight.deadItem',
      params: { name: c.name, days: windowDays },
      values: { menuItemId: c.id },
    })
  }

  // 2) Restock — najhitrejši obrat: enote/dan × 1,1, strop na celo število/dan.
  const perDay = [...input.itemSales]
    .sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents)
    .slice(0, AI_MAX_PER_KIND)
  for (const it of perDay) {
    if (it.qty <= 0) continue
    const unitsPerDay = (it.qty / windowDays) * AI_RESTOCK_SAFETY
    insights.push({
      kind: 'restock',
      severity: 'info',
      i18nKey: 'ai.insight.restock',
      params: {
        name: it.name,
        perDay: Math.max(1, Math.round(unitsPerDay)),
        qty: it.qty,
      },
      values: { menuItemId: it.menuItemId, revenueCents: it.revenueCents },
    })
  }

  // 3) Vrhova obremenitve — 2 najmočnejši (dan tedna × ura) celici.
  const peaks = [...input.hourProfile]
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 2)
    .filter((p) => p.revenueCents > 0)
  for (const p of peaks) {
    insights.push({
      kind: 'peak',
      severity: 'info',
      i18nKey: 'ai.insight.peak',
      params: { dow: p.dow, hour: p.hour, revenue: r2(p.revenueCents / 100) },
      values: { dow: p.dow, hour: p.hour, revenueCents: p.revenueCents },
    })
  }

  // 4) Labor anomalije — dnevi nad ciljem + 5 t. točk (najhujši prej).
  const anomalies = input.dayLabor
    .filter((d) => d.laborPct !== null && d.laborPct > input.targetLaborPct + AI_LABOR_ANOMALY_PCT)
    .sort((a, b) => (b.laborPct as number) - (a.laborPct as number))
    .slice(0, AI_MAX_PER_KIND)
  for (const a of anomalies) {
    insights.push({
      kind: 'labor',
      severity: 'warning',
      i18nKey: 'ai.insight.labor',
      params: { date: a.date, pct: r2(a.laborPct as number), target: input.targetLaborPct },
      values: { date: a.date },
    })
  }

  // Prazen zaslon je napaka UI — vedno vsaj en vpogled.
  if (insights.length === 0) {
    insights.push({
      kind: 'none',
      severity: 'info',
      i18nKey: 'ai.insight.none',
      params: { days: windowDays },
      values: {},
    })
  }

  return {
    insights,
    summary: {
      windowDays,
      itemsWithSales: input.itemSales.filter((i) => i.qty > 0).length,
      deadItems: input.deadCandidates.length,
      daysWithSales: input.dayNet.filter((d) => d.netCents > 0).length,
      insightCount: insights.length,
    },
  }
}
