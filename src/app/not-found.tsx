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
      <div className="w-full max-w-md rounded-xl bg-white border border-stone-200 p-8 text-center shadow-sm">
        <Compass className="h-12 w-12 mx-auto text-stone-400" aria-hidden />
        <h1 className="mt-4 text-3xl font-bold text-stone-900">404</h1>
        <p className="mt-2 text-stone-600">Stran ne obstaja ali je bila premaknjena.</p>
        <p className="mt-1 text-sm text-stone-500" lang="hr">
          Stranica ne postoji ili je premještena.
        </p>
        {/* QA najdba #5 (v1.218.0): dvojezični napis (279 px) se na 375 px
            stisnil v 261 px gumba (kartica max-w-md − p-8 − p-6) — zadnjih
            ~18 px je bilo odrezanih. Pod sm: samo primarni jezik, nad sm: oba
            (namen strani ostaja dvojezičen — SL primarno + HR sekundarno). */}
        <Button asChild className="mt-6 w-full h-12 text-base">
          <Link href="/">
            <span className="sm:hidden">Nazaj na začetek</span>
            <span className="hidden sm:inline">Nazaj na začetek / Natrag na početak</span>
          </Link>
        </Button>
      </div>
    </main>
  )
}
