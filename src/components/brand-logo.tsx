'use client'

/**
 * OSS-11 (v1.213.0) — logotip blagovne znamke na gostovskih površinah.
 *
 * URL prihaja iz nastavljene teme znamke (sanitiziran: SAMO https, max 500
 * znakov — brand-themes.ts). Gostovska stran NIKOLI ne zaupa URL-ju razen
 * z risbo: <img> z alt="" (okrasevno — ime restavracije je sosednje besedilo)
 * in tiho skritim pokvarjenim URL-jem (onError → null; URL ni zaupan, stran
 * mora ostati uporabna tudi z mrtvim logotipom). Brez logotipa v temi se
 * komponenta sploh ne rendra (pogoj na klicni strani).
 */
import { useState } from 'react'

export function BrandLogo({ src, className }: { src: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setBroken(true)}
      className={className ?? 'h-8 w-auto max-w-[160px] object-contain shrink-0'}
    />
  )
}
