/**
 * Naknadna fiskalizacija računa (audit 2026-10 #3, v1.144.0).
 *
 * TEŽAVA: vsaka produkcijska izdaja, kjer SOAP pade (ponudnik je dosegljiv in
 * certifikat nameščen, mreža/signatura pa odpove), je doslej zapisala račun s
 * `fiscalStatus:'pending'`, audit FISCAL_SUBMIT_FAILED in push — in nato nič.
 * Edini način do EOR/JIR je bil ročni SOAP po runbooku
 * (docs/FURS-CERT-RUNBOOK.md korak 5), zato so računi ostali fiskalno
 * neprijavljeni brez sledi.
 *
 * POT: FURS spec 1.13 in HR Fiskalizacija 2.0 imata za to izrecno polje —
 * `SubsequentSubmit` (SI) / `NakDost` (HR) = naknadna oddaja dokumenta, ki je
 * bil že izdan. Klic torej ponovi ISTI dokument: isti ZOI/ZKI (podpisan ob
 * izdaji nad `printedAt`), isti znesek, isto razčlenitev — samo zastavi
 * naknadno zastavico.
 *
 * PRAVICE: `orders.pay` — ISTO dovoljenje kot izdaja ob plačilu (src/lib/furs/
 * issue.ts). 'furs.issue' je bil namerno ODSTRANJEN (issue #72: v resnici je
 * varoval storno), zato ga ni za uporabiti. Naknadna oddaja ne spremeni
 * poslovnih podatkov računa, samo prijavo pri fisku.
 *
 * SOČASNOST: namensko BREZ CAS koraka. Dvojna oddaja istega dokumenta je nemogoča
 * PRI PONUDNIKU (ZOI/BrOznRac je unikat — drugi klic vrne napako in ta pot jo
 * zabeleži kot FISCAL_SUBMIT_FAILED), status pa NE sme dobiti vmesnega
 * 'submitting' stanja (odločitev izdaje: pending je edina resnica, izrecno brez
 * 'error' — glej issue.ts Naloga 36 in test GAP-3).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapReceipt, jparse, jstr, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { resolveFiscalProfile, FiscalConfigError } from '@/lib/fiscal-profile'
import { submitFiscalDocument } from '@/lib/furs/submit'

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await ctx.params

  const receipt = await db.receipt.findUnique({ where: { id }, include: { Location: true } })
  if (!receipt) return fail('Račun ne obstaja.', 404)
  const guard = await guardResource(user, receipt.locationId)
  if (guard) return guard
  const location = receipt.Location
  if (!location) return fail('Lokacija računa ne obstaja.', 400)

  if (receipt.fiscalStatus === 'verified') {
    return fail(`Račun ${receipt.receiptNumber} je že fiskaliziran.`, 409)
  }

  // Brez zaščitne kode dokument NI fiskalni: ZOI/ZKI se piše nad datumom izdaje
  // OB IZDAJI (izdaja brez certifikata pusti prazno polje in račun 'pending').
  // Ponovna oddaja z NOVIM ZOI-jem bi bila drug fiskalni dokument — tega ne
  // počnemo; tak račun se reši z izdajo certifikata + ponovno izdajo po runbooku.
  const isHr = (location.country || '').trim().toUpperCase() === 'HR'
  const protective = isHr ? receipt.cisZki : receipt.zoi
  if (!protective) {
    return fail(
      `Računa ${receipt.receiptNumber} ni mogoče naknadno oddati — manjka ${isHr ? 'ZKI' : 'ZOI'}, ki se generira ob izdaji (certifikat takrat ni bil nameščen).`,
      409,
    )
  }

  let profile
  try {
    profile = resolveFiscalProfile({
      globalEnv: process.env.FURS_ENVIRONMENT,
      locationEnv: location.fursEnvironment,
      allowSimulation: process.env.FURS_ALLOW_SIMULATION,
      productionTestMode: process.env.FURS_PRODUCTION_TEST_MODE,
      nodeEnv: process.env.NODE_ENV,
    })
  } catch (e) {
    if (e instanceof FiscalConfigError) return fail(e.message, e.status)
    throw e
  }
  if (profile.simulation) {
    return fail('Fiskalno okolje je testna simulacija — naknadna oddaja pri FURS/Porezni ni mogoča.', 409)
  }

  const vatMap = jparse<Record<string, { base?: number; vat?: number }>>(receipt.vatBreakdown, {})
  const taxes: Record<string, { base: number; vat: number }> = {}
  for (const [rate, v] of Object.entries(vatMap)) {
    if (!v || typeof v !== 'object') continue
    taxes[rate] = { base: num(v.base), vat: num(v.vat) }
  }

  const submitted = await submitFiscalDocument({
    receipt,
    location,
    total: num(receipt.total),
    vatMap: taxes,
    // ISTI trenutek kot ob izdaji — ZOI/ZKI je podpisan nad njim (sicer FURS
    // zavrne prijavo zaradi neskladja zaščitne kode in IssueDateTime).
    issuedAt: receipt.printedAt ?? receipt.createdAt,
    userId: user.sub,
    subsequentSubmit: true,
    simulation: profile.simulation,
  })

  if (submitted.provider === 'none') {
    return fail(
      submitted.reason === 'no-certificate'
        ? `Certifikat za ${isHr ? 'CIS/Porezno' : 'FURS'} ni nameščen — naknadna oddaja ni mogoča.`
        : 'Fiskalno okolje je simulacija — naknadna oddaja ni mogoča.',
      503,
    )
  }
  if (!submitted.ok) {
    return fail(
      `Naknadna oddaja ${submitted.provider} ni uspela: ${submitted.error.slice(0, 200)}. Račun ostane 'pending'.`,
      502,
    )
  }

  await writeAudit(db, {
    userId: user.sub,
    action: 'FISCAL_RESUBMIT',
    entityType: 'Receipt',
    entityId: receipt.id,
    details: jstr({
      provider: submitted.provider,
      receiptNumber: receipt.receiptNumber,
      orderId: receipt.orderId ?? undefined,
      code: submitted.code,
      subsequentSubmit: true,
      fursEnvironment: profile.environment,
    }),
    locationId: location.id,
  }).catch(() => null)

  return ok({
    receipt: mapReceipt(submitted.receipt),
    fiscal: { provider: submitted.provider, code: submitted.code, subsequentSubmit: true },
  })
}
