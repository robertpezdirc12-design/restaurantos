/**
 * Več poslovalnic — pogledi/pravice po lokaciji (GitLab issue #1, triage ⑧).
 * Čista logika (brez DB/IO) — validacija lokacij, oznake sprememb, client filter.
 *
 * Stanje: Location model obstaja (FURS polja, naslov, timezone, valuta);
 * fail-closed avtorizacija po lokaciji je že povsod (locationScope /
 * requireUserLocation / assertResourceLocation). Sklop dopolni:
 *   1. CRUD lokacij (settings.manage) — brez tega 2. poslovalnice ni mogoče ustvariti
 *   2. lokacijski preklopnik za centralne vloge (pogledi — OWNER/ADMIN vidijo vse)
 *   3. dodelitev zaposlenega lokaciji (PATCH employees locationId)
 *
 * Centralna vloga (isti pomen kot isCentralRole v api.ts): OWNER | ADMIN.
 * Non-central je VEDNO vezan na svojo lokacijo (fail-closed) — preklopnik mu
 * ni na voljo, API pa ignorira tuje locationId.
 */

/** UI vloge, ki videjo vse lokacije (zrcali isCentralRole iz src/lib/api.ts) */
export function isCentralUIRole(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}

// ── Koda lokacije ────────────────────────────────────────────────────────────

const DIACRITICS: Record<string, string> = {
  č: 'c', š: 's', ž: 'z', đ: 'd', ć: 'c', ä: 'a', ö: 'o', ü: 'u',
  Č: 'c', Š: 's', Ž: 'z', Đ: 'd', Ä: 'a', Ö: 'o', Ü: 'u',
}

export const MAX_CODE = 20

/**
 * Normalizacija kode: diakritike → ASCII, A–Z/0–9/pomišljaj, max 20 znakov.
 * Vrne '' če ni ostalo nič uporabnega.
 */
export function normalizeLocationCode(input: unknown): string {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  const swapped = Array.from(raw).map((ch) => DIACRITICS[ch] ?? ch).join('')
  return swapped.toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_CODE)
}

/** Kandidat za kodo iz imena lokacije (»RestaurantOS Ljubljana« → RESTAURANTOS-LJUBLJANA) */
export function codeCandidateFromName(name: string): string {
  return normalizeLocationCode(name)
}

// ── Validacija vnosa ─────────────────────────────────────────────────────────

export interface LocationInput {
  name: string
  code: string
  address: string
  city: string
  postCode: string
  country: string
  phone: string
  email: string
  premisesId: string
  timezone: string
  currency: string
}

export const DEFAULT_TIMEZONE = 'Europe/Ljubljana'
export const DEFAULT_CURRENCY = 'EUR'
/** Podprte države (fiskalizacija je po državi — SI FURS, HR adapter je ločen sklop) */
export const SUPPORTED_COUNTRIES = ['SI', 'HR'] as const

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Validacija lokacije — napake v slovenščini; ok → normalizirane vrednosti. */
export function validateLocationInput(
  input: unknown,
  opts?: { requireName?: boolean }
): { ok: true; value: LocationInput } | { ok: false; error: string } {
  const b = (input ?? {}) as Record<string, unknown>
  const requireName = opts?.requireName !== false

  const name = clean(b.name, 120)
  if (!name && requireName) return { ok: false, error: 'Ime lokacije je obvezno.' }
  if (name && requireName === false && !b.name) {
    // urejanje brez imena → prepovedano tudi pri patch (ime ostane obvezno)
    return { ok: false, error: 'Ime lokacije je obvezno.' }
  }

  const code = normalizeLocationCode(b.code)
  if (code && code.length < 2) return { ok: false, error: 'Koda mora imeti vsaj 2 znaka.' }

  const email = clean(b.email, 120)
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'E-poštni naslov ni veljaven.' }

  const countryRaw = clean(b.country, 2).toUpperCase()
  const country = countryRaw || 'SI'
  if (!(SUPPORTED_COUNTRIES as readonly string[]).includes(country)) {
    return { ok: false, error: 'Podprte države: SI, HR.' }
  }

  const currency = clean(b.currency, 3).toUpperCase() || DEFAULT_CURRENCY

  const phone = clean(b.phone, 30)
  if (phone && !/^[+0-9 ()/-]+$/.test(phone)) {
    return { ok: false, error: 'Telefonska številka vsebuje nedovoljene znake.' }
  }

  return {
    ok: true,
    value: {
      name,
      code,
      address: clean(b.address, 160),
      city: clean(b.city, 80),
      postCode: clean(b.postCode, 12),
      country,
      phone,
      email,
      premisesId: clean(b.premisesId, 40),
      timezone: clean(b.timezone, 60) || DEFAULT_TIMEZONE,
      currency,
    },
  }
}

// ── Oznake stanja in sprememb (audit + UI) ───────────────────────────────────

export function locationStatusLabel(isActive: boolean): string {
  return isActive ? 'Aktivna' : 'Neaktivna'
}

/** Kratek podpis lokacije za UI: »Ljubljana · SI · EUR« / »Ljubljana · SI« */
export function locationSubtitle(loc: { city?: string | null; country?: string | null; currency?: string | null }): string {
  const parts = [loc.city, loc.country, loc.currency].map((x) => (x ? String(x) : '')).filter(Boolean)
  return parts.join(' · ')
}

type LocPatch = {
  name?: unknown; code?: unknown; address?: unknown; city?: unknown; postCode?: unknown
  country?: unknown; phone?: unknown; email?: unknown; premisesId?: unknown
  timezone?: unknown; currency?: unknown; isActive?: unknown
}

const LABELS: Record<string, string> = {
  name: 'ime', code: 'koda', address: 'naslov', city: 'mesto', postCode: 'poštna številka',
  country: 'država', phone: 'telefon', email: 'e-pošta', premisesId: 'FURS poslovni prostor',
  timezone: 'časovni pas', currency: 'valuta', isActive: 'stanje',
}

/** Človeku berljiv seznam sprememb lokacije (za audit LOCATION_UPDATE). */
export function describeLocationChanges(before: LocPatch, after: LocPatch): string[] {
  const changes: string[] = []
  for (const key of Object.keys(LABELS)) {
    if (after[key] === undefined) continue
    const b = before[key]
    const a = after[key]
    if (String(b ?? '') !== String(a ?? '')) {
      changes.push(key === 'isActive'
        ? `stanje: ${locationStatusLabel(b !== false)} → ${locationStatusLabel(a !== false)}`
        : `${LABELS[key]}: »${String(b ?? '') || '—'}« → »${String(a ?? '') || '—'}«`)
    }
  }
  return changes
}

// ── Client-side lokacijski filter (pogledi) ──────────────────────────────────

/**
 * Filtrira vrstice na izbrano lokacijo (preklopnik v glavi).
 * Viri brez locationId (null/undefined — npr. globalni meni) ostanejo vidni.
 * Brez izbire (prazno) → ne filtrira (vse lokacije).
 */
export function filterByLocation<T extends { locationId?: string | null }>(
  rows: readonly T[] | undefined | null,
  locationId: string | null | undefined
): T[] {
  if (!rows) return []
  if (!locationId) return [...rows]
  return rows.filter((r) => !r.locationId || r.locationId === locationId)
}
