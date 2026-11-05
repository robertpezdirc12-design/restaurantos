'use client'

/**
 * v1.255.0 — CONFIRMATION BANNER (docs/PRIMERJAVA-VMESNIKOV-2026 §29;
 * Lightspeed »Order view confirmation banner« — What's New hub, november 2026:
 * »The order view now has a confirmation banner at the top of the screen when
 * a task is complete. Every discount added, sequence completed or course
 * fired will be clear so staff can manage their shifts with confidence.«).
 *
 * Emerald pas na VRHU poglede, kjer se dejanje zgodi (NaročiloSheet /
 * plačilni dialog): kljukica + naslov (cb.<kind>) + detail vrstica
 * (število postavk / tečaj / popust) + ura potrditve. Smisel dosega:
 *   · role="status" + aria-live="polite" — bralnik zaslonov OZNANI uspeh,
 *   · avto-odpad po CONFIRM_BANNER_MS (6 s) + ročni gumb Zapri (44 px),
 *   · nov banner ZAMENJA starega (eno mesto resnice, ne zastoj vrst),
 *   · banner je ČISTI POVRATNI odziv po strežniškem uspehu — nič se ne
 *     zapisuje ob prikazu (avtoriteta ostaja API + revizije),
 *   · brez bannerja NEIZRISEMO NIČESAR (brez praznega okvirja).
 *
 * Model prinese page iz čiste lib confirm-banner (builderji so
 * defenzivni: count ≥ 0 celo, zneski r2, imena trim + kap 60).
 */
import { useEffect } from 'react'
import { useI18n } from '@/components/i18n'
import { CheckCircle2, X } from 'lucide-react'
import { CONFIRM_BANNER_MS, bannerTitleKey, bannerDetailParams, hasBannerDetail } from '@/lib/confirm-banner'
import type { ConfirmBanner } from '@/lib/confirm-banner'

export interface ConfirmBannerViewProps {
  /** model potrditve iz lib/confirm-banner (builderji); null = ne izriši nič */
  banner: ConfirmBanner | null
  /** pohod ob ročnem zaprtju (čisti setState null v page) */
  onDismiss: () => void
  /** data-region atribut (ločevanje pogledov v testih: sheet | payment) */
  region?: string
}

export function ConfirmBannerView({ banner, onDismiss, region }: ConfirmBannerViewProps) {
  const { t } = useI18n()

  // avto-odpad: časovnik ŽE ob pojavitvi bannerja (zamenjava ga ponastavi —
  // nov dejanje = novih 6 s; pošteno tudi ob hitrih zaporednih dejanjih)
  useEffect(() => {
    if (!banner) return
    const id = window.setTimeout(onDismiss, CONFIRM_BANNER_MS)
    return () => window.clearTimeout(id)
  }, [banner, onDismiss])

  if (!banner) return null

  return (
    <div
      data-region={region ?? 'confirm-banner'}
      role="status"
      aria-live="polite"
      className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-900 transition-colors"
    >
      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">{t(bannerTitleKey(banner))}</p>
        {hasBannerDetail(banner) && (
          <p className="mt-0.5 truncate text-xs leading-snug text-emerald-800">
            {t(`${bannerTitleKey(banner)}Detail`, bannerDetailParams(banner))}
          </p>
        )}
        <p className="mt-0.5 text-[11px] leading-snug text-emerald-700/80">
          {new Date(banner.at).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('cb.dismiss')}
        title={t('cb.dismiss')}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-emerald-700 transition-colors hover:bg-emerald-100 hover:text-emerald-900"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
