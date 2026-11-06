/**
 * v1.267.0 (PRIMERJAVA §41, Lightspeed julij 2026 »Restore KDS stations in
 * seconds«) — STREŽNIŠKI PROFIL KDS POSTAJE.
 *
 * MOTIVACIJA (izmerjeno v §41 A): VSE nastavitve KDS zaslona so bile PER
 * NAPRAVA v localStorage (ro_kds_* družina, Issue #74 + §18 B + §38): pragovi
 * starosti, velikost pisave, gostota, stolpci, pogled, zaklep zaslona, način
 * vrstnega reda. Obrezena/zamenjana tablica v kuhinji je izgubila CELOTNO
 * konfiguracijo — namestnik je moral vse prage in pisave ponovno vpisati ročno
 * med obratom. Lightspeed: »Recover KDS stations faster after a reset or
 * reconnection … select the station name, and KDS applies the latest saved
 * settings.«
 *
 * NOSILEC: Integration vrstica name='kds-station-profile', type='other',
 * PER LOKACIJA (vzorec resv-pacing-config §18 A — 0 DDL). config JSON je
 * ZEMLJEVID profilov po postaji: { [stationKey]: profil }, kjer je stationKey
 * 'ALL' | 'KITCHEN' | 'BAR' | <PrepStation.id> (ista domena kot ?station=
 * inicializator KDS zaslona).
 *
 * Ta sloj je ČIST (0 uvozov db/react) — uporabljajo ga API ruta in testi.
 * Sanitizacija je defenzivna v obeh smereh: branje (JSON, ki ga je kdorkoli
 * zapisal) in pisanje (PUT telo) STA vedno prečiščena skozi isto funckijo —
 * neveljavna polja tiho padejo na privzete vrednosti naprave (fail-closed,
 * isti vzorec kot normalizeKdsAgeThresholds).
 */

import { KDS_AGE_DEFAULTS, normalizeKdsAgeThresholds, type KdsAgeThresholds } from './kds-delays'

/** Integration.name marker (enaka disciplina kot PACING_CONFIG_MARKER). */
export const KDS_STATION_PROFILE_MARKER = 'kds-station-profile'

/** Zgornja meja števila postaj v zemljevidu (varovalo pred neskončno rastjo). */
export const KDS_PROFILE_MAX_STATIONS = 64

/** Dovoljene vrednosti pisave (Issue #74 V-8 — A−/A/A+/A++). */
export const KDS_PROFILE_FONTS = ['S', 'M', 'L', 'XL'] as const
/** Dovoljene vrednosti gostote listka. */
export const KDS_PROFILE_DENSITIES = ['compact', 'normal'] as const
/** Dovoljeni pogledi (board po statusu | navpični seznam). */
export const KDS_PROFILE_VIEWS = ['columns', 'list'] as const
/** Dovoljena načina vrstnega reda listkov (§38). */
export const KDS_PROFILE_TICKET_ORDERS = ['default', 'manual'] as const
/** Stolpci navpičnega seznama (Issue #74 V-8, Square 4–10). */
export const KDS_PROFILE_COLUMN_OPTIONS = [4, 6, 8, 10] as const

export type KdsProfileFontT = (typeof KDS_PROFILE_FONTS)[number]
export type KdsProfileDensityT = (typeof KDS_PROFILE_DENSITIES)[number]
export type KdsProfileViewT = (typeof KDS_PROFILE_VIEWS)[number]
export type KdsProfileTicketOrderT = (typeof KDS_PROFILE_TICKET_ORDERS)[number]
export type KdsProfileColumnsT = (typeof KDS_PROFILE_COLUMN_OPTIONS)[number]

/** Kanonična oblika profila postaje (kaj se SHRANI na strežnik). */
export interface KdsStationProfile {
  fontSize: KdsProfileFontT
  density: KdsProfileDensityT
  columns: KdsProfileColumnsT
  view: KdsProfileViewT
  viewOnly: boolean
  ageThresholds: KdsAgeThresholds
  ticketOrder: KdsProfileTicketOrderT
  /** ISO čas zapisa (revizijska sled v sami vrstici;Audit nosi before/after). */
  savedAt: string
  savedBy: string
}

