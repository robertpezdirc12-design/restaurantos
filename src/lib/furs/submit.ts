/**
 * Oddaja fiskalnega dokumenta (ZOI→EOR / ZKI→JIR) — SKUPNA pot (audit 2026-10 #3,
 * v1.144.0).
 *
 * Pred tem je bil ta blok v src/lib/furs/issue.ts dvakrat kopiran (EOR in JIR),
 * zato ga storno ruta (src/app/api/receipts/[id]/storno) sploh ni imela: v
 * produkciji je bil negativni račun samo lokalno kodiran in je ostal 'pending' —
 * pri FURS/Porezni nikoli prijavljen. Ista kopija je bila razlog, da 'pending'
 * računa ni obnovil nihče: SOAP padec je pisal audit in push, noben klic pa ga
 * ni poslal ponovno (»runbook korak 5« je bil ročni SOAP postopek).
 *
 * Trije potrošniki istega koda:
 *   1. izdaja ob plačilu      → subsequentSubmit=false
 *   2. fiskalni storno        → subsequentSubmit=false (negativni dokument je NOV
 *                               fiskalni dokument; spec 1.13 nima storno polja,
 *                               negative oddaje kot navaden InvoiceRequest)
 *   3. obnova pending računa  → subsequentSubmit=true (FURS SubsequentSubmit /
 *                               HR NakDost — zakonita naknadna oddaja)
 *
 * Vedenje je PRENESENO 1:1 iz issue.ts:
 *  - klic gre ZUNAJ DB transakcije (omrežje ne sme držati tx);
 *  - FAIL-SAFE: napaka ne sme pasti plačila — račun OSTANE 'pending' (izrecno NE
 *    uvajamo 'error' statusa), console.warn + RECEIPT_FAILED push + AuditLog
 *    FISCAL_SUBMIT_FAILED (provider FURS|CIS);
 *  - uspeh → EOR/JIR + fiscalStatus 'verified' (+ HR cisStatus/cisSubmittedAt);
 *  - brez certifikata ali simulacija → provider 'none'; nič se NE lažira.
 */

import type { Receipt } from '@prisma/client'
import { db } from '@/lib/db'
import { jstr } from '@/lib/map'
import { pushEvent } from '@/lib/push'
import { writeAudit } from '@/lib/audit-chain'
import { fiscalAdapterFor } from '@/lib/fiscal'
import {
  certFromEnv, fursCaFromEnv, fursInvoice, signZoi,
  type FursCertMaterial, type FursEnvironment,
} from '@/lib/furs/client'
import { isoLocal } from '@/lib/fiscal-time'
import {
  cisCertFromEnv, cisInvoice, hrNacinPlac, signZki,
  type HrEnvironment,
} from '@/lib/cis/client'

export interface FiscalSubmitLocation {
  id: string
  country: string | null
  taxId: string | null
  premisesId: string | null
  registerNumber: string | null
  timezone: string | null
}

/** Potrebne le fiskalne polje računa (klicalec ima lahko sveže ustvarjen zapis). */
export interface FiscalSubmitReceipt {
  id: string
  receiptNumber: string
  zoi: string
  eor: string
  cisZki: string
  cisJir: string
  paymentMethod: string
  /** Samo za revizijo ob napaki (FISCAL_SUBMIT_FAILED je searchable po naročilu). */
  orderId: string | null
}

export interface FiscalSubmitInput {
  receipt: FiscalSubmitReceipt
  location: FiscalSubmitLocation
  /** Znesek dokumenta (storno NEGATIVEN) — InvoiceAmount/PaymentAmount/IznosUkupno. */
  total: number
  /** Razčlenitev PO popustih (audit #1) — ključ je stopnja (npr. '22.00'). */
  vatMap: Record<string, { base: number; vat: number }>
  /** Trenutek izdaje dokumenta (ZOI/ZKI podpisani nad njim). */
  issuedAt: Date
  /** Izvajalec — samo za revizijo. */
  userId: string
  /** true = naknadna oddaja pending dokumenta (SubsequentSubmit / NakDost). */
  subsequentSubmit?: boolean
  /** Simulacija (FURS_ALLOW_SIMULATION / env test) — takrat se NE oddaja. */
  simulation: boolean
}

export type FiscalSubmitOutcome =
  | { provider: 'none'; ok: false; reason: 'simulation' | 'no-certificate' }
  | { provider: 'FURS' | 'CIS'; ok: true; code: string; receipt: Receipt }
  | { provider: 'FURS' | 'CIS'; ok: false; error: string }

