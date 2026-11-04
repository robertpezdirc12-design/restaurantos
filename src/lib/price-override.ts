/**
 * CENOVNI VAL v1.249.0 (PRIMERJAVA-VMESNIKOV-2026 §23 — Lightspeed junij
 * 2026 »authorized staff can now override an item's price directly on the
 * POS during an active order«) — SPREMEMBA CENE POSTAVKE NA POS.
 *
 * IZMERA pred valom: OrderItem.price je ŽE posnetek po vrstici (zapisan ob
 * nastanku iz MenuItem.price + doplačili opcij), račun (Receipt.itemsJson
 * posnetek v1.239.0 §16 C) in computeBill bereta ravno njega — spreminjanje
 * cene NEPLAČANE postavke torej potrebuje samo: pravico (nov kanonični
 * ključ orders.priceOverride), obvezen razlog, revizijo v verigi in žig na
 * posnetku računa. Denarna disciplina §15/§16: plačane postavke so tabu
 * (fiskalni storno je ločena pot), DDV se preračuna v isti transakciji.
 *
 * OZNAKA NA VRSTICI (0 DDL): OrderItem.modifiersJson je OD NASTANKA mrtva
 * shramba (ops.ts vedno zapiše '[]', posnetek opcij živi v OrderItemModifier
 * vrsticah — dokumentirano v item-variants.ts). Od tega vala nosi METAPODATKE
 * VRSTICE: '[]' (brez spremembe cene) ali {"priceOverride":{from,to,at,by}}.
 * Ime polja je ZGODOVINSKO (preimenovanje = DDL) — bralci so defenzivni.
 *
 * Čisti sloj (0 DB uvozov): parse = defenzivno branje (neveljavno → null,
 * self-healing), compose = zapis oznake, validate = STROGA validacija vnosa
 * (napaka je napaka). Vsa denarna matematika (vatFromGross) ostaja v ruti —
 * sloj nosi SAMO obliko.
 */

/**
 * Zgornja meja nove cene (EUR) — varovalo pred tipkarsko napako (1000× preveč
 * ni »višja cena«, ampak nesreča; 99.999,99 pokrije vsak jedilnik).
 */
export const MAX_PRICE_OVERRIDE_EUR = 99999.99

/** Najdaljši razlog spremembe cene (kuhar/kasa dvig, ne esej). */
export const MAX_PRICE_OVERRIDE_REASON = 200

/** Oznaka spremembe cene na postavki (kanonična oblika v modifiersJson). */
export interface PriceOverrideMeta {
  /** cena PRED tem posegom (bruto, z DDV — enaka enota kot OrderItem.price) */
  from: number
  /** nova cena po tem posegu */
  to: number
  /** ISO časovni žig posega */
  at: string
  /** izvajalec (ime, ne id — zapisnik) */
  by: string
}

/**
 * Defenzivno branje oznake iz OrderItem.modifiersJson. Sprejme KATERO koli
 * obliko: '[]' (nikoli preverjeno), '{}' (prazna shramba), string z JSON,
 * že-parsan objekt. Neveljavna/protislovna vrednost → null (vrstica se
 * izrise kot nepogojena — self-healing, nikoli napaka v bralni poti).
 */
export function parsePriceOverrideMeta(raw: unknown): PriceOverrideMeta | null {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s || s === '[]' || s === '{}') return null
    try {
      parsed = JSON.parse(s)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = (parsed as Record<string, unknown>).priceOverride
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const row = o as Record<string, unknown>
  const from = Number(row.from)
  const to = Number(row.to)
  const at = String(row.at ?? '').trim()
  const by = String(row.by ?? '').trim()
  if (!Number.isFinite(from) || from < 0) return null
  if (!Number.isFinite(to) || to < 0) return null
  if (!at || !by) return null
  return { from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100, at, by }
}

/**
 * Zapis oznake v obliko OrderItem.modifiersJson. Obstoječa oznaka se GNEZDI
 * (zgodovina: from vedno cena PRED tem posegom, prejšnji izvajalec ostane v
 * reviziji — ne v shrambi; veriga resnice je auditLog).
 */
export function composePriceOverrideMeta(next: PriceOverrideMeta): string {
  return JSON.stringify({ priceOverride: next })
}

/** Izid stroge validacije vnosa spremembe cene. */
export type PriceOverrideInput =
  | { ok: true; price: number; reason: string }
  | { ok: false; error: string }

/**
 * STROGA validacija vnosa: cena je veljavna denarna vrednost ≥ 0 (2 decimalki,
 * vejica ALI pika — kasa vpiše oboje), ≤ MAX_PRICE_OVERRIDE_EUR; razlog je
 * OBVEZEN (3–200 znakov — denarni poseg brez utemeljitve ne obstaja, tudi
 * ko politika dovoljuje tihi preklic).
 */
export function validatePriceOverrideInput(raw: unknown): PriceOverrideInput {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Manjkajoči ali neveljaven JSON.' }
  const body = raw as Record<string, unknown>
  const priceRaw = body.price
  if (typeof priceRaw !== 'number' && typeof priceRaw !== 'string') {
    return { ok: false, error: 'Cena je obvezna (število).' }
  }
  const priceNum = typeof priceRaw === 'number'
    ? priceRaw
    : Number(String(priceRaw).trim().replace(',', '.'))
  if (!Number.isFinite(priceNum)) return { ok: false, error: 'Cena ni veljavno število.' }
  if (priceNum < 0) return { ok: false, error: 'Cena ne more biti negativna (0 = gostišče; preklic = storno postavke).' }
  if (priceNum > MAX_PRICE_OVERRIDE_EUR) {
    return { ok: false, error: `Cena presega zgornjo mejo ${MAX_PRICE_OVERRIDE_EUR.toFixed(2)} EUR.` }
  }
  const price = Math.round(priceNum * 100) / 100
  const reason = String(body.reason ?? '').trim()
  if (reason.length < 3) return { ok: false, error: 'Razlog spremembe cene je obvezen (vsaj 3 znaki).' }
  return { ok: true, price, reason: reason.slice(0, MAX_PRICE_OVERRIDE_REASON) }
}
