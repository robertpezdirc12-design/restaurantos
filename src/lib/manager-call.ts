/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje iz POS-a: STREŽNIŠKI servis.
 *
 * POONOVA UPORABA obstoječe infrastrukture (issue §4: "ne uvedi druge chat, push
 * ali notification infrastrukture"):
 *  - Web Push: pushEvent/pushNotify/resolvePushTargets iz @/lib/push (matrika
 *    obvestil Integration 'notification-rules' OBSTOJEČI — nova dogodka
 *    MANAGER_CALL / MANAGER_CALL_ESCALATED se pojavita v matriki samodejno);
 *  - audit veriga: writeAudit (hash chain) v isti transakciji kot sprememba;
 *  - nastavitve: Integration vrstica (name='manager-call-settings') — enak
 *    vzorec shranjevanja kot 'notification-rules' / 'push-vapid' (brez DDL).
 *
 * Dostava (issue §4: "brez trditve o prejeto brez dokazila"):
 *  - ob ustvarjanju preštejemo AKTIVNE naročnine ciljnih prejemnikov in zapišemo
 *    deliveryStatus 'sent' (n>0) / 'none' (0) / 'off' (matrika izklopljena) +
 *    notifiedCount — to je POŠTENA evidence "ob koliko naprav smo poskusili",
 *    ne dokaz fizičnega prejema; potrditev je IZKLJUČNO ack akcija vodje.
 *
 * Eskalacija (issue §2): ni pod-dnevnega schedulerja (serverless) → LENO
 * vrednotenje ob vsakem GET (dashboard 15 s polling) — CAS prehod OPEN/ESCALATED
 * → ESCALATED, max MANAGER_CALL_MAX_ESCALATION_ROUNDS, en push na krog.
 */
import { db } from '@/lib/db'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent, resolvePushTargets, pushToEmployees } from '@/lib/push'
import type { PushTarget } from '@/lib/push'
import {
  MANAGER_CALL_TYPE_LABELS_SL,
  parseManagerCallSettings,
  needsEscalation,
  type ManagerCallSettings,
  type ManagerCallType,
} from './manager-call-registry'

/* ─────────────── nastavitve (Integration marker — brez DDL) ─────────────── */

const SETTINGS_MARKER = 'manager-call-settings'

export async function loadManagerCallSettings(): Promise<ManagerCallSettings> {
  const row = await db.integration.findFirst({ where: { name: SETTINGS_MARKER, type: 'other' } })
  if (!row) return parseManagerCallSettings(null)
  try {
    const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
    return parseManagerCallSettings(cfg)
  } catch {
    return parseManagerCallSettings(null)
  }
}

export async function saveManagerCallSettings(settings: ManagerCallSettings): Promise<void> {
  const config = JSON.stringify(settings)
  const existing = await db.integration.findFirst({ where: { name: SETTINGS_MARKER, type: 'other' } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config } })
  } else {
    await db.integration.create({
      data: {
        id: `mcall-set-${Date.now().toString(36)}`,
        name: SETTINGS_MARKER,
        type: 'other',
        provider: 'web-push',
        config,
        isActive: true,
        syncEnabled: false,
      },
    })
  }
}

/* ─────────────── ciljni prejemniki ─────────────── */

/** Bazni cilj prvega klica: vodstvo + admin NA LOKACIJI (matrika lahko omeji/izklopi). */
export function managerCallBaseTarget(locationId: string): PushTarget {
  return { roles: ['manager', 'admin'], locationId }
}

/** Bazni cilj eskalacije: vodstvo + admin + lastnik (matrika lahko omeji/izklopi). */
export function managerCallEscalationTarget(locationId: string): PushTarget {
  return { roles: ['manager', 'admin', 'owner'], locationId }
}

