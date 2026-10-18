/**
 * DEMO MIZE (v1.141.0 — vizualni benchmark Toast/Lightspeed):
 * Tabela miz je v dev DB PRAZNA → tloris (Mize → Tloris) je prazno platno.
 * Skripta doda realističen nabor demo miz VSAKI aktivni lokaciji brez miz:
 *   - Glavna dvorana: 8 miz (kvadratne/pravokotne, 2–6 sedežev)
 *   - Bar: 2 barski mizi (okrogli) + 4 barski stoli
 *   - Terasa: 4 mize (mešane)
 * Pozicije v PX enoti (platno 440×380 — enako kot seed/PATCH, floor-plan.ts
 * hevristika jih prepozna kot px nabor). Idempotentno: preskoči lokacije,
 * ki že imajo mize.
 */
import { db } from '../src/lib/db'

const FLOOR_W = 440
const FLOOR_H = 380

type DemoTable = { n: number; cap: number; area: string; x: number; y: number }

/** Tloris 440×380 px: cona Glavna dvorana zgoraj, Bar desno spodaj, Terasa spodaj levo. */
const demoTables: DemoTable[] = [
  // Glavna dvorana (zgornji del) — 2 × 4 mreža
  { n: 1, cap: 2, area: 'Glavna dvorana', x: 60, y: 70 },
  { n: 2, cap: 4, area: 'Glavna dvorana', x: 160, y: 70 },
  { n: 3, cap: 4, area: 'Glavna dvorana', x: 260, y: 70 },
  { n: 4, cap: 6, area: 'Glavna dvorana', x: 360, y: 70 },
  { n: 5, cap: 2, area: 'Glavna dvorana', x: 60, y: 170 },
  { n: 6, cap: 4, area: 'Glavna dvorana', x: 160, y: 170 },
  { n: 7, cap: 4, area: 'Glavna dvorana', x: 260, y: 170 },
  { n: 8, cap: 8, area: 'Glavna dvorana', x: 360, y: 170 },
  // Bar (desni trak) — okrogle mize + barski stoli
  { n: 9, cap: 4, area: 'Bar', x: 340, y: 280 },
  { n: 10, cap: 4, area: 'Bar', x: 340, y: 330 },
  { n: 11, cap: 1, area: 'Bar', x: 60, y: 300 },
  { n: 12, cap: 1, area: 'Bar', x: 110, y: 300 },
  { n: 13, cap: 1, area: 'Bar', x: 160, y: 300 },
  { n: 14, cap: 1, area: 'Bar', x: 210, y: 300 },
  // Terasa (spodaj) — mešane
  { n: 15, cap: 4, area: 'Terasa', x: 60, y: 345 },
  { n: 16, cap: 4, area: 'Terasa', x: 160, y: 345 },
]

const clamp = (v: number) => Math.min(FLOOR_W - 10, Math.max(10, v))
const nid = (n: number) => `seed-tbl-${Date.now().toString(36)}-${n}`

async function main() {
  const locs = await db.location.findMany({ select: { id: true, name: true, isActive: true } })
  let created = 0
  let skipped = 0
  for (const loc of locs) {
    if (!loc.isActive) { skipped++; continue }
    const existing = await db.table.count({ where: { locationId: loc.id } })
    if (existing > 0) { skipped++; continue }
    for (const dt of demoTables) {
      await db.table.create({
        data: {
          id: nid(dt.n),
          number: dt.n,
          capacity: dt.cap,
          area: dt.area,
          posX: clamp(dt.x),
          posY: clamp(dt.y),
          shape: dt.cap === 1 ? 'stool' : dt.area === 'Bar' || dt.cap >= 6 ? 'round' : 'square',
          status: 'available',
          locationId: loc.id,
        },
      })
      created++
    }
  }
  console.log(`✅ Demo mize ustvarjene: ${created} (lokacije preskočene: ${skipped})`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => { return (db as unknown as { $disconnect: () => Promise<void> }).$disconnect() })
