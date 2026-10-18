'use client'

/**
 * ISSUE #73 audit-22 (v1.139.0) — KDS row as a TAP-CARD.
 *
 * The whole item row becomes the tap target for the MAIN progress action
 * (queued → preparing → ready); secondary actions move off the row:
 *  - 86 sold-out toggle → LONG-PRESS (≥ LONG_PRESS_MS) on the same row;
 *  - ticket printing already lives in the ticket header (issue #69 layout);
 *  - station-flow-managed items and ready items render INERT (disabled).
 *
 * Interaction contract:
 *  - click / tap (or Enter / Space when focused)  → onAdvance
 *  - press-and-hold ≥ LONG_PRESS_MS               → onLongPress
 *    (drift > DRIFT_CANCEL_PX cancels the hold so scrolling the queue
 *    never fires it; a fired long-press suppresses the follow-up click);
 *  - Shift+Enter / Shift+Space (keyboard parity)   → onLongPress;
 *  - `disabled` rows keep the DOM shape (data-region markers are test
 *    anchors) but are aria-disabled and skipped by Tab order.
 *
 * Rendering note: a DIV with role="button" (not <button>) because rows carry
 * nested interactive badges; the caller owns the visuals — this component
 * only adds cursor/hover/select rules, focus ring and the 44 px floor.
 */
import { useRef, useState, type ReactNode } from 'react'

/** Hold duration that separates a deliberate long-press from a tap. */
export const KDS_LONG_PRESS_MS = 550
/** Finger drift (px) that cancels a pending hold (scroll intent). */
const DRIFT_CANCEL_PX = 12

export interface KdsTapCardProps {
  /** main progress action (tap / click / Enter / Space) */
  onAdvance: () => void
  /** secondary action behind a press-and-hold (86 sold-out toggle) */
  onLongPress?: () => void
  /** inert row (station-flow item, ready item, locked item) */
  disabled?: boolean
  /** screen-reader label of the row incl. the next action */
  ariaLabel: string
  /** title hint shown on hover (long-press affordance) */
  longPressHint?: string
  /** test anchor (data-region) — keeps the #69 marker family intact */
  dataRegion?: string
  className?: string
  children: ReactNode
}

export function KdsTapCard({
  onAdvance,
  onLongPress,
  disabled,
  ariaLabel,
  longPressHint,
  dataRegion,
  className,
  children,
}: KdsTapCardProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const [holding, setHolding] = useState(false)

  const clearHold = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startRef.current = null
    setHolding(false)
  }

  const longFire = () => {
    if (disabled || !onLongPress) return
    /* E2E lekcija: zatiranje sledilnega klika drži do NASLEDNJEGA pritiska
       (ne časovno okno) — dolg drž (> longFire) bi sicer sprožil obe dejanji
       (preklop 86 + napredek), ker bi okno poteklo pred izpustom pritiska. */
    suppressClickRef.current = true
    setHolding(false)
    onLongPress()
  }

  return (
    <div
      data-region={dataRegion}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      title={longPressHint}
      onClick={() => {
        if (disabled || suppressClickRef.current) return
        onAdvance()
      }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (e.shiftKey) longFire()
          else onAdvance()
        }
      }}
      onPointerDown={(e) => {
        if (disabled || !onLongPress) return
        if (e.pointerType === 'mouse' && e.button !== 0) return
        /* nov pritisk = novo dejanje: zatiranje iz prejšnjega dolgega pritiska
           se Ponastavi (klik tega pritiska je zaklenjen, naslednji je prost) */
        suppressClickRef.current = false
        startRef.current = { x: e.clientX, y: e.clientY }
        setHolding(true)
        timerRef.current = setTimeout(longFire, KDS_LONG_PRESS_MS)
      }}
      onPointerMove={(e) => {
        if (!startRef.current) return
        const dx = e.clientX - startRef.current.x
        const dy = e.clientY - startRef.current.y
        if (Math.hypot(dx, dy) > DRIFT_CANCEL_PX) clearHold()
      }}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={(e) => {
        // touch long-press raises the browser context menu — our hold wins.
        // desktop right-click without a hold keeps the native menu.
        if (holding || suppressClickRef.current) e.preventDefault()
      }}
      className={`min-h-11 select-none touch-manipulation [-webkit-touch-callout:none] ${
        disabled ? '' : 'cursor-pointer'
      } ${holding ? 'ring-2 ring-amber-400' : ''} ${className ?? ''}`}
    >
      {children}
    </div>
  )
}
