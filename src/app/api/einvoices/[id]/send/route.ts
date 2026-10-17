import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { parseEslog } from '@/lib/eslog'
import { resolveStatusPath, isSendableStatus } from '@/lib/einvoice-lifecycle'
import { resolveEInvoiceProvider } from '@/lib/einvoice-adapter'
import { validateOutgoing } from '@/lib/einvoice-validate'
import type { OutgoingEInvoice } from '@/lib/eslog-export'

/**
 * Issue #4 (P1, v1.125.0) — pošiljanje odhodnega B2B e-računa (outbox → adapter).
 *
 * POST /api/einvoices/[id]/send
 *  1. veljaven samo iz draft/validated/failed/rejected/needs_review (življenjski
 *     cikel — send iz sent/delivered/accepted/queued → 409 {alreadySent:true}
 *     BREZ drugega poskusa: attempts ostane, externalRef se ohrani (idempotenca
 *     issue §P1-C — retry NE ustvari drugega zunanjega dokumenta);
 *  2. PONOVNA validacija payloada (parseEslog XXE-varen + validateOutgoing na
 *     rekonstruiranem računu) — napaka → 400 BREZ pošiljanja (issue: neuspešna
 *     validacija blokira, ne navidezni uspeh);
 *  3. resolveEInvoiceProvider → BLOKIRANO (neregistriran ponudnik) → 409
 *     {blocked:true, reason} — NIKOLI ne lažemo, da je poslano (#9 ključavnica);
 *  4. adapter.send(idempotencyKey, xml) → ok: status 'sent' (pot prek
 *     validated/queued zapiše EN EINVOICE_STATUS dogodek z from/to), externalRef,
 *     attempts+1, sentAt; timeout: 'failed' + EINVOICE_SEND_FAILED (monitoring).
 *
 * Pravica: inventory.manage. locationScope: tuj outbox → 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params

  const scope = await locationScope(user)
  const outbox = await db.eInvoiceOutbox.findFirst({
    where: { id, ...scope },
    select: {
      id: true, status: true, xmlPayload: true, xmlHash: true, externalRef: true,
      idempotencyKey: true, attempts: true, country: true, profile: true, documentType: true,
      currency: true, receiverName: true, receiverTaxId: true, receiverCountry: true,
      invoiceNumber: true, locationId: true,
    },
  })
  if (!outbox) return fail('E-račun ni v vašem obsegu ali ne obstaja.', 404)

  // ── 1. že v pošiljanju/končno → idempotenten odgovor BREZ novega poskusa ──
  if (!isSendableStatus(outbox.status)) {
    return ok(
      {
        alreadySent: true,
        error: `E-račun ${outbox.invoiceNumber} je že v postopku izmenjave (status: ${outbox.status}) — ponovno pošiljanje ni dovoljeno (idempotenca).`,
        status: outbox.status,
        externalRef: outbox.externalRef,
      },
      409,
    )
  }

  // ── 2. ponovna validacija PRAVEGA payloada (dokaz, ki ga bomo poslali) ──
  const parsed = parseEslog(outbox.xmlPayload)
  const inv = parsed.invoice
  if (!inv) {
    return fail('Shranjen XML e-računa ni več berljiv — pošiljanje blokirano (preglejte dokument).', 400)
  }
  const reconstructed: OutgoingEInvoice = {
    invoiceNumber: inv.invoiceNumber || outbox.invoiceNumber,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate || undefined,
    currency: (inv.currency || outbox.currency || 'EUR') as 'EUR',
    seller: { name: inv.supplier.name, taxId: inv.supplier.taxId, country: outbox.country === 'HR' ? 'HR' : 'SI' },
    buyer: {
      name: outbox.receiverName,
      taxId: outbox.receiverTaxId,
      country: (outbox.receiverCountry || outbox.country || 'SI') as 'SI' | 'HR',
    },
    lines: inv.lines.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      unitPriceNet: l.unitPrice,
      vatRate: l.vatRate,
      ...(l.kpdCode ? { kpdCode: l.kpdCode } : {}),
      ...(l.unit ? { unitCode: l.unit } : {}),
      ...(l.lineId ? { lineId: l.lineId } : {}),
    })),
    documentType: outbox.documentType === 'credit_note' ? 'credit_note' : 'invoice',
  }
  const validation = validateOutgoing(reconstructed, outbox.profile === 'ubl-2.1-hr' ? 'ubl-2.1-hr' : 'eslog-2.0-si')
  if (validation.errors.length > 0) {
    return ok({ error: 'E-račun ni veljaven — pošiljanje blokirano.', errors: validation.errors }, 400)
  }

  // ── 3. provider + adapter (register ključavnica) ──
  const resolution = await resolveEInvoiceProvider(outbox.locationId ?? user.loc ?? null)
  if (!resolution.ok || !resolution.adapter) {
    return ok(
      {
        blocked: true,
        error: 'Ponudnik izmenjave e-računov ni konfiguriran — pošiljanje je blokirano.',
        reason: resolution.reason,
      },
      409,
    )
  }

  // ── 4. send z ISTIM idempotencyKey (retry NE ustvari drugega dokumenta) ──
  const t0 = Date.now()
  let result
  try {
    result = await resolution.adapter.send(
      {
        idempotencyKey: outbox.idempotencyKey,
        xml: outbox.xmlPayload,
        receiverTaxId: outbox.receiverTaxId,
        profile: outbox.profile,
      },
      resolution.config,
    )
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : 'Neznana napaka adapterja.' }
  }

  const now = new Date()
  const attempts = outbox.attempts + 1

  if (result.ok && result.externalRef) {
    const to = 'sent'
    const path = resolveStatusPath(outbox.status, to)
    if (!path) {
      return fail(`Prehod statusa ${outbox.status} → ${to} ni dovoljen (življenjski cikel).`, 409)
    }
    await db.eInvoiceOutbox.update({
      where: { id: outbox.id },
      data: {
        status: to,
        externalRef: result.externalRef,
        attempts,
        lastAttemptAt: now,
        sentAt: now,
        lastReason: '',
      },
    })
    await writeAudit(db, {
      userId: user.sub,
      action: 'EINVOICE_STATUS',
      entityType: 'EInvoiceOutbox',
      entityId: outbox.id,
      details: jstr({
        from: outbox.status, to, path,
        origin: 'adapter', provider: resolution.provider, externalRef: result.externalRef,
        attempts, xmlHash: outbox.xmlHash,
      }),
      locationId: outbox.locationId,
    })
    if (resolution.integrationId) {
      await db.integration.update({
        where: { id: resolution.integrationId },
        data: { lastSyncAt: now, lastSyncStatus: 'ok', lastSyncError: '' },
      }).catch(() => null)
      await db.integrationLog.create({
        data: {
          id: nid(),
          integrationId: resolution.integrationId,
          action: 'einvoice-send',
          direction: 'outbound',
          status: 'ok',
          statusCode: 200,
          errorMessage: '',
          durationMs: Date.now() - t0,
          requestData: jstr({ outboxId: outbox.id, idempotencyKey: outbox.idempotencyKey, profile: outbox.profile }).slice(0, 2000),
          responseData: jstr({ ok: true, externalRef: result.externalRef }).slice(0, 2000),
        },
      }).catch(() => null)
    }
    return ok({
      sent: true,
      status: to,
      externalRef: result.externalRef,
      attempts,
      provider: resolution.provider,
    })
  }

  // neuspeh (timeout / napaka adapterja) → failed + EINVOICE_SEND_FAILED (monitoring)
  const reason = String(result.error || 'Pošiljanje ni uspelo.')
  const to = 'failed'
  const path = resolveStatusPath(outbox.status, to)
  if (path) {
    await db.eInvoiceOutbox.update({
      where: { id: outbox.id },
      data: { status: to, attempts, lastAttemptAt: now, lastReason: reason.slice(0, 500) },
    })
    await writeAudit(db, {
      userId: user.sub,
      action: 'EINVOICE_SEND_FAILED',
      entityType: 'EInvoiceOutbox',
      entityId: outbox.id,
      details: jstr({
        from: outbox.status, to, path, origin: 'adapter', provider: resolution.provider,
        reason: reason.slice(0, 500), attempts, invoiceNumber: outbox.invoiceNumber,
      }),
      locationId: outbox.locationId,
    })
  }
  if (resolution.integrationId) {
    await db.integration.update({
      where: { id: resolution.integrationId },
      data: { lastSyncAt: now, lastSyncStatus: 'error', lastSyncError: reason.slice(0, 500) },
    }).catch(() => null)
    await db.integrationLog.create({
      data: {
        id: nid(),
        integrationId: resolution.integrationId,
        action: 'einvoice-send',
        direction: 'outbound',
        status: 'error',
        statusCode: 504,
        errorMessage: reason.slice(0, 500),
        durationMs: Date.now() - t0,
        requestData: jstr({ outboxId: outbox.id, idempotencyKey: outbox.idempotencyKey, profile: outbox.profile }).slice(0, 2000),
        responseData: jstr({ ok: false, error: reason.slice(0, 500) }).slice(0, 2000),
      },
    }).catch(() => null)
  }
  return ok(
    {
      sent: false,
      error: `Pošiljanje e-računa ${outbox.invoiceNumber} ni uspelo: ${reason}`,
      status: to,
      attempts,
      provider: resolution.provider,
    },
    502,
  )
}