/** Slovensko telo pusha (brez opombe/gosta — minimalna informacija, issue §1). */
export function managerCallPushBody(type: ManagerCallType, requestorName: string, tableNumber?: number | null, orderNumber?: string | null): string {
  let body = `${MANAGER_CALL_TYPE_LABELS_SL[type]} · ${requestorName}`
  if (typeof tableNumber === 'number' && tableNumber > 0) body += ` · miza ${tableNumber}`
  if (orderNumber) body += ` · naročilo #${orderNumber}`
  return body
}

/**
 * POŠTEN dostavni zapis: prešteje aktivne naročbine KONČNEGA (matrika-rezanega)
 * cilja in vrne { deliveryStatus, notifiedCount }. 'off' = matrika izklopljena.
 * (Ne trdi prejema — samo "poskusili smo dostaviti na N aktivnih naprav".)
 */
export async function managerCallDelivery(target: PushTarget, eventType: 'MANAGER_CALL' | 'MANAGER_CALL_ESCALATED'): Promise<{ deliveryStatus: 'sent' | 'none' | 'off'; notifiedCount: number }> {
  try {
    const resolved = await resolvePushTargets(eventType, target)
    if (!resolved) return { deliveryStatus: 'off', notifiedCount: 0 }
    const subs = await db.pushSubscription.count({
      where: {
        isActive: true,
        ...(resolved.employeeIds && resolved.employeeIds.length > 0 ? { employeeId: { in: resolved.employeeIds } } : {}),
        ...(resolved.roles && resolved.roles.length > 0
          ? { Employee: { role: { in: resolved.roles }, ...(resolved.locationId ? { locationId: resolved.locationId } : {}) } }
          : { Employee: resolved.locationId ? { locationId: resolved.locationId } : {} }),
      },
    })
    return subs > 0 ? { deliveryStatus: 'sent', notifiedCount: subs } : { deliveryStatus: 'none', notifiedCount: 0 }
  } catch {
    return { deliveryStatus: 'none', notifiedCount: 0 }
  }
}

/* ─────────────── lena eskalacija (GET poll sproži) ─────────────── */

/**
 * Eskaliraj zapadle neprevzete klice (CAS v transakciji + audit veriga + push
 * PO commitu). Omejeno na MANAGER_CALL_MAX_ESCALATION_ROUNDS krogov na klic —
 * "ne pošiljaj neomejene množice push obvestil" (issue §2).
 * Vrne število izvedenih krogov (diagnostika; nikoli ne meče).
 */
