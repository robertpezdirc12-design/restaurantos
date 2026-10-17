/**
 * Issue #4 (P1, v1.125.0) — validacija e-računov. ČISTI MODUL (brez DB/IO).
 *
 *  1. Davčne številke:
 *     - SI: 8 števk, kontrolna mod 11-10 (ISO 7064 — enak algoritem kot OIB,
 *       7 podatkovnih + kontrolna števka);
 *     - HR: 11 števk (OIB) — t=10; t=(d+t)%10; if t==0 → t=10; t=(t*2)%11;
 *       kontrolna = (11−t)%10.
 *     Številke za teste IZGENERIRA funkcija sama (checkDigitSi/checkDigitHr) —
 *     brez realnih podjetij (pravilo: 0 izmišljenih podatkov).
 *
 *  2. validateOutgoing: POSLOVNA validacija pred pošiljanjem (issue §P1-C:
 *     neveljavna validacija BLOKIRA pošiljanje). Napake imajo field (pot do
 *     polja) + sporočilo v SL. HR profil: kpdCode OBVEZEN na vsaki vrstici.
 *
 *  3. validateIncoming: tolerantna opozorila PREJETEGA e-računa (NE blokira
 *     uvoza — import ruta jih aditivno doda v odgovor).
 */
import type { EslogInvoice } from '@/lib/eslog'
import type { OutgoingEInvoice } from '@/lib/eslog-export'

export interface ValidationIssue {
  field: string
  message: string
}

