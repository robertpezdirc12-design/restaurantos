'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { UtensilsCrossed, Loader2, MapPin, ShieldCheck, MonitorSmartphone, ChevronDown } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'

interface Location {
  id: string
  name: string
}

export default function LoginPage() {
  const router = useRouter()
  const [locations, setLocations] = useState<Location[]>([])
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  // ISSUE #4 §2.2 — device aktivacija prek ENKRATNE vpisne kode (dashboard ustvari kodo,
  // naprava jo unovči JAVNO — brez prijave; token pride nazaj samo tukaj in se shrani lokalno)
  const [provOpen, setProvOpen] = useState(false)
  const [provCode, setProvCode] = useState('')
  const [provBusy, setProvBusy] = useState(false)
  const [provToken, setProvToken] = useState('')
  const [provName, setProvName] = useState('')
  const [provError, setProvError] = useState('')

  useEffect(() => {
    const token = localStorage.getItem('ro_token')
    if (token) {
      router.replace('/dashboard')
      return
    }
    fetch('/api/auth/locations')
      .then((r) => r.json())
      .then((d) => setLocations(d.locations || []))
      .catch(() => setLocations([]))
      .finally(() => setChecking(false))
  }, [router])

  async function claimDevice() {
    setProvBusy(true); setProvError('')
    try {
      const res = await fetch('/api/devices/enroll', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: provCode.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setProvError(data.error || 'Aktivacija ni uspela.'); return }
      setProvToken(data.device?.token || '')
      setProvName(data.device?.name || 'naprava')
      // shrani token lokalno (isti ključ kot kiosk prej) — naprava je TAKOJ uporabna
      if (data.device?.type === 'KIOSK') localStorage.setItem('ro_kiosk_device_token', data.device.token)
      if (data.device?.type === 'CUSTOMER_DISPLAY') localStorage.setItem('ro_cfd_device_token', data.device.token)
    } catch {
      setProvError('Povezava s strežnikom ni uspela.')
    } finally { setProvBusy(false) }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Prijava ni uspela.')
        return
      }
      localStorage.setItem('ro_token', data.token)
      localStorage.setItem('ro_user', JSON.stringify(data.employee))
      // Vaja PIN-ov: bootstrap prijava (začasen 2-urni dostop) označimo, da dashboard lahko svetuje prehod na PIN iz baze
      if (data.bootstrap) localStorage.setItem('ro_bootstrap', '1')
      else localStorage.removeItem('ro_bootstrap')
      router.push('/dashboard')
    } catch {
      setError('Povezava s strežnikom ni uspela.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="relative min-h-screen flex flex-col bg-gradient-to-b from-stone-100 to-stone-200">
      <div className="absolute top-3 right-3 z-10">
        <ThemeToggle />
      </div>
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-emerald-700 text-white flex items-center justify-center shadow-lg">
              <UtensilsCrossed className="w-7 h-7" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">RestavrantOS</h1>
            <p className="text-sm text-stone-500">Blagajna · naročila · mize · kuhinja</p>
          </div>

          {locations.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {locations.map((l) => (
                <span
                  key={l.id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white border border-stone-200 px-3 py-1 text-sm shadow-sm"
                >
                  <MapPin className="w-3.5 h-3.5 text-emerald-700" />
                  {l.name}
                </span>
              ))}
            </div>
          )}

          {/* ISSUE #4 §2.2 — aktivacija naprave z enkratno vpisno kodo (brez prijave) */}
          <Collapsible open={provOpen} onOpenChange={setProvOpen}>
            <CollapsibleTrigger className="w-full flex items-center justify-between rounded-lg bg-white/70 border border-stone-200 px-4 py-2.5 text-sm text-stone-600 hover:bg-white transition">
              <span className="inline-flex items-center gap-2"><MonitorSmartphone className="w-4 h-4 text-emerald-700" /> Aktiviraj napravo (kiosk/display)</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${provOpen ? 'rotate-180' : ''}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Card className="mt-2 border-stone-200">
                <CardContent className="pt-4 space-y-3">
                  {provToken ? (
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium text-emerald-800">✅ Naprava aktivirana: {provName}</p>
                      <p className="text-xs text-stone-500">Žeton je shranjen v tem brskalniku. Za customer display odprite /display, za kiosk /kiosk.</p>
                      <Button size="sm" variant="outline" onClick={() => { setProvToken(''); setProvCode('') }}>Aktiviraj še eno napravo</Button>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="dev-code">Vpisna koda (8 števk)</Label>
                        <Input id="dev-code" inputMode="numeric" value={provCode} onChange={(e) => setProvCode(e.target.value.replace(/[^\d]/g, '').slice(0, 8))} placeholder="npr. 12345678" className="tracking-[0.3em] font-mono" />
                        <p className="text-[11px] text-stone-400">Kodo ustvari vodja: Dashboard → Nastavitve → Naprave → Vpisna koda. Velja 15 minut in je enkratna.</p>
                      </div>
                      {provError && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{provError}</p>}
                      <Button size="sm" className="w-full bg-emerald-700 hover:bg-emerald-800" disabled={provBusy || provCode.length !== 8} onClick={claimDevice}>
                        {provBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Aktiviraj napravo'}
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>

          <Card className="shadow-xl border-stone-200">
            <CardHeader>
              <CardTitle>Prijava</CardTitle>
              <CardDescription>Vpišite se s službenim računom in PIN kodo.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">E-pošta</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    placeholder="ime@restaurantos.app"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pin">PIN</Label>
                  <Input
                    id="pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="current-password"
                    placeholder="••••"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    required
                    className="h-11 tracking-[0.4em]"
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}
                <Button type="submit" disabled={loading} className="w-full h-11 bg-emerald-700 hover:bg-emerald-800">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Prijava'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="text-center space-y-1">
            <p className="text-xs text-stone-500 inline-flex items-center gap-1 justify-center">
              <ShieldCheck className="w-3.5 h-3.5" /> Demo prijava: admin@restaurantos.app / PIN 1234
            </p>
            <p className="text-[11px] text-stone-400">
              Rekonstrukcija 1.30.0 — obnovljeno iz Vercel deploymenta (GitHub račun hakiran)
            </p>
          </div>
        </div>
      </div>
      <footer className="mt-auto py-4 text-center text-xs text-stone-400 pb-[max(1rem,env(safe-area-inset-bottom))]">
        RestavrantOS · FURS simulacija · EUR
      </footer>
    </main>
  )
}
