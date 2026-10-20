/**
 * CFD (customer display) pogojni polling — v1.156.0.
 *
 * Zaslon gostov polla vsaki 2 s. Pred to izdajo je vsak obisk prebral celo
 * vrstico DeviceRegistry (displayPayload) in Integration (config promocij),
 * tudi ko se stanje ni spremenilo — pri 24/7 zaslonu je to glavni porabnik
 * mesečnega prenosa baze. Strežnik zdaj vrne `version`, odjemalec pa jo pošlje
 * nazaj; ob nespremenjenem stanju odgovor ne vsebuje payloada/promocij.
 */

export interface DisplayLine {
  name: string
  qty: number
  modifiers?: string[]
  price: number
}

export interface DisplayPayload {
  state?: 'idle' | 'ordering' | 'paid'
  tableName?: string
  orderNumber?: number
  lines?: DisplayLine[]
  subtotal?: number
  tax?: number
  vatBreakdown?: { rate: number; amount: number }[]
  total?: number
  message?: string
}

export interface DisplayPromo {
  id: string
  imageUrl: string
  durationSec: number
  active: boolean
}

export interface DisplayStateView {
  payload: DisplayPayload | null
  posOnline: boolean
  updatedAt?: string
  promos?: DisplayPromo[]
}

export interface DisplayStateResponse {
  paired?: boolean
  posName?: string
  posOnline?: boolean
  updatedAt?: string
  payload?: DisplayPayload | null
  promos?: DisplayPromo[]
  unchanged?: boolean
  version?: string
  error?: string
}

const ms = (d: Date | null | undefined): number => (d instanceof Date ? d.getTime() : 0)

/** Različica stanja = payload POS-a + konfiguracija promocij; brez skrivnosti. */
export function displayStateVersion(
  displayUpdatedAt: Date | null | undefined,
  promosId: string | null | undefined,
  promosUpdatedAt: Date | null | undefined,
): string {
  return `d${ms(displayUpdatedAt)}.p${ms(promosUpdatedAt)}.${promosId ?? '-'}`
}

export function displayStateUrl(version: string | null): string {
  return version
    ? `/api/devices/display/state?v=${encodeURIComponent(version)}`
    : '/api/devices/display/state'
}

/** `unchanged` ohrani zadnje stanje (payload/promocije) in osveži le prisotnost POS-a. */
export function mergeDisplayPoll(
  prev: DisplayStateView | null,
  data: DisplayStateResponse,
): DisplayStateView | null {
  if (data.unchanged) {
    return prev ? { ...prev, posOnline: data.posOnline === true } : null
  }
  return {
    payload: data.payload ?? null,
    posOnline: data.posOnline === true,
    updatedAt: data.updatedAt,
    promos: Array.isArray(data.promos) ? data.promos : [],
  }
}
