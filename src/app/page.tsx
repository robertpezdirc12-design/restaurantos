'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { UtensilsCrossed, Loader2, MapPin, ShieldCheck } from 'lucide-react'

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
      router.push('/dashboard')
    } catch {
      setError('Povezava s strežnikom ni uspela.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex flex-col bg-gradient-to-b from-stone-100 to-stone-200">
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
              Rekonstrukcija 1.26.0 — obnovljeno iz Vercel deploymenta (GitHub račun hakiran)
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
