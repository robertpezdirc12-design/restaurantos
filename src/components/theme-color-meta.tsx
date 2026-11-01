'use client'

import { useEffect } from 'react'
import { useTheme } from 'next-themes'

/**
 * Issue #89 (QA hrošč 7): `<meta name="theme-color">` je bil statičen
 * (#047857) — v temnem načinu je aplikacija temna, brskalnikova vrstica
 * (PWA standalone / naslovna vrstica na mobilnem) pa je ostala zelena.
 *
 * Aplikacija uporablja ROČNI preklop (next-themes, class strategija +
 * localStorage), zmedijna poizvedba `prefers-color-scheme` ne odraža
 * uporabnikove izbire — barvo je treba posodobiti ob preklopu (JS).
 *
 * Barvi sledita app paleti: svetla = stone-50 (#fafaf9), temna = stone-900
 * (#1c1917). Manifest theme_color ostaja #047857 (znamčna zelena za
 * namestitveno ikono/predstavitveno okno — to je DRUGA od barve vrstice).
 */
export function ThemeColorMeta() {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolvedTheme === 'dark' ? '#1c1917' : '#fafaf9')
  }, [resolvedTheme])

  return null
}
