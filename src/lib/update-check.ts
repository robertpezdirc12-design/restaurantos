/**
 * R4b — PREVERJANJE NOVIH RAZLIČIC (PRD-LOKALNA-BAZA §8, v1.216.0 del 1).
 *
 * Kontekst: LOKALNI-ZAGON.md je do tega vala eksplicitno zapisal »aplikacija
 * sama ne preverja, ali je nova različica izšla« (R4b). Pogoj za R4b — lokalni
 * migracijski pogon — je bil izpolnjen v v1.183.0 (R6, izmerjeno na živi bazi),
 * zato preostanek R4b razpada na: preverjanje (TA VAL) in podpisani paket
 * (ostaja lastniku — ključ je lastniška odločitev, B-razred).
 *
 * VIR »najnovejše« različice (izbor, ne ugiban): produkcijski /api/health —
 * edini živi JAVNI signal različice, ki za ta projekt obstaja (repozitorij je
 * zaseben, GitHub Releases ne obstajajo, žeton v lokalni namestitvi ne smem
 * biti). Health javlja { version, commit } brez podatkov (route-coverage:
 * »liveness probe — brez podatkov«). Privzeti URL je nadomestljiv prek
 * UPDATE_CHECK_URL (prazna vrednost = izklopljeno), sanitiziran po isti
 * disciplini kot logoUrl (SAMO https).
 *
 * POŠTENOST (srednja vrednost vs. laž): updateAvailable je true SAMO, kadar je
 * oddaljena različica DOKAZANO novejša. Neznano (vir nedosegljiv, slab JSON,
 * neberljiva različica) → false + razlog — NIKOLI »na voljo« brez dokaza in
 * NIKOLI tiha laž »posodobljeno«, ko odgovorja ni bilo.
 *
 * DETERMINIZEM: primerjava je številska trojka (major.minor.patch), brez
 * localeCompare, brez datumske logike v tem sloju. 0 uvozov (čisti sloj —
 * disciplina brand-themes.ts / item-variants.ts).
 *
 * Meje (dokumentirano, ne skrito):
 *  - vir je AVTORITATIVNA sledeča stran (cloud), ne podpisana objava — pred
 *    podpisanim paketom (R4b ostanek) je to obvestilo, ne varnostna meja;
 *  - primerjava pozna SAMO tri številske dele (1.216.0-beta → null, zavrnjeno);
 *  - offline namestitev: preverjanje fail-soft (razlog unreachable), namestitev
 *    deluje naprej.
 */

/** Privzeti vir: produkcijski health endpoint (README — restaurantos-theta). */
export const DEFAULT_UPDATE_CHECK_URL = 'https://restaurantos-theta.vercel.app/api/health'

/** Meja dolžine URL-ja (ista disciplina kot LOGO_URL_MAX v brand-themes). */
export const UPDATE_CHECK_URL_MAX = 300

/** Uspešen izid (latest znana) se pomni 1 uro — odhodni klic naj bo redak. */
export const UPDATE_CHECK_TTL_MS = 3_600_000

/** Neuspešen izid (vir nedosegljiv ipd.) se pomni le 60 s — okrevanje hitro. */
export const UPDATE_CHECK_FAIL_TTL_MS = 60_000

/** Časovna omejitev odhodnega klica (ssrfSafeJson timeout). */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000

/** Zgornja meja prebranega telesa odgovora (health odgovor je ~0,5 kB). */
export const UPDATE_CHECK_JSON_MAX_BYTES = 16_384

/** Veljavna različica: SAMO tri številske skupine po največ 8 števk. */
const APP_VERSION_RE = /^(\d{1,8})\.(\d{1,8})\.(\d{1,8})$/

/** Razčlenjena različica — številska trojka (immutable). */
export type AppVersionTriple = readonly [number, number, number]

/**
 * Striktno razčleni '1.216.0' → [1, 216, 0]. Vse ostalo (prefixi, 2/4 deli,
 * črke, presledki znotraj, ne-nizi) → null. Trim je dovoljen (isti vzorec kot
 * ostala uporabniška polja); 'v1.216.0' zavrnjen — prefiks ni del oblike.
 */
export function parseAppVersion(raw: unknown): AppVersionTriple | null {
  if (typeof raw !== 'string') return null
  const m = APP_VERSION_RE.exec(raw.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * Deterministična primerjava trojk: -1 | 0 | 1. Brez nizovne primerjave
 * (localeCompare je odvisen od okolja) — SAMO številke po teži major > minor > patch.
 */
export function compareAppVersions(a: AppVersionTriple, b: AppVersionTriple): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/**
 * Ali je `latest` DOKAZANO novejša od `current`? true samo ob strogo večji
 * trojki; null = katera od različic ni berljiva (neznanost NI »ne« — klicatelj
 * razloži razlog, ne laže z negativnim izidom).
 */
export function isNewerVersion(latest: unknown, current: unknown): boolean | null {
  const l = parseAppVersion(latest)
  const c = parseAppVersion(current)
  if (!l || !c) return null
  return compareAppVersions(l, c) > 0
}

/**
 * URL vira preverjanja: SAMO https, ≤ UPDATE_CHECK_URL_MAX znakov, brez
 * presledkov in kontrolnih znakov (isti vratarji kot sanitizeLogoUrl —
 * http:/data:/javascript: ne gredo skozi). Trim je nameren.
 */
export function sanitizeUpdateCheckUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const u = raw.trim()
  if (!u || u.length > UPDATE_CHECK_URL_MAX) return null
  if (!u.startsWith('https://')) return null
  if (/[\s\u0000-\u001f\u007f]/.test(u)) return null
  return u
}

/** Od kod prihaja URL vira — pošteno poročano v odgovoru rute. */
export type UpdateCheckSource = 'default' | 'env' | 'disabled' | 'invalid'

export interface UpdateCheckUrlResolution {
  url: string | null
  source: UpdateCheckSource
}

/**
 * Preslikava env → vir: NENASTAVLJENO → privzeti produkcijski health (deluje
 * brez konfiguracije); PRAZNO (ali sami presledki) → izklopljeno; https URL →
 * env (trim); vse ostalo (http, data:, smeti, ne-niz) → invalid (fail-soft,
 * razlog poročan — tiha zamenjava s privzetim bi bila laž o viru).
 */
export function resolveUpdateCheckUrl(envRaw: unknown): UpdateCheckUrlResolution {
  if (envRaw === undefined) return { url: DEFAULT_UPDATE_CHECK_URL, source: 'default' }
  if (typeof envRaw !== 'string') return { url: null, source: 'invalid' }
  const v = envRaw.trim()
  if (v === '') return { url: null, source: 'disabled' }
  const url = sanitizeUpdateCheckUrl(v)
  if (!url) return { url: null, source: 'invalid' }
  return { url, source: 'env' }
}
