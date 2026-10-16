/**
 * Issue #70 §4 (P1, v1.121.0) — TLORIS: enotsko-odporne pozicije miz.
 *
 * VŽIVI vzrok (produkcija v1.119.0, demo): shranjene posX/posY vrednosti demo
 * miz so v Odstotkih (8,6 … 69,9), UI pa jih tolmači kot PX na dizajn-platnu
 * 440×380 → deljenje s 440/380 vse stisne v zgornji levi vogal (x ≤ 16 %,
 * y ≤ 17 %) velikega praznega platna. Mešanica enot v ZGODOVINI: seed in
 * trenutno PATCH shranjeta PX (40 … 400), starejši demo zapisi pa Odstotke.
 *
 * REŠITEV (0 DDL, BREZ mutacije produkcijskih koordinat — issue #70):
 *  - detekcija enote NABORA: če ima vsaka pozicionirana miza posX ≤ 100 IN
 *    posY ≤ 100, je nabor v odstotkih (px nabor na 440×380 platnu bi skoraj
 *    zagotovo presegel 100; vse-padajo-v-100 px nabor se izriše razpršeno —
 *    nikoli zgoščeno v vogalu, zato je hevristika varna);
 *  - odstotkovni nabor se uporabi neposredno, px nabor se deli s platnom;
 *  - mize BREZ/degenerirane pozicije (0/0) → obstoječa avto-mreža
 *    (cona = stolpec, miza znotraj cone = vrstica);
 *  - vlečenje (persist prek PATCH /api/tables/[id]) shranjuje v ENOTO NABORA
 *    (odstotkovski nabor ostane homogen odstotkovski — mešanje enot ne nastane).
 *
 * Modul je ČIST (brez uvozov) — varen za client bundle in enotsko testiran.
 */

/** Dizajn-platno tlorisa (PX enota — v kateri shranjujeta seed in PATCH). */
export const FLOOR_PLAN_W = 440
export const FLOOR_PLAN_H = 380

/** Meja "izgleda kot odstotek" (0–100 naravno območje odstotkov). */
const PERCENT_MAX = 100

/** Clamp pozicije na platno (enake meje kot prejšnji UI: 3 … 97 %). */
const clampPct = (v: number): number => Math.min(97, Math.max(3, v))

export interface FloorPlanTable {
  id: string
  zone: string
  posX: number
  posY: number
}

/**
 * Issue #70 §4: je NABOR pozicij v odstotkih?
 * Nabor brez nobene pozicionirane mize → false (privzeta px enota za nove
 * vlečene pozicije; same mize razporedi avto-mreža).
 */
export function floorPlanUnitIsPercent(tables: readonly FloorPlanTable[]): boolean {
  const positioned = tables.filter((t) => t.posX > 0 || t.posY > 0)
  if (positioned.length === 0) return false
  return positioned.every((t) => t.posX <= PERCENT_MAX && t.posY <= PERCENT_MAX)
}

/**
 * Issue #70 §4: pozicija mize na tlorisu v Odstotkih platna.
 *  - pozicionirana miza: odstotkovni nabor → vrednosti so že %; px nabor →
 *    deljenje s 440×380 (zgodovinsko vedenje);
 *  - miza brez/degenerirane pozicije → AVTO-MREŽA (cona = stolpec 15+zi*17,
 *    miza znotraj cone = vrstica 16+idx*18 — obstoječa semantika OPS-4).
 */
export function planPositionOf(tb: FloorPlanTable, tables: readonly FloorPlanTable[]): { x: number; y: number } {
  if (tb.posX > 0 || tb.posY > 0) {
    const percent = floorPlanUnitIsPercent(tables)
    const x = percent ? tb.posX : (tb.posX / FLOOR_PLAN_W) * 100
    const y = percent ? tb.posY : (tb.posY / FLOOR_PLAN_H) * 100
    return { x: clampPct(x), y: clampPct(y) }
  }
  // privzeto (mize brez pozicije): cona = stolpec, miza znotraj cone = vrstica (5 vrst)
  const zones = [...new Set(tables.map((t) => t.zone))].sort()
  const zi = Math.max(0, zones.indexOf(tb.zone))
  const zoneTables = tables.filter((t) => t.zone === tb.zone)
  const idx = Math.max(0, zoneTables.findIndex((t) => t.id === tb.id))
  return { x: clampPct(15 + (zi % 5) * 17), y: clampPct(16 + (idx % 5) * 18) }
}
