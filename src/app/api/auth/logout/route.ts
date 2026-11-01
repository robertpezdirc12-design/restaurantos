import { NextRequest, NextResponse } from 'next/server'
import { getAuth, clearSessionCookie } from '@/lib/auth'
import { writeAudit } from '@/lib/audit-chain'
import { db } from '@/lib/db'

/**
 * Issue #90 (QA): odjava za httpOnly piškotek seje.
 *
 * httpOnly piškotka klient NE more izbrisati z JS (document.cookie ne vidi
 * HttpOnly zapisov) — zato odjava MORA priti čez strežnik. Prej je bila
 * »odjava« samo brisanje localStorage (ro_token/ro_user), kar je zadostovalo,
 * ker je bil žeton izključno v localStorage; s piškotkom pa bi ostal živ še
 * do 12 h po »odjavi«.
 *
 * Lastnosti:
 *  - idempotentno: brez seje vrne 200 (klient lahko kliče vedno);
 *  - brez avtentikacije: brisanje piškotka ne razkriva ničesar (CSRF ni
 *    tveganje — »odjava« največ izpiše klica samega na napravi, kjer živi
 *    piškotek; SameSite=Lax prekrije cross-site POST);
 *  - revizijsko: uspešna odjava se zapiše v audit sled (LOGOUT), neuspešna
 *    (brez seje) ne — sicer bi anonimno tolčenje polnilo dnevnik;
 *  - localStorage (ro_user/ro_token) klient počisti sam ob odgovoru.
 */
export async function POST(req: NextRequest) {
  const user = getAuth(req)
  const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  clearSessionCookie(res, req)
  if (user && user.sub && user.sub !== 'bootstrap') {
    await writeAudit(db, {
      userId: user.sub,
      action: 'LOGOUT',
      entityType: 'Employee',
      entityId: user.sub,
      details: `Odjava (${user.name}) — piškotek seje potekel.`,
      locationId: user.loc,
    }).catch(() => {})
  }
  return res
}