export interface OutgoingValidation {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** Glavni zneski (preverba usklajenosti Σ vrstic ≈ glava, ±0.02). */
export interface OutgoingHeaderTotals {
  subtotal: number
  vatAmount: number
  totalAmount: number
}

/* ─────────────── davčne številke (checksum) ─────────────── */

/** SI mod 11-10: kontrolna števka iz 7 podatkovnih števk (za teste — generiranje). */
export function checkDigitSiTaxId(first7: string): number {
  let t = 10
  for (const ch of String(first7).replace(/\D/g, '')) {
    t = (Number(ch) + t) % 10
    if (t === 0) t = 10
    t = (t * 2) % 11
  }
  return (11 - t) % 10
}

/** HR OIB: kontrolna števka iz 10 podatkovnih števk (za teste — generiranje). */
export function checkDigitHrOib(first10: string): number {
  let t = 10
  for (const ch of String(first10).replace(/\D/g, '')) {
    t = (Number(ch) + t) % 10
    if (t === 0) t = 10
    t = (t * 2) % 11
  }
  return (11 - t) % 10
}

/** SI davčna številka: 8 števk + mod 11-10 checksum. */
export function validateSiTaxId(taxId: string): boolean {
  const digits = String(taxId ?? '').replace(/\s/g, '')
  if (!/^\d{8}$/.test(digits)) return false
  return checkDigitSiTaxId(digits.slice(0, 7)) === Number(digits[7])
}

/** HR OIB: 11 števk + OIB checksum. */
export function validateHrOib(oib: string): boolean {
  const digits = String(oib ?? '').replace(/\s/g, '')
  if (!/^\d{11}$/.test(digits)) return false
  return checkDigitHrOib(digits.slice(0, 10)) === Number(digits[10])
}

/** Veljavna SI ali HR davčna številka (dolžina določa državo). */
export function validateTaxIdForCountry(taxId: string, country: string): boolean {
  const c = String(country ?? '').toUpperCase()
  if (c === 'SI') return validateSiTaxId(taxId)
  if (c === 'HR') return validateHrOib(taxId)
  return false
}

/* ─────────────── odhodni e-račun (blokirne napake) ─────────────── */

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Poslovna validacija odhodnega e-računa. Vsa pravila po issue §P1-C + §P1-D:
 *  - obvezen naziv prejemnika, davčna številka (checksum + dolžina po državi);
 *  - ≥ 1 vrstica; količina ≠ 0 (račun > 0, dobropis < 0); neto cena ≥ 0;
 *  - DDV stopnja 0–30;
 *  - Σ vrstic ≈ glavni zneski (±0.02 — zaokrožitvena toleranca; glavo poda
 *    klicatelj (AR zneski), ko želi preveriti usklajenost z vrsticami);
 *  - dueDate ≥ issueDate;
 *  - valuta EUR (opozorilo, če ne — B2B SI/HR izmenjava je v EUR);
 *  - HR profil: kpdCode OBVEZEN na vsaki vrstici (6 števk, napaka nosi vrstico);
 *    SI profil: kpdCode tiho opcijsko (prejmemo prejemnikovo kodo).
 */
export function validateOutgoing(
  inv: OutgoingEInvoice,
  profile: 'eslog-2.0-si' | 'ubl-2.1-hr',
  header?: OutgoingHeaderTotals,
): OutgoingValidation {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (!inv.buyer.name || !String(inv.buyer.name).trim()) {
    errors.push({ field: 'customerName', message: 'Manjka naziv prejemnika (kupec).' })
  }

  const buyerTax = String(inv.buyer.taxId ?? '').replace(/\s/g, '')
  if (!buyerTax) {
    errors.push({ field: 'customerTaxId', message: 'Manjka davčna številka prejemnika.' })
  } else if (!validateTaxIdForCountry(buyerTax, inv.buyer.country)) {
    const expect = inv.buyer.country === 'HR' ? '11 števk (OIB)' : '8 števk'
    errors.push({
      field: 'customerTaxId',
      message: `Davčna številka prejemnika ni veljavna (${inv.buyer.country}: ${expect} z ustreznim kontrolnim znakom).`,
    })
  }

  if (!Array.isArray(inv.lines) || inv.lines.length === 0) {
    errors.push({ field: 'lines', message: 'Račun mora vsebovati vsaj eno vrstico.' })
  } else {
    inv.lines.forEach((l, i) => {
      const n = i + 1
      const qty = Number(l.quantity)
      const price = Number(l.unitPriceNet)
      const vat = Number(l.vatRate)
      if (!l.name || !String(l.name).trim()) {
        errors.push({ field: `lines[${i}].name`, message: `Vrstica ${n}: manjka naziv postavke.` })
      }
      if (!Number.isFinite(qty) || qty === 0) {
        errors.push({ field: `lines[${i}].quantity`, message: `Vrstica ${n}: količina mora biti različna od 0.` })
      } else if (inv.documentType !== 'credit_note' && qty < 0) {
        errors.push({ field: `lines[${i}].quantity`, message: `Vrstica ${n}: količina ne more biti negativna (negativne vrstice samo pri dobropisu).` })
      }
      if (!Number.isFinite(price) || price < 0) {
        errors.push({ field: `lines[${i}].unitPriceNet`, message: `Vrstica ${n}: neto cena mora biti 0 ali več.` })
      }
      if (!Number.isFinite(vat) || vat < 0 || vat > 30) {
        errors.push({ field: `lines[${i}].vatRate`, message: `Vrstica ${n}: DDV stopnja mora biti med 0 in 30 %.` })
      }
      if (profile === 'ubl-2.1-hr') {
        const kpd = String(l.kpdCode ?? '').trim()
        if (!kpd) {
          errors.push({ field: `lines[${i}].kpdCode`, message: `Vrstica ${n}: manjka KPD klasifikacijska oznaka (obvezna za HR eRačun).` })
        } else if (!/^\d{6}$/.test(kpd)) {
          errors.push({ field: `lines[${i}].kpdCode`, message: `Vrstica ${n}: KPD oznaka mora biti 6-mestna (KPD 2025).` })
        }
      }
    })
  }

  // Σ vrstic ≈ glavni zneski (±0.02) — samo ko klicatelj poda glavo (AR zneski)
  if (Array.isArray(inv.lines) && inv.lines.length > 0 && header) {
    const linesNet = r2(inv.lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPriceNet), 0))
    const linesVat = r2(
      inv.lines.reduce(
        (a, l) =>
          a +
          (Number.isFinite(l.lineVatAmount)
            ? Number(l.lineVatAmount)
            : Number(l.quantity) * Number(l.unitPriceNet) * (Number(l.vatRate) / 100)),
        0,
      ),
    )
    if (Math.abs(linesNet - Number(header.subtotal)) > 0.02) {
      errors.push({ field: 'subtotal', message: `Vsota vrstic (neto ${r2(linesNet).toFixed(2)}) se ne ujema z glavo (${r2(Number(header.subtotal)).toFixed(2)}).` })
    }
    if (Math.abs(linesVat - Number(header.vatAmount)) > 0.02) {
      errors.push({ field: 'vatAmount', message: `Vsota DDV vrstic (${r2(linesVat).toFixed(2)}) se ne ujema z glavo (${r2(Number(header.vatAmount)).toFixed(2)}).` })
    }
    if (Math.abs(r2(linesNet + linesVat) - Number(header.totalAmount)) > 0.02) {
      errors.push({ field: 'totalAmount', message: 'Skupni znesek vrstic se ne ujema z glavo računa.' })
    }
  }

  // dueDate ≥ issueDate
  if (inv.dueDate && inv.issueDate) {
    const due = new Date(`${inv.dueDate}T00:00:00Z`)
    const issue = new Date(`${inv.issueDate}T00:00:00Z`)
    if (!isNaN(due.getTime()) && !isNaN(issue.getTime()) && due < issue) {
      errors.push({ field: 'dueDate', message: 'Rok plačila ne more biti pred datumom izdaje.' })
    }
  } else if (!inv.issueDate) {
    errors.push({ field: 'issueDate', message: 'Manjka datum izdaje.' })
  }

  // valuta: EUR je edina podprta (opozorilo — ne blokira, ker je vmesnik tipen)
  if (inv.currency !== 'EUR') {
    warnings.push({ field: 'currency', message: `Valuta ${inv.currency} — izmenjava SI/HR je podprta samo v EUR.` })
  }

  return { errors, warnings }
}