/** Zaporedna številka dokumenta: `leto-mesec-sek-PREMISES` → `sek` (kot prej). */
const sequenceOf = (receiptNumber: string): string =>
  String(Number(receiptNumber.split('-')[2]) || 0)

// ── Zaščitne kode (ZOI SI / ZKI HR) — SKUPNA pot izdaje in storna ──

export interface FiscalCerts {
  furs: { cert: FursCertMaterial; env: FursEnvironment } | null
  hr: { cert: FursCertMaterial; env: HrEnvironment } | null
}

/**
 * Certifikata se razrešita IZVEN DB transakcije (branje env + dekripcija PKCS#12
 * sta I/O in CPU, ki v transakciji nima kaj). `simulation` ju izrecno ignoriira —
 * simulacijske kode so deterministične in brez ponudnika.
 */
export function fiscalCerts(simulation: boolean, country: string | null | undefined): FiscalCerts {
  if (simulation) return { furs: null, hr: null }
  const isHr = (country || '').trim().toUpperCase() === 'HR'
  return isHr ? { furs: null, hr: cisCertFromEnv() } : { furs: certFromEnv(), hr: null }
}

export interface FiscalStampInput {
  location: FiscalSubmitLocation
  receiptNumber: string
  /** Zaporedna številka (HR `BrOznRac` ga zahteva kot `String(seq)`, ne `sek-PREMISES`). */
  sequence: number
  total: number
  issuedAt: Date
  simulation: boolean
}

export interface FiscalStamp {
  zoi: string
  eor: string
  cisZki: string
  cisJir: string
}

/**
 * Fiskalne kode dokumenta — AUDIT 2026-10 #3: storno ruta je doslej klicala SAMO
 * `fiscal.computeCodes`, ki v produkciji vrne PRAZNE kode (certifikat se upošteva
 * šele v podpisni poti) → negativni račun je dobil `zoi:''` in ga ni bilo mogoče
 * oddati NIKOLI VEČ (niti z naknadno oddajo, ki prazen ZOI zavrne). Zato izdaja in
 * storno oba uporabljata to funkcijo; vedenje izdaje je preneseno 1:1.
 *
 * Semantika (nespremenjena):
 *  - simulacija → adapterjeve testne kode (SI MD5 ZOI + UUID EOR, HR SHA-256 ZKI + UUID JIR);
 *  - produkcija S certifikatom → ZOI/ZKI = RSA-SHA256 podpis kanoničnega niza,
 *    EOR/JIR ostane prazen (prijavi ga ponudnik v odgovoru);
 *  - produkcija BREZ certifikata → vse prazno → dokument 'pending' brez zaščitne kode.
 */
export function stampFiscalCodes(i: FiscalStampInput, certs: FiscalCerts): FiscalStamp {
  const fiscal = fiscalAdapterFor(i.location.country)
  const isHr = fiscal.country === 'HR'
  const premisesId = i.location.premisesId || 'BLG001'
  const codes = fiscal.computeCodes({
    taxId: i.location.taxId || '',
    issuedAt: i.issuedAt,
    receiptNumber: i.receiptNumber,
    premisesId,
    total: i.total,
    simulation: i.simulation,
    timeZone: i.location.timezone,
  })
  if (i.simulation) {
    return {
      zoi: isHr ? '' : codes.protective,
      eor: isHr ? '' : codes.verification,
      cisZki: isHr ? codes.protective : '',
      cisJir: isHr ? codes.verification : '',
    }
  }
  if (isHr) {
    const hr = certs.hr
    return {
      zoi: '', eor: '', cisJir: '',
      cisZki: hr
        ? signZki(
            {
              oib: (i.location.taxId || '').replace(/\D/g, ''),
              issuedAt: i.issuedAt,
              invoiceNumber: String(i.sequence),
              premisesId,
              deviceId: i.location.registerNumber || '1',
              total: i.total,
              timeZone: i.location.timezone,
            },
            hr.cert.keyPem,
          )
        : '',
    }
  }
  const furs = certs.furs
  return {
    eor: '', cisZki: '', cisJir: '',
    zoi: furs
      ? signZoi(
          {
            taxId: i.location.taxId || '',
            issuedAt: i.issuedAt,
            receiptNumber: i.receiptNumber,
            premisesId,
            total: i.total,
            timeZone: i.location.timezone,
          },
          furs.cert.keyPem,
        )
      : '',
  }
}

