import nodemailer, { type Transporter } from 'nodemailer'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import { ssrfSafeRequest } from '@/lib/ssrf-guard'

/**
 * OPS-7 (v1.69.0) — OPOMNIKI REZERVACIJ (e-mail + SMS).
 *
 * E-MAIL: SMTP iz RestaurantSettings (polja že od v1.x: emailEnabled, emailSmtpHost/
 * Port/User/Password, emailFromAddress). Nodemailer, STARTTLS/TLS po porti.
 *
 * SMS: plitvi adapter prek Integrations tabele (type='sms', config JSON):
 *  - {provider:'twilio', accountSid, authToken, from}  → Twilio REST API (fetch,
 *    FIKSEN gostitelj api.twilio.com — ne uporabniško nastavljiv)
 *  - {provider:'webhook', url, secret?}                → POST {to, message} na
 *    webhook — Issue #30: uporabniško nastavljiv URL teče skozi SSRF varovalo
 *    (https/dns-pinning/brez preusmeritev/porti 80/443/8443); skrivnost
 *    X-Webhook-Secret se pošlje SAMO na https cilj.
 * Integracije so generični register (v1.x) — brez DDL, konfiguracija prek Zaposleni→Integracije.
 *
 * Vsi naslovi so fail-soft: napaka pošiljanja NE blokira rezervacije; rezultat gre v audit.
 */

export interface ReminderTarget {
  email?: string | null
  phone?: string | null
  guestName: string
  restaurantName: string
  when: Date
  partySize: number
  note?: string | null
}

export interface ReminderSendResult {
  email: { ok: boolean; detail: string }
  sms: { ok: boolean; detail: string }
  anySent: boolean
}

function fmtWhen(d: Date, locale: 'sl' | 'hr'): string {
  return d.toLocaleString(locale === 'hr' ? 'hr-HR' : 'sl-SI', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  })
}

/** Issue #13 (v1.110.0): potrditev SPLETNE rezervacije gostu (ob uspešnem
 * oddanem obrazcu widgeta). Isti dvojezični vzorec kot opomnik. */
export function bookingConfirmationText(t: ReminderTarget, locale: 'sl' | 'hr'): { subject: string; body: string; sms: string } {
  const when = fmtWhen(t.when, locale)
  if (locale === 'hr') {
    return {
      subject: `Potvrda: rezervacija u ${t.restaurantName} — ${when}`,
      body: `Poštovani/a ${t.guestName},\n\nvaša je rezervacija potvrđena:\n\n  ${when}\n  Broj gostiju: ${t.partySize}\n  Lokal: ${t.restaurantName}\n\nUkoliko ne možete doći, molimo Vas da nas obavijestite.\n\nVidimo se!\n${t.restaurantName}`,
      sms: `Potvrda: rezervacija ${t.restaurantName}, ${when} za ${t.partySize} os.`,
    }
  }
  return {
    subject: `Potrditev: rezervacija v ${t.restaurantName} — ${when}`,
    body: `Spoštovani/a ${t.guestName},\n\nvaša rezervacija je potrjena:\n\n  ${when}\n  Št. oseb: ${t.partySize}\n  Lokal: ${t.restaurantName}\n\nČe ne morete priti, nas prosim obvestite.\n\nSe vidimo!\n${t.restaurantName}`,
    sms: `Potrditev: rezervacija ${t.restaurantName}, ${when} za ${t.partySize} oseb.`,
  }
}

export function reminderText(t: ReminderTarget, locale: 'sl' | 'hr'): { subject: string; body: string; sms: string } {
  const when = fmtWhen(t.when, locale)
  if (locale === 'hr') {
    return {
      subject: `Podsjetnik: rezervacija u ${t.restaurantName} — ${when}`,
      body: `Poštovani/a ${t.guestName},\n\npodsjećamo Vas na rezervaciju:\n\n  ${when}\n  Broj gostiju: ${t.partySize}\n  Lokal: ${t.restaurantName}\n\nVidimo se!\n${t.restaurantName}`,
      sms: `Podsjetnik: rezervacija ${t.restaurantName}, ${when} za ${t.partySize} os.`,
    }
  }
  return {
    subject: `Opomnik: rezervacija v ${t.restaurantName} — ${when}`,
    body: `Spoštovani/a ${t.guestName},\n\nopominjamo Vas na rezervacijo:\n\n  ${when}\n  Št. oseb: ${t.partySize}\n  Lokal: ${t.restaurantName}\n\nSe vidimo!\n${t.restaurantName}`,
    sms: `Opomnik: rezervacija ${t.restaurantName}, ${when} za ${t.partySize} oseb.`,
  }
}

/** SMTP transport iz nastavitev (null = e-mail ni konfiguriran). Nastavitve so globalna vrstica. */
export async function smtpTransportForLocation(_locationId: string | null): Promise<Transporter | null> {
  const settings = await db.restaurantSettings.findFirst()
  if (!settings?.emailEnabled || !settings.emailSmtpHost || !settings.emailFromAddress) return null
  return nodemailer.createTransport({
    host: settings.emailSmtpHost,
    port: settings.emailSmtpPort || 587,
    secure: settings.emailSmtpPort === 465,
    auth: settings.emailSmtpUser
      ? { user: settings.emailSmtpUser, pass: settings.emailSmtpPassword }
      : undefined,
  })
}

