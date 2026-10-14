/**
 * Issue #23 — write-only skrivnosti: namenski varni DTO-ji za Settings/Location/Integration.
 *
 * Pravilo (zahtevani rezultat #23): obstoječe geslo/certifikat/zasebni ključ/API
 * key/secret/token ali skrivno ugnezdeno config polje se v ODGOVORU nikoli ne
 * vrne — NITI uporabniku z OWNER/ADMIN/settings.manage. Namesto vrednosti
 * odgovor nosi indikator:
 *   ''     → skrivnost NI nastavljena (iskrena praznina),
 *   '••••' → skrivnost JE nastavljena (od tu naprej write-only).
 *
 * Zamenjava teče prek write-only polja: PUT/PATCH nastavi novo vrednost;
 * prazna vrednost v zahtevkih, ki skrivnosti sploh ne sprejemajo (EDITABLE
 * bela lista v settings PUT), pomeni »spremeni nekaj drugega«, ne »pobriši«.
 *
 * Integracije: config se maskira GLOBOKO (maskIntegrationConfig — ključi z
 * secret/token/key/password v imenu) ZA VSE vloge (prej so centralne videle
 * surov config — #23 §3); apiKey/apiSecret se za vse vloge nadomestita z
 * indikatorjem ('' / '••••').
 */
import type { Integration } from '@prisma/client'
import { jparse } from '@/lib/map'
import { maskIntegrationConfig, MASK as SECRET_MASK } from '@/lib/integration-mask'

export { SECRET_MASK }

/** '' kadar ni nastavljeno; maskni indikator kadar je. */
export function maskSecretValue(v: string | null | undefined): string {
  return v ? SECRET_MASK : ''
}

/** apiKeys je JSON seznam nizov — prazen seznam pomeni »ni nastavljeno«. */
function maskApiKeysList(v: string | null | undefined): string {
  const arr = jparse<string[]>(v ?? '[]', [])
  return Array.isArray(arr) && arr.length > 0 ? SECRET_MASK : ''
}

const SETTINGS_SECRET_KEYS = ['fursCertPassword', 'cisCertPassword', 'emailSmtpPassword'] as const

/** #23 §1: varni settings DTO — vsa polja vrstice, skrivnosti zamenjane z indikatorjem. */
export function safeSettingsDto<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const k of SETTINGS_SECRET_KEYS) out[k] = maskSecretValue(row[k] as string | null | undefined)
  out.apiKeys = maskApiKeysList(row.apiKeys as string | null | undefined)
  return out
}

const LOCATION_SECRET_KEYS = ['fursCertPassword'] as const

/** #23 §2: varni Location DTO (poti certifikatov ostanejo vidne — operativni podatek). */
export function safeLocationDto<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const k of LOCATION_SECRET_KEYS) out[k] = maskSecretValue(row[k] as string | null | undefined)
  return out
}

/**
 * #23 §3 + #42: varni Integration DTO — maskiran config (vse vloge), indikatorja
 * apiKey/apiSecret, lastSyncError le za centralne vloge (enako pravilo kot seznam).
 * Surovi `row` se v odgovorih ne sme več pojaviti (GET/POST/PATCH/DELETE).
 */
export function safeIntegrationDto(row: Integration, opts: { central: boolean }): Record<string, unknown> {
  const config = jparse<Record<string, unknown>>(row.config, {})
  const { masked, maskedFields } = maskIntegrationConfig(config)
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: maskSecretValue(row.apiKey),
    apiSecret: maskSecretValue(row.apiSecret),
    syncEnabled: row.syncEnabled,
    syncInterval: row.syncInterval,
    isActive: row.isActive,
    connectionStatus: row.connectionStatus,
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: opts.central ? row.lastSyncError : '',
    locationId: row.locationId,
    config: masked,
    ...(maskedFields.length ? { maskedFields } : {}),
    events: jparse(row.events, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
