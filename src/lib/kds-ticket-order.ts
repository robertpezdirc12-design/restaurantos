/**
 * PRIMERJAVA §38 (v1.264.0) — ROČNO ZAPOREDJE LISTKOV NA KDS (Square
 * Vol 16, 5. 11. 2026 »Draggable ticket reordering on KDS«): ČISTI
 * sloj (0 uvozov — isto disciplino kot receipt.ts §37 ali
 * modifiers.ts orderModifiersForSnapshot §36; db dostop živi v
 * src/lib/kds-ticket-sequence.ts).
 *
 * Merjena semantika (Square §37): vrstni red »Manual« per naprava;
 * sekvenca SE SHRANI in sinhronizira na druge KDS naprave iste
 * lokacije z istim načinom. Naša določitev Ž9:
 *  - sekvenca je GLOBALNA per lokacija (Order.ticketSequence, ničen =
 *    brez ročnega mesta);
 *  - Manual sort: sekvenca NARAŠČAJOČE; listki brez zapisa (novi
 *    naročili) padejo NA KONEC po obstoječem (izpeljanem) vrstnem
 *    redu — Square isto: obstoječa razvrstitev ostane, novi prihajajo
 *    za njo;
 *  - velja SAMO na »Aktivni izmeni« (osnutki §32 in zastareli
 *    Issue #70 §2 obdržijo svoj red — njuni disciplini sta
 *    prihodnji tok / revizijska veja, ne ročna vrsta).
 *
 * Defenzivnost (§36 disciplina): ne-končne sekvence (NaN/Infinity/
 * undefined/null) se OBRAVNAJO kot ODSOTNE (konec po izpeljanem
 * redu) — kar ne znamo izmeriti, ne razvrščamo ročno.
 */

/** Kandidat za ročno razvrstitev (listek aktivne izmene). */
export interface ManualTicketOrderT<T> {
  /** listek brez ročnega mesta (sekvenca ni vpisana) */
  order: T
  /** ročno mesto (0 = prvi); null/undefined/NaN = odsotno */
  sequence: number | null | undefined
  /** izpeljani vrstni red (createdAt ms) za odsotne in izenačitve */
  createdAtMs: number
}

/**
 * Ročno (Manual) zaporedje listkov: STABILNA ureditev po
 * (sekvenca ASC → izpeljani vrstni red ASC). Listki z merljivo
 * sekvenco pridejo PRVI po njej; listki brez zapisa sledijo po
 * obstoječem (vhodnem) redu — točno po §38 B2. Vhod ostane
 * NEDOTAKNJEN (kopija), prazen vhod → prazen izhod, samo-1 → ista
 * vsebina (identiteta sekvenc ni pomembna).
 */
export function applyManualTicketOrder<T>(tickets: readonly T[]): T[]
export function applyManualTicketOrder<T>(
  tickets: readonly T[],
  seqOf: (t: T) => number | null | undefined,
  createdAtOf: (t: T) => number | string | Date,
): T[]
export function applyManualTicketOrder<T>(
  tickets: readonly T[],
  seqOf?: (t: T) => number | null | undefined,
  createdAtOf?: (t: T) => number | string | Date,
): T[] {
  if (tickets.length <= 1) return [...tickets]
  const seq = seqOf ?? ((t: T) => (t as { ticketSequence?: number | null }).ticketSequence ?? null)
  const created = createdAtOf ?? ((t: T) => (t as { createdAt?: string | number | Date }).createdAt ?? 0)
  const ms = (t: T): number => {
    const v = created(t)
    if (v instanceof Date) return v.getTime()
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0
    const p = Date.parse(String(v))
    return Number.isFinite(p) ? p : 0
  }
  const out = [...tickets]
  out.sort((a, b) => {
    const sa = seq(a)
    const sb = seq(b)
    const fa = typeof sa === 'number' && Number.isFinite(sa)
    const fb = typeof sb === 'number' && Number.isFinite(sb)
    // oba z merljivo sekvenco → sekvenca odloča (izenačitev pade na čas)
    if (fa && fb) return sa! - sb! || ms(a) - ms(b)
    // samo a ima mesto → a je PRED b (ročno razvrščeni vedno prvi)
    if (fa) return -1
    // samo b ima mesto → a ZA b
    if (fb) return 1
    // oba brez mesta → izpeljani vrstni red (stabilno: padla primerjava
    // ohrani vhodno pozicijo — Array.prototype.sort je stabilen v ES2019+)
    return ms(a) - ms(b)
  })
  return out
}

/** Validirani izhod parseReorderPayload. */
export interface ReorderPayload {
  /** celoten novi vrstni red (edinstveni id-ji listkov) */
  orderIds: string[]
}

/**
 * Čista validacija PATCH /api/kitchen {reorder} telesa: polje mora
 * biti NEPRAZEN array stringov (id-ji listkov) BREZ duplikatov.
 * Vrne { orderIds } ob uspehu ali { error } s sporočilom (klicatelj
 * preslika v 400). Vse ostalo (neobstoječi/tuji/ne-aktivni listki)
 * preverja STREŽNIK ob bazi — tu je samo oblika (ista delitev kot
 * seat-assignments parseSeatAssignments).
 */
export function parseReorderPayload(body: unknown): { orderIds: string[] } | { error: string } {
  if (body === null || typeof body !== 'object') return { error: 'reorder zahteva telo z orderIds.' }
  const raw = (body as { reorder?: unknown }).reorder
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'reorder zahteva neprazen seznam orderIds.' }
  }
  if (raw.length > 500) {
    return { error: 'reorder sprejme največ 500 listkov.' }
  }
  const orderIds: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || v.length === 0 || v.length > 64) {
      return { error: 'orderIds smejo biti samo neprazni nizi.' }
    }
    if (orderIds.includes(v)) return { error: 'orderIds ne smejo imeti duplikatov.' }
    orderIds.push(v)
  }
  return { orderIds }
}
