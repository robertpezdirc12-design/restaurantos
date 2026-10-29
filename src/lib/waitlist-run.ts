/**
 * v1.188.0 (P2-14) — strežniški sloj SMS obvestila čakalne vrste.
 *
 * Prehod waiting → notified poskuša poslati SMS »vaša miza je prosta« na
 * guestPhone (fail-soft — izid NIKOLI ne blokira prehoda, gostinec primarno
 * usadi gosta). Izid se zapiše na vnos (notifyStatus) in v revizijo (SAMO
 * status — brez številke, brez vsebine sporočila; PII higiena).
 *
 * Odvisnosti (sendFn/smsConfigFn) so vbrizgaljive — vzorec crm.ts
 * (smtpSendFn) in coupons-run.ts (sendEmail): `mock.module` je v tem repu
 * ZAVRAN (tests/audit2530-ci-determinism.test.ts), injekcija pa testom da
 * determinističen nadzor brez omrežja in brez strupa modulnega registra.
 *
 * GDPR: številka je pridobljena izključno za ta namen ob prijavi na čakalno
 * vrsto — sporočilo je izvedba zahtevane storitve (enkratno obvestilo o mizi),
 * NE tržna komunikacija (za marketing velja GuestConsent, #11).
 */
import { db } from '@/lib/db'
import { sendSms, smsConfigForLocation } from '@/lib/reminders'
import { localeForLocation } from '@/lib/crm'
import { canSmsWaitlist, waitlistSmsText, type WaitlistNotifyStatus } from '@/lib/waitlist'

export interface WaitlistSmsInput {
  entryId: string
  locationId: string | null
  phone: string
  guestName: string
  tableNumber?: number | null
}

export type WaitlistSmsConfig = { provider?: string; accountSid?: string; authToken?: string; from?: string; url?: string; secret?: string }
export type WaitlistSmsSendFn = (cfg: WaitlistSmsConfig, to: string, message: string) => Promise<{ ok: boolean; detail: string }>
export type WaitlistSmsConfigFn = (locationId: string | null) => Promise<WaitlistSmsConfig | null>

/**
 * Poskus pošiljanja SMS: VEDNO vrne status in fail-soft zapiše notifyStatus
 * na vnos; NIKOLI ne meče in nikoli ne blokira klicatelja (prehoda).
 *  - neuporabna številka → 'no_phone' (ni poskusa pošiljanja);
 *  - brez SMS integracije lokacije → 'sms_unconfigured' (ni poskusa);
 *  - ponudnik zavrne / omrežna napaka / izjema → 'failed';
 *  - uspeh → 'sent'.
 */
export async function attemptWaitlistSms(
  input: WaitlistSmsInput,
  deps?: { sendFn?: WaitlistSmsSendFn; smsConfigFn?: WaitlistSmsConfigFn },
): Promise<WaitlistNotifyStatus> {
  const send = deps?.sendFn ?? sendSms
  const configFor = deps?.smsConfigFn ?? smsConfigForLocation
  let status: WaitlistNotifyStatus
  try {
    if (!canSmsWaitlist(input.phone)) {
      status = 'no_phone'
    } else {
      const cfg = await configFor(input.locationId)
      if (!cfg) {
        status = 'sms_unconfigured'
      } else {
        const locale = await localeForLocation(input.locationId)
        const res = await send(cfg, input.phone, waitlistSmsText({ guestName: input.guestName, tableNumber: input.tableNumber ?? null }, locale))
        status = res.ok ? 'sent' : 'failed'
      }
    }
  } catch {
    status = 'failed'
  }
  await db.waitlistEntry.update({ where: { id: input.entryId }, data: { notifyStatus: status } }).catch(() => undefined)
  return status
}