/* ─────────────── prejeti e-račun (neblokirna opozorila) ─────────────── */

/**
 * Opozorila PREJETEGA eSLOG računa (issue §P1-B): tolerantna validacija, ki NE
 * blokira uvoza — vsako opozorilo se doda v odgovor uvoza (UI prikaže).
 * Parser je XXE-varen (fast-xml-parser, brez zunanjih resolucij) — tukaj samo
 * poslovne preverbe.
 */
export function validateIncoming(inv: EslogInvoice): ValidationIssue[] {
  const warnings: ValidationIssue[] = []

  // 1. valuta: manjka ali ≠ EUR
  const currency = String((inv as { currency?: string }).currency ?? '').trim().toUpperCase()
  if (!currency) {
    warnings.push({ field: 'currency', message: 'Račun ne nosi valute (DocumentCurrencyCode) — predpostavljeno EUR.' })
  } else if (currency !== 'EUR') {
    warnings.push({ field: 'currency', message: `Valuta računa je ${currency}, pričakovano EUR.` })
  }

  // 2. Σ vrstic ≈ glavni zneski (toleranca 0.05 — samo ko glava nosi znesek)
  const hasFinite = (v: unknown) => Number.isFinite(Number(v))
  if (inv.lines.length > 0) {
    const linesNet = inv.lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0)
    if (hasFinite(inv.subtotal) && Math.abs(r2(linesNet) - Number(inv.subtotal)) > 0.05) {
      warnings.push({ field: 'subtotal', message: 'Vsota vrstic se ne ujema z glavnim zneskom brez DDV (razlika > 0,05).' })
    }
    if (hasFinite(inv.total)) {
      const linesGross = inv.lines.reduce(
        (a, l) => a + Number(l.quantity) * Number(l.unitPrice) * (1 + Number(l.vatRate) / 100),
        0,
      )
      if (Math.abs(r2(linesGross) - Number(inv.total)) > 0.05) {
        warnings.push({ field: 'total', message: 'Vsota vrstic z DDV se ne ujema s skupnim zneskom računa (razlika > 0,05).' })
      }
    }
  }

  // 3. issueDate v prihodnosti > 1 dan
  if (inv.issueDate) {
    const d = new Date(`${inv.issueDate}T00:00:00Z`)
    if (!isNaN(d.getTime())) {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      if (d > tomorrow) {
        warnings.push({ field: 'issueDate', message: `Datum izdaje ${inv.issueDate} je v prihodnosti (več kot 1 dan).` })
      }
    }
  }

  // 4. davčna številka dobavitelja ne ustreza SI/HR formatu
  const taxId = String(inv.supplier.taxId ?? '').trim()
  if (taxId && !validateSiTaxId(taxId) && !validateHrOib(taxId)) {
    warnings.push({
      field: 'supplier.taxId',
      message: `Davčna številka dobavitelja ${taxId} ne ustreza formatu SI (8 števk, mod 11-10) ali HR (11 števk, OIB).`,
    })
  }

  // 5. DDV stopnja izven 0–30
  inv.lines.forEach((l, i) => {
    const v = Number(l.vatRate)
    if (!Number.isFinite(v) || v < 0 || v > 30) {
      warnings.push({ field: `lines[${i}].vatRate`, message: `Vrstica ${i + 1}: DDV stopnja ${l.vatRate} je izven območja 0–30 %.` })
    }
  })

  return warnings
}
