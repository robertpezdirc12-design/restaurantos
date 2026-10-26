import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'
import { sendReminder } from '@/lib/reminders'

/**
 * OPS-7 (v1.69.0) — SERIJSKI OPOMNIKI (batch, OpenTable vzorec).
 *
 * POST /api/reservations/reminders  body: {hoursBefore?: number (privzeto 24)}
 *  - perm `reservations.manage`
 *  - najde PRIHAJAJOČE rezervacije v oknu [zdaj, zdaj + hoursBefore], ki še nimajo
 *    opomnika (reminderSent=false), in jih pošlje (e-mail/SMS, fail-soft per rezervacija)
 *  - statusovni filter je SAMO `confirmed`: `ReservationStatus` (prisma/schema.prisma)
 *    pozna confirmed|seated|completed|cancelled|no_show — 'pending' NE obstaja in ga
 *    Postgres zavrne; 'seated' je brez veze (gost je že pri mizi). `tests/schema-enum-literals.test.ts`
 *    to prepreči vrniti, ker SQLite enumov ne validira.
 *  - vrne poročilo (poslanih/napak/prezrtih brez kontaktov)
 *  - namenjen gumbu "Pošlji vse opomnike" + prihodnjemu cronu
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const hoursBefore = Math.max(1, Math.min(72, Number(body?.hoursBefore) || 24))

  const now = new Date()
  const until = new Date(now.getTime() + hoursBefore * 3600 * 1000)

  const due = await db.reservation.findMany({
    where: {
      dateTime: { gte: now, lte: until },
      reminderSent: false,
      status: 'confirmed',
    },
    orderBy: { dateTime: 'asc' },
    take: 50,
  })
  if (due.length === 0) return ok({ processed: 0, sent: 0, skipped: 0, errors: 0, details: [] })

  const locationIds = [...new Set(due.map((d) => d.locationId).filter((x): x is string => Boolean(x)))]
  const locations = await db.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true, country: true } })
  const locMap = new Map(locations.map((l) => [l.id, l]))

  const details: { id: string; ok: boolean; email: string; sms: string }[] = []
  let sent = 0
  let errors = 0
  let skipped = 0

  for (const r of due) {
    const loc = locMap.get(r.locationId ?? '')
    const scoped = await guardResource(user, r.locationId)
    if (scoped) { skipped += 1; continue }
    if (!r.customerEmail && !r.customerPhone) { skipped += 1; continue }
    const locale = loc?.country === 'HR' ? 'hr' : 'sl'
    const result = await sendReminder(
      {
        email: r.customerEmail,
        phone: r.customerPhone,
        guestName: r.customerName,
        restaurantName: loc?.name || 'RestaurantOS',
        when: r.dateTime,
        partySize: r.partySize,
        note: r.notes,
      },
      locale,
      r.locationId,
    )
    details.push({ id: r.id, ok: result.anySent, email: result.email.detail, sms: result.sms.detail })
    if (result.anySent) sent += 1
    else errors += 1
    const __aId = nid()
    try {
      await db.$transaction(async (tx) => {
        if (result.anySent) {
          await tx.reservation.update({ where: { id: r.id }, data: { reminderSent: true, reminderSentAt: new Date() } })
        }
        const __chain = await auditChainFields(tx, {
          action: 'RESERVATION_REMINDER',
          entityType: 'Reservation',
          entityId: r.id,
          details: jstr({ batch: true, email: result.email, sms: result.sms, by: user.name }),
          locationId: r.locationId,
          id: __aId,
        })
        await tx.auditLog.create({
          data: { ...__chain, id: __aId, userId: user.sub, action: 'RESERVATION_REMINDER', entityType: 'Reservation', entityId: r.id, details: jstr({ batch: true, email: result.email, sms: result.sms, by: user.name }), locationId: r.locationId },
        })
      })
    } catch { /* audit fail ne sme prekiniti serije */ }
  }

  return ok({ processed: due.length, sent, skipped, errors, details })
}
