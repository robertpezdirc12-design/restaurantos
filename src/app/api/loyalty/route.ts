import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { guardResource, assertOrgScope } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { maskPhone } from '@/lib/pii'
import { writeAudit } from '@/lib/audit-chain'

const TIER_FOR = (points: number): string => (points >= 1000 ? 'platinum' : points >= 500 ? 'gold' : points >= 100 ? 'silver' : 'bronze')

/** Issue #44 (P1): varna številska domena delte točk — celo število, ±1.000.000. */
export const LOYALTY_DELTA_LIMIT = 1_000_000

/** Interni reject (#44) — znotraj $transaction povzroči ROLLBACK celote (saldo + ledger + audit). */
class LoyaltyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Seznam računov zvestobe.
 * P2 audit PII: telefonske številke so VEDNO maskirane (npr. »+386 *** 567«) —
 * seznam je berljiv vsem avtenticiranim, polna številka pa za delo s seznamom
 * ni potrebna (GDPR). Nezakrit pogled (?full=1 — izvoz/admin potreba) zahteva
 * dovoljenje settings.manage, sicer 403.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const wantsFull = new URL(req.url).searchParams.get('full') === '1'
  if (wantsFull) {
    const gate = await requirePermission(req, 'settings.manage')
    if (isResponse(gate)) return gate
  }
  const rows = await db.loyaltyAccount.findMany({
    // Issue #4 §1: staff vidi samo račune zvestobe svoje lokacije
    where: await locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({
    accounts: rows.map((r) => ({
      id: r.id,
      guestName: r.customerName,
      phone: wantsFull ? (r.customerPhone || null) : maskPhone(r.customerPhone),
      points: r.pointsBalance,
      visits: r.lifetimePoints,
      tier: r.tier,
      lastVisit: null,
      createdAt: r.createdAt,
    })),
  })
}

/**
 * Nov član programa zvestobe — N3 (audit P1): kanonično dovoljenje `settings.manage` (DB lookup).
 *
 * Issue #43 (P1): lokacija računa se izpelje/varno določi na STREŽNIKU po kanoničnem
 * §10 vzorcu (enak kot /api/giftcards, /api/expenses, /api/discounts):
 *  - ne-centralna vloga: IZKLJUČNO server-side dodeljena lokacija (user.loc);
 *    klientov body.locationId se IGNORIRA (poskus preusmeritve v drugo poslovalnico
 *    nima učinka);
 *  - centralna vloga: ekspliciten body.locationId (iz preklopnika pogleda) ALI
 *    user.loc; brez obojega → 400 — NE pa findFirst() fallback na prvo lokacijo baze
 *    (prejšnja rutina je lahko pripela račun zvestobe TUJI organizaciji);
 *  - lokacija obstaja in je aktivna (404/400), org obseg pa preveri assertOrgScope
 *    (centralni uporabnik orgA ne more ustvariti računa na lokaciji orgB).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const guestName = String(body?.guestName || '').trim()
  if (!guestName) return fail('Ime gosta je obvezno.', 400)
  const phone = String(body?.phone || '').trim().slice(0, 40)

  // Issue #43: kanonična izpeljava lokacije — BREZ findFirst() fallbacka
  const loc = requireUserLocation(user, body?.locationId)
  if (isResponse(loc)) return loc
  const orgGuard = await assertOrgScope(user, loc)
  if (orgGuard) return orgGuard
  const location = await db.location.findUnique({ where: { id: loc }, select: { id: true, isActive: true } })
  if (!location) return fail('Lokacija ne obstaja.', 404)
  if (!location.isActive) return fail('Lokacija ni aktivna.', 400)

  const row = await db.loyaltyAccount.create({
    data: {
      id: nid(),
      customerName: guestName.slice(0, 120),
      customerPhone: phone,
      tier: 'bronze',
      locationId: loc,
    },
  })
  // Issue #43: audit nosi lokacijo + izvajalca (veriga dokazov tenant vezave)
  await writeAudit(db, {
    userId: user.sub,
    action: 'LOYALTY_ACCOUNT_CREATED',
    entityType: 'LoyaltyAccount',
    entityId: row.id,
    details: jstr({ guest: guestName }),
    locationId: loc,
  })
  return ok({ account: { id: row.id, guestName: row.customerName } }, 201)
}

/**
 * Točke: prihod (delta > 0) ali obračun (delta < 0) + samodejni tier.
 * N3 (audit P1): kanonično dovoljenje `settings.manage` namesto trdo kodiranih vlog;
 * lokacijski gate na tujem računu ostaja fail-closed.
 *
 * Issue #44 (P1): saldo, ledger, tier in audit so ENA atomarna operacija:
 *  - $transaction: ANCHOR zapis na vrstici računa (serializacija sočasnih PATCH —
 *    SQLite write lock, PG vrstični zaklep) → FRESH read znotraj transakcije →
 *    izračun → update salda → LoyaltyTransaction → audit. Noben uspeh ne pusti
 *    salda brez ledgerja (in obratno); napaka v kateremkoli koraku rollbacka vse;
 *  - poslovna politika odpisa: |delta| NE sme preseči salda → 409 zavrnitev
 *    (prej: tihi clamp Math.max(0, …) — ledger −50 ≢ saldo 0). Ledger VEDNO ≡
 *    sprememba salda;
 *  - delta: celo število (trunc), ±LOYALTY_DELTA_LIMIT meja (prepreči nenamerno
 *    ogromne kredite/odbitke);
 *  - tier/lifetimePoints izpeljana iz ISTE operacije; zgodovinskih zapisov ne
 *    prepisujemo.
 */
export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const delta = Math.trunc(Number(body?.delta))
  if (!id) return fail('Manjka id računa zvestobe.', 400)
  if (!Number.isFinite(delta) || delta === 0) return fail('Delta točk je obvezna (npr. 25 ali -10).', 400)
  if (Math.abs(delta) > LOYALTY_DELTA_LIMIT) {
    return fail(`Delta točk presega dovoljeno mejo (±${LOYALTY_DELTA_LIMIT.toLocaleString('sl-SI')}).`, 400)
  }
  const reason = String(body?.reason || (delta > 0 ? 'Prihod točk' : 'Obračun točk')).slice(0, 200)

  const account = await db.loyaltyAccount.findUnique({ where: { id } })
  if (!account) return fail('Račun zvestobe ne obstaja.', 404)
  // Issue #4 §1: odštevanje/dodajanje točk tujemu računu (druga lokacija) je zavrnjeno;
  // null lokacija računa = "vir brez lokacije" → 403 za non-central (fail-closed)
  const locRes = await guardResource(user, account.locationId)
  if (locRes) return locRes

  try {
    const updated = await db.$transaction(async (tx) => {
      // ANCHOR (#44): prvi zapis v transakciji na vrstici računa — sočasna PATCHa
      // se serializirata; drugi vidi ŽE POTRJENO stanje prvega (izgubljeni update
      // ni možen)
      const anchor = await tx.loyaltyAccount.updateMany({ where: { id }, data: { updatedAt: new Date() } })
      if (anchor.count === 0) throw new LoyaltyError(404, 'Račun zvestobe ne obstaja.')
      const fresh = await tx.loyaltyAccount.findUnique({ where: { id } })
      if (!fresh) throw new LoyaltyError(404, 'Račun zvestobe ne obstaja.')
      // poslovna politika odpisa (#44): zavrnitev namesto tihega clamp-a
      if (delta < 0 && Math.abs(delta) > fresh.pointsBalance) {
        throw new LoyaltyError(409, `Ni dovolj točk: saldo je ${fresh.pointsBalance}, zahtevan odpis pa ${Math.abs(delta)}.`)
      }
      const newBalance = fresh.pointsBalance + delta
      const lifetime = fresh.lifetimePoints + Math.max(0, delta)
      const row = await tx.loyaltyAccount.update({
        where: { id },
        data: { pointsBalance: newBalance, lifetimePoints: lifetime, tier: TIER_FOR(newBalance) },
      })
      await tx.loyaltyTransaction.create({
        data: {
          id: nid(),
          loyaltyAccountId: id,
          type: delta > 0 ? 'earn' : 'redeem',
          points: delta,
          reason,
        },
      })
      await writeAudit(tx, {
        userId: user.sub,
        action: 'LOYALTY_POINTS',
        entityType: 'LoyaltyAccount',
        entityId: id,
        details: jstr({ guest: fresh.customerName, delta, newBalance }),
        locationId: fresh.locationId ?? undefined,
      })
      return row
    })
    return ok({ account: { id: updated.id, guestName: updated.customerName, points: updated.pointsBalance, tier: updated.tier } })
  } catch (e) {
    if (e instanceof LoyaltyError) return fail(e.message, e.status)
    throw e
  }
}
