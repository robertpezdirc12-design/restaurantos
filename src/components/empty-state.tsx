import * as React from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Enoten vzorec praznega stanja (Toast/Square raven) — ikona + naslov + pojasnilo
 * + neobvezno dejanje. Nastal je iz ugotovitve vizualne QA v1.300.0: prazna
 * stanja so bila po aplikaciji razpršena (gola <p>, sivi blok, KDS vzorec,
 * Mize vzorec) — uporabnik ni mogel razlikovati »ni podatkov« od »se nalaga«
 * ali »napaka«.
 *
 * DVA GOSTOTA:
 *   • 'block'  (privzeto) — obrobljen center (dashed rob, ikona 40 px) —
 *     vzorec v1.235.0 (Mize/Naročila prazni stanji), za večje površine.
 *   • 'inline' — brez obrobe, ikona + vrstica — za majhne kartice/komponente,
 *     kjer bi blok odtegnil vsebino.
 *
 * PRAVILA (iz gate-ov projekta):
 *   • Besedilo pride prek props (title/hint) — komponenta NIMA lastnih nizov
 *     in NOVEGA i18n ključa (D1 pin šteje velikost slovarja 4324/4324).
 *   • role="status" — prazno stanje je sprememba stanja, bralci ga naznanijo
 *     (isti vzorec kot data-region="orders-empty"/"tables-empty").
 *   • Barvni pari sledijo temni preslikavi globals.css (stone žetoni).
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  size = 'block',
  region,
  className,
}: {
  icon?: LucideIcon
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  size?: 'block' | 'inline'
  /** data-region za selektorske teste / QA (isti vzorec kot obstoječa prazna stanja). */
  region?: string
  className?: string
}) {
  if (size === 'inline') {
    return (
      <div
        data-slot="empty-state"
        data-region={region}
        role="status"
        className={cn('flex flex-col items-center justify-center gap-1.5 py-6 text-center', className)}
      >
        {Icon && <Icon className="h-8 w-8 text-stone-300" aria-hidden />}
        <p className="text-sm font-medium text-stone-600">{title}</p>
        {hint && <p className="max-w-md text-xs text-stone-500">{hint}</p>}
        {action}
      </div>
    )
  }
  return (
    <div
      data-slot="empty-state"
      data-region={region}
      role="status"
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-6 text-center',
        className
      )}
    >
      {Icon && <Icon className="h-10 w-10 text-stone-300" aria-hidden />}
      <p className="text-sm font-bold text-stone-700">{title}</p>
      {hint && <p className="max-w-md text-sm text-stone-500">{hint}</p>}
      {action}
    </div>
  )
}
