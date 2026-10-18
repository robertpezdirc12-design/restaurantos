'use client'

/**
 * ISSUE #73 audit-33 (v1.139.0) — inline term tooltip.
 *
 * Jargon terms (FEFO, GRN, AP, dispatch station, escalation, quarantine /
 * recall) render with a dotted underline; hover, keyboard focus or touch
 * press-and-hold opens a one-sentence explanation (Radix Tooltip).
 *
 * The term label comes as children (acronym or t() label of the host UI),
 * the explanation is looked up by `tipKey` in the dictionaries.
 */
import type { ReactNode } from 'react'
import { useI18n } from '@/components/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function TermTip({ tipKey, children }: { tipKey: string; children: ReactNode }) {
  const { t } = useI18n()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t(tipKey)}
          className="inline-flex items-center gap-0.5 underline decoration-dotted decoration-stone-400 underline-offset-2 text-inherit font-inherit cursor-help"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs leading-relaxed whitespace-normal">
        {t(tipKey)}
      </TooltipContent>
    </Tooltip>
  )
}