interface SmsConfig {
  provider?: string
  accountSid?: string
  authToken?: string
  from?: string
  url?: string
  secret?: string
}

/** SMS konfiguracija iz Integrations (type='sms', isActive). */
export async function smsConfigForLocation(locationId: string | null): Promise<SmsConfig | null> {
  const rows = await db.integration.findMany({
    where: { type: 'sms', isActive: true, ...(locationId ? { OR: [{ locationId }, { locationId: null }] } : {}) },
  })
  for (const r of rows) {
    const cfg = jparse<SmsConfig>(r.config, {})
    if (cfg?.provider === 'twilio' && cfg.accountSid && cfg.authToken && cfg.from) return cfg
    if (cfg?.provider === 'webhook' && cfg.url) return cfg
  }
  return null
}

/** Pošlji SMS prek konfiguriranega ponudnika (fail-soft — vrne {ok, detail}).
 * Issue #30: webhook URL je uporabniško nastavljen → SSRF varovalo (validacija
 * URL-ja + DNS pinning + brez sledenja preusmeritvam); X-Webhook-Secret se
 * pošlje SAMO na https cilj (poverilnica ne gre po odprtem kanalu). */
export async function sendSms(cfg: SmsConfig, to: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const clean = to.replace(/[^\d+]/g, '')
  if (!clean || clean.length < 6) return { ok: false, detail: 'Neveljavna telefonska številka.' }
  try {
    if (cfg.provider === 'twilio') {
      const sid = cfg.accountSid as string
      const token = cfg.authToken as string
      const body = new URLSearchParams({ To: clean, From: cfg.from as string, Body: message })
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      })
      if (!res.ok) return { ok: false, detail: `Twilio ${res.status}` }
      return { ok: true, detail: 'Twilio OK' }
    }
    // webhook (privzeto, če provider manjka) — #30: SSRF varovalni klic
    const payload = JSON.stringify({ to: clean, message })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let webhookUrl: URL
    try {
      webhookUrl = new URL(cfg.url as string)
    } catch {
      return { ok: false, detail: 'Webhook URL ni veljaven.' }
    }
    if (webhookUrl.protocol === 'https:' && cfg.secret) headers['X-Webhook-Secret'] = cfg.secret
    const res = await ssrfSafeRequest(cfg.url as string, { method: 'POST', headers, body: payload, timeoutMs: 5000 })
    if (res.status === 0) return { ok: false, detail: `Webhook ni dosegljiv (${res.errorCategory})` }
    if (!res.ok) return { ok: false, detail: `Webhook ${res.status}` }
    return { ok: true, detail: 'Webhook OK' }
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 120) }
  }
}

/** Celoten opomnik (e-mail + SMS po podatkih gosta). Fail-soft po kanalih. */
export async function sendReminder(t: ReminderTarget, locale: 'sl' | 'hr', locationId: string | null): Promise<ReminderSendResult> {
  const texts = reminderText(t, locale)
  const result: ReminderSendResult = {
    email: { ok: false, detail: 'ni konfigurirano' },
    sms: { ok: false, detail: 'ni konfigurirano' },
    anySent: false,
  }
  // e-mail
  if (t.email) {
    const transport = await smtpTransportForLocation(locationId)
    if (transport) {
      try {
        const settings = await db.restaurantSettings.findFirst()
        await transport.sendMail({ from: settings?.emailFromAddress || undefined, to: t.email, subject: texts.subject, text: texts.body })
        result.email = { ok: true, detail: 'OK' }
      } catch (e) {
        result.email = { ok: false, detail: (e as Error).message.slice(0, 120) }
      }
    }
  }
  // SMS
  if (t.phone) {
    const cfg = await smsConfigForLocation(locationId)
    if (cfg) {
      result.sms = await sendSms(cfg, t.phone, texts.sms)
    }
  }
  result.anySent = result.email.ok || result.sms.ok
  return result
}

/**
 * Issue #13 (v1.110.0) — potrditev SPLETNE rezervacije gostu (ob oddanem
 * obrazcu widgeta /r/<token>). Fail-soft po kanalih — ne blokira rezervacije.
 * Lokalni jezik lokacije (Location.locale, privzeto sl-SI) — hr-HR dobi HR.
 */
export async function sendBookingConfirmation(t: ReminderTarget, localeTag: string | null, locationId: string | null): Promise<ReminderSendResult> {
  const locale: 'sl' | 'hr' = String(localeTag || '').toLowerCase().startsWith('hr') ? 'hr' : 'sl'
  const texts = bookingConfirmationText(t, locale)
  const result: ReminderSendResult = {
    email: { ok: false, detail: 'ni konfigurirano' },
    sms: { ok: false, detail: 'ni konfigurirano' },
    anySent: false,
  }
  if (t.email) {
    const transport = await smtpTransportForLocation(locationId)
    if (transport) {
      try {
        const settings = await db.restaurantSettings.findFirst()
        await transport.sendMail({ from: settings?.emailFromAddress || undefined, to: t.email, subject: texts.subject, text: texts.body })
        result.email = { ok: true, detail: 'OK' }
      } catch (e) {
        result.email = { ok: false, detail: (e as Error).message.slice(0, 120) }
      }
    }
  }
  if (t.phone) {
    const cfg = await smsConfigForLocation(locationId)
    if (cfg) {
      result.sms = await sendSms(cfg, t.phone, texts.sms)
    }
  }
  result.anySent = result.email.ok || result.sms.ok
  return result
}
