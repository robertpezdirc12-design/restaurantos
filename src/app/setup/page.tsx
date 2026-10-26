'use client'

/**
 * v1.180.0 — R3: prva namestitev brez terminala.
 *
 * Zaslon je mišljen za STROJ, KJER ŠE NI NIČ: brez uporabnika, brez seje, brez
 * podatka. Zato bere `/api/setup/status` in piše na `/api/setup/claim` — obe poti
 * sta javni, varovalka je petpogojna ograja v `setup-claim.ts` (lokalni profil,
 * dokaz fronte, naslov v zanki, limit, prazna baza), ne prijava.
 *
 * Besedilo je slovensko in ne prevajano (t): ekran obstaja samo v lokalnem
 * profilu, ki ga ima v lasti en obrat; jezikovni sloj za en zaslon ne bi
 * zmanjšal nobene napake, bi jo pa zakril pred testom.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, Info, Loader2, Printer, ShieldAlert, UtensilsCrossed } from 'lucide-react'

interface Status {
  isInitialized: boolean
  mode: string
}

interface Odgovor {
  ok?: boolean
  error?: string
  razlog?: string
  errors?: Record<string, string>
  sheet?: string
  restaurantName?: string
  ownerEmail?: string
}

export default function SetupPage() {
  const [preverjam, setPreverjam] = useState(true)
  const [status, setStatus] = useState<Status | null>(null)
  const [ime, setIme] = useState('')
  const [davcna, setDavcna] = useState('')
  const [eposta, setEposta] = useState('')
  const [pin, setPin] = useState('')
  const [posiljam, setPosiljam] = useState(false)
  const [napake, setNapake] = useState<Record<string, string>>({})
  const [zavrnjeno, setZavrnjeno] = useState('')
  const [uspeh, setUspeh] = useState<Odgovor | null>(null)

  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
      .finally(() => setPreverjam(false))
  }, [])

  async function oddaj(e: React.FormEvent) {
    e.preventDefault()
    setPosiljam(true)
    setNapake({})
    setZavrnjeno('')
    try {
      const res = await fetch('/api/setup/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantName: ime, taxId: davcna, email: eposta, pin }),
      })
      const data: Odgovor = await res.json()
      if (!res.ok || !data.ok) {
        setNapake(data.errors && typeof data.errors === 'object' ? data.errors : {})
        setZavrnjeno(data.error || 'Prevzem namestitve ni uspel. Poskusi znova.')
        return
      }
      setUspeh(data)
    } catch {
      setZavrnjeno('Povezave z obratom ni bilo mogoče vzpostaviti. Preveri, da `bun run local` še teče, in osveži stran.')
    } finally {
      setPosiljam(false)
    }
  }

  if (uspeh) {
    return (
      <main data-screen="setup" className="min-h-screen bg-white py-8 print:py-0">
        <div className="mx-auto w-full max-w-xl px-4">
          <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <h1 className="text-base font-semibold">Namestitev je prevzeta</h1>
            <p>Prijavi se z e-pošto in PIN-om, ki sta izpisana spodaj.</p>
          </div>
          <Card className="border-stone-200 print:border-0 print:shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-700" aria-hidden="true" />
                Poverilnice obrata
              </CardTitle>
              <CardDescription>Natisni jih ali prepiši; hrambena kopija ostane v podatkovni mapi.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <pre className="min-h-11 overflow-x-auto rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">
                {uspeh.sheet}
              </pre>
              <div className="flex flex-wrap gap-2 print:hidden">
                <Button className="min-h-11 bg-emerald-700 text-white hover:bg-emerald-800" onClick={() => window.print()}>
                  <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
                  Natisni
                </Button>
                <a className="min-h-11 inline-flex items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50" href="/">
                  Na prijavo
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    )
  }

  if (preverjam) {
    return (
      <main data-screen="setup" className="flex min-h-screen items-center justify-center bg-white">
        <p className="flex items-center gap-2 text-sm text-stone-700">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Preverjam stanje namestitve ...
        </p>
      </main>
    )
  }

  const oblak = status?.mode === 'cloud'
  const prevzeto = status?.isInitialized === true

  return (
    <main data-screen="setup" className="min-h-screen bg-white py-8">
      <div className="mx-auto w-full max-w-xl px-4">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-700 text-white shadow-lg">
            <UtensilsCrossed className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-stone-800">Prva namestitev</h1>
          <p className="text-sm text-stone-600">Obrat poganja na tem računalniku; podatki ne zapustijo omrežja.</p>
        </div>

        {prevzeto ? (
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle>Namestitev je že prevzeta</CardTitle>
              <CardDescription>V bazi že obstajajo uporabniki. Prijavi se ali ih poišči v nastavitvah.</CardDescription>
            </CardHeader>
            <CardContent>
              <a className="min-h-11 inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800" href="/">
                Na prijavo
              </a>
            </CardContent>
          </Card>
        ) : oblak ? (
          <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Ta pot je namenjena lokalnemu profilu (baza je datoteka na tem računalniku). V oblaku ime in davčno
            številko vneseš v nastavitvah po prijavi.
          </div>
        ) : (
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle>Podatki obrata</CardTitle>
              <CardDescription>Ista merila kot terminal: e-pošta, PIN štirih do osmih števk, veljavna davčna številka.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={oddaj} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-stone-800" htmlFor="restaurantName">Ime obrata</label>
                  <Input id="restaurantName" className="min-h-11" value={ime} onChange={(e) => setIme(e.target.value)} required maxLength={120} />
                  {napake.restaurantName && <p role="alert" className="text-sm text-red-700">{napake.restaurantName}</p>}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-stone-800" htmlFor="taxId">Davčna številka</label>
                  <Input id="taxId" className="min-h-11" inputMode="numeric" value={davcna} onChange={(e) => setDavcna(e.target.value)} />
                  <p className="text-xs text-stone-600">Neobvezno zdaj — dopolniš jo lahko pozneje; rabljena bo za e-račune.</p>
                  {napake.taxId && <p role="alert" className="text-sm text-red-700">{napake.taxId}</p>}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-stone-800" htmlFor="email">E-pošta lastnika</label>
                  <Input id="email" className="min-h-11" type="email" autoComplete="username" value={eposta} onChange={(e) => setEposta(e.target.value)} required />
                  {napake.email && <p role="alert" className="text-sm text-red-700">{napake.email}</p>}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-stone-800" htmlFor="pin">PIN</label>
                  <Input id="pin" className="min-h-11" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} required />
                  <p className="text-xs text-stone-600">4–8 števk. To je geslo do celega obrata — shrani ga, kamor ga najdeš tudi čez mesec dni.</p>
                  {napake.pin && <p role="alert" className="text-sm text-red-700">{napake.pin}</p>}
                </div>

                {zavrnjeno && (
                  <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{zavrnjeno}</span>
                  </div>
                )}

                <Button type="submit" className="min-h-11 w-full bg-emerald-700 text-white hover:bg-emerald-800" disabled={posiljam}>
                  {posiljam ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Prevzemam namestitev ...
                    </>
                  ) : (
                    'Prevzemi namestitev'
                  )}
                </Button>
              </form>

              <div className="mt-4 flex items-start gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
                <span>
                  Deluje samo, kadar je obrat zagnan z <code>bun run local --https</code> in stran odprta na
                  naslovu, ki ga izpiše zagon (<code>https://localhost:…</code>). Brez fronte ali iz druge naprave
                  v omrežju strežnik prevzem zavrne — za njih je namenjena prijava, ne ta stran.
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        <p className="mt-6 text-center text-xs text-stone-600 print:hidden">
          Isti koraki so na voljo tudi brez brskalnika: <code>bun run local --tax-id …</code>
        </p>
      </div>
    </main>
  )
}
