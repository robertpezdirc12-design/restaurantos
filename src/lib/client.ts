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

/**
 * v1.277.0: centralni formatirniki fmtEUR/fmtNumSI/fmtFixedSI so preseljeni v
 * čisti sloj '@/lib/fmt' (0 uvozov, strežniško varen — API rute jih zdaj lahko
 * uporabljajo za potisna televa in fail() napake). Ta modul jih le re-izvozi,
 * da VSI obstoječi uvozi (25 datotek) in testni pini (v276/issue71) ostanejo
 * zeleni. Ena funkcija = ena oblika (doktrina issue #71) — en sam vir resnice.
 */
export { fmtEUR, fmtNumSI, fmtFixedSI } from './fmt'

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
