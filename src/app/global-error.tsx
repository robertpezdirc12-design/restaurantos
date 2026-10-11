'use client'

/**
 * Global error boundary ZADNJE GARANCIJE (Task 50) — lovi napake, ki padejo
 * TUDI v root layoutu (npr. tematski ponudnik/globalni hook), kjer app/error.tsx
 * ne seže. Zato rendra lasten <html><body> (zahteva Next.js) in ne sme
 * uporabljati nobenega konteksta — samo statična SL/HR besedila.
 *
 * Razlika do app/error.tsx: ta segment lovi vse RAZEN napak v root layoutu;
 * global-error lovi tudi te (a ne napak v sebi — to ostaja brskalnik).
 */
import { AlertTriangle, RotateCw } from 'lucide-react'
import './globals.css'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="sl">
      <body className="bg-stone-50">
        <main className="min-h-screen flex items-center justify-center p-6">
          <div
            role="alert"
            className="w-full max-w-md rounded-3xl bg-white border border-stone-200 p-8 text-center shadow-sm"
          >
            <AlertTriangle className="h-12 w-12 mx-auto text-amber-500" aria-hidden />
            <h1 className="mt-4 text-xl font-bold text-stone-900">Napaka aplikacije</h1>
            <p className="mt-2 text-stone-600">Ponovno naložite stran.</p>
            <p className="mt-1 text-sm text-stone-500" lang="hr">
              Greška aplikacije. Ponovno učitajte stranicu.
            </p>
            <button
              onClick={reset}
              className="mt-6 w-full h-12 rounded-xl bg-stone-900 text-white text-base font-medium hover:bg-stone-800 transition-colors inline-flex items-center justify-center"
            >
              <RotateCw className="mr-2 h-4 w-4" aria-hidden />
              Znova / Ponovno
            </button>
            {error.digest && (
              <p className="mt-4 text-xs text-stone-400 font-mono break-all">digest: {error.digest}</p>
            )}
          </div>
        </main>
      </body>
    </html>
  )
}
