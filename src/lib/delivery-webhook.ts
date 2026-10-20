/**
 * v1.159.0 — skupno jedro dostavnih webhookov (Glovo/Wolt).
 *
 * Najdba: izbira integracije je bila `findFirst(provider)` brez lokacije in
 * brez determinističnega vrstnega reda, secret pa se je bral z DRUGIM
 * findFirst klicem. Ob dveh aktivnih integracijah iste platforme sta lahko
 * podpis in lokacija pripadala različnima vrsticama; idempotenca ni ločila
 * lokacij; preslikava artiklov je iskala po celem katalogu.
 *
 * Pogodba:
 *  - eksplicitna pot /webhook/[provider]/[integration] → natanko ta
 *    integracija (id + provider + isActive), njen secret in njena lokacija;
 *  - stara pot /webhook/[provider] → ena aktivna integracija = ona; več njih
 *    = podpis mora zadeti NATANKO eno (0 → 401, 2+ → 409 brez zapisa);
 *  - brez integracij ostane env secret (enonajemniška legacy namestitev);
 *  - podpis (HMAC-SHA256, timing-safe) je preverjen PRED branjem JSON-a;
 *  - idempotenca je vezana na lokacijo; stari ključi brez lokacije se še
 *    prepoznajo (replay/preklic), a le za isto lokacijo;
 *  - artikli se rešujejo znotraj menija ciljne lokacije.
 */
import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { nid, jstr, num } from '@/lib/map'
import { createOrderCore, OrderError, claimMutableOrder } from '@/lib/ops'
import {
  rateLimit, verifyWebhookSignature, deliveryEnvSecret, maskPhone,
  mapGlovoPayload, mapWoltPayload, validateMapped,
  webhookIdempotencyKey, legacyWebhookIdempotencyKey,
  getDeliveryAutoAcceptConfig, autoAcceptsProvider, estimatedTimeFromMinutes,
} from '@/lib/delivery'
import { auditChainFields } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'

const PROVIDERS = new Set(['glovo', 'wolt'])

type IntegrationRef = { id: string | null; locationId: string | null }

type Resolution =
  | { kind: 'ok'; integration: IntegrationRef }
  | { kind: 'unconfigured'; integrationId: string | null }
  | { kind: 'unauthorized'; integrationId: string | null }
  | { kind: 'ambiguous'; integrationIds: string[] }
  | { kind: 'not_found' }

/**
 * Katera integracija je naslovnik? Eksplicitni segment je avtoritativen;
 * stara pot zahteva enolično ujemanje podpisa med aktivnimi integracijami.
 */
