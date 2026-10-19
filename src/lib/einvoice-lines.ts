/**
 * v1.149.0 (revizija 2026-10 #5 #6) — gradnik VRSTIC odhodnega e-računa iz
 * naročila. ČIST MODUL (brez DB, brez HTTP), ker je vsa fiskalna aritmetika —
 * razrez popusta in zaokroževanje — tu merljiva neposredno.
 *
 * Dve najdbi, ki ju zapre:
 *
 *  #5 — `POST /api/einvoices/issue` je iz naročila vzel SAMO `OrderItem.price`
 *       in je B2B račun izstavil po celotni ceni, čeprav je naročilo že imelo
 *       popust (`Order.discount` in morebitni `OrderItem.discountAmount`).
 *       Posledica je račun, višji od zneska, ki ga stranka dejansko dolguje, in
 *       terjatev (AR), ki se nikoli ne poravna do konca.
 *
 *  #6 — osnova in DDV sta bila izpeljana IZ ENOTE (`r2(cena / (1 + stopnja))`,
 *       nato pomnoženo s količino). Zaokrožitev na enoti se pomnoži s količino,
 *       zato vrstica ne zadošča pravilu EN 16931 BT-111 = BT-118 × BT-146,
 *       njena DDV komponenta pa je za centke mimo zneska «osnova × stopnja».
 *       Pri 7 × 5,75 € pri 9,5 % je razlika med enotskim in vrstičnim
 *       zaokroževanjem natanko 0,01 € na vrstico — na računu s sto vrsticami je
 *       to en evro napačno prijavljene osnove.
 *
 * KONVENCA (nespremenjena): cene v `OrderItem` so KONČNE cene za gosta
 * (v1.124.0), DDV se IZVLEČE iz cene. Vrstica e-računa je NETO, zato izvoz
 * potrebuje par (neto osnova vrstice, DDV vrstice), ki se sešteje natanko v
 * bruto znesek vrstice — tega tu sestavim in nikoli ne vrnem obeh zaokroženih
 * posebej.
 */
import { netFromGross } from '@/lib/billing'
import { r2 } from '@/lib/map'
import type { OutgoingEInvoiceLine } from '@/lib/eslog-export'

export interface EinvoiceOrderLineInput {
  /** naziv postavke (že posnet `menuItemName`, ne trenutni meni) */
  name: string
  quantity: number
  /** KONČNA cena na enoto (z DDV), kot je bila zaračunana na naročilu */
  unitPrice: number
  vatRate: number
  /** popust TE vrstice (v bruto pomenu) — `OrderItem.discountAmount` */
  lineDiscount?: number
}

export interface BuiltOrderLines {
  lines: OutgoingEInvoiceLine[]
  /** vsota bruto vrstic PRED razrezom popusta na naročilu */
  grossBefore: number
  /** kolikor bruto je bilo razdeljenega po vrsticah */
  discountSpread: number
  /** Σ bruto PO razdelemu — mora biti enak znesku, ki ga dolguje naročilo */
  gross: number
  net: number
  vatAmount: number
  /**
   * Centi, ki jih naročilo dolguje VEČ, kot jih ima postavk (npr. artikel je
   * bil spremenjen ali izbrisan po plačilu). Tudi to je razlog za fail-closed
   * zavrnitev: računa, ki ga ni iz česa sestaviti, ne izdam «po glavi».
   */
  shortfallCents: number
}

function cents(v: number): number {
  return Math.round((Number.isFinite(v) ? v : 0) * 100)
}

/** Bruto znesek ENE vrstice (končna cena × količina − popust vrstice), v centih. */
function lineGrossCents(it: EinvoiceOrderLineInput): number {
  const q = Number.isFinite(it.quantity) ? Math.max(0, it.quantity) : 0
  return Math.max(0, cents(q * Math.max(0, it.unitPrice)) - Math.max(0, cents(it.lineDiscount ?? 0)))
}

/**
 * Vsota bruto zneskov postavk naročila — po ISTI aritmetiki kot
 * `buildOrderLines`, da ruta pričakovani znesek izpelje iz istih podatkov, ki jih
 * nato izda račun. Drugačna formula pomeni drugačen zaokrog in lažen odklon.
 */
export function grossOfOrderItems(items: EinvoiceOrderLineInput[]): number {
  return r2(items.reduce((a, it) => a + lineGrossCents(it), 0) / 100)
}