/** Privzeti profil = privzete vrednosti SVEŽE naprave (hidracijske vrednosti). */
export function defaultKdsStationProfile(savedAt = '', savedBy = ''): KdsStationProfile {
  return {
    fontSize: 'M',
    density: 'compact',
    columns: 6,
    view: 'columns',
    viewOnly: false,
    ageThresholds: { ...KDS_AGE_DEFAULTS },
    ticketOrder: 'default',
    savedAt,
    savedBy,
  }
}

/**
 * Ključ postaje: 'ALL' | 'KITCHEN' | 'BAR' | slug/id poimenovane postaje.
 * Ista regularnost kot ?station= inicializator (dashboard KDS) — /[A-Za-z0-9_-]{1,64}/.
 */
export function isValidProfileStationKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key)
}

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

function pickColumns(raw: unknown): KdsProfileColumnsT {
  const n = Number(raw)
  return (KDS_PROFILE_COLUMN_OPTIONS as readonly number[]).includes(n) ? (n as KdsProfileColumnsT) : 6
}

/**
 * Defenzivna pretvorba neznane vrednosti (PUT telo ALI shranjen JSON) v
 * kanonični profil. Neveljavna/poljsko manjkajoča vrednost pade na privzeto
 * naprave — profil NIKOLI ne vrže (obnova je prezentacijska plast, ne varnostna).
 * savedAt/savedBy se preneseta samo, če sta niz (sicer ju zapiše klicatelj).
 */
export function sanitizeKdsStationProfile(raw: unknown, savedAt = '', savedBy = ''): KdsStationProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    fontSize: pickEnum(r.fontSize, KDS_PROFILE_FONTS, 'M'),
    density: pickEnum(r.density, KDS_PROFILE_DENSITIES, 'compact'),
    columns: pickColumns(r.columns),
    view: pickEnum(r.view, KDS_PROFILE_VIEWS, 'columns'),
    viewOnly: r.viewOnly === true,
    ageThresholds: normalizeKdsAgeThresholds(r.ageThresholds),
    ticketOrder: pickEnum(r.ticketOrder, KDS_PROFILE_TICKET_ORDERS, 'default'),
    savedAt: typeof r.savedAt === 'string' && r.savedAt ? r.savedAt : savedAt,
    savedBy: typeof r.savedBy === 'string' && r.savedBy ? r.savedBy : savedBy,
  }
}

/**
 * Zemljevid profilov (Integration.config JSON). Neveljavni ključi/nadmerne
 * postaje izpadejo; veljavne vrednosti grejo skozi sanitizeKdsStationProfile.
 * Vrne VEDNO veljavno zemljevid (prazen objekt = noben profil).
 */
export function sanitizeKdsProfileMap(raw: unknown): Record<string, KdsStationProfile> {
  const out: Record<string, KdsStationProfile> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= KDS_PROFILE_MAX_STATIONS) break
    if (isValidProfileStationKey(key)) out[key] = sanitizeKdsStationProfile(value)
  }
  return out
}

/** Seznam localStorage ključev, ki jih profil obvladuje (test »sveže naprave«). */
export const KDS_PROFILE_LS_KEYS = [
  'ro_kds_age_thresholds',
  'ro_kds_font_size',
  'ro_kds_density',
  'ro_kds_columns',
  'ro_kds_view',
  'ro_kds_view_only',
  'ro_kds_ticket_order',
] as const

/**
 * Podpis profila za primerjavo (savedAt/savedBy namenoma IZPUŠČENA — gumb
 * »shrani« mora biti omogočen tudi po ponovnem shranjevanju istih nastavitev
 * z drugačnim časom; primerja se SAMO vsebina prikaza).
 */
export function kdsProfileContentSig(p: KdsStationProfile): string {
  return JSON.stringify([
    p.fontSize, p.density, p.columns, p.view, p.viewOnly, p.ageThresholds, p.ticketOrder,
  ])
}
