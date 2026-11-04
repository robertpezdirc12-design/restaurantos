/**
 * STREŽNI VAL v1.248.0 (PRIMERJAVA-VMESNIKOV-2026 §22 A) — SAMODEJNA
 * DODELITEV MIZE spletni rezervaciji (Lightspeed maj 2026 »automatic table
 * assignments … based on guest count … staff can accept, change or skip«).
 *
 * IZMERA pred valom: v1.231.0 je avtododelitev prinesla kot GUMB v internem
 * dialogu (klient); javna pot (/api/public/reservations) je ustvarila
 * rezervacijo BREZ mize. Ta sloj je STREŽNIŠKI izbor za javne rezervacije.
 *
 * Načela (podedovana iz v1.231/v1.245 — ena resnica o izbiri):
 *  - kandidati = enojne mize + REGISTRIRANE kombinacije (družba, večja od
 *    največje mize → Miza 5+6);
 *  - sedežev ≥ oseb, NAJMANJŠA zmaga (ne zapiraj 8-mize za dva gosta);
 *  - izključene mize (walk-in rezerva, resv-bookable-config) NE sodelujejo —
 *    sicer bi spletni gost pojedel rezervo, ki jo je gostilna namenila
 *    naključnim gostom (§19 B mehanika);
 *  - prekrivanje: AKTIVNE rezervacije (confirmed/seated/completed — isti
 *    CLAIM_BLOCKING_STATUSES kot v1.240.0) zavirajo VSAKO članico, ki jo
 *    držijo (tableId ∪ comboTableIds);
 *  - avtododelitev je POMOČ, ne obveza: nobena miza ne ustreza → null
 *    (rezervacija brez mize; osebje dodeli ročno — Lightspeed »skip«).
 *
 * ČIST sloj (0 uvozov — vzorec ops-checklists/hourly-email): testi in ruta
 * delijo isto resnico o izbiri, brez DB dotika.
 */

/** Miza, kot jo vidi izbor (obris obstoječega Table modela). */
export interface AutoassignTableLike {
  id: string
  number?: number | null
  name?: string | null
  seats: number
}

/** Registrirana kombinacija (obris TableCombo). */
export interface AutoassignComboLike {
  id: string
  tableIds: string[]
}

/** Rezervacija, ki lahko zavira mizo (obris aktivnih rezervacij dneva). */
export interface AutoassignBusyReservationLike {
  dateTime: Date | string
  duration?: number | null
  tableId?: string | null
  comboTableIds?: string | null
}

/** Izbor za rezervacijo (isto telo kot SeatCandidate iz table-combos). */
export interface AutoassignPick {
  /** tabela id-jev za zapis ([id] enojna; ≥ 2 kombinacija). */
  tableIds: string[]
  seats: number
  /** človeško ime (»Miza 5« / »Miza 5+6«). */
  label: string
  /** id kombinacije (null = enojna miza). */
  comboId: string | null
}

/** Privzeta minutaža rezervacije (kanonični model javne poti = 120). */
export const AUTOASSIGN_DURATION_MIN = 120

/**
 * Mize, ki jih v oknu [start, start+durationMin) držijo druge rezervacije.
 * Prekrivanje je OBOJESTRANSKO STROGO odprto (start < konecDrugi && startDrugi
 * < konec) — neposredno sosednji termini (19:00–21:00 in 21:00–23:00) se lahko
 * usedeta na isto mizo, kar je pošteno za obrat (v1.231 autoAssignTable).
 */
export function busyTableIdsForWindow(
  reservations: readonly AutoassignBusyReservationLike[],
  start: Date | string,
  durationMin: number,
): Set<string> {
  const s = start instanceof Date ? start.getTime() : new Date(start).getTime()
  const end = s + Math.max(0, durationMin) * 60_000
  const busy = new Set<string>()
  for (const r of reservations) {
    const at = r.dateTime instanceof Date ? r.dateTime.getTime() : new Date(r.dateTime).getTime()
    if (!Number.isFinite(at)) continue
    const dur = Math.max(0, Math.round(Number(r.duration ?? AUTOASSIGN_DURATION_MIN)) || 0)
    const rEnd = at + dur * 60_000
    if (!(s < rEnd && at < end)) continue // brez prekrivanja — miza je prosta
    if (r.tableId) busy.add(r.tableId)
    // kombinacijska rezervacija drži VSE članice (vključno s primarno)
    if (r.comboTableIds) {
      for (const id of String(r.comboTableIds).split(',')) {
        const t = id.trim()
        if (t) busy.add(t)
      }
    }
  }
  return busy
}

/**
 * Izbor mize za spletno rezervacijo: najmanjša enojna miza ali kombinacija,
 * ki ustreza številu oseb, ni izključena (walk-in rezerva) in ni zasedena v
 * oknu. Določen vrstni red: sedeži naraščajoče, nato oznaka po 'sl' — isti
 * tie-break kot seatCandidatesForParty (v1.245.0), da interni gumb in
 * strežniški izbor ne moreta izbrati RAZLIČNIH miz za isto situacijo.
 */
export function autoassignTableForBooking(args: {
  tables: readonly AutoassignTableLike[]
  combos: readonly AutoassignComboLike[]
  party: number
  busyTableIds: ReadonlySet<string>
  /** walk-in rezerva (resv-bookable-config) — spletni gost jih ne dobi. */
  excludedTableIds?: readonly string[]
}): AutoassignPick | null {
  const { tables, combos, party, busyTableIds } = args
  const excluded = new Set((args.excludedTableIds ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))
  const byId = new Map(tables.map((t) => [t.id, t]))
  const labelOf = (t: AutoassignTableLike) =>
    (t.name ? t.name.replace('Miza ', '') : String(t.number ?? '?'))

  const out: AutoassignPick[] = []
  // enojne mize: sedežev ≥ oseb, prosta, ne izključena
  for (const t of tables) {
    if (t.seats < party || busyTableIds.has(t.id) || excluded.has(t.id)) continue
    out.push({ tableIds: [t.id], seats: t.seats, label: `Miza ${labelOf(t)}`, comboId: null })
  }
  // registrirane kombinacije: vse članice obstajajo + so prostе + ne izključene
  for (const c of combos) {
    const members = c.tableIds.map((id) => byId.get(id)).filter((t): t is AutoassignTableLike => !!t)
    if (members.length !== c.tableIds.length) continue // zamujena izbrisana miza — preskoči
    if (members.some((t) => busyTableIds.has(t.id) || excluded.has(t.id))) continue
    const seats = members.reduce((s, t) => s + t.seats, 0)
    if (seats < party) continue
    out.push({ tableIds: [...c.tableIds], seats, label: `Miza ${members.map((t) => labelOf(t)).join('+')}`, comboId: c.id })
  }
  if (out.length === 0) return null
  out.sort((a, b) => a.seats - b.seats || a.label.localeCompare(b.label, 'sl'))
  return out[0]
}
