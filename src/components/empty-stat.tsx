'use client'

/**
 * Issue #74 V-15 (Stopnja 3, v1.135.0) — TRI stanja namesto enega "—".
 *
 * Merjena napaka v produkciji 1.132.0: sivi pill z "—" (SPH, Povprečno — min)
 * je vizualno enak skeletonu nalaganja — uporabnik ne more razlikovati
 * "aplikacija računa" od "ni podatka". Enoten vzorec po vsem back-officeu:
 *
 *   1. NI PODATAKA      → "ni še podatkov" (ležeče, sivo, ikona Info)
 *                         — prišlo je nič zapisov, izračun NI smiseln
 *   2. NI IZRAČUNANO    → "—" z naslovom/pojasnilom "ni izračunano" (deljenje
 *                         z 0: npr. labor % brez prometa) — NI sivi pill/blok,
 *                         da se ne zamenja s skeletonom
 *   3. NALAGANJE        → obstoječi <Skeleton> (utripajoč blok) — nedotaknjeno
 *
 * Vzorec: Vercel Geist "empty state" ikona + besedilo; Stripe prazne tabele.
 * Datoteka živi v src/components/ (IZVEN i18n regresijske družine tabs/) —
 * vsak viden niz gre skozi t().
 */
import { Info } from 'lucide-react'
import { useI18n } from '@/components/i18n'

export function EmptyStat({
  kind,
  className,
}: {
  /** 'no-data' = ni še podatkov (prazen nabor) · 'not-computed' = deljenje z 0. */
  kind: 'no-data' | 'not-computed'
  className?: string
}) {
  const { t } = useI18n()
  if (kind === 'not-computed') {
    // em-dash ostane (zakonita matematična vrednost), a NE v sivem pillu —
    // naslov + sr-only poved ločita od skeletona nalaganja
    return (
      <span
        className={`text-sm font-semibold text-stone-400 ${className || ''}`}
        title={t('emptystat.notComputedHint')}
      >
        —
        <span className="sr-only">{t('emptystat.notComputedHint')}</span>
      </span>
    )
  }
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-xs italic text-stone-400 ${className || ''}`}
      title={t('emptystat.noDataHint')}
    >
      <Info className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{t('emptystat.noData')}</span>
    </span>
  )
}
