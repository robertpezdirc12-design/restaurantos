'use client'

/**
 * Global error boundary (Task 50) — branded SL/HR fallback za vse rute
 * (dashboard, kiosk, QR meni, display, delivery).
 *
 * Zasnova: SAMOZADOSTNA — ne sme biti odvisna od i18n ponudnika/DB/auth,
 * saj je lahko prav ta odvisnost vzrok crash-a. Besedila so torej statična
 * (SL primarno + HR sekundarno, isti vzorec kot preostali gostujoči tokovi).
 *
 * - reset(): poskus ponovnega rendra brez reload-a (očasi tranzitivne napake)
 * - error.digest: Next.js runtime korelacijski ID → prikazan za podporo
 *   (dvignjen iz konzolnih logov; ne razkriva stacka uporabniku)
 * - role="alert" + aria: screen reader napove napako; gumb ≥ 44 px
 */
import { useEffect } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Dejstvo o napaki v konzolo (opazljivo v dev + Vercel runtime logi)
    console.error('[RestavrantOS] Neujeta napaka:', error)
  }, [error])

  return (
    <main className="min-h-screen flex items-center justify-center bg-stone-50 p-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl bg-white border border-stone-200 p-8 text-center shadow-sm"
      >
        <AlertTriangle className="h-12 w-12 mx-auto text-amber-500" aria-hidden />
        <h1 className="mt-4 text-xl font-bold text-stone-900">Ups — prišlo je do napake</h1>
        <p className="mt-2 text-stone-600">Osvežite stran ali poskusite znova.</p>
        <p className="mt-1 text-sm text-stone-500" lang="hr">
          Ups — došlo je do greške. Osvežite stranicu ili pokušajte ponovno.
        </p>
        <Button onClick={reset} className="mt-6 w-full h-12 text-base">
          <RotateCw className="mr-2 h-4 w-4" aria-hidden />
          Poskusi znova / Pokušaj ponovno
        </Button>
        {error.digest && (
          <p className="mt-4 text-xs text-stone-400 font-mono break-all">digest: {error.digest}</p>
        )}
      </div>
    </main>
  )
}
