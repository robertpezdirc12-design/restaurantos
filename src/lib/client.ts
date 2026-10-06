'use client'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('ro_token')
}

export function getUser(): { id: string; name: string; role: string } | null {
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