export async function submitFiscalDocument(input: FiscalSubmitInput): Promise<FiscalSubmitOutcome> {
  const { receipt, location, total, vatMap, issuedAt, userId } = input
  const subsequentSubmit = input.subsequentSubmit === true
  if (input.simulation) return { provider: 'none', ok: false, reason: 'simulation' }

  const isHr = (location.country || '').trim().toUpperCase() === 'HR'
  const taxes = Object.entries(vatMap).map(([rate, v]) => ({
    vatRate: Number(rate), basis: v.base, taxAmount: v.vat,
  }))

  if (isHr) {
    const hrProd = cisCertFromEnv()
    if (!hrProd) return { provider: 'none', ok: false, reason: 'no-certificate' }
    try {
      const oibDigits = (location.taxId || '').replace(/\D/g, '')
      const resp = await cisInvoice(hrProd.env, hrProd.cert, {
        oib: oibDigits,
        inVatSystem: Boolean(location.taxId),
        issuedAt,
        invoiceNumber: sequenceOf(receipt.receiptNumber),
        premisesId: location.premisesId || 'BLG001',
        deviceId: location.registerNumber || '1',
        vatRates: taxes.map((t) => ({ rate: t.vatRate, base: t.basis, amount: t.taxAmount })),
        total,
        paymentMethod: hrNacinPlac(receipt.paymentMethod),
        operatorOib: oibDigits, // rezidual: OIB operaterja (Employee) pride z validacijo testnega okolja
        zki: receipt.cisZki,
        subsequentSubmit,
        timeZone: location.timezone,
      })
      const updated = await db.receipt.update({
        where: { id: receipt.id },
        data: { cisJir: resp.jir, cisStatus: 'verified', cisSubmittedAt: new Date(), fiscalStatus: 'verified', fiscalVerified: true, verificationDate: new Date() },
      })
      return { provider: 'CIS', ok: true, code: resp.jir, receipt: updated }
    } catch (e) {
      return failSubmit('CIS', 'CIS fiskalizacija ni uspela', receipt, location.id, userId, subsequentSubmit, e)
    }
  }

  const fursProd = certFromEnv()
  if (!fursProd) return { provider: 'none', ok: false, reason: 'no-certificate' }
  try {
    const taxNum = parseInt((location.taxId || '').replace(/\D/g, ''), 10)
    const resp = await fursInvoice(fursProd.env, fursProd.cert, {
      taxNumber: taxNum,
      issueDateTime: isoLocal(issuedAt, location.timezone),
      invoiceNumber: sequenceOf(receipt.receiptNumber),
      businessPremiseId: location.premisesId || 'BLG001',
      electronicDeviceId: location.registerNumber || 'BLG-001',
      invoiceAmount: total,
      paymentAmount: total,
      taxesPerSeller: taxes,
      operatorTaxNumber: taxNum, // rezidual: ločen OperatorTaxNumber (Location) pride z validacijo testnega okolja
      protectedID: receipt.zoi,
      subsequentSubmit,
      timeZone: location.timezone,
    }, fursCaFromEnv())
    const updated = await db.receipt.update({
      where: { id: receipt.id },
      data: { eor: resp.eor, fiscalStatus: 'verified', fiscalVerified: true, verificationDate: new Date() },
    })
    return { provider: 'FURS', ok: true, code: resp.eor, receipt: updated }
  } catch (e) {
    return failSubmit('FURS', 'FURS fiskalizacija ni uspela', receipt, location.id, userId, subsequentSubmit, e)
  }
}

/** Skupna odpoved: račun OSTANE pending, napaka pa je VIDNA (push + audit). */
async function failSubmit(
  provider: 'FURS' | 'CIS',
  title: string,
  receipt: FiscalSubmitReceipt,
  locationId: string,
  userId: string,
  subsequentSubmit: boolean,
  e: unknown,
): Promise<FiscalSubmitOutcome> {
  const message = String((e as Error).message || 'napaka')
  console.warn(`[${provider.toLowerCase()}] ${title} — račun ostane pending:`, message)
  void pushEvent('RECEIPT_FAILED', {
    title,
    body: `${receipt.receiptNumber} — ${message.slice(0, 120)}`,
    url: '/dashboard?tab=racuni',
    tag: `receipt-failed-${receipt.id}`,
  }, { roles: ['manager', 'admin'], locationId })
  // Issue #3 §B (P0): fiskalizacijska napaka mora biti VIDNA v diagnostiki
  // (brez AuditLog je /api/monitoring/errors ni ujel). Fire-and-forget.
  void writeAudit(db, {
    userId,
    action: 'FISCAL_SUBMIT_FAILED',
    entityType: 'Receipt',
    entityId: receipt.id,
    details: jstr({
      provider,
      receiptNumber: receipt.receiptNumber,
      orderId: receipt.orderId ?? undefined,
      subsequentSubmit,
      error: message.slice(0, 200),
    }),
    locationId,
  }).catch(() => null)
  return { provider, ok: false, error: message }
}