async function resolveIntegration(
  provider: string, ref: string | null, raw: string, signature: string | null,
): Promise<Resolution> {
  const env = deliveryEnvSecret(provider)

  if (ref) {
    const row = await db.integration.findFirst({
      where: { id: ref, provider, isActive: true },
      select: { id: true, locationId: true, apiSecret: true },
    })
    if (!row) return { kind: 'not_found' }
    const secret = row.apiSecret || env
    if (!secret) return { kind: 'unconfigured', integrationId: row.id }
    if (!verifyWebhookSignature(raw, signature, secret)) {
      return { kind: 'unauthorized', integrationId: row.id }
    }
    return { kind: 'ok', integration: { id: row.id, locationId: row.locationId } }
  }

  const rows = await db.integration.findMany({
    where: { provider, isActive: true },
    select: { id: true, locationId: true, apiSecret: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  if (rows.length === 0) {
    if (!env) return { kind: 'unconfigured', integrationId: null }
    if (!verifyWebhookSignature(raw, signature, env)) return { kind: 'unauthorized', integrationId: null }
    return { kind: 'ok', integration: { id: null, locationId: null } }
  }

  const matches = rows.filter((r) => {
    const secret = r.apiSecret || env
    return !!secret && verifyWebhookSignature(raw, signature, secret)
  })
  if (matches.length === 0) {
    const configured = rows.some((r) => !!(r.apiSecret || env))
    return configured
      ? { kind: 'unauthorized', integrationId: rows.length === 1 ? rows[0].id : null }
      : { kind: 'unconfigured', integrationId: rows.length === 1 ? rows[0].id : null }
  }
  if (matches.length > 1) return { kind: 'ambiguous', integrationIds: matches.map((m) => m.id) }
  return {
    kind: 'ok',
    integration: { id: matches[0].id, locationId: matches[0].locationId },
  }
}

/** Zaposleni, pod katerim gre platformsko naročilo (sistemski vir, FK zahteva obstoj). */
async function systemEmployeeId(): Promise<string | null> {
  const mgr = await db.employee.findFirst({
    where: { role: { in: ['admin', 'manager'] }, status: 'active' },
    select: { id: true },
  })
  if (mgr) return mgr.id
  const any = await db.employee.findFirst({ select: { id: true } })
  return any?.id ?? null
}

async function logIntegration(
  provider: string, integrationId: string | null, action: string, status: string,
  statusCode: number, errorMessage: string, durationMs: number, requestData: unknown,
) {
  if (!integrationId) return
  await db.integrationLog.create({
    data: {
      id: nid(),
      integrationId,
      action,
      direction: 'inbound',
      status,
      statusCode,
      errorMessage: errorMessage.slice(0, 500),
      durationMs,
      requestData: jstr(requestData).slice(0, 2000),
      responseData: '{}',
    },
  }).catch(() => null)
}

async function writeAudit(
  userId: string, action: string, entityType: string, entityId: string | null, details: unknown,
) {
  // 33-c: chain polja (tamper-evidentna veriga); veriga je globalna — locationId ostane '' (webhook nima konteksta akterja)
  const id = nid()
  const chain = await auditChainFields(db, { id, action, entityType, entityId: entityId ?? '', details: jstr(details).slice(0, 2000) })
  await db.auditLog.create({
    data: { ...chain, id, userId, action, entityType, entityId, details: jstr(details).slice(0, 2000) },
  }).catch(() => null)
}

export async function handleDeliveryWebhook(
  req: NextRequest,
  providerSegment: string,
  integrationRef: string | null,
): Promise<Response> {
  const t0 = Date.now()
  const p = providerSegment?.toLowerCase() ?? ''
  if (!PROVIDERS.has(p)) return fail('Neznana dostavna platforma.', 404)

  // Rate limiting (javni endpoint)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!(await rateLimit(`${p}:${ip}`))) {
    return fail('Preveč zahtev — rate limit.', 429)
  }

  // Podpis preverjen PRED čim koli drugim (raw body!)
  const raw = await req.text()
  const sigHeader = req.headers.get('x-glovo-signature') || req.headers.get('x-wolt-signature')
    || req.headers.get('x-signature') || req.headers.get('x-hub-signature-256')

  const resolution = await resolveIntegration(p, integrationRef, raw, sigHeader)
  if (resolution.kind === 'not_found') {
    return fail('Neznana dostavna integracija.', 404)
  }
  if (resolution.kind === 'unconfigured') {
    await logIntegration(p, resolution.integrationId, 'webhook', 'skipped', 503,
      'Webhook secret ni nastavljen (Integration.apiSecret ali env).', Date.now() - t0, null)
    return fail('Dostavna integracija ni konfigurirana.', 503)
  }
  if (resolution.kind === 'unauthorized') {
    await logIntegration(p, resolution.integrationId, 'webhook', 'error', 401,
      'Neveljaven/manjkajoč podpis.', Date.now() - t0, null)
    await writeAudit('system', 'DELIVERY_WEBHOOK_REJECTED', 'Integration', resolution.integrationId, {
      provider: p, reason: 'invalid_signature', ip,
    })
    return fail('Neveljaven podpis.', 401)
  }
  if (resolution.kind === 'ambiguous') {
    await logIntegration(p, null, 'webhook', 'error', 409,
      'Podpis se ujema z več aktivnimi integracijami — pot ni enolična.', Date.now() - t0,
      { integrations: resolution.integrationIds })
    await writeAudit('system', 'DELIVERY_WEBHOOK_REJECTED', 'Integration', null, {
      provider: p, reason: 'ambiguous_integration', integrationIds: resolution.integrationIds, ip,
    })
    return fail('Dostavna integracija ni enolična — uporabite /api/delivery/webhook/<platforma>/<integracija>.', 409)
  }

  const integration = resolution.integration
  const integrationId = integration.id
  // Ciljna lokacija: integracija ima prednost; brez nje dovoljeni (dokumentirani)
  // fallback na prvo lokacijo — deterministično po createdAt, da sta preslikava
  // artiklov in naročilo VEDNO na isti lokaciji.
  const fallback = integration.locationId ? null : await db.location.findFirst({
    orderBy: { createdAt: 'asc' }, select: { id: true },
  })
  const locationId = integration.locationId ?? fallback?.id ?? null
  if (!locationId) {
    await logIntegration(p, integrationId, 'order.create', 'error', 503, 'Ni lokacije za platformsko naročilo.', Date.now() - t0, null)
    return fail('Sistem ni pripravljen (ni lokacije).', 503)
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    await logIntegration(p, integrationId, 'webhook', 'error', 400, 'Payload ni veljaven JSON.', Date.now() - t0, null)
    return fail('Payload ni veljaven JSON.', 400)
  }

  try {
    // Preslikava payloada (tolerantna, rekonstruirana) — artikli SAMO iz menija ciljne lokacije
    const mapped = p === 'glovo' ? await mapGlovoPayload(body, locationId) : await mapWoltPayload(body, locationId)

    // Platformski status dogodki (npr. preklic s strani platforme)
    const evtStatus = String(
      body.status
      ?? (body.order as Record<string, unknown> | undefined)?.status
      ?? body.event ?? '',
    ).toLowerCase()

    const idem = webhookIdempotencyKey(p as 'glovo' | 'wolt', mapped.platformOrderId, locationId)
    const legacyIdem = legacyWebhookIdempotencyKey(p as 'glovo' | 'wolt', mapped.platformOrderId)

    if (evtStatus.includes('cancel')) {
      // Novi ključ (lokacija) pred starim (brez lokacije): stare vrstice se
      // prepoznajo za preklic, a cross-location zaščita ostane v veljavi.
      const existing = await db.order.findUnique({ where: { idempotencyKey: idem }, select: { id: true, status: true, locationId: true } })
        ?? await db.order.findUnique({ where: { idempotencyKey: legacyIdem }, select: { id: true, status: true, locationId: true } })
      if (existing && existing.status !== 'paid') {
        // Issue #4 D6: preklic velja SAMO za naročilo te lokacije (cross-location zaščita)
        if (integration.locationId && existing.locationId && existing.locationId !== integration.locationId) {
          await writeAudit('system', 'DELIVERY_CANCEL_BLOCKED', 'Order', existing.id, {
            provider: p, reason: 'cross_location', orderLocation: existing.locationId, integrationLocation: integration.locationId,
          })
          await logIntegration(p, integrationId, 'order.cancelled', 'error', 403, 'Preklic zavrnjen — naročilo pripada drugi lokaciji.', Date.now() - t0, { platformOrderId: mapped.platformOrderId })
          return fail('Preklic zavrnjen — naročilo pripada drugi lokaciji.', 403)
        }
        // v1.148.0 (isti razred napak kot audit #10/#12): `status !== 'paid'` je
        // bil prebran ZUNAJ, zapis pa brezpogojen → plačilo, ki je commitnilo med
        // branjem in updateom, je dobilo 'cancelled' naročilo z EOR računom. Claim
        // ovrednoti stanje OB ZAPISU (isti beli seznam kot kanonični preklic).
        const claim = await claimMutableOrder(db, existing.id, {
          status: 'cancelled', cancelReason: `Preklic prek ${p} webhooka`, cancelledAt: new Date(),
        })
        if (!claim.ok) {
          // ŽE zaključeno (plačano/preklicano) ali spremenjeno po branju: webhook je
          // idempotentno IGNORIRAN (2xx, da ponudnik ne obuja), dostavni status in
          // revizijski zapis preklica pa ostaneta nedotaknjena.
          await logIntegration(p, integrationId, 'webhook', 'success', 200, '', Date.now() - t0, {
            note: 'cancel ignoriran — naročilo je medtem zaključeno', platformOrderId: mapped.platformOrderId,
          })
          return ok({ received: true, ignored: true })
        }
        await db.deliveryInfo.updateMany({ where: { Order: { id: existing.id } }, data: { status: 'cancelled' } })
        await writeAudit('system', 'DELIVERY_ORDER_CANCELLED', 'Order', existing.id, { provider: p })
        await logIntegration(p, integrationId, 'order.cancelled', 'success', 200, '', Date.now() - t0, { platformOrderId: mapped.platformOrderId })
        return ok({ received: true, cancelled: true })
      }
      // Dnevnik napak razlikuje OBE ignorirani poti: »brez naročila« je lahko tudi
      // zamujen create, »že plačano« pa je finančni podatek, ki ga mora operater
      // videti (platforma je preklicala plačan order — to je izjema, ne šum).
      await logIntegration(p, integrationId, 'webhook', 'success', 200, '', Date.now() - t0, {
        note: existing ? 'cancel ignoriran — naročilo je že plačano' : 'cancel brez obstoječega naročila',
        platformOrderId: mapped.platformOrderId,
      })
      return ok({ received: true, ignored: true })
    }

    const invalid = validateMapped(mapped)
    if (invalid) {
      await logIntegration(p, integrationId, 'order.create', 'error', 422, invalid, Date.now() - t0, body)
      await writeAudit('system', 'DELIVERY_WEBHOOK_ERROR', 'Integration', integrationId, {
        provider: p, reason: 'mapping', detail: invalid,
      })
      return fail(invalid, 422)
    }

    // Varnost selitve (v1.159.0): vrstica, ustvarjena pred lokalno vezavo
    // ključa, se prepozna kot replay — a samo, če pripada ISTI lokaciji.
    // Tuj ključ iste platforme je posledica starega trčenja in se ignorira.
    const legacyExisting = await db.order.findUnique({
      where: { idempotencyKey: legacyIdem },
      select: { id: true, locationId: true, orderNumber: true },
    })
    if (legacyExisting && legacyExisting.locationId === locationId) {
      await logIntegration(p, integrationId, 'order.create', 'success', 200, '', Date.now() - t0, {
        replayed: true, legacyKey: true, platformOrderId: mapped.platformOrderId,
      })
      return ok({ received: true, replayed: true, orderNumber: legacyExisting.orderNumber })
    }

    const employeeId = await systemEmployeeId()
    if (!employeeId) {
      await logIntegration(p, integrationId, 'order.create', 'error', 503, 'Ni zaposlenega za sistemski vir.', Date.now() - t0, null)
      return fail('Sistem ni pripravljen (ni zaposlenih).', 503)
    }

    // OPS-9 val 3 (v1.76.0): auto-accept — konfiguracija (Integration 'delivery-auto-accept')
    // se prebere PO preverjanju podpisa. Vklopljen ponudnik → naročilo vstopi kot 'confirmed'
    // (isti prehod pending→confirmed, ki ga sicer klikne osebstvo); izklopljen → ostane
    // 'pending' za ročno potrditev. Brez konfiguracije = defaults (enabled, vsi ponudniki)
    // → nazajkompatibilno z dosedanjim obnašanjem ('confirmed' ob prihodu).
    const autoCfg = await getDeliveryAutoAcceptConfig()
    const autoAccept = autoAcceptsProvider(autoCfg, p)

    const { order, replayed } = await createOrderCore({
      employeeId,
      // Eksplicitna ciljna lokacija (integracija ali deterministični fallback) —
      // ista lokacija, po kateri je preslikava artiklov že iskala.
      locationId,
      items: mapped.items,
      type: 'DELIVERY',
      // Issue #9 (v1.119.0): platformsko naročilo nosi vir 'delivery' (četrti vir
      // poleg pos/qr/kiosk — isti kanonični Order pipeline). Replay-context
      // varovalka (ops.ts) primerja tudi orderSource, zato podvojeni webhook
      // ostane idempotenten pri ISTEM viru.
      orderSource: 'delivery',
      note: mapped.note,
      clientOperationId: idem,
      delivery: {
        address: mapped.address,
        city: mapped.city,
        postCode: mapped.postCode,
        recipientName: mapped.recipientName,
        recipientPhone: mapped.recipientPhone,
        deliveryInstructions: mapped.instructions,
        deliveryFee: num(mapped.deliveryFee),
        packagingFee: num(mapped.packagingFee),
        status: autoAccept ? 'confirmed' : 'pending',
        // OPS-9 val 3: provider ETA (če ga platforma pošlje) → DeliveryInfo.estimatedTime
        ...(estimatedTimeFromMinutes(mapped.estimatedMinutes) ? { estimatedTime: estimatedTimeFromMinutes(mapped.estimatedMinutes) as Date } : {}),
      },
    })

    if (replayed) {
      // Idempotenten replay — podvojeni webhook NE ustvari dvojnega naročila
      await logIntegration(p, integrationId, 'order.create', 'success', 200, '', Date.now() - t0, { replayed: true, platformOrderId: mapped.platformOrderId })
      return ok({ received: true, replayed: true, orderNumber: order.orderNumber })
    }

    await writeAudit('system', 'DELIVERY_ORDER_RECEIVED', 'Order', order.id, {
      provider: p, platformOrderId: mapped.platformOrderId, orderNumber: order.orderNumber,
      total: order.total, phone: maskPhone(mapped.recipientPhone), items: mapped.items.length,
    })
    // OPS-9 val 3: audit note for the automatic acceptance (pending → confirmed via config)
    if (autoAccept) {
      await writeAudit('system', 'DELIVERY_AUTO_ACCEPT', 'Order', order.id, {
        provider: p, platformOrderId: mapped.platformOrderId, orderNumber: order.orderNumber,
        note: 'auto-accepted at webhook (delivery-auto-accept config)',
      })
    }
    // OPS-8 val 2 (v1.72.0): push to waiters/management on new delivery-platform order
    // (via notification matrix; fire-and-forget — webhook stays a critical path)
    void pushEvent('DELIVERY_NEW', {
      title: 'Novo dostavno naročilo',
      body: `${p === 'glovo' ? 'Glovo' : 'Wolt'}${order.orderNumber ? ` · #${order.orderNumber}` : ''} · ${mapped.items.length} postavk · ${order.total ?? ''} €`,
      url: '/dashboard?tab=dostava',
      tag: `delivery-${order.id}`,
    }, { roles: ['waiter', 'staff', 'manager'], locationId })
    await logIntegration(p, integrationId, 'order.create', 'success', 200, '', Date.now() - t0, { platformOrderId: mapped.platformOrderId })
    return ok({ received: true, orderNumber: order.orderNumber, orderId: order.id })
  } catch (e) {
    const status = e instanceof OrderError ? 422 : 500
    const msg = e instanceof Error ? e.message : 'Neznana napaka.'
    await logIntegration(p, integrationId, 'order.create', 'error', status, msg, Date.now() - t0, body)
    await writeAudit('system', 'DELIVERY_WEBHOOK_ERROR', 'Integration', integrationId, { provider: p, error: msg })
    return fail(msg, status)
  }
}
