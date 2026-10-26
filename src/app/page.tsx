'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { UtensilsCrossed, Loader2, MapPin, MonitorSmartphone, ChevronDown, ShieldCheck, KeyRound } from 'lucide-react'
import { landingTab } from '@/lib/tab-permissions'
import { ThemeToggle } from '@/components/theme-toggle'
import { I18nProvider, LanguageToggle, useI18n } from '@/components/i18n'

interface Location {
  id: string
  name: string
}

export default function LoginPage() {
  return (
    <I18nProvider>
      <LoginPageInner />
    </I18nProvider>
  )
}

function LoginPageInner() {
  const router = useRouter()
  const { t } = useI18n()
  const [locations, setLocations] = useState<Location[]>([])
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [checking, setChecking] = useState(true)
  // v1.94.0 (issue #12/#31): druga stopnja — MFA koda pri 401 mfaRequired
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaCode, setMfaCode] = useState('')
  // v1.94.0 (issue #31): obvezni vpis MFA (enforcement) — enrollment tok na prijavi
  const [enrollToken, setEnrollToken] = useState('')
  const [enrollEmployee, setEnrollEmployee] = useState<Record<string, unknown> | null>(null)
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null)
  const [enrollCode, setEnrollCode] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  // ISSUE #4 §2.2 — device aktivacija prek ENKRATNE vpisne kode (dashboard ustvari kodo,
  // naprava jo unovči JAVNO — brez prijave; token pride nazaj samo tukaj in se shrani lokalno)
  const [provOpen, setProvOpen] = useState(false)
  const [provCode, setProvCode] = useState('')
  const [provBusy, setProvBusy] = useState(false)
  const [provToken, setProvToken] = useState('')
  const [provName, setProvName] = useState('')
  const [provError, setProvError] = useState('')
  // Issue #7 (v1.148.0): demo vrata se lahko zaprejo z env (DEMO_LOGIN_ENABLED=0
  // ali potekel DEMO_LOGIN_EXPIRES_AT). Stanje se prebere z GET-om, da gumb ne
  // obeta nečesa, kar je zaprto. Privzeto ODPRT: če stanja ni mogoče prebrati
  // (izpad omrežja), se vedenje ne sme razlikovati od dosedanjega.
  const [demoOpen, setDemoOpen] = useState(true)
  // v1.180.0 (R3): povezava do čarovnika za prvo namestitev. Poganja jo SAMO
  // stanje z `/api/setup/status` in samo na lokalnem profilu: na oblaku čarovnik
  // ne more delovati (brez HTTPS fronte), zato se Lastnik ne more zmoti.
  const [setupOpen, setSetupOpen] = useState(false)

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
    // Issue #7: stanje demo vrat (samo boolean + morebiten rok, brez računov)
    fetch('/api/auth/demo-login')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.enabled === 'boolean') setDemoOpen(d.enabled) })
      .catch(() => setDemoOpen(true))
    fetch('/api/setup/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSetupOpen(!!d && d.isInitialized === false && d.mode === 'local'))
      .catch(() => setSetupOpen(false))
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
      if (!res.ok) { setProvError(data.error || t('login.deviceFailed')); return }
      setProvToken(data.device?.token || '')
      setProvName(data.device?.name || t('login.deviceNameFallback'))
      // shrani token lokalno (isti ključ kot kiosk prej) — naprava je TAKOJ uporabna
      if (data.device?.type === 'KIOSK') localStorage.setItem('ro_kiosk_device_token', data.device.token)
      if (data.device?.type === 'CUSTOMER_DISPLAY') localStorage.setItem('ro_cfd_device_token', data.device.token)
    } catch {
      setProvError(t('login.connection'))
    } finally { setProvBusy(false) }
  }

  /** DEMO VSTOP BREZ GESLA (zahteva lastnika 16. 10. 2026, za čas dela na aplikaciji):
   *  strežnik prijavi najstarejši AKTIVEN vodstveni račun brez MFA — isti račun,
   *  kot bi ga lastnik sicer uporabil, samo brez vpisa e-pošte/PIN. */
  async function demoLogin() {
    setError('')
    setDemoBusy(true)
    try {
      const res = await fetch('/api/auth/demo-login', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || t('login.demoFailed'))
        return
      }
      localStorage.setItem('ro_token', data.token)
      localStorage.setItem('ro_user', JSON.stringify(data.employee))
      localStorage.removeItem('ro_bootstrap')
      const landing = landingTab(String(data.employee?.role || ''), Array.isArray(data.employee?.permissions) ? data.employee.permissions : [])
      router.push(landing.station ? `/dashboard?tab=${landing.tab}&station=${landing.station}` : `/dashboard?tab=${landing.tab}`)
    } catch {
      setError(t('login.connection'))
    } finally {
      setDemoBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // mfaCode se pošlje samo, ko je UI v drugi stopnji (401 mfaRequired)
        body: JSON.stringify(mfaRequired ? { email, pin, mfaCode } : { email, pin }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.mfaRequired) {
          // račun ima vklopljeno MFA → prikaži drugo stopnjo (PIN ostane v formi)
          setMfaRequired(true)
          setError(data.error || t('login.mfaRequired'))
        } else {
          setError(data.error || t('login.failed'))
        }
        return
      }
      localStorage.setItem('ro_token', data.token)
      localStorage.setItem('ro_user', JSON.stringify(data.employee))
      // v1.94.0 (#34): bootstrap prijava je VEDNO ločena break-glass identiteta —
      // dashboard svetuje prehod na pravi račun (PIN iz baze + MFA)
      if (data.bootstrap) localStorage.setItem('ro_bootstrap', '1')
      else localStorage.removeItem('ro_bootstrap')
      // v1.94.0 (#31): enforcement — privilegiran račun brez MFA: OMEJENA
      // enrollment-only seja (samo /api/auth/mfa/**). Žetona NE shranimo v
      // localStorage (dashboard bi z njim razpadel) — držimo ga v stanju forme
      // in sprožimo vpis MFA (enroll s svežim PIN-om → koda aplikacije → enable).
      if (data.mfaEnrollmentRequired) {
        localStorage.removeItem('ro_token')
        localStorage.removeItem('ro_user')
        setEnrollToken(String(data.token || ''))
        setEnrollEmployee(data.employee || null)
        await startEnrollment(String(data.token || ''))
        return
      }
      // Issue #5 (P1-A): pristajalni zavihek PO VLOGI/dovoljenjih — vsak delavec
      // pristane v SVOJEM delovnem okolju (kuhinja → KDS, šank → hitra prodaja,
      // natakar → mize, čistilka → HACCP, vodstvo → pregled). URL param ne more
      // povišati pravic (backend preverja neodvisno) — to je samo izbira zavihka.
      const landing = landingTab(String(data.employee?.role || ''), Array.isArray(data.employee?.permissions) ? data.employee.permissions : [])
      router.push(landing.station ? `/dashboard?tab=${landing.tab}&station=${landing.station}` : `/dashboard?tab=${landing.tab}`)
    } catch {
      setError(t('login.connection'))
    } finally {
      setLoading(false)
    }
  }

  /* v1.94.0 (#31): obvezni vpis MFA neposredno na prijavi — enroll (PIN je v
     formi, sveže preverjen) → QR/skrivnost → koda iz aplikacije → enable →
     recovery kode (enkrat!) → nadaljevalni žeton → prijava dokončana. */
  async function startEnrollment(token: string) {
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/mfa/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pin }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || t('login.failed')); return }
      setEnroll({ secret: data.secret, otpauthUri: data.otpauthUri, qrDataUrl: data.qrDataUrl })
    } catch {
      setError(t('login.connection'))
    } finally {
      setLoading(false)
    }
  }

  async function confirmEnrollment() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/mfa/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrollToken}` },
        body: JSON.stringify({ pin, code: enrollCode }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || t('login.failed')); return }
      setRecovery(data.recoveryCodes || [])
      // nadaljevalni žeton + identiteta SHRANIMO šele po potrditvi, da je
      // uporabnik videl recovery kode (v DB so samo hash — to je EDINA priložnost)
      if (data.token) {
        localStorage.setItem('ro_token', data.token)
        if (enrollEmployee) localStorage.setItem('ro_user', JSON.stringify(enrollEmployee))
      }
    } catch {
      setError(t('login.connection'))
    } finally {
      setLoading(false)
    }
  }

  function finishEnrollment() {
    setEnroll(null); setRecovery(null); setEnrollCode(''); setMfaRequired(false)
    router.push('/dashboard')
  }

  return (
    <main data-screen="login" className="relative min-h-screen flex flex-col bg-gradient-to-b from-stone-100 to-stone-200">
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-emerald-700 text-white flex items-center justify-center shadow-lg">
              <UtensilsCrossed className="w-7 h-7" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">RestaurantOS</h1>
            <p className="text-sm text-stone-500">{t('login.subtitle')}</p>
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
              <span className="inline-flex items-center gap-2"><MonitorSmartphone className="w-4 h-4 text-emerald-700" /> {t('login.device')}</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${provOpen ? 'rotate-180' : ''}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Card className="mt-2 border-stone-200">
                <CardContent className="pt-4 space-y-3">
                  {provToken ? (
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium text-emerald-800">✅ {t('login.deviceActivated')}: {provName}</p>
                      <p className="text-xs text-stone-500">{t('login.deviceActivatedHint')}</p>
                      <Button size="sm" variant="outline" onClick={() => { setProvToken(''); setProvCode('') }}>{t('login.deviceAnother')}</Button>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="dev-code">{t('login.deviceCode')}</Label>
                        <Input id="dev-code" inputMode="numeric" value={provCode} onChange={(e) => setProvCode(e.target.value.replace(/[^\d]/g, '').slice(0, 8))} placeholder={t('login.devicePlaceholder')} className="tracking-[0.3em] font-mono" />
                        <p className="text-xs text-stone-400">{t('login.deviceCodeHint')}</p>
                      </div>
                      {provError && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{provError}</p>}
                      <Button size="sm" className="w-full bg-emerald-700 hover:bg-emerald-800" disabled={provBusy || provCode.length !== 8} onClick={claimDevice}>
                        {provBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('login.deviceSubmit')}
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>

          <Card className="shadow-xl border-stone-200">
            <CardHeader>
              <CardTitle>{t('login.title')}</CardTitle>
              <CardDescription>{t('login.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* v1.94.0 (#31): obvezni vpis MFA — QR + koda + recovery kode */}
              {enroll && (
                <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3">
                  <p className="text-sm font-semibold text-amber-900 flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" /> {t('login.mfaEnrollTitle')}</p>
                  <div className="flex flex-col sm:flex-row gap-3 items-start">
                    {enroll.qrDataUrl && (
                      <img src={enroll.qrDataUrl} alt={t('login.mfaQrAlt')} className="rounded-lg bg-white p-1 border border-amber-200 w-32 h-32" />
                    )}
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <p className="text-xs text-amber-800">{t('login.mfaScanHint')}</p>
                      <p className="text-xs text-stone-500">{t('login.mfaManual')}</p>
                      <p className="font-mono text-xs break-all bg-white border border-amber-200 rounded-sm px-2 py-1 select-all">{enroll.secret}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mfa-enroll-code">{t('login.mfaCodeLabel')}</Label>
                    <Input id="mfa-enroll-code" inputMode="numeric" autoComplete="one-time-code" value={enrollCode} onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" className="tracking-[0.3em] font-mono h-11" />
                  </div>
                  <Button className="w-full h-11 bg-emerald-700 hover:bg-emerald-800" disabled={loading || enrollCode.length !== 6} onClick={confirmEnrollment}>
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('login.mfaEnable')}
                  </Button>
                </div>
              )}
              {/* v1.94.0: recovery kode — prikazane ENKRAT (v DB samo hash) */}
              {recovery && (
                <div className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 p-4 space-y-2">
                  <p className="text-sm font-semibold text-emerald-900">{t('login.mfaRecoveryTitle')}</p>
                  <p className="text-xs text-emerald-700">{t('login.mfaRecoveryHint')}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {recovery.map((c) => (
                      <p key={c} className="font-mono text-xs bg-white border border-emerald-200 rounded-sm px-2 py-1 select-all">{c}</p>
                    ))}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(recovery.join('\n')); }}>{t('dev.copyCode')}</Button>
                  <Button className="w-full h-11 bg-emerald-700 hover:bg-emerald-800" onClick={finishEnrollment}>{t('login.mfaContinue')}</Button>
                </div>
              )}
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">{t('login.email')}</Label>
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
                  <Label htmlFor="pin">{t('login.pin')}</Label>
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
                {/* v1.94.0 (#12): druga stopnja — MFA koda (račun z vklopljeno MFA) */}
                {mfaRequired && (
                  <div className="space-y-1.5">
                    <Label htmlFor="mfa-code">{t('login.mfaCodeLabel')}</Label>
                    <Input
                      id="mfa-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="••••••"
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="h-11 tracking-[0.3em] font-mono"
                      autoFocus
                    />
                    <p className="text-xs text-stone-400">{t('login.mfaHint')}</p>
                  </div>
                )}
                {error && (
                  <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}
                <Button type="submit" disabled={loading} className="w-full h-11 bg-emerald-700 hover:bg-emerald-800">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('login.submit')}
                </Button>
                {/* DEMO VSTOP BREZ GESLA — zahteva lastnika (16. 10. 2026), za čas dela.
                    Strežnik sam izbere vodstveni račun brez MFA; vsak vstop se zapiše v audit (DEMO_LOGIN).
                    Issue #7: skrit, ko je strežnik vrata zaprl (DEMO_LOGIN_ENABLED=0 / potekel rok). */}
                {demoOpen && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={demoBusy || loading}
                      onClick={demoLogin}
                      className="w-full h-11 mt-2 border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                    >
                      {demoBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><KeyRound className="w-4 h-4 mr-1.5" aria-hidden />{t('login.demoBtn')}</>}
                    </Button>
                    <p className="text-xs text-stone-400 text-center">{t('login.demoHint')}</p>
                  </>
                )}
              </form>
              {setupOpen && (
                <a
                  href="/setup"
                  className="mt-3 flex min-h-11 items-center justify-center rounded-md border border-dashed border-emerald-300 px-3 text-sm text-emerald-800 hover:bg-emerald-50"
                >
                  {t('login.setupLink')}
                </a>
              )}
            </CardContent>
          </Card>

                  </div>
      </div>
      <footer className="mt-auto py-4 text-center text-xs text-stone-400 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {t('login.footer')}
      </footer>
    </main>
  )
}