/**
 * Razdeli `totalC` centov po `weightsC` (sorazmerno z utežmi), cent-exact.
 * Ostanek gre po padajočem ulomku, ob izenačenju NIŽJI indeks — zato je razrez
 * determinističen (isti vhod → ista XML → isti sha256). `capC` prepreči, da bi
 * popust vrstico pripel pod 0.
 */
export function spreadCentsByWeight(totalC: number, weightsC: number[], capC: number[]): number[] {
  const out = weightsC.map(() => 0)
  const sumW = weightsC.reduce((a, b) => a + Math.max(0, b), 0)
  if (!(totalC > 0) || sumW <= 0) return out
  const order: { i: number; frac: number }[] = []
  for (let i = 0; i < weightsC.length; i++) {
    const w = Math.max(0, weightsC[i])
    const exact = (totalC * w) / sumW
    out[i] = Math.min(Math.floor(exact), Math.max(0, capC[i]))
    order.push({ i, frac: exact - Math.floor(exact) })
  }
  order.sort((a, b) => b.frac - a.frac || a.i - b.i)
  let remaining = totalC - out.reduce((a, b) => a + b, 0)
  // več passov, dokler je kje še rezerve: kapica na posamezni vrstici ne sme
  // pustiti nerazdeljenega popusta, sicer glava ne ustreza vrsticam
  while (remaining > 0) {
    let placed = false
    for (const { i } of order) {
      if (remaining <= 0) break
      if (out[i] >= Math.max(0, capC[i])) continue
      out[i] += 1
      remaining -= 1
      placed = true
    }
    if (!placed) break
  }
  return out
}

/**
 * Zgradi odhodnje vrstice iz postavk naročila.
 *
 * `expectedGross` je bruto znesek, KI GA NAROČILO RES DOLGUJE (že po popustih).
 * Iz njega se izračuna razrez, zato je vsota vrstic enaka terjatvi cent na
 * cent — izračun `Σ bruto − popust` bi pri kasneje spremenjenih postavkah
 * generiral negativen popust in račun, ki ne ustreza nobenemu plačilu.
 */
export function buildOrderLines(items: EinvoiceOrderLineInput[], expectedGross: number): BuiltOrderLines {
  const grossC = items.map(lineGrossCents)
  const sumC = grossC.reduce((a, b) => a + b, 0)
  const expectedC = Math.max(0, cents(expectedGross))
  // popust, ki ga mora razrez pokriti — nikoli negativen (vrstice ne smejo
  // «dodati» zneska, ki ga naročilo ne pozna); nasprotno smer pove
  // `shortfallCents`, ki jo ruta zavrne
  const wantC = Math.max(0, sumC - expectedC)
  const shareC = spreadCentsByWeight(wantC, grossC, grossC)
  const spreadC = shareC.reduce((a, b) => a + b, 0)

  const lines: OutgoingEInvoiceLine[] = []
  let netSum = 0
  let vatSum = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const q = Number.isFinite(it.quantity) ? it.quantity : 0
    const lineGross = r2(Math.max(0, grossC[i] - shareC[i]) / 100)
    // ZAOKROŽEVANJE PO VRSTICI (#6): neto iz zneska vrstice, DDV je preostanek
    // do bruto zneska — vsota obeh je vedno natanko bruto vrstice.
    const net = netFromGross(lineGross, it.vatRate)
    const vat = r2(lineGross - net)
    netSum = r2(netSum + net)
    vatSum = r2(vatSum + vat)
    // neto CENA na enoto se izpiše iz neto zneska vrstice (deljeno s količino);
    // sicer pomnožek dvodecimalne cene in količine ne vrne izpisanega zneska
    // vrstice (EN 16931 BT-111 = BT-118 × BT-146)
    lines.push({
      name: it.name,
      quantity: q,
      unitPriceNet: q !== 0 ? net / q : net,
      vatRate: it.vatRate,
      lineNetAmount: net,
      lineVatAmount: vat,
    })
  }

  return {
    lines,
    grossBefore: r2(sumC / 100),
    discountSpread: r2(spreadC / 100),
    gross: r2((sumC - spreadC) / 100),
    net: netSum,
    vatAmount: vatSum,
    shortfallCents: Math.max(0, expectedC - sumC),
  }
}
