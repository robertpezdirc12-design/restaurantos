'use client'

/**
 * Plačilni terminal adapter (issue #1, naloga 2 — POS/plačilni terminal).
 * Načini (per-device localStorage):
 *  - 'none'      — brez terminala (samo gotovina/druge metode)
 *  - 'simulator' — avtomatska odobritev z oznako SIM (preverjen simulator po issue kriterijih)
 *  - 'manual'    — kassir potrdi na terminalu in vnesde kodo odobritve (realna pot prek osebja)
 * Znesek/koda odobritve se zapiše v Payment.authorizationCode (sledljivost).
 */

export type TerminalMode = 'none' | 'simulator' | 'manual'

export interface TerminalConfig {
  mode: TerminalMode
}

export interface TerminalResult {
  approved: boolean
  approvalCode?: string
  terminal: TerminalMode
  error?: string
}

const TERMINAL_KEY = 'ro_terminal_config'

export function getTerminalConfig(): TerminalConfig {
  if (typeof window === 'undefined') return { mode: 'none' }
  try {
    const raw = localStorage.getItem(TERMINAL_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TerminalConfig>
      if ((['none', 'simulator', 'manual'] as const).includes(parsed.mode as TerminalMode)) {
        return { mode: parsed.mode as TerminalMode }
      }
    }
  } catch { /* fallback spodaj */ }
  return { mode: 'none' }
}

export function saveTerminalConfig(cfg: TerminalConfig) {
  localStorage.setItem(TERMINAL_KEY, JSON.stringify(cfg))
}

/** Izvedi avtorizacijo na terminalu (pred zapisom plačila) */
export async function processTerminalPayment(amount: number): Promise<TerminalResult> {
  const cfg = getTerminalConfig()
  if (cfg.mode === 'none') {
    return { approved: false, terminal: 'none', error: 'Terminal ni konfiguriran. Nastavite ga v Nastavitvah ali uporabite drug način plačila.' }
  }
  if (cfg.mode === 'simulator') {
    // JASNO označena simulacija — nikoli se ne pošlje na pravo napravo
    await new Promise((r) => setTimeout(r, 700))
    const code = `SIM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    console.info(`[TERMINAL SIMULATOR] odobritev ${amount.toFixed(2)} EUR → ${code}`)
    return { approved: true, approvalCode: code, terminal: 'simulator' }
  }
  // manual: operater potrdi na fizičnem terminalu in prepiše kodo odobritve
  const code = window.prompt(
    `Terminal: AVTORIZACIJA ${amount.toFixed(2)} EUR\n\nPotrdite na plačilnem terminalu in vnesite kodo odobritve (approval code):`
  )
  const trimmed = (code || '').trim()
  if (!trimmed) {
    return { approved: false, terminal: 'manual', error: 'Transakcija na terminalu ni bila odobrena.' }
  }
  return { approved: true, approvalCode: trimmed.slice(0, 40), terminal: 'manual' }
}
