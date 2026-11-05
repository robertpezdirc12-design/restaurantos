'use client'

/**
 * v1.254.0 — REAL-TIME CHECK VIEW (docs/PRIMERJAVA-VMESNIKOV-2026 §28;
 * Square oktober 2026 »Edit items with the check in view«).
 *
 * Živi predogled računa, ki stoji ZRAVEN urejevalca v vseh štirih
 * dialogih POS (izbira variante / opomba vrstice / sprememba cene /
 * preklic postavke). Model (vrstice + skupaj + more) prinese page iz
 * čiste lib live-check — komponenta SAMO izriše:
 *   · vrstica v urejanju (pending) → jantarna obroba + značka,
 *   · preklicana (voided) → prečrtana, IZPUŠČENA iz skupaj,
 *   · sprememba cene → prečrtana prejšnja + nova,
 *   · opomba → ℹ pod vrstico (isto kot v košarici — kuhinja jo vidi,
 *     POS naj jo vidi PRI VNOSU),
 *   · kap 30 vrstic → iskren »… in še N«, skupaj se sešteje VSE,
 *   · prazno stanje je vidno prazno (izrecna vrstica, ne tišina).
 *
 * Postavitev: v dialogu dvostolpčno (sm+), na mobilnem plošča NAD
 * urejevalcem (isti DOM — grid se prelije v en stolpec). Sqareova
 * esenca: »Item edits show up on the check, which is where staff
 * confirm them.«
 */
import { useI18n } from '@/components/i18n'
import { fmtEUR } from '@/lib/client'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { LiveCheckModel } from '@/lib/live-check'

export interface LiveCheckAsideProps {
  /** model iz lib/live-check (buildLiveCheck) */
  model: LiveCheckModel
  /** naslov plošče (i18n ključ; privzeto 'lcv.title') */
  titleKey?: string
  /** oznaka skupaj (i18n ključ; privzeto 'lcv.total' — preklic nosi 'lcv.totalAfterVoid') */
  totalKey?: string
  /** data-region atribut plošče (ločevanje dialogov v testih) */
  region?: string
}

export function LiveCheckAside({ model, titleKey, totalKey, region }: LiveCheckAsideProps) {
  const { t } = useI18n()
  return (
    <aside
      data-region={region ?? 'lcv-aside'}
      aria-label={t(titleKey ?? 'lcv.title')}
      className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-stone-400">{t(titleKey ?? 'lcv.title')}</p>
        <Badge variant="outline" className="shrink-0 border-emerald-200 bg-emerald-50 px-1.5 py-0 text-[10px] font-semibold uppercase text-emerald-700">
          {t('lcv.live')}
        </Badge>
      </div>
      {model.lines.length === 0 ? (
        <p className="py-1.5 text-sm text-stone-500" data-region="lcv-empty">{t('lcv.empty')}</p>
      ) : (
        <ScrollArea className="max-h-48">
          <div className="space-y-1 pr-1">
            {model.lines.map((l) => (
              <div
                key={l.key}
                data-region="lcv-line"
                className={`rounded-lg border px-2 py-1.5 ${l.pending ? 'border-amber-300 bg-amber-50' : 'border-stone-200 bg-white'} ${l.voided ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`min-w-0 truncate text-sm ${l.voided ? 'line-through' : ''}`}>
                    {l.qty}× {l.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {l.pending && (
                      <Badge variant="outline" className="border-amber-300 bg-amber-100 px-1.5 py-0 text-[10px] font-semibold text-amber-800">
                        {t(l.voided ? 'lcv.voided' : 'lcv.pending')}
                      </Badge>
                    )}
                    <span className="text-sm font-semibold tabular-nums">{fmtEUR(l.unitPrice * l.qty)}</span>
                  </span>
                </div>
                {l.prevPrice !== undefined && l.prevPrice !== l.unitPrice && (
                  <p className="text-xs text-stone-400">
                    {t('lcv.prev')}: <s>{fmtEUR(l.prevPrice * l.qty)}</s>
                  </p>
                )}
                {l.note ? <p className="truncate text-xs text-amber-800" title={l.note}>ℹ {l.note}</p> : null}
              </div>
            ))}
            {model.more > 0 && <p className="px-1 text-xs text-stone-400">{t('lcv.more', { n: model.more })}</p>}
          </div>
        </ScrollArea>
      )}
      <div className="flex items-baseline justify-between gap-2 border-t border-stone-200 pt-2">
        <span className="text-xs font-semibold uppercase text-stone-400">{t(totalKey ?? 'lcv.total')}</span>
        <span className="text-sm font-bold tabular-nums" data-region="lcv-total">{fmtEUR(model.total)}</span>
      </div>
      <p className="text-[10px] leading-tight text-stone-400">{t('lcv.hint')}</p>
    </aside>
  )
}
