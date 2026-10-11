/**
 * Task 60 — skupne pomočnice za maskiranje skrivnosti integracij.
 *
 * Issue #4 §1 (obstoječe pravilo iz integrations/route.ts, zdaj izvlečeno, da ga
 * delijo GET/[id]/test rute): ključi configa, katerih ime vsebuje
 * secret/token/key/password (case-insensitive), se za non-central vloge
 * maskirajo ('••••') in označijo v `maskedFields`.
 *
 * ZAPIS (Task 60): vrednost '••••' je maskni sentinel — pri zapisu (POST/PATCH
 * config) se take vrednosti IZPUSTIJO, tako da urednik brez pravic do skrivnosti
 * ne more prepisati prave vrednosti z masko (dopolnilni zapis ohrani skrivnost).
 */
export const SECRET_KEY_PATTERN = /(secret|token|key|password)/i
export const MASK = '••••'

/** Poleg imena ključa tudi vrednost '••••' šteje kot maska (varnost v globini). */
export function isMaskedValue(v: unknown): boolean {
  return typeof v === 'string' && v.trim() === MASK
}

/** Vrne config s maskiranimi skrivnostmi + seznam maskiranih ključev. */
export function maskIntegrationConfig(config: Record<string, unknown>): {
  masked: Record<string, unknown>
  maskedFields: string[]
} {
  const masked: Record<string, unknown> = {}
  const maskedFields: string[] = []
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_KEY_PATTERN.test(k) || isMaskedValue(v)) {
      masked[k] = MASK
      maskedFields.push(k)
    } else {
      masked[k] = v
    }
  }
  return { masked, maskedFields }
}

/**
 * Ob zapisu: odstrani maskne vrednosti ('••••'), da se prave skrivnosti
 * ne prepišejo z masko. Ključ z masko pomeni »pusti nespremenjeno«.
 */
export function stripMaskedConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (isMaskedValue(v) && SECRET_KEY_PATTERN.test(k)) continue
    out[k] = v
  }
  return out
}