export async function escalateOverdueManagerCalls(locationId?: string | null): Promise<number> {
  try {
    const settings = await loadManagerCallSettings()
    const now = new Date()
    const candidates = await db.managerCall.findMany({
      where: {
        status: { in: ['OPEN', 'ESCALATED'] },
        acknowledgedAt: null,
        escalatedCount: { lt: 3 },
        ...(locationId ? { locationId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })
    const due = candidates.filter((c) => needsEscalation(c, now, settings.ackTimeoutMinutes))
    let rounds = 0
    for (const c of due) {
      const ok = await db.$transaction(async (tx) => {
        // CAS: samo če je klic medtem ostal neprevzet (sočasen ack vodje zmaga)
        const upd = await tx.managerCall.updateMany({
          where: { id: c.id, status: { in: ['OPEN', 'ESCALATED'] }, acknowledgedAt: null },
          data: { status: 'ESCALATED', escalatedCount: { increment: 1 }, lastEscalatedAt: now },
        })
        if (upd.count !== 1) return false
        await writeAudit(tx, {
          userId: null, // samodejni krog (časovni pogoj) — ni človeškega izvajalca
          action: 'MANAGER_CALL_ESCALATED',
          entityType: 'ManagerCall',
          entityId: c.id,
          details: jstr({
            round: c.escalatedCount + 1,
            minutesOpen: Math.round((now.getTime() - c.createdAt.getTime()) / 60_000),
            auto: true,
          }),
          locationId: c.locationId,
        })
        return true
      })
      if (!ok) continue
      rounds++
      // push PO commitu — eskalacijski dogodek gre prek SVOJE matrika vrstice
      void pushEvent(
        'MANAGER_CALL_ESCALATED',
        {
          title: 'Eskalacija: klic vodje',
          body: managerCallPushBody(c.type as ManagerCallType, c.requestorName, c.tableNumber, c.orderNumber),
          url: '/dashboard?tab=pregled',
          tag: `mcall-esc-${c.id}`,
        },
        managerCallEscalationTarget(c.locationId),
      )
    }
    return rounds
  } catch {
    return 0 // eskalacija NIKOLI ne ruši bralnega toka
  }
}

/* ─────────────── potrditveni push prosilcu (direkten odgovor) ─────────────── */

/** Push prosilcu ob ack/resolve/cancel (pushToEmployees — obstoječi wrapper). */
export function notifyRequestor(
  requestorId: string,
  message: { title: string; body: string },
): void {
  pushToEmployees([requestorId], { ...message, url: '/dashboard?tab=pregled' })
}

/* ─────────────── serializacija (API oblika) ─────────────── */

type ManagerCallRow = {
  id: string
  locationId: string
  requestorId: string
  requestorName: string
  type: string
  status: string
  note: string
  orderId: string | null
  orderNumber: string | null
  tableNumber: number | null
  deliveryStatus: string
  notifiedCount: number
  escalatedCount: number
  lastEscalatedAt: Date | null
  acknowledgedAt: Date | null
  acknowledgedById: string | null
  acknowledgedByName: string | null
  inProgressAt: Date | null
  inProgressById: string | null
  resolvedAt: Date | null
  resolvedById: string | null
  resolvedByName: string | null
  resolutionNote: string
  cancelledAt: Date | null
  cancelledById: string | null
  idempotencyKey: string | null
  createdAt: Date
}

/** API oblika + IZPELJANI časi (issue §4: poročilo pokaže čas do potrditve/rešitve). */
export function serializeManagerCall(c: ManagerCallRow, settings: ManagerCallSettings, now = new Date()) {
  const mins = (a: Date | null, b: Date) => (a ? Math.round(((a.getTime() - b.getTime()) / 60_000) * 10) / 10 : null)
  return {
    id: c.id,
    locationId: c.locationId,
    requestorId: c.requestorId,
    requestorName: c.requestorName,
    type: c.type,
    status: c.status,
    note: c.note,
    orderId: c.orderId,
    orderNumber: c.orderNumber,
    tableNumber: c.tableNumber,
    deliveryStatus: c.deliveryStatus,
    notifiedCount: c.notifiedCount,
    escalatedCount: c.escalatedCount,
    lastEscalatedAt: c.lastEscalatedAt,
    acknowledgedAt: c.acknowledgedAt,
    acknowledgedById: c.acknowledgedById,
    acknowledgedByName: c.acknowledgedByName,
    inProgressAt: c.inProgressAt,
    inProgressById: c.inProgressById,
    resolvedAt: c.resolvedAt,
    resolvedById: c.resolvedById,
    resolvedByName: c.resolvedByName,
    resolutionNote: c.resolutionNote,
    cancelledAt: c.cancelledAt,
    cancelledById: c.cancelledById,
    createdAt: c.createdAt,
    /** izpeljano: minute od ustvarjanja (aktiven klic) */
    ageMinutes: (c.status === 'RESOLVED' || c.status === 'CANCELLED')
      ? null
      : Math.round(((now.getTime() - c.createdAt.getTime()) / 60_000) * 10) / 10,
    /** izpeljano: minute do potrditve (ack − create) */
    minutesToAcknowledge: mins(c.acknowledgedAt, c.createdAt),
    /** izpeljano: minute do rešitve (resolve − create) */
    minutesToResolve: mins(c.resolvedAt, c.createdAt),
    /** izpeljano: aktiven + brez potrditve + čez ackTimeout */
    overdue:
      c.acknowledgedAt === null &&
      (c.status === 'OPEN' || c.status === 'ESCALATED') &&
      now.getTime() - c.createdAt.getTime() > settings.ackTimeoutMinutes * 60_000,
  }
}
