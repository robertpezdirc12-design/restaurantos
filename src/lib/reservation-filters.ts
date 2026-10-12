/**
 * OPS-8 val 3 (v1.73.0) — client-side reservation list filtering (pure).
 *
 * Status values are the UI (uppercase) forms produced by mapReservation:
 * CONFIRMED | SEATED | COMPLETED | CANCELLED | NO_SHOW.
 * The function is intentionally DB-free and timezone-local (day boundary = viewer's day).
 */

export type ReservationFilter = 'ALL' | 'UPCOMING' | 'TODAY' | 'SEATED' | 'NO_SHOW' | 'CANCELLED'

export const RESERVATION_FILTERS: ReservationFilter[] = ['ALL', 'UPCOMING', 'TODAY', 'SEATED', 'NO_SHOW', 'CANCELLED']

interface FilterableRes {
  reservedAt: string | Date
  status: string
}

const hourMs = 36e5
const dayMs = 86_400_000

/**
 * Filter + chronological sort (oldest first).
 *  - ALL: everything, sorted;
 *  - UPCOMING: same rule the dashboard used pre-OPS-8.3 — starts 1h ago or later, not cancelled;
 *  - TODAY: reservations whose local calendar day is today (any status);
 *  - SEATED / NO_SHOW / CANCELLED: exact status match.
 */
export function filterReservations<T extends FilterableRes>(rows: T[], filter: ReservationFilter, now: number): T[] {
  const sorted = [...rows].sort((a, b) => +new Date(a.reservedAt) - +new Date(b.reservedAt))
  switch (filter) {
    case 'UPCOMING':
      return sorted.filter((r) => new Date(r.reservedAt).getTime() >= now - hourMs && r.status !== 'CANCELLED')
    case 'TODAY': {
      const d = new Date(now)
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      const end = start + dayMs
      return sorted.filter((r) => {
        const t = new Date(r.reservedAt).getTime()
        return t >= start && t < end
      })
    }
    case 'SEATED':
      return sorted.filter((r) => r.status === 'SEATED')
    case 'NO_SHOW':
      return sorted.filter((r) => r.status === 'NO_SHOW')
    case 'CANCELLED':
      return sorted.filter((r) => r.status === 'CANCELLED')
    case 'ALL':
    default:
      return sorted
  }
}
