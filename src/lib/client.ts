'use client'

/**
 * Issue #90 (QA): seja od v1.219.0 potuje prek httpOnly piškotka `ro_session`
 * (Set-Cookie ob prijavi) — isti-origin fetch ga nosi SAM (same-origin
 * privzeto). Žeton v localStorage (ro_token) ostaja SAMO kot prehod za seje,
 * prijavljene PRED tem dvigom: če obstaja, ga še priložimo kot Bearer (strežnik
 * sprejme oba transporta; getAuth preizkusi Bearer najprej, nato piškotek).
 * Nove prijave ro_token NE zapišejo več — XSS ga ne more prebrati.
 */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('ro_token')
}

export function getUser(): { id: string; name: string; role: string; email?: string; locationId?: string | null; permissions?: string[] } | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('ro_user')
  return raw ? JSON.parse(raw) : null
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.removeItem('ro_token')
    localStorage.removeItem('ro_user')
    window.location.href = '/'
    throw new Error('unauthorized')
  }
  const data = await res.json()
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Napaka zahteve')
  return data as T
}

export const fmtEUR = (n: number) =>
  new Intl.NumberFormat('sl-SI', { style: 'currency', currency: 'EUR' }).format(n)

/**
 * Issue #71 audit-12: ENOTNO oblikovanje števil za vse izpise meritev/vrednosti
 * (HACCP temperature, DDV stopnje, recepture …) — sl-SI decimalna VEJICA
 * (»4,2 °C«, »9,5 %«), ne pika. Ena sama funkcija = ena sama oblika.
 */
export const fmtNumSI = (n: number, opts?: { min?: number; max?: number; unit?: string }) =>
  `${new Intl.NumberFormat('sl-SI', {
    ...(opts?.min != null ? { minimumFractionDigits: opts.min } : {}),
    maximumFractionDigits: opts?.max ?? 2,
  }).format(n)}${opts?.unit ?? ''}`

/**
 * v1.276.0: fiksno število decimalnk po vzorcu toFixed(N), a v sl-SI obliki
 * (vejica + ločilo tisočic) — »12,50«, ne »12.50«. min === max === N nadomesti
 * surove `${n.toFixed(N)}` izpise v render poteh (ista doktrina issue #71:
 * ena funkcija = ena oblika; surovi toFixed izpiše PIKO ob sosednjih vejicah).
 */
export const fmtFixedSI = (n: number, digits: number, unit?: string) =>
  `${new Intl.NumberFormat('sl-SI', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)}${unit ?? ''}`

/** v1.129.0 (Toast/Square benchmark): podpisana rast v % za Δ na KPI karticah (+12,3 % / −4,5 %) */
export const fmtPctSigned = (ratio: number) => {
  if (!Number.isFinite(ratio)) return '—'
  const pct = ratio * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 1 }).format(pct)} %`
}

/** Izvoz CSV (ločilo ; + BOM za Excel, slovenske kode) */
export function downloadCSV(filename: string, rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = String(v ?? '')
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = rows.map((r) => r.map(esc).join(';')).join('\r\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
