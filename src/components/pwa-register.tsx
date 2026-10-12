'use client'

/**
 * OPS-4 (v1.67.0) — registracija service workerja za PWA (tablica natakarja).
 * Komponenta ne renderira ničesar; vstavljena v root layout. SW je passthrough
 * (public/sw.js — brez predpomnilnika), torej samo omogoči "namesti aplikacijo".
 */
import { useEffect } from 'react'

export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => null)
    }
    if (document.readyState === 'complete') onLoad()
    else {
      window.addEventListener('load', onLoad)
      return () => window.removeEventListener('load', onLoad)
    }
  }, [])
  return null
}
