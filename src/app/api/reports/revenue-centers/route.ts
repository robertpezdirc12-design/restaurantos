import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num } from '@/lib/map'

/**
 * PRIMERJAVA §34 (v1.260.0; Square Vol 13 september 2026 »Create revenue centers
 * to group and compare sales«): prihodkovni center = del posla — šank, terasa ali
 * dostavni kanal. Square dodeli NAPRAVE, odseke tlorisa in kanale centru, da se
 * naročila štejejo na pravo mesto SAMODEJNO; »Sales summary« poročilo, grupirano
 * po centru, pokaže, katera območja nosijo dan in katera vlečejo navzdol
 * (»staffing and menu decisions rest on real numbers«).
 *
 * NAŠ PREVOD (0 DDL): RevenueCenter model obstaja (enterprise štetje) a brez
 * CRUD/seed/vezav — Order.revenueCenterId se nikoli ne piše. Namesto upravne
 * plasti (ustvari centre → dodeli odseke → seli naročila) izpeljujemo centre ob
 * BRANJU iz podatkov, ki jih naročilo ŽE nosi:
 *  - DINE_IN z mizo → CONA mize (Table.area — »Glavna dvorana/Bar/Terasa/VIP
 *    loža«; urejevalnik con + ZONE_RENAME revizija že obstajata od v1.233.0),
 *  - TAKEAWAY → kanal PREVZEM,
 *  - DELIVERY → kanal DOSTAVA (platformska webhook naročila),
 *  - DINE_IN brez mize (robni primer) → »Brez mize«, izpisan SAMO če ni prazen.
 * To je ista avtomatika, ki jo obljavlja Square (»orders are counted in the right
 * place automatically«) — cona mize je pri nas ŽE vezava na odsek tlorisa, vrsta
 * naročila ŽE kanal. Skupine se izračunajo nad VSO zgodovino (preimenovanje cone
 * združi tudi pretekle naročila pod novo ime — enako kot pogled miz po conah;
 * poštena navedba v §34 B).
 *
 * READ-ONLY: 0 mutacij, 0 revizij (bralno poročilo, enaka odločitev kot §32 B6).
 * Gating reports.sales + locationScope (Issue #4 §1) kot vsa poročila.
 * Nameno IZVEN X/Z poročila: X/Z je fiskalni zaključek — grupiranje po centru je
 * poslovni vpogled; vključitev v zz ostaja B-načrt, če jo lastnik izrecno želi.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const now = new Date()
  const fromP = url.searchParams.get('from')
  const toP = url.searchParams.get('to')
  // Privzeto okno = današnji dan (isti pars vzorec kot reports/export).
  const from = fromP ? new Date(`${fromP}T00:00:00`) : (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d })()
  const to = toP ? new Date(`${toP}T23:59:59.999`) : now
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return fail('Neveljaven datum (pričakovano YYYY-MM-DD).', 400)
  if (from > to) return fail('Datum "from" je za datumom "to".', 400)

  // Issue #4 §1: poročilo je location-scoped (centralne vloge vidijo vse).
  const scope = await locationScope(user)

  const [zoneRows, grouped, tables] = await Promise.all([
    // Vse cone, ki obstajajo na mizah lokacije — izpis tudi PRAZNIH con (mrtvo
    // območje je informacija; Square izrise vse centre).
    db.table.findMany({ where: { ...scope }, select: { area: true }, distinct: ['area'] }),
    // PLAČANA naročila okna, grupirana po (vrsta, miza) — tableId je stolpec na
    // Order, zato groupBy deluje brez joina; cono prilegamo prek tabel spodaj.
    db.order.groupBy({
      by: ['type', 'tableId'],
      where: { paymentStatus: 'paid', paidAt: { gte: from, lte: to }, ...scope },
      _sum: { total: true, tax: true, tip: true },
      _count: true,
    }),
    db.table.findMany({ where: { ...scope }, select: { id: true, area: true } }),
  ])

  // miza → cona (miza brez ujema — izbrisana miza — pade v cono '', iskreno)
  const areaById = new Map(tables.map((t) => [t.id, t.area || '']))

  type Row = {
    key: string
    kind: 'zone' | 'takeaway' | 'delivery' | 'none'
    /** ime cone (uporabniški podatek) — za kanale prevod na klientu (kind) */
    label: string | null
    orders: number
    gross: number
    net: number
    tips: number
    avgCheck: number
    share: number
  }
  const buckets = new Map<string, Row>()
  const bucket = (key: string, kind: Row['kind'], label: string | null): Row => {
    const existing = buckets.get(key)
    if (existing) return existing
    const row: Row = { key, kind, label, orders: 0, gross: 0, net: 0, tips: 0, avgCheck: 0, share: 0 }
    buckets.set(key, row)
    return row
  }

  for (const g of grouped) {
    const gross = num(g._sum.total)
    const net = gross - num(g._sum.tax)
    const tips = num(g._sum.tip)
    const type = (g.type || 'dine-in').toLowerCase()
    let row: Row
    if (type === 'takeaway') {
      row = bucket('takeaway', 'takeaway', null)
    } else if (type === 'delivery') {
      row = bucket('delivery', 'delivery', null)
    } else if (g.tableId) {
      const area = areaById.get(g.tableId) || ''
      row = bucket(`zone:${area || '?'}`, 'zone', area)
    } else {
      // DINE_IN brez mize — robni primer (naj ne bi nastal na novih poteh, a
      // zgodovina/demo lahko nosi) — izpisan SAMO če ima naročila.
      row = bucket('none', 'none', null)
    }
    row.orders += g._count
    row.gross += gross
    row.net += net
    row.tips += tips
  }

  // zagotovi prisotnost VSEH con (tudi praznih) + obeh kanalov (prazen kanal =
  // ni bilo prevzema/dostave v oknu — vidljivo, ne skrito)
  for (const z of zoneRows) {
    const label = z.area || ''
    bucket(`zone:${label || '?'}`, 'zone', label)
  }
  bucket('takeaway', 'takeaway', null)
  bucket('delivery', 'delivery', null)

  const rowsAll = [...buckets.values()].filter((r) => r.kind !== 'none' || r.orders > 0)
  const totalNet = rowsAll.reduce((s, r) => s + r.net, 0)
  for (const r of rowsAll) {
    r.avgCheck = r.orders > 0 ? Math.round((r.gross / r.orders) * 100) / 100 : 0
    r.share = totalNet > 0 ? Math.round((r.net / totalNet) * 1000) / 10 : 0
    r.gross = Math.round(r.gross * 100) / 100
    r.net = Math.round(r.net * 100) / 100
    r.tips = Math.round(r.tips * 100) / 100
  }
  // vrstni red: po neto padajoče (najmočnejše območje na vrhu — »who is carrying
  // the day«), izenačene po vrsti (cone pred kanali), nato po imenu (deterministično)
  const kindOrder: Record<Row['kind'], number> = { zone: 0, takeaway: 1, delivery: 2, none: 3 }
  rowsAll.sort((a, b) => (b.net - a.net) || (kindOrder[a.kind] - kindOrder[b.kind]) || String(a.label).localeCompare(String(b.label), 'sl'))

  const totals = {
    orders: rowsAll.reduce((s, r) => s + r.orders, 0),
    gross: Math.round(rowsAll.reduce((s, r) => s + r.gross, 0) * 100) / 100,
    net: Math.round(totalNet * 100) / 100,
    tips: Math.round(rowsAll.reduce((s, r) => s + r.tips, 0) * 100) / 100,
  }

  return ok({ from: from.toISOString(), to: to.toISOString(), rows: rowsAll, totals })
}
