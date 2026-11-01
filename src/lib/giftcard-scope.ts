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
 *  - uporabnik BREZ org dreva (nevezana lokacija — migracijsko varno), NE glede
 *    na to ali je vloga centralna ali staff → 'own' (samo lastna lokacija: POS
 *    tok ostane uporaben, tuji tenanti nevidni). QA-val v1.221.0 (najdba):
 *    prej je centralna vloga z nevezano lokacijo padla v 'none' — na isti
 *    lokaciji je natakar našel kartico, ADMIN pa ne (»Kartica s to številko
 *    ne obstaja.«). TRENUTNA produkcija/demo imajo lokacije BREZ propertyId —
 *    rezanje centralnih vlog od lastne lokacije je ravno regresija, ki jo
 *    tenant.ts (»zakaj tako«) izrecno prepoveduje; guardResource isto semantiko.
 *  - katera koli vloga BREZ lokacije → 'none' (fail-closed — pravi obseg
 *    ni znan; vključno s centralnimi, vzorec #38);
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
  if (isCentralRole(user) && !user.loc) return { kind: 'none' }
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
