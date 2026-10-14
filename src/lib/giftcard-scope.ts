/**
 * Issue #26 (P1) — tenant obseg za darilne kartice (lookup / POS plačilni tok).
 *
 * Poslovno pravilo (iz issue #46 + #26): kartica je instrument PODJETJA
 * (organizacije), ne poslovalnice — veljavna kartica se sme unovčiti na kateri
 * koli lokaciji ISTE organizacije (medposlovalnično unovčenje). Isto pravilo
 * zato velja za minimalni POS lookup; podrobni finančni dnevnik, polnjenje in
 * urejanje so STROŽJI (giftcards.manage + guardResource — staff = lastna
 * lokacija, centralni = organizacija).
 *
 * Obsegi:
 *  - bootstrap platformni operater → 'global' (break-glass, kot povsod);
 *  - uporabnik z znano organizacijo (Location → Property → Brand → Org) →
 *    'org' (vse lokacije organizacije — medposlovalnični lookup/unovčenje);
 *  - staff BREZ org dreva (nevezana lokacija — migracijsko varno) → 'own'
 *    (samo lastna lokacija: POS tok ostane uporaben, tuji tenanti nevidni);
 *  - centralna vloga z NEZNANO organizacijo (loc null / nevezana) → 'none'
 *    (fail-closed, isti vzorec kot eventTenantScope #38);
 *  - legacy kartica brez locationId ni v NOGEM od teh obsegov → nevidna v
 *    lookup-u za vse razen bootstrap (izrecno fail-closed pravilo issue #26).
 */
import { db } from '@/lib/db'
import { isCentralRole } from '@/lib/api'
import { chainForLocation, isBootstrapAdmin } from '@/lib/tenant'
import type { AuthPayload } from '@/lib/auth'

export type GiftCardScope =
  | { kind: 'global' }
  | { kind: 'org'; locationIds: string[] }
  | { kind: 'own'; locationId: string }
  | { kind: 'none' }

/** Tenant obseg uporabnika za iskanje kartic (POS lookup). */
export async function giftCardScopeFor(user: AuthPayload): Promise<GiftCardScope> {
  if (isBootstrapAdmin(user)) return { kind: 'global' }
  const chain = await chainForLocation(user.loc)
  const orgId = chain?.organizationId ?? null
  if (orgId) {
    const rows = await db.location.findMany({
      where: { Property: { Brand: { organizationId: orgId } } },
      select: { id: true },
    })
    return rows.length ? { kind: 'org', locationIds: rows.map((r) => r.id) } : { kind: 'none' }
  }
  if (isCentralRole(user)) return { kind: 'none' }
  if (user.loc) return { kind: 'own', locationId: user.loc }
  return { kind: 'none' }
}

/**
 * Where-pogoj za iskanje kartic znotraj obsega. 'none' → neujemajoči
 * locationId (iskanje vrne prazno → enoten 404, brez razlike med
 * neobstoječo in tujo kartico — enumeracijska zaščita #46/#26).
 */
export function giftCardScopeWhere(scope: GiftCardScope): { locationId?: string | { in: string[] } } {
  if (scope.kind === 'global') return {}
  if (scope.kind === 'org') return { locationId: { in: scope.locationIds } }
  if (scope.kind === 'own') return { locationId: scope.locationId }
  return { locationId: '__gc_scope_none__' }
}
