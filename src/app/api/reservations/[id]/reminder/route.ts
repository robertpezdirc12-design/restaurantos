import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { sendReminder } from '@/lib/reminders'

/**
 * OPS-7 (v1.69.0) — OPOMNIK REZERVACIJE (e-mail/SMS, OpenTable vzorec).
 *
 * POST /api/reservations/[id]/reminder  → pošlji opomnik ZDAJ (e-mail + SMS po podatkih gosta)
 *  - perm `reservations.manage`
 *  - nastavi reminderSent/reminderSentAt (idempotentno: že poslan → 409, prek ?force=1 je mogoče ponoviti)
 *  - fail-soft: napaka SMTP/SMS ne zruši zahtevka — rezultat po kanalih gre v odgovor + audit
 *  - lokacija rezervacije DOLOČA jezik (HR → hr-HR, ostalo → sl-SI)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const force = req.nextUrl.searchParams.get('force') === '1'

  const reservation = await db.reservation.findUnique({ where: { id } })
  if (!reservation) return fail('Rezervacija ne obstaja.', 404)
  const guard = await guardResource(user, reservation.locationId)
  if (guard) return guard
  if (['cancelled', 'completed'].includes(reservation.status)) {
    return fail('Preklicane/zaključene rezervacije ne prejmejo opomnika.', 409)
  }
  if (reservation.reminderSent && !force) {
    return fail('Opomnik je že poslan (ponovno pošiljanje: ?force=1).', 409)
  }
  if (!reservation.customerEmail && !reservation.customerPhone) {
    return fail('Rezervacija nima e-pošte niti telefona — opomnika ni mogoče poslati.', 400)
  }

  const location = await db.location.findUnique({
    where: { id: reservation.locationId ?? '' },
    select: { name: true, country: true },
  })
  const locale = location?.country === 'HR' ? 'hr' : 'sl'

  const result = await sendReminder(
    {
      email: reservation.customerEmail,
      phone: reservation.customerPhone,
      guestName: reservation.customerName,
      restaurantName: location?.name || 'RestaurantOS',
      when: reservation.dateTime,
      partySize: reservation.partySize,
      note: reservation.notes,
    },
    locale,
    reservation.locationId,
  )

  const now = new Date()
  await db.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id },
      data: { reminderSent: result.anySent || reservation.reminderSent, reminderSentAt: result.anySent ? now : reservation.reminderSentAt },
    })
    await writeAudit(tx, { userId: user.sub, action: 'RESERVATION_REMINDER', entityType: 'Reservation', entityId: id, details: jstr({ email: result.email, sms: result.sms, guest: reservation.customerName, by: user.name }), locationId: reservation.locationId })
  })

  return ok({ sent: result.anySent, channels: { email: result.email, sms: result.sms } })
}
