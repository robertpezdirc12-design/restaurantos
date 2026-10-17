import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { resolveStatusPath, EINVOICE_RETRYABLE, EINVOICE_TERMINAL } from '@/lib/einvoice-lifecycle'
import { resolveEInvoiceProvider } from '@/lib/einvoice-adapter'

/**
 * Issue #4 (P1, v1.125.0) — VAREN retry odhodnega B2B e-računa.
 *
 * POST /api/einvoices/[id]/retry — dovoljen SAMO iz failed/rejected/needs_review
 * (sporni status prikaže »potrebna razrešitev«, ne »uspešno« — issue §G).
 *
 * Zaporedje (issue §P1-C: retry ne ustvari drugega računa zunanjega dokumenta):
 *  1. externalRef obstaja → adapter.probeStatus NAJPREJ (varen retry po preverbi):
 *     terminal stanje pri ponudniku → lokalna uskladitev BREZ ponovnega pošiljanja;
 *  2. sicer (neznan/neskončen status pri ponudniku) → send z ISTIM idempotencyKey
 *     → status 'sent' (pot prek queued), attempts+1, ISTI externalRef (deterministični
 *     ključ → pri ponudniku deduplikacija);
 *  3. timeout → 'failed' + EINVOICE_SEND_FAILED (monitoring OR).
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
      id: true, status: true, externalRef: true, idempotencyKey: true, attempts: true,
      xmlPayload: true, xmlHash: true, receiverTaxId: true, profile: true, invoiceNumber: true,
      locationId: true, lastReason: true,
    },
  })
  if (!outbox) return fail('E-račun ni v vašem obsegu ali ne obstaja.', 404)

  if (!EINVOICE_RETRYABLE.includes(outbox.status as never)) {
    return ok(
      {
        error: `Ponovni poskus je dovoljen samo iz statusov failed/rejected/needs_review (trenutni: ${outbox.status}).`,
        status: outbox.status,
        externalRef: outbox.externalRef,
      },
      409,
    )
  }

  const resolution = await resolveEInvoiceProvider(outbox.locationId ?? user.loc ?? null)
  if (!resolution.ok || !resolution.adapter) {
    return ok(
      {
        blocked: true,
        error: 'Ponudnik izmenjave e-računov ni konfiguriran — retry je blokiran.',
        reason: resolution.reason,
      },
      409,
    )
  }
  const adapter = resolution.adapter

  const now = new Date()
  const currentStatus = outbox.status
  const t0 = Date.now()

  // ── 1. varen retry: če externalRef obstaja, NAJPREJ preveri status pri ponudniku ──
  if (outbox.externalRef) {
    let probe: { status?: string; reason?: string } = {}
    try {
      probe = await adapter.probeStatus(outbox.externalRef, resolution.config)
    } catch (e) {
      probe = { reason: e instanceof Error ? e.message : 'Napaka poizvedbe statusa.' }
    }
    const probeStatus = typeof probe.status === 'string' && probe.status ? probe.status : undefined
    // terminal pri ponudniku → lokalna uskladitev BREZ ponovnega pošiljanja
    if (probeStatus && EINVOICE_TERMINAL.includes(probeStatus as never)) {
      const path = resolveStatusPath(currentStatus, probeStatus)
      if (path) {
        await db.eInvoiceOutbox.update({
          where: { id: outbox.id },
          data: { status: probeStatus, lastReason: (probe.reason || 'Usklajeno s statusom ponudnika.').slice(0, 500) },
        })
        await writeAudit(db, {
          userId: user.sub,
          action: 'EINVOICE_STATUS',
          entityType: 'EInvoiceOutbox',
          entityId: outbox.id,
          details: jstr({
            from: currentStatus, to: probeStatus, path, origin: 'adapter',
            source: 'probe', provider: resolution.provider, externalRef: outbox.externalRef,
          }),
          locationId: outbox.locationId,
        })
        return ok({
          retried: false,
          reconciled: true,
          status: probeStatus,
          externalRef: outbox.externalRef,
          note: 'Dokument je pri ponudniku že v končnem stanju — lokalni status je usklajen, ponovno pošiljanje NI izvedeno.',
        })
      }
    }
    // ne-terminal/neznan → nadaljuj s send (zapis opombe o sondo v audit details)
  }

  // ── 2. send z ISTIM idempotencyKey (drugi zunanjni dokument NI možen) ──
  let result
  try {
    result = await adapter.send(
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

  const attempts = outbox.attempts + 1

  if (result.ok && result.externalRef) {
    const to = 'sent'
    const path = resolveStatusPath(currentStatus, to)
    if (!path) return fail(`Prehod statusa ${currentStatus} → ${to} ni dovoljen (življenjski cikel).`, 409)
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
        from: currentStatus, to, path, origin: 'adapter', provider: resolution.provider,
        externalRef: result.externalRef, attempts, retry: true, idempotencyKey: outbox.idempotencyKey,
      }),
      locationId: outbox.locationId,
    })
    if (resolution.integrationId) {
      await db.integrationLog.create({
        data: {
          id: nid(),
          integrationId: resolution.integrationId,
          action: 'einvoice-retry',
          direction: 'outbound',
          status: 'ok',
          statusCode: 200,
          errorMessage: '',
          durationMs: Date.now() - t0,
          requestData: jstr({ outboxId: outbox.id, retry: true, idempotencyKey: outbox.idempotencyKey }).slice(0, 2000),
          responseData: jstr({ ok: true, externalRef: result.externalRef }).slice(0, 2000),
        },
      }).catch(() => null)
    }
    return ok({
      retried: true,
      status: to,
      externalRef: result.externalRef,
      attempts,
      provider: resolution.provider,
      note: 'Ponovni poskus je uspel — ISTI dokument pri ponudniku (idempoten ključ).',
    })
  }

  // ── 3. timeout/napaka → failed + EINVOICE_SEND_FAILED (monitoring) ──
  const reason = String(result.error || 'Ponovni poskus ni uspel.')
  const to = 'failed'
  const path = resolveStatusPath(currentStatus, to)
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
        from: currentStatus, to, path, origin: 'adapter', provider: resolution.provider,
        reason: reason.slice(0, 500), attempts, retry: true, invoiceNumber: outbox.invoiceNumber,
      }),
      locationId: outbox.locationId,
    })
  }
  return ok(
    {
      retried: false,
      error: `Ponovni poskus e-računa ${outbox.invoiceNumber} ni uspel: ${reason}`,
      status: to,
      attempts,
      provider: resolution.provider,
    },
    502,
  )
}

export const dynamic = 'force-dynamic'
