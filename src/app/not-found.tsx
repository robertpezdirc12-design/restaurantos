/**
 * Branded 404 (Task 50) — namesto privzete Next.js strani.
 * Samozadostna (server component, brez kontekstov) — SL primarno + HR sekundarno.
 * Uporabna za: napačne URL-je, iztek/promet QR tokenov, ročno vkucane poti.
 */
import Link from 'next/link'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-stone-50 p-6">
      <div className="w-full max-w-md rounded-3xl bg-white border border-stone-200 p-8 text-center shadow-sm">
        <Compass className="h-12 w-12 mx-auto text-stone-400" aria-hidden />
        <h1 className="mt-4 text-3xl font-bold text-stone-900">404</h1>
        <p className="mt-2 text-stone-600">Stran ne obstaja ali je bila premaknjena.</p>
        <p className="mt-1 text-sm text-stone-500" lang="hr">
          Stranica ne postoji ili je premještena.
        </p>
        <Button asChild className="mt-6 w-full h-12 text-base">
          <Link href="/">Nazaj na začetek / Natrag na početak</Link>
        </Button>
      </div>
    </main>
  )
}
