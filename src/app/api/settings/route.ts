import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, requireAuthWithPerms, isResponse, ok } from '@/lib/api'
import { nid, jstr, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { safeSettingsDto } from '@/lib/secret-dto'
import { apToleranceConfig, apToleranceAvailable, writeApTolerance, AP_TOLERANCE_COLUMNS } from '@/lib/ap-tolerance'
import { exceptionPolicy, exceptionPolicyAvailable, writeExceptionPolicy, EXCEPTION_POLICY_COLUMNS, type ExceptionPolicyColumn } from '@/lib/exception-policy'
import { cashPolicy, cashPolicyAvailable, writeCashPolicy, CASH_POLICY_COLUMNS, type CashPolicyColumn } from '@/lib/cash-movements'

const EDITABLE = [
  'name', 'address', 'city', 'postCode', 'phone', 'email', 'web', 'businessId', 'taxId',
  'registerNumber', 'fursEnvironment', 'defaultVatRate', 'reducedVatRate', 'loyaltyEnabled',
  'receiptFooter', 'currency', 'locale', 'country', 'emailEnabled',
] as const

/**
 * Issue #5 (P0, kommentar #3): prej je GET vrnil CELO vrstico RestaurantSettings
 * vsakemu prijavljenemu — vključno s skrivnostmi (fursCertPassword, emailSmtpPassword,
 * apiKeys, cisCertPassword). Zdaj:
 *  - navaden prijavljen (POS potrebuje receiptFooter za tisk) → MINIMALNI operativni
 *    DTO iz EDITABLE (poslovni podatki, NI skrivnosti — enak seznam kot PUT sprejme);
 *  - settings.manage → polna vrstica, a z write-only skrivnostmi (#23 §1):
 *    fursCertPassword/cisCertPassword/emailSmtpPassword/apiKeys se nikoli ne
 *    vrnejo — indikator '' (ni nastavljeno) / '••••' (nastavljeno). PUT sprejema
 *    samo EDITABLE ključe, zato skrivnosti ostanejo write-only.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const s = await db.restaurantSettings.findFirst()
  if (!s) return ok({ settings: null })
  if (ctx.perms.includes('settings.manage')) {
    // #23 §1: tudi nastavitvena vloga ne vidi obstoječih skrivnosti — samo indikator
    // Issue #18: tolerance ujemanja so del globalne računovodske politike (DDL-gated)
    // Issue #19: politika finančnih izjem (pragovi odobritve + obveznost razloga)
    const tolerance = await apToleranceConfig()
    return ok({ settings: safeSettingsDto(s), apMatchTolerance: tolerance, apToleranceDdlActive: await apToleranceAvailable(), exceptionPolicy: await exceptionPolicy(), exceptionPolicyDdlActive: await exceptionPolicyAvailable(), cashPolicy: await cashPolicy(), cashPolicyDdlActive: await cashPolicyAvailable() })
  }
  const minimal: Record<string, unknown> = {}
  for (const key of EDITABLE) {
    if (s[key] !== undefined) minimal[key] = s[key]
  }
  return ok({ settings: minimal })
}

export async function PUT(req: NextRequest) {
  // Issue #4 §1: inline role check zamenjan s kanoničnim dovoljenjem settings.manage (konsistentnost)
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return ok({ error: 'Manjkajo podatki.' }, 400)
  const data: Record<string, unknown> = {}
  for (const key of EDITABLE) {
    if (body[key] !== undefined) data[key] = body[key]
  }
  if (body.emailReportRecipients !== undefined) data.emailReportRecipients = jstr(body.emailReportRecipients)

  // Issue #18: tolerance tristranskega ujemanja (pooblaščena računovodska
  // politika, DDL-gated raw SQL — vzorec kategorij). Ne odmevajo v `settings`
  // DTO (tipiziran client stolpcev ne pozna), ampak ločeno pod apMatchTolerance.
  // NAMENOMA ZA ustvarjanjem/posodobitvijo vrstice: writeApTolerance je UPDATE —
  // brez singleton vrstice (prvi zagon) se vrednost ne bi shranila.
  const toleranceValues: Partial<Record<(typeof AP_TOLERANCE_COLUMNS)[number], number>> = {}
  for (const col of AP_TOLERANCE_COLUMNS) {
    if (body[col] !== undefined) {
      const v = num(body[col], NaN)
      if (!Number.isFinite(v)) return ok({ error: `${col} mora biti število.` }, 400)
      toleranceValues[col] = v
    }
  }

  // Issue #19 (v1.107.0): politika finančnih izjem (pragovi odobritve +
  // obveznost razloga) — ista disciplina kot tolerance (DDL-gated raw UPDATE,
  // ne odmevajo v settings DTO ampak ločeno pod exceptionPolicy).
  const excValues: Partial<Record<ExceptionPolicyColumn, number | boolean>> = {}
  for (const col of EXCEPTION_POLICY_COLUMNS) {
    if (body[col] !== undefined) {
      const raw = body[col]
      const bounds = col.startsWith('exc') && (typeof raw === 'boolean' || raw === 'true' || raw === 'false')
      if (bounds) {
        excValues[col] = raw === true || raw === 'true'
      } else {
        const v = num(raw, NaN)
        if (!Number.isFinite(v)) return ok({ error: `${col} mora biti število ali true/false.` }, 400)
        excValues[col] = v
      }
    }
  }
  // Issue #16 (v1.108.0): politika blagajniških premikov (prag variance +
  // slepi popis) — ista disciplina kot izjeme (DDL-gated raw UPDATE).
  const cashValues: Partial<Record<CashPolicyColumn, number | boolean>> = {}
  for (const col of CASH_POLICY_COLUMNS) {
    if (body[col] !== undefined) {
      const raw = body[col]
      if (col === 'cashBlindCount') {
        if (typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
          return ok({ error: 'cashBlindCount mora biti true/false.' }, 400)
        }
        cashValues[col] = raw === true || raw === 'true'
      } else {
        const v = num(raw, NaN)
        if (!Number.isFinite(v)) return ok({ error: `${col} mora biti število.` }, 400)
        cashValues[col] = v
      }
    }
  }
  const existing = await db.restaurantSettings.findFirst()
  const settings = existing
    ? await db.restaurantSettings.update({ where: { id: existing.id }, data })
    : await db.restaurantSettings.create({ data: { id: nid(), ...data } })
  if (Object.keys(toleranceValues).length > 0) {
    const err = await writeApTolerance(toleranceValues)
    if (err) return ok({ error: err }, 503)
  }
  if (Object.keys(excValues).length > 0) {
    const err = await writeExceptionPolicy(excValues)
    if (err) return ok({ error: err }, 503)
  }
  if (Object.keys(cashValues).length > 0) {
    const err = await writeCashPolicy(cashValues)
    if (err) return ok({ error: err }, 503)
  }
  // 33-c (audit §6): spremembe nastavitev so zdaj revidirane — SAMO ključi (NI vrednosti,
  // ker so med njimi poslovni podatki; pin/skrivnosti v Editable sploh niso)
  // Issue #19: ključi politike izjem (pragovi odobritve/razlogi) so finančno
  // občutljivi → vsaj zapis, KATERI so se spremenili (vrednosti števila/booli)
  const changedKeys = Object.keys(data)
  const excChanged = Object.keys(excValues)
  const cashChanged = Object.keys(cashValues)
  if (changedKeys.length > 0 || excChanged.length > 0 || cashChanged.length > 0) {
    await writeAudit(db, { userId: user.sub, action: 'SETTINGS_UPDATE', entityType: 'RestaurantSettings', entityId: settings.id, details: jstr({ changed: changedKeys, exceptionPolicyChanged: excChanged, exceptionPolicyValues: excValues, cashPolicyChanged: cashChanged, cashPolicyValues: cashValues }), locationId: user.loc })
  }
  // #23 §1: PUT odgovor vrača varni DTO — ne odmeva obstoječih skrivnosti
  // Issue #18: + trenutne tolerance (pri prisotnosti v telesu se odražajo takoj)
  // Issue #19: + trenutna politika izjem
  return ok({ settings: safeSettingsDto(settings), apMatchTolerance: await apToleranceConfig(), exceptionPolicy: await exceptionPolicy(), cashPolicy: await cashPolicy() })
}
