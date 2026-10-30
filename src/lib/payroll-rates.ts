/**
 * N-27-3 (v1.197.0, docs/TRZNA-VRZELI-2027.md) — NOGE DOPLAČIL, čisti sloj.
 *
 * v1.192.0 je izvažal doplačilne OSNOVE (minute — noč/nedelja/praznik/nadure);
 * biro je odstotke razstavljal ročno. Ta val pretvori odstotek v UPORABNIŠKI
 * VHOD: lastnik vnese noge po SVOJI kolektivni pogodbi, sistem izračuna
 * ZNESKE iz že izvažanih minut in posnetkov urnih postavk.
 *
 * ISKRENOST (meja ostaja, premaknjena za en korak): noga je uporabniški vhod.
 * Sistem NIKOLI ne trdi, da je noga »zakonska« — zakonitost/kolektivno pogodbo
 * potrdi zunanji payroll sistem (biro). Nič tu ni pravni nasvet.
 *
 * ARITMETIKA (deterministična, centi):
 *   - odstotek hranimo kot število 0..100 (največ 2 decimalna mesta);
 *   - interno pctPct = odstotek × 100 (STOTINKE odstotka, integer) — vse
 *     vmesne produkte tako ostanejo CELOŠTEVILČNI, zaokrožitev je ENA na
 *     skupino (Math.round), brez plavajoče točke:
 *       noč/nedelja/praznik (po zaposlenem+delu):
 *         znesek[cent] = round( Σ_vnos (catMin × payRateCents_vnosa) × pctPct / 600000 )
 *         (600000 = 60 min/h × 100 %/delež × 100 stotink odstotka)
 *       nadure (po zaposlenem; presežek ne nosi delovnega mesta):
 *         znesek[cent] = round( nadureMin × povprečnaUrnaPostavka × pct / 6000 ),
 *         povprečnaUrnaPostavka = Σ grossCents × 60 / Σ netMinutes
 *         → = round( nadureMin × Σ grossCents × pctPct / (10000 × Σ netMinutes) )
 *
 * MEJE (dokumentirane, testirane):
 *   - postavka je POSNETEK vnosa (TimeEntry.payRate → payRateCents) — kadar se
 *     je postavka v obdobju spreminjala, vsak vnos nosi svojo;
 *   - vnos BREZ posnetka postavke (starejši klici, payRate 0) prispeva 0 zneska
 *     — plačilna osnova nastane šele ob postavki (RATE_ZERO izjema to oznaka);
 *   - nadure so po zaposlenem (ne po delovnem mestu — prag je osebni), zato
 *     znesek nadur uporablja POVPREČNO urno postavko obdobja (bruto/neto) —
 *     za natančnost po delovnem mestu biro upošteva minute × postavka;
 *   - Σ netMinutes = 0 → povprečna postavka 0 → znesek nadur 0.
 *
 * Ta modul je ČIST (0 DB uvozov) — shramba nog je v payroll-rates-store.ts.
 */

/** Noge doplačil v odstotkih (0..100, največ 2 decimalni mesti). */
export interface SurchargeRates {
  nightPct: number
  sundayPct: number
  holidayPct: number
  overtimePct: number
}

/** Stroga zgornja meja noge: doplačilo NAD osnovno postavko, do 100 %. */
export const MAX_SURCHARGE_PCT = 100

/** Imena polj nog (za validacijo manjkajočih — vsi štirje obvezni). */
const RATE_KEYS = ['nightPct', 'sundayPct', 'holidayPct', 'overtimePct'] as const

/**
 * Validira in normalizira noge iz nezaupanega vhoda (API body):
 * - vsa štiri polja OBVEZNA (0 je dovoljena vrednost — manjkajoče polje je
 *   napaka, ne tiha nula; fail-closed: izračun brez izrecne noge ne nastane);
 * - Number() sprejme numerične nize (UI pošilja števila), NaN/Infinity zavrne;
 * - obseg 0..100 (vključno), zaokroži na 2 decimalni mesti.
 */
export function parseSurchargeRates(input: unknown): { ok: true; rates: SurchargeRates } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object') {
    return { ok: false, error: 'Noge doplačil morajo biti objekt s štirimi odstotki.' }
  }
  const src = input as Record<string, unknown>
  const out = {} as SurchargeRates
  for (const k of RATE_KEYS) {
    const v = src[k]
    if (v === undefined || v === null || v === '') {
      return { ok: false, error: `Noga '${k}' je obvezna (0 je dovoljena vrednost).` }
    }
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) {
      return { ok: false, error: `Noga '${k}' mora biti število med 0 in ${MAX_SURCHARGE_PCT}.` }
    }
    const rounded = Math.round(n * 100) / 100
    if (rounded < 0 || rounded > MAX_SURCHARGE_PCT) {
      return { ok: false, error: `Noga '${k}' mora biti med 0 in ${MAX_SURCHARGE_PCT} (doplačilo nad osnovno postavko).` }
    }
    out[k] = rounded
  }
  return { ok: true, rates: out }
}

/** Odstotek → stotinke odstotka (integer osnova za centno aritmetiko). */
export function pctPctOf(pct: number): number {
  return Math.round(pct * 100)
}

/** Znesek noči/nedelje/praznika iz RAW količine (Σ catMin × cents × pctPct). */
export function surchargeAmountOfRaw(raw: number): number {
  return Math.round(raw / 600000)
}

/** Znesek nadur iz presežka + povprečne postavke obdobja (integer produkti). */
export function overtimeAmountOf(otMinutes: number, grossSumCents: number, netSumMinutes: number, pct: number): number {
  if (netSumMinutes <= 0 || grossSumCents <= 0 || otMinutes <= 0) return 0
  return Math.round((otMinutes * grossSumCents * pctPctOf(pct)) / (10000 * netSumMinutes))
}

/** CSV/JSON prikaz odstotka (EUR vzorec: decimalna VEJICA) — '30' → '30%'. */
export function pctCsv(pct: number): string {
  return `${String(pct).replace('.', ',')}%`
}
