'use client'

/**
 * ISSUE #73 audit-33 (v1.139.0) — one-time module intro.
 *
 * Short help shown on the FIRST entry to a module (KDS, lots, procurement,
 * payables, manager calls): two sentences explaining the flow + the module's
 * jargon. Dismissal persists in localStorage (`ro_intro_<module>`); a
 * dismissed intro stays hidden across sessions.
 *
 * Hydration discipline (the #132.1 lesson) WITHOUT setState-in-effect:
 *  - `hydrated` gate via useSyncExternalStore (server snapshot = false →
 *    renders null on the server pass and during hydration; flips before the
 *    first interactive paint, so SSR and client agree);
 *  - `dismissed` reads localStorage as an external store — the dismiss button
 *    writes the flag and emits to the module-level listeners (plus `storage`
 *    covers cross-tab), so re-render is event-driven, never an effect.
 */
import { useSyncExternalStore } from 'react'
import { useI18n } from '@/components/i18n'
import { Info, X } from 'lucide-react'

export const MODULE_INTRO_LS_PREFIX = 'ro_intro_'

/* module-level listener registry (dismiss emits, `storage` syncs cross-tab) */
const introListeners = new Set<() => void>()
const introEmit = () => introListeners.forEach((l) => l())
const introSubscribe = (cb: () => void): (() => void) => {
  introListeners.add(cb)
  if (typeof window !== 'undefined') window.addEventListener('storage', cb)
  return () => {
    introListeners.delete(cb)
    if (typeof window !== 'undefined') window.removeEventListener('storage', cb)
  }
}

/** hydration gate — server snapshot false, client true (post-hydration flip). */
const hydratedSubscribe = (): (() => void) => () => { /* fixed value — no updates */ }

export function ModuleIntro({ module, titleKey, bodyKey }: { module: string; titleKey: string; bodyKey: string }) {
  const { t } = useI18n()
  const lsKey = `${MODULE_INTRO_LS_PREFIX}${module}`

  const hydrated = useSyncExternalStore(hydratedSubscribe, () => true, () => false)
  const dismissed = useSyncExternalStore(
    introSubscribe,
    () => {
      try {
        return localStorage.getItem(lsKey) !== null
      } catch {
        /* storage unavailable — treat as not dismissed */
        return false
      }
    },
    () => false,
  )

  if (!hydrated || dismissed) return null

  return (
    <section
      data-region="module-intro"
      data-module={module}
      aria-label={t(titleKey)}
      className="rounded-xl border border-amber-200 bg-amber-50/70 dark:border-amber-700/60 dark:bg-amber-950/40 px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-bold text-amber-900 dark:text-amber-300">
            <Info className="w-4 h-4 shrink-0" aria-hidden /> {t(titleKey)}
          </p>
          <p className="text-xs leading-relaxed text-amber-800/90 dark:text-amber-200/80">{t(bodyKey)}</p>
        </div>
        <button
          type="button"
          aria-label={t('intro.dismiss')}
          onClick={() => {
            try {
              localStorage.setItem(lsKey, '1')
            } catch {
              /* non-persistent dismissal */
            }
            introEmit()
          }}
          className="shrink-0 rounded-md p-1.5 min-h-9 min-w-9 text-amber-700 hover:bg-amber-100"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>
    </section>
  )
}
