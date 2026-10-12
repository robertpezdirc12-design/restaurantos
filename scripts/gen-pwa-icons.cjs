#!/usr/bin/env node
/**
 * OPS-4 (v1.67.0) — generator PWA ikon (tablica/PWA val).
 * Renderira inline SVG (blagajna/lončnica v brand emerald) v PNG velikosti,
 * ki jih zahteva manifest (192/512) + apple-touch-icon (180).
 * Zagon: node scripts/gen-pwa-icons.cjs (idempotentno; overwrite).
 */
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#047857"/>
  <g fill="#ffffff">
    <!-- strežniški pladenj (cloche) -->
    <path d="M256 128c-14 0-25 11-25 25 0 6 2 11 5 15-52 9-92 51-100 104h240c-8-53-48-95-100-104 3-4 5-9 5-15 0-14-11-25-25-25z"/>
    <rect x="112" y="288" width="288" height="28" rx="14"/>
    <rect x="96" y="332" width="320" height="24" rx="12"/>
    <!-- pin mize -->
    <circle cx="256" cy="404" r="18"/>
    <rect x="176" y="424" width="160" height="18" rx="9"/>
  </g>
</svg>
`

async function main() {
  const pub = path.join(__dirname, '..', 'public')
  fs.mkdirSync(pub, { recursive: true })
  const sizes = [
    ['pwa-icon-192.png', 192],
    ['pwa-icon-512.png', 512],
    ['apple-touch-icon.png', 180],
  ]
  for (const [name, size] of sizes) {
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(pub, name))
    console.log('generated', name, size)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
