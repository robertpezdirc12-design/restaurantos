/**
 * R4b-1 (v1.216.0) — strežniški sloj preverjanja novih različic.
 *
 * Sestavlja: vir (env UPDATE_CHECK_URL → privzeti produkcijski health, čisti
 * sloj update-check.ts) → odhodni klic (ssrfSafeJson — DNS pinning, timeout,
 * omejeno telo) → primerjava (čisti sloj) → DTO. Vse fail-soft: NIKOLI ne vrže
 * in NIKOLI ne laže — updateAvailable je true SAMO ob dokazano novejši različici,
 * neznano pa poroča razlog.
 *
 * POMNILNIŠKA PREDPOMNILNIK (lokalni pomnilnik, per-proces — sklad s stackom):
 * uspešen izide se pomni 1 uro (odhodni klic naj bo redek tudi ob vsakem odprtju
 * Nastavitev), neuspešen le 60 s (okrevanje vira se zazna hitro). Predpomnilnik
 * pomeni tudi: po nadgradnji lokalne namestitve nov proces preveri SVEŽ (po
 * git pull je latest == current → »posodobljeno«, brez zamikanja).
 *
 * Vbrizgljivi odvisnosti (fetchJson, now) — vzorec transportFactory iz
 * daily-email.ts: veja z omrežjem je dosegljiva DETERMINISTIČNEMU testu brez
 * omrežja. Ruta ne vbrizga ničesar (privzeti ssrfSafeJson).
 */
import { ssrfSafeJson, type SsrfJsonInit, type SsrfJsonResponse } from '@/lib/ssrf-guard'
import { APP_VERSION } from '@/lib/version'
import {
  UPDATE_CHECK_FAIL_TTL_MS,
  UPDATE_CHECK_JSON_MAX_BYTES,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TTL_MS,
  isNewerVersion,
  resolveUpdateCheckUrl,
} from '@/lib/update-check'

/** Razlog, zakaj latest ni znana ('' = znana). Poročan klientu pošteno. */
export type UpdateCheckReason = '' | 'off' | 'invalid_url' | 'unreachable' | 'bad_response' | 'bad_version'

export interface UpdateCheckResult {
  /** Različica TE namestitve (APP_VERSION — ena resnica). */
  current: string
  /** Različica vira ali null, če ni znana. */
  latest: string | null
  /** true SAMO ob dokazano novejši različici vira. Neznano → false + reason. */
  updateAvailable: boolean
  /** ISO čas dejanskega preverjanja (pri predpomnjenem izidu: izvirnega). */
  checkedAt: string
  /** Od kod prihaja vir — pošteno poročilo o izbiri. */
  source: 'default' | 'env' | 'disabled' | 'invalid'
  reason: UpdateCheckReason
  /** Trajanje odhodnega klica (ms) ali null, kadar klica ni bilo. */
  durationMs: number | null
}

/** Odhodni JSON bralc (vbrizgljiv za teste). */
export type FetchLatestJson = (url: string, init: SsrfJsonInit) => Promise<SsrfJsonResponse>

const defaultFetchJson: FetchLatestJson = (url, init) => ssrfSafeJson(url, init)

interface CacheEntry {
  at: number
  result: UpdateCheckResult
}

let cache: CacheEntry | null = null

/** Test-only: počisti predpomnilnik (deterministični testi TTL). */
export function __resetUpdateCheckCacheForTests(): void {
  cache = null
}

function ttlFor(result: UpdateCheckResult): number {
  // uspeh (latest znana) → dolga doba; odpoved → kratka (hitro okrevanje vira)
  return result.latest !== null ? UPDATE_CHECK_TTL_MS : UPDATE_CHECK_FAIL_TTL_MS
}

/** Polje version iz health odgovora (neznana oblika → null = bad_response). */
function versionFieldOf(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || !('version' in json)) return null
  return (json as { version?: unknown }).version
}

/**
 * Izvedi (ali vzemi predpomnjeno) preverjanje. Deterministično glede na
 * (env, fetchJson, now) — datum prihaja iz `now` (testi vbrizgajo fiksni).
 */
export async function getUpdateCheckResult(
  opts: { fetchJson?: FetchLatestJson; now?: number } = {},
): Promise<UpdateCheckResult> {
  const now = opts.now ?? Date.now()
  if (cache && now - cache.at < ttlFor(cache.result)) {
    return cache.result
  }

  const fetchJson = opts.fetchJson ?? defaultFetchJson
  const resolved = resolveUpdateCheckUrl(process.env.UPDATE_CHECK_URL)

  const base = (over: Partial<UpdateCheckResult>): UpdateCheckResult => ({
    current: APP_VERSION,
    latest: null,
    updateAvailable: false,
    checkedAt: new Date(now).toISOString(),
    source: resolved.source,
    reason: 'unreachable',
    durationMs: null,
    ...over,
  })

  let result: UpdateCheckResult
  if (!resolved.url) {
    // disabled (prazna vrednost) ali invalid (http/data/…): odhodnega klica NI
    // bilo — razlog se razlikuje, da lastnik ve, Zakaj je tiho
    result = base({ reason: resolved.source === 'disabled' ? 'off' : 'invalid_url' })
  } else {
    const res = await fetchJson(resolved.url, {
      timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
      maxBytes: UPDATE_CHECK_JSON_MAX_BYTES,
    })
    if (!res.ok) {
      result = base({ reason: 'unreachable', durationMs: res.durationMs })
    } else {
      const raw = versionFieldOf(res.json)
      if (raw === null) {
        result = base({ reason: 'bad_response', durationMs: res.durationMs })
      } else {
        const newer = isNewerVersion(raw, APP_VERSION)
        if (newer === null) {
          // polje obstaja, a ni berljiva različica (npr. 'v-next', '1.2')
          result = base({ reason: 'bad_version', durationMs: res.durationMs })
        } else {
          result = base({
            latest: typeof raw === 'string' ? raw.trim() : String(raw),
            updateAvailable: newer,
            reason: '',
            durationMs: res.durationMs,
          })
        }
      }
    }
  }

  cache = { at: now, result }
  return result
}
