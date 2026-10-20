/**
 * RestavrantOS — OBSEŽEN DEMO SEED (za testiranje)
 * Zaženi na SVEŽI bazi:
 *   DATABASE_URL=file:... bunx prisma db push --schema prisma/schema.sqlite.prisma --accept-data-loss
 *   DATABASE_URL=file:... bun prisma/seed-demo.ts
 *
 * Vsebina: lokacija, delavci (PIN prijava + demo admin), postaje (KDS),
 * meni s 15 kategorijami in ~170 artikli (cene po slovenskih cenikih
 * z dne 18. 10. 2026 — spletne reference: picerije/gostilne Ljubljana),
 * zaloga ~150 artiklov (surovine + pijače), 7 dobaviteljev, serije
 * (InventoryBatch z roki uporabe), recepture za izbrane artikle,
 * 16 miz z oblikami (krožne/kvadratne/šank), odpiralni čas, nastavitve.
 */
import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
import { employeePinFields } from '../src/lib/auth'

const db = new PrismaClient()

/** Determinističen ID iz semena (sha1, 20 znakov) */
function nid(seed: string): string {
  return createHash('sha1').update(`demo:${seed}`).digest('hex').slice(0, 20)
}

const day = 24 * 3600_000
const now = Date.now()

async function main() {
  console.log('🌱 Obsežen demo seed — začetek...')

  /* ─────────── LOKACIJA ─────────── */
  const locationId = nid('loc-main')
  await db.location.create({
    data: {
      id: locationId,
      name: 'Gostilna Pri Lipi',
      code: 'LJU-01',
      type: 'restaurant',
      address: 'Slovenska cesta 12',
      city: 'Ljubljana',
      postCode: '1000',
      country: 'SI',
      phone: '+386 1 234 56 78',
      email: 'info@gostilnaprilipi.si',
      businessId: '7654321',
      taxId: 'SI76543212',
      registerNumber: 'BLG-001',
      premisesId: 'BLG001',
      fursEnvironment: 'test',
      currency: 'EUR',
      locale: 'sl-SI',
      isOpen: true,
      isActive: true,
    },
  })
  console.log('📍 Lokacija: Gostilna Pri Lipi (Ljubljana)')

  /* ─────────── ZAPLOSNENI (demo login izbere najstarejšega aktivnega admina) ─────────── */
  const employees = [
    { id: nid('emp-admin'), name: 'Ana Admin', email: 'admin@gostilnaprilipi.si', role: 'admin', pin: '1234' },
    { id: nid('emp-owner'), name: 'Franc Lipovšek', email: 'franc@gostilnaprilipi.si', role: 'owner', pin: '9999' },
    { id: nid('emp-manager'), name: 'Mojca Vodja', email: 'mojca@gostilnaprilipi.si', role: 'manager', pin: '4567' },
    { id: nid('emp-waiter1'), name: 'Marko Natakar', email: 'marko@gostilnaprilipi.si', role: 'waiter', pin: '2345' },
    { id: nid('emp-waiter2'), name: 'Petra Natakarica', email: 'petra@gostilnaprilipi.si', role: 'waiter', pin: '2355' },
    { id: nid('emp-waiter3'), name: 'Luka Štirna', email: 'luka@gostilnaprilipi.si', role: 'waiter', pin: '2365' },
    { id: nid('emp-bar'), name: 'Borut Barmen', email: 'borut@gostilnaprilipi.si', role: 'bar', pin: '3000' },
    { id: nid('emp-chef'), name: 'Katarina Kuharica', email: 'katarina@gostilnaprilipi.si', role: 'chef', pin: '3456' },
    { id: nid('emp-kitchen'), name: 'Janez Pomočnik', email: 'janez@gostilnaprilipi.si', role: 'kitchen', pin: '3555' },
    { id: nid('emp-warehouse'), name: 'Viktor Skladiščnik', email: 'viktor@gostilnaprilipi.si', role: 'warehouse', pin: '4000' },
  ]
  for (const e of employees) {
    const fields = employeePinFields(e.pin, e.email)
    await db.employee.create({
      data: {
        id: e.id, name: e.name, email: e.email, role: e.role as never,
        status: 'active', locationId,
        pin: fields.pin, pinLookup: fields.pinLookup,
        phone: '+386 40 000 000',
      },
    })
  }
  console.log(`👥 Zaposleni: ${employees.length} (admin PIN 1234, natakar 2345, kuhar 3456 ...)`)

  /* ─────────── POSTAJE (KDS) ─────────── */
  const st = {
    kitchen: nid('ps-kitchen'),
    grill: nid('ps-grill'),
    pizza: nid('ps-pizza'),
    bar: nid('ps-bar'),
    dessert: nid('ps-dessert'),
  }
  await db.prepStation.createMany({
    data: [
      { id: st.kitchen, name: 'Kuhinja', type: 'kitchen', avgPrepTime: 15, sortOrder: 1, locationId },
      { id: st.grill, name: 'Žar', type: 'grill', avgPrepTime: 12, sortOrder: 2, locationId },
      { id: st.pizza, name: 'Pica', type: 'pizza', avgPrepTime: 8, sortOrder: 3, locationId },
      { id: st.bar, name: 'Bar', type: 'bar', avgPrepTime: 4, sortOrder: 4, locationId },
      { id: st.dessert, name: 'Slaščičarna', type: 'dessert', avgPrepTime: 5, sortOrder: 5, locationId },
    ],
  })
  console.log('🔥 Postaje: Kuhinja, Žar, Pica, Bar, Slaščičarna')

  /* ─────────── MENI + KATEGORIJE ─────────── */
  const menuId = nid('menu-main')
  await db.menu.create({
    data: { id: menuId, name: 'Glavni meni', icon: '🍽️', color: '#059669', sortOrder: 1, locationId, isActive: true },
  })
  await db.menu.create({
    data: { id: nid('menu-vecerja'), name: 'Večerja a la carte', icon: '🌙', color: '#7c3aed', sortOrder: 2, locationId, isActive: true },
  })

  const catDefs: { key: string; name: string; icon: string; color: string }[] = [
    { key: 'kava', name: 'Kava in topli napitki', icon: '☕', color: '#8b5cf6' },
    { key: 'brezalk', name: 'Brezalkoholne pijače', icon: '🥤', color: '#0ea5e9' },
    { key: 'pivo', name: 'Pivo', icon: '🍺', color: '#d97706' },
    { key: 'vino', name: 'Vino', icon: '🍷', color: '#9f1239' },
    { key: 'zganje', name: 'Žgane pijače in likerji', icon: '🥃', color: '#a16207' },
    { key: 'koktajli', name: 'Koktajli', icon: '🍸', color: '#db2777' },
    { key: 'predjedi', name: 'Predjedi', icon: '🥓', color: '#ea580c' },
    { key: 'juhe', name: 'Juhe', icon: '🍲', color: '#f59e0b' },
    { key: 'solate', name: 'Solate', icon: '🥗', color: '#16a34a' },
    { key: 'glavne', name: 'Glavne jedi', icon: '🍽️', color: '#059669' },
    { key: 'burgerji', name: 'Burgerji', icon: '🍔', color: '#b45309' },
    { key: 'pice', name: 'Pice', icon: '🍕', color: '#dc2626' },
    { key: 'ribe', name: 'Ribe in morski sadeži', icon: '🐟', color: '#0369a1' },
    { key: 'priloge', name: 'Priloge', icon: '🍟', color: '#65a30d' },
    { key: 'sladice', name: 'Sladice', icon: '🍰', color: '#c026d3' },
    { key: 'otrocki', name: 'Otroški meniji', icon: '🧒', color: '#f97316' },
  ]
  const catId: Record<string, string> = {}
  for (let i = 0; i < catDefs.length; i++) {
    const c = catDefs[i]
    const id = nid(`cat-${c.key}`)
    catId[c.key] = id
    await db.category.create({
      data: { id, name: c.name, icon: c.icon, color: c.color, sortOrder: i + 1, menuId },
    })
  }
  console.log(`🗂️ Kategorije: ${catDefs.length}`)

  /* ─────────── MENU ARTIKLI (POS) ───────────
     DDV: hrana 9,5 % | alkohol/kava/soki 22 % | voda/mleko 9,5 % (SLO lestvica).
     Cene v EUR po slovenskih cenikih (spletne reference, okt. 2026). */
  type Art = { n: string; p: number; c: string; s?: keyof typeof st; d?: string; vat?: number }
  const art: Art[] = [
    // ── Kava in topli napitki (Bar) ──
    { n: 'Espresso', p: 1.9, c: 'kava', s: 'bar', vat: 22, d: 'Klasična črna kava' },
    { n: 'Ristretto', p: 1.9, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Macchiato', p: 2.1, c: 'kava', s: 'bar', vat: 22, d: 'Kava z kapljico mleka' },
    { n: 'Kava z mlekom', p: 2.3, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Kava s smetano', p: 2.5, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Cappuccino', p: 2.5, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Bela kava / Caffe latte', p: 3.0, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Latte macchiato', p: 3.2, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Flat white', p: 3.0, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Dvojna kava', p: 3.6, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Brezkofeinska kava', p: 2.7, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Turška kava', p: 2.5, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Kava z žganjem', p: 4.5, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Črni čaj', p: 2.2, c: 'kava', s: 'bar', vat: 22, d: 'Izbor 5 vrst' },
    { n: 'Zeleni čaj', p: 2.4, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Čaj z limono in medom', p: 2.9, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Vroča čokolada', p: 3.5, c: 'kava', s: 'bar', vat: 22, d: 'S smetano' },
    { n: 'Kakav', p: 2.8, c: 'kava', s: 'bar', vat: 22 },
    { n: 'Zakuhano vino', p: 3.2, c: 'kava', s: 'bar', vat: 22, d: '0,2 l, z začimbami' },
    { n: 'Zakuhano jabolko', p: 3.5, c: 'kava', s: 'bar', vat: 22 },
    // ── Brezalkoholne pijače (Bar) ──
    { n: 'Radenska 0,5 l', p: 2.5, c: 'brezalk', s: 'bar', vat: 9.5 },
    { n: 'Radenska 0,75 l', p: 3.2, c: 'brezalk', s: 'bar', vat: 9.5 },
    { n: 'Stilla 0,33 l', p: 2.3, c: 'brezalk', s: 'bar', vat: 9.5 },
    { n: 'Stilla 0,75 l', p: 2.9, c: 'brezalk', s: 'bar', vat: 9.5 },
    { n: 'Coca-Cola 0,25 l', p: 3.0, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Coca-Cola 0,33 l', p: 3.2, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Coca-Cola Zero 0,33 l', p: 3.2, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Fanta 0,25 l', p: 3.0, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Sprite 0,25 l', p: 3.0, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Schweppes tonik 0,25 l', p: 3.0, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Ginger ale 0,25 l', p: 3.0, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Pomarančni sok 0,2 l', p: 3.0, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Domače stisnjen pomarančni sok 0,3 l', p: 3.8, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Jabolčni sok 0,2 l', p: 2.8, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Multivitamin sok 0,25 l', p: 3.2, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Ledni čaj (breskev/limona) 0,25 l', p: 2.9, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Domači sirup (bazilika-limona) 0,3 l', p: 3.3, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Domača limonada 0,4 l', p: 3.5, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Voda z limono in meto 0,5 l', p: 3.5, c: 'brezalk', s: 'bar', vat: 9.5 },
    { n: 'Red Bull 0,25 l', p: 3.5, c: 'brezalk', s: 'bar', vat: 22 },
    { n: 'Mleko 0,2 l', p: 1.8, c: 'brezalk', s: 'bar', vat: 9.5 },
    { n: 'Pomaranča (kos)', p: 1.5, c: 'brezalk', s: 'bar', vat: 9.5 },
    // ── Pivo (Bar) ──
    { n: 'Union svetlo 0,5 l', p: 3.6, c: 'pivo', s: 'bar', vat: 22, d: 'Točeno' },
    { n: 'Laško svetlo 0,5 l', p: 3.6, c: 'pivo', s: 'bar', vat: 22, d: 'Točeno' },
    { n: 'Union 0,3 l', p: 3.0, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Union temni 0,5 l', p: 3.9, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Laško radler 0,5 l', p: 3.6, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Radler grenivka 0,5 l', p: 3.6, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Heineken 0,5 l', p: 4.2, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Kozel svetli 0,5 l', p: 4.0, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Stella Artois 0,4 l', p: 4.3, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Craft IPA Reservoir Dogs 0,3 l', p: 5.0, c: 'pivo', s: 'bar', vat: 22, d: 'Lokalna pivovarna' },
    { n: 'Nefiltrirano pivo 0,5 l', p: 4.5, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Nealkoholno pivo 0,5 l', p: 3.2, c: 'pivo', s: 'bar', vat: 22 },
    { n: 'Pivo v steklenici 0,33 l', p: 3.0, c: 'pivo', s: 'bar', vat: 22 },
    // ── Vino (Bar) ──
    { n: 'Cviček 1 dl', p: 2.8, c: 'vino', s: 'bar', vat: 22, d: 'Domače, Dolenjska' },
    { n: 'Cviček 2 dl', p: 4.9, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Cviček 0,75 l (flaša)', p: 16.9, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Laški rizling 1 dl', p: 3.0, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Laški rizling 2 dl', p: 5.2, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Rebula 2 dl', p: 5.5, c: 'vino', s: 'bar', vat: 22, d: 'Brda' },
    { n: 'Chardonnay 2 dl', p: 5.0, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Sauvignon blanc 2 dl', p: 5.5, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Sivi pinot 2 dl', p: 5.2, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Belo vino 0,75 l (flaša)', p: 19.0, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Modri pinot 2 dl', p: 5.8, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Merlot 2 dl', p: 5.5, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Cabernet sauvignon 2 dl', p: 6.0, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Refošk 2 dl', p: 6.2, c: 'vino', s: 'bar', vat: 22, d: 'Kras' },
    { n: 'Rdeče vino 0,75 l (flaša)', p: 21.0, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Penina 1 dl', p: 4.5, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Penina 0,75 l (flaša)', p: 28.0, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Sladka penina 0,75 l', p: 32.0, c: 'vino', s: 'bar', vat: 22 },
    { n: 'Metliška črnina 2 dl', p: 4.8, c: 'vino', s: 'bar', vat: 22 },
    // ── Žgane pijače in likerji (Bar) ──
    { n: 'Jenever 0,03 l', p: 2.5, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Vodka 0,03 l', p: 3.0, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Gin 0,03 l', p: 3.5, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Rum 0,03 l', p: 3.5, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Whisky 0,03 l', p: 4.0, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Bourbon 0,04 l', p: 4.5, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Tequila 0,03 l', p: 3.8, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Domači sadjevec 0,03 l', p: 3.2, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Borovničevec 0,03 l', p: 3.5, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Pelinkovac 0,03 l', p: 3.2, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Teranov liker 0,03 l', p: 3.8, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Medeni žganjec 0,03 l', p: 4.0, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Amaro 0,03 l', p: 3.5, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Baileys 0,03 l', p: 3.8, c: 'zganje', s: 'bar', vat: 22 },
    { n: 'Cognac 0,04 l', p: 6.0, c: 'zganje', s: 'bar', vat: 22 },
    // ── Koktajli (Bar) ──
    { n: 'Aperol spritz', p: 7.5, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Hugo', p: 7.0, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Gin tonic', p: 6.5, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Mojito', p: 8.0, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Margarita', p: 8.5, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Caipirinha', p: 8.5, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Negroni', p: 9.0, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Cuba libre', p: 7.0, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Sex on the beach', p: 7.5, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Cosmopolitan', p: 8.5, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Martini dry', p: 9.0, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Tequila sunrise', p: 7.5, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Piña colada', p: 8.0, c: 'koktajli', s: 'bar', vat: 22 },
    { n: 'Virgin mojito', p: 6.0, c: 'koktajli', s: 'bar', vat: 22, d: 'Brez alkohola' },
    // ── Predjedi (Kuhinja) ──
    { n: 'Bruskete s paradižnikom in baziliko', p: 6.5, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Bruskete s kozicami', p: 9.5, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Pršut in sir (deska za 2)', p: 12.9, c: 'predjedi', s: 'kitchen', vat: 9.5, d: 'Kraški pršut, domači sir' },
    { n: 'Sirna deska', p: 11.5, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Mesna deska', p: 13.9, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Kozice v česnovem maslu', p: 9.9, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Hobotnica na žaru', p: 12.5, c: 'predjedi', s: 'grill', vat: 9.5 },
    { n: 'Lignji na žaru', p: 10.5, c: 'predjedi', s: 'grill', vat: 9.5 },
    { n: 'Polpeti (čičerikini)', p: 7.5, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Bučke v parmezanu', p: 7.2, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Gobe v pivskem testu', p: 7.9, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Laška frtalja', p: 6.9, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Domač kruh z mastjo in soljo', p: 4.5, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Ajdovi žganci s tolčencem', p: 8.5, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    { n: 'Kranjska klobasa (hladna)', p: 8.9, c: 'predjedi', s: 'kitchen', vat: 9.5 },
    // ── Juhe (Kuhinja) ──
    { n: 'Goveja juha z rezanci', p: 4.5, c: 'juhe', s: 'kitchen', vat: 9.5 },
    { n: 'Gobova kremna juha', p: 4.9, c: 'juhe', s: 'kitchen', vat: 9.5 },
    { n: 'Bučna kremna juha', p: 4.9, c: 'juhe', s: 'kitchen', vat: 9.5, d: 'S bučnim oljem in semeni' },
    { n: 'Jota', p: 5.5, c: 'juhe', s: 'kitchen', vat: 9.5, d: 'Kislo zelje, repa, klobasa' },
    { n: 'Ričet', p: 5.2, c: 'juhe', s: 'kitchen', vat: 9.5 },
    { n: 'Minestra', p: 5.8, c: 'juhe', s: 'kitchen', vat: 9.5 },
    { n: 'Bograč (skleda)', p: 6.9, c: 'juhe', s: 'kitchen', vat: 9.5, d: 'Prekmurska specialiteta' },
    { n: 'Paradižnikova juha', p: 4.5, c: 'juhe', s: 'kitchen', vat: 9.5 },
    { n: 'Kokošja juha z cmoki', p: 4.9, c: 'juhe', s: 'kitchen', vat: 9.5 },
    { n: 'Kisla juha', p: 4.8, c: 'juhe', s: 'kitchen', vat: 9.5 },
    // ── Solate (Kuhinja) ──
    { n: 'Mešana solata', p: 6.9, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Cezar solata', p: 9.9, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Cezar solata s piščancem', p: 12.9, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Caprese', p: 8.9, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Grška solata', p: 8.5, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Tuna solata', p: 10.5, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Solata s kozicami', p: 12.9, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Solata z burrato in paradižnikom', p: 11.5, c: 'solate', s: 'kitchen', vat: 9.5 },
    { n: 'Blitva s kuhanim jajcem', p: 7.9, c: 'solate', s: 'kitchen', vat: 9.5 },
    // ── Glavne jedi (Kuhinja/Žar) ──
    { n: 'Telečji dunajski zrezek', p: 17.9, c: 'glavne', s: 'kitchen', vat: 9.5, d: 'S pomfritom in limono' },
    { n: 'Telečji zrezek v omaki', p: 18.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Svinjski dunajski zrezek', p: 13.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Svinjski zrezek po želji', p: 14.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Piščančji file na žaru', p: 14.5, c: 'glavne', s: 'grill', vat: 9.5 },
    { n: 'Dunajski piščančji zrezek', p: 14.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Pečen piščanec z žara', p: 13.5, c: 'glavne', s: 'grill', vat: 9.5 },
    { n: 'Ražnjiči mešani', p: 15.5, c: 'glavne', s: 'grill', vat: 9.5 },
    { n: 'Goveji golaš', p: 13.5, c: 'glavne', s: 'kitchen', vat: 9.5, d: 'S polento' },
    { n: 'Bograč', p: 14.9, c: 'glavne', s: 'kitchen', vat: 9.5, d: 'Prekmurski lonec' },
    { n: 'Kranjska klobasa s kislim zeljem', p: 12.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Zapečena kranjska klobasa', p: 13.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Zebra pečenka', p: 18.9, c: 'glavne', s: 'grill', vat: 9.5, d: 'Peljska specialiteta' },
    { n: 'Telečja jetrca z čebulo', p: 12.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Morska rižota', p: 15.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Rižota z gobami', p: 12.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Rižota s kozicami', p: 16.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Testenine Bolognese', p: 12.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Testenine Carbonara', p: 12.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Testenine s pestom', p: 12.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Testenine z morskimi sadeži', p: 16.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Njoki s sirom in smetano', p: 11.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Njoki z golažem', p: 12.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Lazanja', p: 12.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Žlikrofi z žganci', p: 11.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Polenta z golažem', p: 11.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Piščanec stir-fry', p: 13.9, c: 'glavne', s: 'kitchen', vat: 9.5, d: 'Z rižem in zelenjavo' },
    { n: 'Veganski rižot z zelenjavo', p: 12.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Tofu z zelenjavo', p: 12.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Palačinka z mesom (slana)', p: 10.9, c: 'glavne', s: 'kitchen', vat: 9.5 },
    { n: 'Burek s sirom', p: 4.5, c: 'glavne', s: 'kitchen', vat: 9.5 },
    // ── Burgerji (Žar) ──
    { n: 'Klasičen burger', p: 10.9, c: 'burgerji', s: 'grill', vat: 9.5 },
    { n: 'Cheese burger', p: 11.9, c: 'burgerji', s: 'grill', vat: 9.5 },
    { n: 'Dvojni cheese burger', p: 13.9, c: 'burgerji', s: 'grill', vat: 9.5 },
    { n: 'Bacon burger', p: 12.9, c: 'burgerji', s: 'grill', vat: 9.5 },
    { n: 'Pikantni burger', p: 11.9, c: 'burgerji', s: 'grill', vat: 9.5, d: 'Z jalapeño' },
    { n: 'Chicken burger', p: 10.5, c: 'burgerji', s: 'grill', vat: 9.5 },
    { n: 'Veggie burger', p: 10.9, c: 'burgerji', s: 'grill', vat: 9.5 },
    { n: 'Pomfrit (ob burgerju)', p: 3.5, c: 'burgerji', s: 'grill', vat: 9.5 },
    // ── Pice (Pica) ──
    { n: 'Pizza Margherita', p: 8.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Capricciosa', p: 11.5, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Quattro formaggi', p: 12.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Prosciutto', p: 12.5, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Prosciutto e funghi', p: 12.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Vegetariana', p: 10.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Calzone', p: 11.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Tuna', p: 12.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Marinara', p: 9.5, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Napoletana', p: 11.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza s tartufi', p: 14.9, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Pizza Diavola', p: 12.5, c: 'pice', s: 'pizza', vat: 9.5 },
    { n: 'Otroška pica', p: 6.5, c: 'pice', s: 'pizza', vat: 9.5 },
    // ── Ribe (Kuhinja/Žar) ──
    { n: 'Losos na žaru', p: 21.0, c: 'ribe', s: 'grill', vat: 9.5 },
    { n: 'Brancin na žaru', p: 19.5, c: 'ribe', s: 'grill', vat: 9.5 },
    { n: 'Morski list', p: 22.0, c: 'ribe', s: 'grill', vat: 9.5 },
    { n: 'Postrv v foliji', p: 16.9, c: 'ribe', s: 'kitchen', vat: 9.5 },
    { n: 'Kalamari na žaru', p: 13.5, c: 'ribe', s: 'grill', vat: 9.5 },
    { n: 'Mušle v belnem vinu', p: 14.9, c: 'ribe', s: 'kitchen', vat: 9.5 },
    { n: 'Rižota z morskimi sadeži', p: 16.5, c: 'ribe', s: 'kitchen', vat: 9.5 },
    { n: 'Ribji file (paniran)', p: 15.5, c: 'ribe', s: 'kitchen', vat: 9.5 },
    { n: 'Kozice na žaru', p: 16.5, c: 'ribe', s: 'grill', vat: 9.5 },
    { n: 'Ribja juha (bourride)', p: 7.5, c: 'ribe', s: 'kitchen', vat: 9.5 },
    // ── Priloge (Kuhinja) ──
    { n: 'Pomfrit', p: 3.5, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Pečen krompir z rožmarinom', p: 4.0, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Krompirjev pire', p: 3.9, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Riž', p: 3.5, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Njoki (priloga)', p: 4.0, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Blitva s krompirjem', p: 4.5, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Kislo zelje', p: 3.9, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Polenta', p: 3.9, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Zelenjavna priloga', p: 4.5, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Grisini', p: 2.5, c: 'priloge', s: 'dessert', vat: 9.5 },
    { n: 'Domač kruh (rezina)', p: 1.5, c: 'priloge', s: 'kitchen', vat: 9.5 },
    { n: 'Mešana solata (priloga)', p: 3.0, c: 'priloge', s: 'kitchen', vat: 9.5 },
    // ── Sladice (Slaščičarna) ──
    { n: 'Kremna rezina', p: 4.9, c: 'sladice', s: 'dessert', vat: 9.5, d: 'Bledska' },
    { n: 'Prekmurska gibanica', p: 5.9, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Potica (orehova)', p: 4.5, c: 'sladice', s: 'dessert', vat: 9.5, d: 'Domača' },
    { n: 'Štruklji (masleni)', p: 5.5, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Palačinke z nutello', p: 5.9, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Palačinke z marmelado', p: 5.5, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Tiramisu', p: 6.0, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Čokoladna torta', p: 5.5, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Cheesecake z jagodami', p: 5.9, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Topla čokoladna torta', p: 6.5, c: 'sladice', s: 'dessert', vat: 9.5, d: 'Z vaniljevim sladoledom' },
    { n: 'Ledi (3 kroglice)', p: 4.5, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Panna cotta', p: 5.5, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Sadna skleda', p: 4.9, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Jabolko v listnatem testu', p: 5.9, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Rižev pudding', p: 4.5, c: 'sladice', s: 'dessert', vat: 9.5 },
    { n: 'Cremeschnitta', p: 5.2, c: 'sladice', s: 'dessert', vat: 9.5 },
    // ── Otroški meniji (Kuhinja) ──
    { n: 'Piščančji palčki s pomfritom', p: 7.5, c: 'otrocki', s: 'kitchen', vat: 9.5 },
    { n: 'Rezanci z maslom', p: 6.5, c: 'otrocki', s: 'kitchen', vat: 9.5 },
    { n: 'Mini pizza', p: 6.9, c: 'otrocki', s: 'pizza', vat: 9.5 },
    { n: 'Otroški zrezek s pirejem', p: 7.9, c: 'otrocki', s: 'kitchen', vat: 9.5 },
    { n: 'Otroška palačinka z nutello', p: 4.5, c: 'otrocki', s: 'dessert', vat: 9.5 },
  ]
  const menuItemId: Record<string, string> = {}
  let mi = 0
  for (const a of art) {
    const id = nid(`mi-${a.n}`)
    menuItemId[a.n] = id
    const orderInCat = art.filter((x) => x.c === a.c).findIndex((x) => x.n === a.n)
    await db.menuItem.create({
      data: {
        id, name: a.n, description: a.d ?? '',
        price: a.p, vatRate: a.vat ?? 22,
        categoryId: catId[a.c],
        prepStationId: a.s ? st[a.s] : null,
        isAvailable: true,
        sortOrder: orderInCat + 1,
      },
    })
    mi++
  }
  console.log(`🍽️ Menu artikli (POS): ${mi}`)

  /* ─────────── DOBAVITELJI ─────────── */
  const supDefs = [
    { id: nid('sup-kmetija'), name: 'Kmetija Sonce', code: 'SUP-001', contact: 'Jože Kmet', phone: '+386 41 111 222', city: 'Domžale', days: ['ponedeljek', 'četrtek'] },
    { id: nid('sup-petek'), name: 'Petek Meso d.o.o.', code: 'SUP-002', contact: 'Marija Petek', phone: '+386 41 222 333', city: 'Kranj', days: ['torek', 'petek'] },
    { id: nid('sup-ulov'), name: 'Jadranski ulov', code: 'SUP-003', contact: 'Ivo Ribič', phone: '+386 41 333 444', city: 'Koper', days: ['torek', 'sobota'] },
    { id: nid('sup-mlinotest'), name: 'Mlinotest Žito', code: 'SUP-004', contact: 'Služba za stranke', phone: '+386 2 220 5555', city: 'Ajdovščina', days: ['ponedeljek'] },
    { id: nid('sup-mercator'), name: 'Mercator Intersnack', code: 'SUP-005', contact: 'Poslovodstvo', phone: '+386 1 560 2000', city: 'Ljubljana', days: ['ponedeljek', 'sreda', 'petek'] },
    { id: nid('sup-vinarna'), name: 'Vinarska Lipa', code: 'SUP-006', contact: 'Tone Vinar', phone: '+386 41 555 666', city: 'Vipava', days: ['sreda'] },
    { id: nid('sup-pekarna'), name: 'Pekarna Kruhek', code: 'SUP-007', contact: 'Pepek Pekar', phone: '+386 41 777 888', city: 'Ljubljana', days: ['vsakodnevno'] },
  ]
  for (const s of supDefs) {
    await db.supplier.create({
      data: {
        id: s.id, name: s.name, code: s.code, contactPerson: s.contact, phone: s.phone,
        city: s.city, country: 'Slovenija', isActive: true,
        paymentTerms: '30 dni',
        deliveryDays: JSON.stringify(s.days),
        rating: 4.5,
      },
    })
  }
  const supName: Record<string, string> = {
    meso: 'Petek Meso d.o.o.', ribe: 'Jadranski ulov', mlecni: 'Mercator Intersnack',
    zelenjava: 'Kmetija Sonce', sadje: 'Kmetija Sonce', suho: 'Mlinotest Žito',
    konzerve: 'Mercator Intersnack', olja: 'Mercator Intersnack', zacimbe: 'Mercator Intersnack',
    'kava-caj': 'Mercator Intersnack', brezalk: 'Mercator Intersnack', alkohol: 'Vinarska Lipa',
    pekovsko: 'Pekarna Kruhek', embalaza: 'Mercator Intersnack',
  }

  /* ─────────── ZALOGA (InventoryItem) ───────────
     category → skupina; location → prostor (skladišče/hladilnica/bar/kuhinja).
     Količine/min/cene realistične (gros cene dobaviteljev). */
  type Inv = { n: string; u: string; qty: number; min: number; cost: number; cat: string; loc?: string; exp?: number; serv?: number; ss?: string; alg?: string[]; lead?: number; rop?: number; saf?: number }
  const inv: Inv[] = [
    // ── Meso in mesni izdelki (hladilnica) ──
    { n: 'Govedina (pleče)', u: 'kg', qty: 18, min: 5, cost: 11.5, cat: 'meso', loc: 'hladilnica', exp: 5, serv: 4, ss: '250 g', alg: [], lead: 2, rop: 6, saf: 2 },
    { n: 'Govedina (mleta)', u: 'kg', qty: 12, min: 4, cost: 9.8, cat: 'meso', loc: 'hladilnica', exp: 3, serv: 4 },
    { n: 'Teletina (file)', u: 'kg', qty: 6, min: 2, cost: 24.9, cat: 'meso', loc: 'hladilnica', exp: 4, serv: 4 },
    { n: 'Svinjina (zrezki)', u: 'kg', qty: 22, min: 8, cost: 6.9, cat: 'meso', loc: 'hladilnica', exp: 5, serv: 4 },
    { n: 'Piščančji file', u: 'kg', qty: 25, min: 10, cost: 7.5, cat: 'meso', loc: 'hladilnica', exp: 4, serv: 4 },
    { n: 'Piščanec (cel, 1,2 kg)', u: 'pcs', qty: 15, min: 6, cost: 5.5, cat: 'meso', loc: 'hladilnica', exp: 5 },
    { n: 'Kranjska klobasa', u: 'kg', qty: 14, min: 5, cost: 8.9, cat: 'meso', loc: 'hladilnica', exp: 14, alg: [] },
    { n: 'Slanina', u: 'kg', qty: 8, min: 3, cost: 5.5, cat: 'meso', loc: 'hladilnica', exp: 21 },
    { n: 'Telečja jetrca', u: 'kg', qty: 4, min: 2, cost: 9.2, cat: 'meso', loc: 'hladilnica', exp: 3 },
    { n: 'Pečenka (zebra)', u: 'kg', qty: 9, min: 3, cost: 12.5, cat: 'meso', loc: 'hladilnica', exp: 6 },
    { n: 'Goveji fond (juha meso)', u: 'kg', qty: 12, min: 4, cost: 7.8, cat: 'meso', loc: 'hladilnica', exp: 5 },
    // ── Ribe in morski sadeži (hladilnica) ──
    { n: 'Losos (file)', u: 'kg', qty: 7, min: 3, cost: 22.5, cat: 'ribe', loc: 'hladilnica', exp: 3, alg: ['FISH'] },
    { n: 'Brancin (cel)', u: 'kg', qty: 8, min: 2, cost: 18.0, cat: 'ribe', loc: 'hladilnica', exp: 3, alg: ['FISH'] },
    { n: 'Morski list', u: 'kg', qty: 5, min: 2, cost: 21.0, cat: 'ribe', loc: 'hladilnica', exp: 3, alg: ['FISH'] },
    { n: 'Postrv (gojena)', u: 'kg', qty: 10, min: 4, cost: 11.0, cat: 'ribe', loc: 'hladilnica', exp: 4, alg: ['FISH'] },
    { n: 'Kozice (lupljene, globoke)', u: 'kg', qty: 6, min: 3, cost: 13.5, cat: 'ribe', loc: 'hladilnica', exp: 180, alg: ['CRUSTACEANS'] },
    { n: 'Kalamari (olupljeni)', u: 'kg', qty: 5, min: 2, cost: 12.8, cat: 'ribe', loc: 'hladilnica', exp: 90, alg: ['MOLLUSCS'] },
    { n: 'Mušle (žive)', u: 'kg', qty: 4, min: 2, cost: 7.5, cat: 'ribe', loc: 'hladilnica', exp: 2, alg: ['MOLLUSCS'] },
    { n: 'Tunina (v pločevinki)', u: 'kg', qty: 12, min: 4, cost: 9.5, cat: 'ribe', loc: 'skladišče', exp: 720, alg: ['FISH'] },
    { n: 'Dimljen losos (paket 200 g)', u: 'pcs', qty: 10, min: 4, cost: 6.5, cat: 'ribe', loc: 'hladilnica', exp: 30, alg: ['FISH'] },
    // ── Mlečni izdelki in jajca (hladilnica) ──
    { n: 'Mleko 3,5 % (1 l)', u: 'l', qty: 60, min: 20, cost: 1.05, cat: 'mlecni', loc: 'hladilnica', exp: 7, alg: ['MILK'] },
    { n: 'Smetana 33 % (1 l)', u: 'l', qty: 15, min: 5, cost: 2.9, cat: 'mlecni', loc: 'hladilnica', exp: 12, alg: ['MILK'] },
    { n: 'Maslo (250 g)', u: 'pcs', qty: 24, min: 8, cost: 2.4, cat: 'mlecni', loc: 'hladilnica', exp: 60, alg: ['MILK'] },
    { n: 'Maslo (bulk, kg)', u: 'kg', qty: 6, min: 2, cost: 8.9, cat: 'mlecni', loc: 'hladilnica', exp: 60, alg: ['MILK'] },
    { n: 'Sir gauda (kg)', u: 'kg', qty: 12, min: 4, cost: 9.5, cat: 'mlecni', loc: 'hladilnica', exp: 45, alg: ['MILK'] },
    { n: 'Mocarela (kg)', u: 'kg', qty: 15, min: 6, cost: 8.5, cat: 'mlecni', loc: 'hladilnica', exp: 30, alg: ['MILK'] },
    { n: 'Parmezan (kg)', u: 'kg', qty: 3, min: 1, cost: 18.0, cat: 'mlecni', loc: 'hladilnica', exp: 90, alg: ['MILK'] },
    { n: 'Feta (kg)', u: 'kg', qty: 4, min: 2, cost: 9.0, cat: 'mlecni', loc: 'hladilnica', exp: 45, alg: ['MILK'] },
    { n: 'Burrata (kos, 125 g)', u: 'pcs', qty: 16, min: 6, cost: 2.2, cat: 'mlecni', loc: 'hladilnica', exp: 14, alg: ['MILK'] },
    { n: 'Skuta (kg)', u: 'kg', qty: 8, min: 3, cost: 3.5, cat: 'mlecni', loc: 'hladilnica', exp: 10, alg: ['MILK'] },
    { n: 'Jogurt (500 g)', u: 'pcs', qty: 20, min: 6, cost: 1.2, cat: 'mlecni', loc: 'hladilnica', exp: 14, alg: ['MILK'] },
    { n: 'Jajca (škatla 30)', u: 'box', qty: 6, min: 2, cost: 9.6, cat: 'mlecni', loc: 'hladilnica', exp: 21, alg: ['EGGS'] },
    { n: 'Vaniljev sladoled (5 l)', u: 'pcs', qty: 4, min: 1, cost: 18.0, cat: 'mlecni', loc: 'zamrzovalnik', exp: 180, alg: ['MILK'] },
    { n: 'Sladoled jagoda (5 l)', u: 'pcs', qty: 2, min: 1, cost: 18.0, cat: 'mlecni', loc: 'zamrzovalnik', exp: 180, alg: ['MILK'] },
    // ── Zelenjava (hladilnica/skladišče) ──
    { n: 'Krompir', u: 'kg', qty: 80, min: 25, cost: 0.9, cat: 'zelenjava', loc: 'skladišče', exp: 30 },
    { n: 'Paradižnik', u: 'kg', qty: 30, min: 10, cost: 2.5, cat: 'zelenjava', loc: 'hladilnica', exp: 8 },
    { n: 'Solata kristalka (kos)', u: 'pcs', qty: 30, min: 12, cost: 1.1, cat: 'zelenjava', loc: 'hladilnica', exp: 6 },
    { n: 'Rukola (vrečka 100 g)', u: 'pcs', qty: 12, min: 4, cost: 1.4, cat: 'zelenjava', loc: 'hladilnica', exp: 5 },
    { n: 'Kumare', u: 'kg', qty: 12, min: 5, cost: 1.5, cat: 'zelenjava', loc: 'hladilnica', exp: 10 },
    { n: 'Paprika', u: 'kg', qty: 14, min: 5, cost: 3.0, cat: 'zelenjava', loc: 'hladilnica', exp: 10 },
    { n: 'Čebula', u: 'kg', qty: 40, min: 15, cost: 1.2, cat: 'zelenjava', loc: 'skladišče', exp: 40 },
    { n: 'Česen', u: 'kg', qty: 5, min: 2, cost: 6.0, cat: 'zelenjava', loc: 'skladišče', exp: 60 },
    { n: 'Bučke', u: 'kg', qty: 10, min: 4, cost: 2.2, cat: 'zelenjava', loc: 'hladilnica', exp: 8 },
    { n: 'Buča ( za juho)', u: 'kg', qty: 15, min: 5, cost: 1.5, cat: 'zelenjava', loc: 'skladišče', exp: 45 },
    { n: 'Blitva', u: 'kg', qty: 8, min: 3, cost: 2.0, cat: 'zelenjava', loc: 'hladilnica', exp: 5 },
    { n: 'Špinaka', u: 'kg', qty: 6, min: 2, cost: 3.0, cat: 'zelenjava', loc: 'hladilnica', exp: 5 },
    { n: 'Gobe šampinjoni', u: 'kg', qty: 10, min: 4, cost: 5.5, cat: 'zelenjava', loc: 'hladilnica', exp: 5 },
    { n: 'Jurčki (zamrznjeni)', u: 'kg', qty: 3, min: 1, cost: 14.0, cat: 'zelenjava', loc: 'zamrzovalnik', exp: 180 },
    { n: 'Korenje', u: 'kg', qty: 18, min: 6, cost: 1.0, cat: 'zelenjava', loc: 'skladišče', exp: 25 },
    { n: 'Peteršilj (šop)', u: 'pcs', qty: 15, min: 5, cost: 0.8, cat: 'zelenjava', loc: 'hladilnica', exp: 5 },
    { n: 'Bazilika (šop)', u: 'pcs', qty: 12, min: 4, cost: 1.2, cat: 'zelenjava', loc: 'hladilnica', exp: 4 },
    { n: 'Kislo zelje', u: 'kg', qty: 20, min: 6, cost: 1.8, cat: 'zelenjava', loc: 'hladilnica', exp: 30 },
    { n: 'Kisla repa', u: 'kg', qty: 15, min: 5, cost: 1.8, cat: 'zelenjava', loc: 'hladilnica', exp: 30 },
    { n: 'Sveže zelje', u: 'kg', qty: 10, min: 4, cost: 1.2, cat: 'zelenjava', loc: 'skladišče', exp: 20 },
    { n: 'Koromač', u: 'kg', qty: 4, min: 1, cost: 2.8, cat: 'zelenjava', loc: 'hladilnica', exp: 10 },
    { n: 'Artičoke (kozervirane)', u: 'kg', qty: 4, min: 1, cost: 8.5, cat: 'zelenjava', loc: 'skladišče', exp: 365 },
    // ── Sadje ──
    { n: 'Jabolka', u: 'kg', qty: 25, min: 8, cost: 1.4, cat: 'sadje', loc: 'skladišče', exp: 25 },
    { n: 'Banane', u: 'kg', qty: 15, min: 5, cost: 1.3, cat: 'sadje', loc: 'hladilnica', exp: 7 },
    { n: 'Jagode', u: 'kg', qty: 4, min: 1, cost: 6.5, cat: 'sadje', loc: 'hladilnica', exp: 3 },
    { n: 'Borovnice', u: 'kg', qty: 3, min: 1, cost: 7.0, cat: 'sadje', loc: 'hladilnica', exp: 5 },
    { n: 'Maline', u: 'kg', qty: 2, min: 1, cost: 8.0, cat: 'sadje', loc: 'hladilnica', exp: 3 },
    { n: 'Breskve', u: 'kg', qty: 8, min: 3, cost: 2.8, cat: 'sadje', loc: 'hladilnica', exp: 7 },
    { n: 'Limon (kg)', u: 'kg', qty: 8, min: 3, cost: 2.5, cat: 'sadje', loc: 'hladilnica', exp: 20 },
    { n: 'Lajm', u: 'kg', qty: 4, min: 1, cost: 4.0, cat: 'sadje', loc: 'hladilnica', exp: 20 },
    { n: 'Pomaranče', u: 'kg', qty: 20, min: 6, cost: 2.0, cat: 'sadje', loc: 'hladilnica', exp: 20 },
    // ── Suho blago (skladišče) ──
    { n: 'Moka tip 500', u: 'kg', qty: 50, min: 15, cost: 1.2, cat: 'suho', loc: 'skladišče', exp: 180, alg: ['GLUTEN'] },
    { n: 'Moka tip 850', u: 'kg', qty: 20, min: 8, cost: 1.1, cat: 'suho', loc: 'skladišče', exp: 180, alg: ['GLUTEN'] },
    { n: 'Ajdova moka', u: 'kg', qty: 8, min: 3, cost: 3.2, cat: 'suho', loc: 'skladišče', exp: 180 },
    { n: 'Riž (zrnat)', u: 'kg', qty: 25, min: 8, cost: 2.0, cat: 'suho', loc: 'skladišče', exp: 365 },
    { n: 'Riž za rižoto (arborio)', u: 'kg', qty: 10, min: 3, cost: 3.8, cat: 'suho', loc: 'skladišče', exp: 365 },
    { n: 'Testenine špageti', u: 'kg', qty: 15, min: 5, cost: 2.2, cat: 'suho', loc: 'skladišče', exp: 365, alg: ['GLUTEN', 'EGGS'] },
    { n: 'Testenine penne', u: 'kg', qty: 10, min: 4, cost: 2.2, cat: 'suho', loc: 'skladišče', exp: 365, alg: ['GLUTEN'] },
    { n: 'Njoki (suhi)', u: 'kg', qty: 8, min: 3, cost: 2.8, cat: 'suho', loc: 'skladišče', exp: 365, alg: ['GLUTEN'] },
    { n: 'Sladkor', u: 'kg', qty: 20, min: 6, cost: 1.1, cat: 'suho', loc: 'skladišče', exp: 730 },
    { n: 'Sol', u: 'kg', qty: 12, min: 4, cost: 0.5, cat: 'suho', loc: 'skladišče', exp: 9999 },
    { n: 'Drobtine', u: 'kg', qty: 6, min: 2, cost: 1.8, cat: 'suho', loc: 'skladišče', exp: 180, alg: ['GLUTEN'] },
    { n: 'Polenta', u: 'kg', qty: 10, min: 3, cost: 1.6, cat: 'suho', loc: 'skladišče', exp: 365 },
    { n: 'Oves (kosmiči)', u: 'kg', qty: 5, min: 2, cost: 2.0, cat: 'suho', loc: 'skladišče', exp: 365, alg: ['GLUTEN'] },
    { n: 'Leča', u: 'kg', qty: 8, min: 3, cost: 2.5, cat: 'suho', loc: 'skladišče', exp: 365 },
    { n: 'Fižol (beli)', u: 'kg', qty: 10, min: 4, cost: 2.8, cat: 'suho', loc: 'skladišče', exp: 365 },
    { n: 'Žlikrofi (zamrznjeni)', u: 'kg', qty: 5, min: 2, cost: 4.5, cat: 'suho', loc: 'zamrzovalnik', exp: 180 },
    { n: 'Listnato testo', u: 'kg', qty: 6, min: 2, cost: 4.0, cat: 'suho', loc: 'zamrzovalnik', exp: 180, alg: ['GLUTEN', 'MILK'] },
    { n: 'Burek testo', u: 'kg', qty: 8, min: 3, cost: 3.0, cat: 'suho', loc: 'zamrzovalnik', exp: 90, alg: ['GLUTEN'] },
    // ── Konzerve ──
    { n: 'Paradižnik pelati (pelati 2,5 kg)', u: 'pcs', qty: 12, min: 4, cost: 3.2, cat: 'konzerve', loc: 'skladišče', exp: 730 },
    { n: 'Passata (1 kg)', u: 'pcs', qty: 10, min: 4, cost: 1.6, cat: 'konzerve', loc: 'skladišče', exp: 730 },
    { n: 'Paradižnikova bazza za pico', u: 'kg', qty: 15, min: 5, cost: 1.9, cat: 'konzerve', loc: 'skladišče', exp: 30 },
    { n: 'Koruza (konzerva)', u: 'pcs', qty: 12, min: 4, cost: 1.2, cat: 'konzerve', loc: 'skladišče', exp: 730 },
    { n: 'Grah (konzerva)', u: 'pcs', qty: 8, min: 3, cost: 1.3, cat: 'konzerve', loc: 'skladišče', exp: 730 },
    { n: 'Olive (črne, kg)', u: 'kg', qty: 4, min: 1, cost: 5.5, cat: 'konzerve', loc: 'skladišče', exp: 365 },
    { n: 'Kapre', u: 'kg', qty: 1, min: 0.5, cost: 9.0, cat: 'konzerve', loc: 'skladišče', exp: 365 },
    { n: 'Kokosovo mleko (1 l)', u: 'pcs', qty: 6, min: 2, cost: 2.1, cat: 'konzerve', loc: 'skladišče', exp: 540 },
    { n: 'Ananas (rezine, konzerva)', u: 'pcs', qty: 6, min: 2, cost: 1.4, cat: 'konzerve', loc: 'skladišče', exp: 730 },
    // ── Olja in maščobe ──
    { n: 'Sončnično olje (5 l)', u: 'l', qty: 20, min: 5, cost: 2.2, cat: 'olja', loc: 'skladišče', exp: 365 },
    { n: 'Oljčno olje (1 l)', u: 'l', qty: 12, min: 4, cost: 8.5, cat: 'olja', loc: 'skladišče', exp: 540 },
    { n: 'Ekstra deviško oljčno olje (1 l)', u: 'l', qty: 6, min: 2, cost: 12.0, cat: 'olja', loc: 'skladišče', exp: 540 },
    { n: 'Bučno olje (250 ml)', u: 'pcs', qty: 8, min: 3, cost: 4.5, cat: 'olja', loc: 'skladišče', exp: 365 },
    { n: 'Mast (kg)', u: 'kg', qty: 10, min: 3, cost: 5.5, cat: 'olja', loc: 'hladilnica', exp: 180 },
    // ── Začimbe in dišave ──
    { n: 'Črni poper (mlet)', u: 'kg', qty: 1, min: 0.3, cost: 14.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Morska sol groba', u: 'kg', qty: 3, min: 1, cost: 2.0, cat: 'zacimbe', loc: 'skladišče', exp: 9999 },
    { n: 'Origano', u: 'kg', qty: 0.5, min: 0.2, cost: 16.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Bazilika (suha)', u: 'kg', qty: 0.3, min: 0.1, cost: 18.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Rožmarin', u: 'kg', qty: 0.4, min: 0.1, cost: 17.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Timijan', u: 'kg', qty: 0.3, min: 0.1, cost: 15.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Lovorjev list', u: 'kg', qty: 0.2, min: 0.05, cost: 11.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Cimet', u: 'kg', qty: 0.2, min: 0.05, cost: 18.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Vanilja (stroki)', u: 'pcs', qty: 10, min: 4, cost: 3.5, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Čili (mlet)', u: 'kg', qty: 0.3, min: 0.1, cost: 16.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Curry pasta', u: 'kg', qty: 1, min: 0.3, cost: 12.0, cat: 'zacimbe', loc: 'skladišče', exp: 180 },
    { n: 'Gorčica (kg)', u: 'kg', qty: 2, min: 0.5, cost: 3.5, cat: 'zacimbe', loc: 'hladilnica', exp: 180, alg: ['MUSTARD', 'SULPHITES'] },
    { n: 'Majoneza (kg)', u: 'kg', qty: 3, min: 1, cost: 3.2, cat: 'zacimbe', loc: 'hladilnica', exp: 120, alg: ['EGGS', 'MUSTARD'] },
    { n: 'Ketchup (kg)', u: 'kg', qty: 4, min: 1, cost: 2.2, cat: 'zacimbe', loc: 'hladilnica', exp: 180 },
    { n: 'Sojina omaka (1 l)', u: 'pcs', qty: 3, min: 1, cost: 3.8, cat: 'zacimbe', loc: 'skladišče', exp: 540, alg: ['SOYBEANS', 'GLUTEN'] },
    { n: 'Balzamični kis (1 l)', u: 'pcs', qty: 3, min: 1, cost: 6.0, cat: 'zacimbe', loc: 'skladišče', exp: 730 },
    { n: 'Med (kg)', u: 'kg', qty: 5, min: 2, cost: 8.0, cat: 'zacimbe', loc: 'skladišče', exp: 9999 },
    { n: 'Kakav prah (kg)', u: 'kg', qty: 2, min: 0.5, cost: 7.0, cat: 'zacimbe', loc: 'skladišče', exp: 540 },
    // ── Kava in čaj (bar) ──
    { n: 'Kava zrna 100 % arabica (kg)', u: 'kg', qty: 6, min: 2, cost: 14.0, cat: 'kava-caj', loc: 'bar', exp: 180 },
    { n: 'Kava brez kofeina (kg)', u: 'kg', qty: 1, min: 0.5, cost: 16.0, cat: 'kava-caj', loc: 'bar', exp: 180 },
    { n: 'Črni čaj (filter vrečke, 100 kos)', u: 'pcs', qty: 4, min: 1, cost: 4.5, cat: 'kava-caj', loc: 'bar', exp: 730 },
    { n: 'Zeleni čaj (filter vrečke, 100 kos)', u: 'pcs', qty: 2, min: 1, cost: 5.5, cat: 'kava-caj', loc: 'bar', exp: 730 },
    { n: 'Sadni čaj (filter vrečke, 100 kos)', u: 'pcs', qty: 2, min: 1, cost: 4.8, cat: 'kava-caj', loc: 'bar', exp: 730 },
    { n: 'Vroča čokolada (prah, kg)', u: 'kg', qty: 2, min: 0.5, cost: 6.5, cat: 'kava-caj', loc: 'bar', exp: 540 },
    { n: 'Beljakovinski sirup (kg)', u: 'kg', qty: 1, min: 0.3, cost: 5.5, cat: 'kava-caj', loc: 'bar', exp: 180 },
    // ── Brezalkoholne pijače (bar) ──
    { n: 'Radenska 0,5 (gazirana)', u: 'pcs', qty: 120, min: 40, cost: 0.85, cat: 'brezalk', loc: 'bar' },
    { n: 'Radenska 0,75 (gazirana)', u: 'pcs', qty: 60, min: 24, cost: 1.1, cat: 'brezalk', loc: 'bar' },
    { n: 'Stilla 0,33 (negazirana)', u: 'pcs', qty: 96, min: 30, cost: 0.55, cat: 'brezalk', loc: 'bar' },
    { n: 'Stilla 0,75 (negazirana)', u: 'pcs', qty: 30, min: 12, cost: 0.95, cat: 'brezalk', loc: 'bar' },
    { n: 'Coca-Cola 0,25', u: 'pcs', qty: 144, min: 48, cost: 0.75, cat: 'brezalk', loc: 'bar' },
    { n: 'Coca-Cola 0,33', u: 'pcs', qty: 72, min: 24, cost: 0.9, cat: 'brezalk', loc: 'bar' },
    { n: 'Coca-Cola Zero 0,33', u: 'pcs', qty: 48, min: 12, cost: 0.9, cat: 'brezalk', loc: 'bar' },
    { n: 'Fanta 0,25', u: 'pcs', qty: 96, min: 24, cost: 0.75, cat: 'brezalk', loc: 'bar' },
    { n: 'Sprite 0,25', u: 'pcs', qty: 72, min: 18, cost: 0.75, cat: 'brezalk', loc: 'bar' },
    { n: 'Schweppes tonik 0,25', u: 'pcs', qty: 48, min: 12, cost: 0.8, cat: 'brezalk', loc: 'bar' },
    { n: 'Ginger ale 0,25', u: 'pcs', qty: 24, min: 6, cost: 0.8, cat: 'brezalk', loc: 'bar' },
    { n: 'Sok pomaranča 1 l', u: 'pcs', qty: 24, min: 8, cost: 1.4, cat: 'brezalk', loc: 'bar' },
    { n: 'Sok jabolko 1 l', u: 'pcs', qty: 24, min: 8, cost: 1.2, cat: 'brezalk', loc: 'bar' },
    { n: 'Multivitamin 1 l', u: 'pcs', qty: 12, min: 4, cost: 1.5, cat: 'brezalk', loc: 'bar' },
    { n: 'Ledni čaj 1,5 l', u: 'pcs', qty: 12, min: 4, cost: 1.6, cat: 'brezalk', loc: 'bar' },
    { n: 'Red Bull 0,25', u: 'pcs', qty: 48, min: 12, cost: 1.4, cat: 'brezalk', loc: 'bar' },
    { n: 'Sirup bazilika-limona (1 l)', u: 'pcs', qty: 8, min: 2, cost: 3.5, cat: 'brezalk', loc: 'bar' },
    { n: 'Mleko za kavo 1 l', u: 'pcs', qty: 40, min: 15, cost: 1.1, cat: 'brezalk', loc: 'bar', alg: ['MILK'] },
    // ── Alkoholne pijače (bar) ──
    { n: 'Union svetlo (sod 20 l)', u: 'pcs', qty: 2, min: 1, cost: 28.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Laško svetlo (sod 20 l)', u: 'pcs', qty: 2, min: 1, cost: 28.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Union temni (sod 20 l)', u: 'pcs', qty: 1, min: 0, cost: 30.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Heineken 0,5 (flaša)', u: 'pcs', qty: 72, min: 24, cost: 1.1, cat: 'alkohol', loc: 'bar' },
    { n: 'Kozel svetli 0,5 (flaša)', u: 'pcs', qty: 48, min: 12, cost: 1.2, cat: 'alkohol', loc: 'bar' },
    { n: 'Stella Artois 0,4 (flaša)', u: 'pcs', qty: 36, min: 12, cost: 1.3, cat: 'alkohol', loc: 'bar' },
    { n: 'Craft IPA 0,3 (flaša)', u: 'pcs', qty: 24, min: 6, cost: 1.9, cat: 'alkohol', loc: 'bar' },
    { n: 'Radler 0,5 (pločevinka)', u: 'pcs', qty: 48, min: 12, cost: 0.9, cat: 'alkohol', loc: 'bar' },
    { n: 'Pivo brez alkohola 0,5', u: 'pcs', qty: 36, min: 12, cost: 0.8, cat: 'alkohol', loc: 'bar' },
    { n: 'Cviček 0,75 (flaša)', u: 'pcs', qty: 24, min: 8, cost: 6.5, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Laški rizling 0,75', u: 'pcs', qty: 18, min: 6, cost: 7.2, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Rebula 0,75', u: 'pcs', qty: 18, min: 6, cost: 8.4, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Chardonnay 0,75', u: 'pcs', qty: 18, min: 6, cost: 7.8, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Sauvignon blanc 0,75', u: 'pcs', qty: 12, min: 4, cost: 8.2, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Merlot 0,75', u: 'pcs', qty: 12, min: 4, cost: 8.5, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Cabernet sauvignon 0,75', u: 'pcs', qty: 12, min: 4, cost: 9.2, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Refošk 0,75', u: 'pcs', qty: 12, min: 4, cost: 9.6, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Modri pinot 0,75', u: 'pcs', qty: 8, min: 2, cost: 8.9, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Penina 0,75', u: 'pcs', qty: 12, min: 4, cost: 14.0, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Sladka penina 0,75', u: 'pcs', qty: 6, min: 2, cost: 16.5, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    { n: 'Jenever 0,7', u: 'pcs', qty: 6, min: 2, cost: 9.5, cat: 'alkohol', loc: 'bar' },
    { n: 'Vodka 0,7', u: 'pcs', qty: 6, min: 2, cost: 11.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Gin 0,7', u: 'pcs', qty: 6, min: 2, cost: 15.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Rum 0,7', u: 'pcs', qty: 4, min: 1, cost: 12.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Whisky 0,7', u: 'pcs', qty: 4, min: 1, cost: 18.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Bourbon 0,7', u: 'pcs', qty: 3, min: 1, cost: 21.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Tequila 0,7', u: 'pcs', qty: 3, min: 1, cost: 16.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Sadjevec 1 l', u: 'pcs', qty: 4, min: 1, cost: 10.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Borovničevec 1 l', u: 'pcs', qty: 3, min: 1, cost: 12.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Pelinkovac 1 l', u: 'pcs', qty: 3, min: 1, cost: 10.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Teranov liker 0,7', u: 'pcs', qty: 2, min: 1, cost: 11.5, cat: 'alkohol', loc: 'bar' },
    { n: 'Aperol 0,7', u: 'pcs', qty: 4, min: 1, cost: 13.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Baileys 0,7', u: 'pcs', qty: 2, min: 1, cost: 15.0, cat: 'alkohol', loc: 'bar', alg: ['MILK'] },
    { n: 'Cognac 0,7', u: 'pcs', qty: 2, min: 0, cost: 24.0, cat: 'alkohol', loc: 'bar' },
    { n: 'Prosecco 0,2', u: 'pcs', qty: 24, min: 6, cost: 2.2, cat: 'alkohol', loc: 'bar', alg: ['SULPHITES'] },
    // ── Pekovski izdelki ──
    { n: 'Beli kruh (500 g)', u: 'pcs', qty: 20, min: 6, cost: 1.9, cat: 'pekovsko', loc: 'skladišče', exp: 2, alg: ['GLUTEN'] },
    { n: 'Polnozrnati kruh (500 g)', u: 'pcs', qty: 12, min: 4, cost: 2.3, cat: 'pekovsko', loc: 'skladišče', exp: 2, alg: ['GLUTEN'] },
    { n: 'Črni kruh (500 g)', u: 'pcs', qty: 10, min: 3, cost: 2.1, cat: 'pekovsko', loc: 'skladišče', exp: 2, alg: ['GLUTEN'] },
    { n: 'Hamburger bun (kos)', u: 'pcs', qty: 100, min: 30, cost: 0.4, cat: 'pekovsko', loc: 'zamrzovalnik', exp: 60, alg: ['GLUTEN'] },
    { n: 'Bruskete kruh (kos)', u: 'pcs', qty: 60, min: 20, cost: 0.3, cat: 'pekovsko', loc: 'skladišče', exp: 14, alg: ['GLUTEN'] },
    { n: 'Grisini (kos)', u: 'pcs', qty: 80, min: 20, cost: 0.25, cat: 'pekovsko', loc: 'skladišče', exp: 90, alg: ['GLUTEN'] },
    // ── Embalaža in potrošni material ──
    { n: 'Kozarec 0,3 (plastika)', u: 'pcs', qty: 500, min: 100, cost: 0.06, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Kozarec 0,5 (plastika)', u: 'pcs', qty: 300, min: 60, cost: 0.08, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Pokrov za kozarec', u: 'pcs', qty: 500, min: 100, cost: 0.03, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Vrečka za živila', u: 'pcs', qty: 1000, min: 200, cost: 0.02, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Kartonska posoda za hrano', u: 'pcs', qty: 200, min: 50, cost: 0.15, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Karton za pico', u: 'pcs', qty: 150, min: 40, cost: 0.25, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Papirnati prti (100)', u: 'pcs', qty: 20, min: 5, cost: 1.2, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Slamice (500)', u: 'pcs', qty: 4, min: 1, cost: 2.5, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Alu folija (45 m)', u: 'pcs', qty: 6, min: 2, cost: 3.0, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Vrečke za smeti 60 l', u: 'pcs', qty: 10, min: 4, cost: 0.9, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Rokavice nitril (100)', u: 'pcs', qty: 10, min: 3, cost: 4.5, cat: 'embalaza', loc: 'skladišče' },
    { n: 'Toaletni papir (8 kos)', u: 'pcs', qty: 6, min: 2, cost: 5.5, cat: 'embalaza', loc: 'skladišče' },
  ]

  const invId: Record<string, string> = {}
  let ic = 0
  for (const i of inv) {
    const id = nid(`inv-${i.n}`)
    invId[i.n] = id
    const servings = i.serv ?? 1
    const costPerServing = i.u === 'kg' || i.u === 'l' ? +(i.cost / Math.max(1, servings)).toFixed(4) : i.cost
    await db.inventoryItem.create({
      data: {
        id,
        name: i.n,
        unit: i.u,
        quantity: i.qty,
        minQuantity: i.min,
        costPerUnit: i.cost,
        supplier: supName[i.cat] ?? 'Mercator Intersnack',
        category: i.cat,
        location: i.loc ?? 'skladišče',
        locationId,
        expiryDate: i.exp && i.exp < 9999 ? new Date(now + i.exp * day) : null,
        servingsPerUnit: servings,
        servingSize: i.ss ?? '',
        costPerServing: costPerServing,
        allergens: JSON.stringify(i.alg ?? []),
        lastRestocked: new Date(now - Math.floor(Math.random() * 10) * day),
        leadTimeDays: i.lead ?? 1,
        reorderPoint: i.rop ?? null,
        safetyStock: i.saf ?? null,
      },
    })
    ic++
  }
  console.log(`📦 Zaloga (artikli): ${ic}`)

  /* ─────────── SERIJE (InventoryBatch) z roki uporabe — za FEFO ─────────── */
  const batches: { inv: string; lot: string; qty: number; exp: number; received: number; supplier: string }[] = [
    { inv: 'Mleko 3,5 % (1 l)', lot: 'LOT-MLK-241018-A', qty: 30, exp: 5, received: 1, supplier: 'Mercator Intersnack' },
    { inv: 'Mleko 3,5 % (1 l)', lot: 'LOT-MLK-241018-B', qty: 30, exp: 8, received: 0, supplier: 'Mercator Intersnack' },
    { inv: 'Jajca (škatla 30)', lot: 'LOT-JAJ-241017', qty: 4, exp: 16, received: 1, supplier: 'Kmetija Sonce' },
    { inv: 'Govedina (pleče)', lot: 'LOT-GOV-241016', qty: 10, exp: 2, received: 2, supplier: 'Petek Meso d.o.o.' },
    { inv: 'Govedina (pleče)', lot: 'LOT-GOV-241018', qty: 8, exp: 6, received: 0, supplier: 'Petek Meso d.o.o.' },
    { inv: 'Losos (file)', lot: 'LOT-LOS-241018', qty: 7, exp: 3, received: 0, supplier: 'Jadranski ulov' },
    { inv: 'Piščančji file', lot: 'LOT-PIS-241017', qty: 25, exp: 3, received: 1, supplier: 'Petek Meso d.o.o.' },
    { inv: 'Smetana 33 % (1 l)', lot: 'LOT-SMT-241018', qty: 15, exp: 11, received: 0, supplier: 'Mercator Intersnack' },
    { inv: 'Maslo (250 g)', lot: 'LOT-MAS-241015', qty: 12, exp: 40, received: 3, supplier: 'Mercator Intersnack' },
    { inv: 'Mušle (žive)', lot: 'LOT-MUS-241018', qty: 4, exp: 2, received: 0, supplier: 'Jadranski ulov' },
  ]
  for (const b of batches) {
    await db.inventoryBatch.create({
      data: {
        id: nid(`batch-${b.inv}-${b.lot}`),
        inventoryItemId: invId[b.inv],
        lotNumber: b.lot,
        supplierName: b.supplier,
        receivedAt: new Date(now - b.received * day),
        expiryDate: new Date(now + b.exp * day),
        quantityInitial: b.qty,
        quantityRemaining: b.qty,
        unit: inv.find((x) => x.n === b.inv)?.u ?? 'pcs',
        unitCost: inv.find((x) => x.n === b.inv)?.cost ?? 0,
        status: 'ACTIVE',
        note: 'Demo serija (seed)',
        locationId,
      },
    })
  }
  console.log(`🏷️ Serije z roki uporabe (FEFO): ${batches.length}`)

  /* ─────────── RECEPTE (RecipeItem) za izbrane artikle ─────────── */
  const recipes: { m: string; lines: { i: string; q: number; u: string }[] }[] = [
    {
      m: 'Espresso', lines: [
        { i: 'Kava zrna 100 % arabica (kg)', q: 0.008, u: 'kg' },
      ],
    },
    {
      m: 'Cappuccino', lines: [
        { i: 'Kava zrna 100 % arabica (kg)', q: 0.008, u: 'kg' },
        { i: 'Mleko za kavo 1 l', q: 0.15, u: 'l' },
      ],
    },
    {
      m: 'Bela kava / Caffe latte', lines: [
        { i: 'Kava zrna 100 % arabica (kg)', q: 0.008, u: 'kg' },
        { i: 'Mleko za kavo 1 l', q: 0.25, u: 'l' },
      ],
    },
    {
      m: 'Pizza Margherita', lines: [
        { i: 'Moka tip 500', q: 0.28, u: 'kg' },
        { i: 'Paradižnikova bazza za pico', q: 0.12, u: 'kg' },
        { i: 'Mocarela (kg)', q: 0.12, u: 'kg' },
        { i: 'Origano', q: 0.002, u: 'kg' },
        { i: 'Oljčno olje (1 l)', q: 0.01, u: 'l' },
      ],
    },
    {
      m: 'Pizza Capricciosa', lines: [
        { i: 'Moka tip 500', q: 0.28, u: 'kg' },
        { i: 'Paradižnikova bazza za pico', q: 0.12, u: 'kg' },
        { i: 'Mocarela (kg)', q: 0.12, u: 'kg' },
        { i: 'Šunka (kg)', q: 0.08, u: 'kg' },
        { i: 'Gobe šampinjoni', q: 0.05, u: 'kg' },
        { i: 'Olive (črne, kg)', q: 0.02, u: 'kg' },
      ],
    },
    {
      m: 'Testenine Bolognese', lines: [
        { i: 'Testenine špageti', q: 0.12, u: 'kg' },
        { i: 'Govedina (mleta)', q: 0.15, u: 'kg' },
        { i: 'Passata (1 kg)', q: 0.15, u: 'kg' },
        { i: 'Čebula', q: 0.05, u: 'kg' },
        { i: 'Parmezan (kg)', q: 0.02, u: 'kg' },
      ],
    },
    {
      m: 'Goveji golaš', lines: [
        { i: 'Govedina (pleče)', q: 0.25, u: 'kg' },
        { i: 'Čebula', q: 0.12, u: 'kg' },
        { i: 'Mast (kg)', q: 0.03, u: 'kg' },
        { i: 'Paprika', q: 0.05, u: 'kg' },
        { i: 'Krompir', q: 0.2, u: 'kg' },
      ],
    },
    {
      m: 'Klasičen burger', lines: [
        { i: 'Govedina (mleta)', q: 0.18, u: 'kg' },
        { i: 'Hamburger bun (kos)', q: 1, u: 'pcs' },
        { i: 'Cheddar (kg)', q: 0.03, u: 'kg' },
        { i: 'Solata kristalka (kos)', q: 0.15, u: 'pcs' },
        { i: 'Paradižnik', q: 0.05, u: 'kg' },
        { i: 'Kumare', q: 0.03, u: 'kg' },
      ],
    },
    {
      m: 'Telečji dunajski zrezek', lines: [
        { i: 'Teletina (file)', q: 0.2, u: 'kg' },
        { i: 'Jajca (škatla 30)', q: 0.1, u: 'box' },
        { i: 'Moka tip 500', q: 0.08, u: 'kg' },
        { i: 'Drobtine', q: 0.05, u: 'kg' },
        { i: 'Krompir', q: 0.25, u: 'kg' },
      ],
    },
    {
      m: 'Tiramisu', lines: [
        { i: 'Mascarpone (kg)', q: 0.12, u: 'kg' },
        { i: 'Jajca (škatla 30)', q: 0.1, u: 'box' },
        { i: 'Sladkor', q: 0.03, u: 'kg' },
        { i: 'Kava zrna 100 % arabica (kg)', q: 0.005, u: 'kg' },
        { i: 'Piškoti savoiardi (kg)', q: 0.08, u: 'kg' },
      ],
    },
    {
      m: 'Kremna rezina', lines: [
        { i: 'Listnato testo', q: 0.1, u: 'kg' },
        { i: 'Mleko 3,5 % (1 l)', q: 0.25, u: 'l' },
        { i: 'Jajca (škatla 30)', q: 0.1, u: 'box' },
        { i: 'Sladkor', q: 0.05, u: 'kg' },
        { i: 'Maslo (bulk, kg)', q: 0.05, u: 'kg' },
      ],
    },
    {
      m: 'Palačinke z nutello', lines: [
        { i: 'Moka tip 500', q: 0.1, u: 'kg' },
        { i: 'Mleko 3,5 % (1 l)', q: 0.2, u: 'l' },
        { i: 'Jajca (škatla 30)', q: 0.1, u: 'box' },
        { i: 'Nutella (kg)', q: 0.05, u: 'kg' },
      ],
    },
  ]
  // dodaj manjkajoče sestavine, ki jih recepi omenjajo
  const extraInv: Inv[] = [
    { n: 'Šunka (kg)', u: 'kg', qty: 10, min: 3, cost: 6.8, cat: 'meso', loc: 'hladilnica', exp: 14 },
    { n: 'Cheddar (kg)', u: 'kg', qty: 6, min: 2, cost: 10.5, cat: 'mlecni', loc: 'hladilnica', exp: 45, alg: ['MILK'] },
    { n: 'Mascarpone (kg)', u: 'kg', qty: 4, min: 1, cost: 9.5, cat: 'mlecni', loc: 'hladilnica', exp: 21, alg: ['MILK'] },
    { n: 'Nutella (kg)', u: 'kg', qty: 3, min: 1, cost: 9.0, cat: 'suho', loc: 'skladišče', exp: 180, alg: ['MILK', 'HAZELNUTS'] },
    { n: 'Piškoti savoiardi (kg)', u: 'kg', qty: 3, min: 1, cost: 7.5, cat: 'suho', loc: 'skladišče', exp: 120, alg: ['GLUTEN', 'EGGS'] },
  ]
  for (const i of extraInv) {
    const id = nid(`inv-${i.n}`)
    invId[i.n] = id
    await db.inventoryItem.create({
      data: {
        id, name: i.n, unit: i.u, quantity: i.qty, minQuantity: i.min, costPerUnit: i.cost,
        supplier: supName[i.cat] ?? 'Mercator Intersnack', category: i.cat,
        location: i.loc ?? 'skladišče', locationId,
        expiryDate: i.exp ? new Date(now + i.exp * day) : null,
        servingsPerUnit: 1, allergens: JSON.stringify(i.alg ?? []),
        lastRestocked: new Date(now - 3 * day), leadTimeDays: 1,
      },
    })
    ic++
  }
  let rc = 0
  for (const r of recipes) {
    for (const l of r.lines) {
      const invItem = invId[l.i]
      if (!invItem || !menuItemId[r.m]) continue
      await db.recipeItem.create({
        data: {
          id: nid(`rec-${r.m}-${l.i}`),
          menuItemId: menuItemId[r.m],
          inventoryItemId: invItem,
          quantityPerServing: l.q,
          unit: l.u,
          yieldPercent: 100,
        },
      })
      rc++
    }
  }
  console.log(`📋 Recepturne postavke: ${rc} (za ${recipes.length} artiklov)`)

  /* ─────────── MIZE (tloris z oblikami) ─────────── */
  const tableDefs: { n: number; area: string; cap: number; shape: string; x: number; y: number; w: number; h: number }[] = []
  // Glavna dvorana: mize 1-10 (krožne 4-, kvadratne 2-, 6-osebne)
  const hallLayout = [
    { n: 1, cap: 4, shape: 'round', x: 12, y: 10, w: 8, h: 8 },
    { n: 2, cap: 2, shape: 'square', x: 26, y: 10, w: 6, h: 6 },
    { n: 3, cap: 6, shape: 'round', x: 12, y: 26, w: 10, h: 10 },
    { n: 4, cap: 4, shape: 'square', x: 28, y: 26, w: 8, h: 8 },
    { n: 5, cap: 4, shape: 'round', x: 44, y: 10, w: 8, h: 8 },
    { n: 6, cap: 2, shape: 'square', x: 58, y: 10, w: 6, h: 6 },
    { n: 7, cap: 6, shape: 'round', x: 46, y: 26, w: 10, h: 10 },
    { n: 8, cap: 4, shape: 'square', x: 60, y: 26, w: 8, h: 8 },
    { n: 9, cap: 4, shape: 'round', x: 12, y: 44, w: 8, h: 8 },
    { n: 10, cap: 8, shape: 'square', x: 28, y: 44, w: 12, h: 10 },
  ]
  for (const t of hallLayout) tableDefs.push({ ...t, area: 'Glavna dvorana' })
  // Šank: 3 visoke mize (stool)
  for (let i = 0; i < 3; i++) {
    tableDefs.push({ n: 11 + i, area: 'Šank', cap: 2, shape: 'square', x: 76 + i * 8, y: 10, w: 5, h: 5 })
  }
  // Terasa: krožne mize
  const terrace = [
    { n: 14, cap: 4, x: 12, y: 62 },
    { n: 15, cap: 4, x: 28, y: 62 },
    { n: 16, cap: 6, x: 46, y: 62 },
  ]
  for (const t of terrace) tableDefs.push({ ...t, area: 'Terasa', shape: 'round', w: 8, h: 8 })
  // VIP loža
  tableDefs.push({ n: 17, area: 'VIP loža', cap: 8, shape: 'square', x: 64, y: 44, w: 12, h: 10 })
  tableDefs.push({ n: 18, area: 'VIP loža', cap: 4, shape: 'round', x: 84, y: 44, w: 8, h: 8 })

  let tc = 0
  for (const t of tableDefs) {
    await db.table.create({
      data: {
        id: nid(`tbl-${t.n}`),
        number: t.n,
        capacity: t.cap,
        status: t.n === 3 ? 'reserved' : t.n === 5 ? 'occupied' : 'available',
        area: t.area,
        posX: t.x, posY: t.y, width: t.w, height: t.h,
        shape: t.shape,
        rotation: 0,
        locationId,
      },
    })
    tc++
  }
  console.log(`🪑 Mize: ${tc} (dvorana/šank/terasa/VIP, krožne + kvadratne)`)

  /* ─────────── NASTAVITVE, RAZLOGI, ODPIRALNI ČAS, NAPRAVE ─────────── */
  await db.restaurantSettings.create({
    data: {
      id: nid('settings-default'),
      name: 'Gostilna Pri Lipi',
      address: 'Slovenska cesta 12',
      city: 'Ljubljana',
      postCode: '1000',
      phone: '+386 1 234 56 78',
      email: 'info@gostilnaprilipi.si',
      web: 'www.gostilnaprilipi.si',
      businessId: '7654321',
      taxId: 'SI76543212',
      registerNumber: 'BLG-001',
      fursEnvironment: 'test',
      defaultVatRate: 22,
      reducedVatRate: 9.5,
      currency: 'EUR',
      locale: 'sl-SI',
      country: 'SI',
      receiptFooter: 'Hvala za obisk in nasvidenje! 💛 Gostilna Pri Lipi',
    },
  })

  const voidReasons = ['Napačen artikel', 'Gost je zavrnil', 'Zamuda priprave', 'Napaka pri naročanju', 'Povrnjeno v kuhinjo']
  for (let i = 0; i < voidReasons.length; i++) {
    await db.voidReason.create({ data: { id: nid(`vr-${i}`), name: voidReasons[i], sortOrder: i + 1, locationId } })
  }

  // odpiralni čas (pon-ned, 0=nedelja po shemi dayOfWeek)
  const hours = [
    { d: 1, o: '08:00', c: '23:00' }, // ponedeljek
    { d: 2, o: '08:00', c: '23:00' },
    { d: 3, o: '08:00', c: '23:00' },
    { d: 4, o: '08:00', c: '23:00' },
    { d: 5, o: '08:00', c: '24:00' }, // petek
    { d: 6, o: '09:00', c: '24:00' }, // sobota
    { d: 0, o: '09:00', c: '21:00', closed: true }, // nedelja — zaprto (demo)
  ]
  for (const h of hours) {
    await db.openingHours.create({
      data: { id: nid(`oh-${h.d}`), dayOfWeek: h.d, openTime: h.o, closeTime: h.c, isClosed: !!h.closed, locationId },
    })
  }

  // načini naročanja
  const diningOpts = [
    { id: nid('do-dinein'), name: 'Lokalno (dine-in)', type: 'dine-in', prep: 15, order: 1 },
    { id: nid('do-takeaway'), name: 'Za vzeti (takeaway)', type: 'takeaway', prep: 10, order: 2 },
    { id: nid('do-delivery'), name: 'Dostava', type: 'delivery', prep: 25, order: 3 },
  ]
  for (const d of diningOpts) {
    await db.diningOption.create({
      data: { id: d.id, name: d.name, type: d.type, prepTimeMinutes: d.prep, sortOrder: d.order, locationId },
    })
  }

  // naprave
  await db.deviceRegistry.createMany({
    data: [
      { id: nid('dev-pos1'), deviceId: 'POS-LJU-001', name: 'Blagajna 1 (glavna)', type: 'pos', status: 'online', locationId },
      { id: nid('dev-pos2'), deviceId: 'POS-LJU-002', name: 'Blagajna 2 (terasa)', type: 'pos', status: 'online', locationId },
      { id: nid('dev-kds1'), deviceId: 'KDS-LJU-001', name: 'Kuhinjski zaslon', type: 'kds', status: 'online', locationId },
      { id: nid('dev-kds2'), deviceId: 'KDS-LJU-002', name: 'Barski zaslon', type: 'kds', status: 'offline', locationId },
    ],
  })

  // rezervacija (demo)
  await db.reservation.create({
    data: {
      id: nid('res-demo1'),
      customerName: 'Družina Novak',
      customerPhone: '+386 40 123 456',
      dateTime: new Date(now + 2 * 3600_000),
      partySize: 4,
      status: 'confirmed',
      source: 'phone',
      locationId,
      tableId: nid('tbl-3'),
      notes: 'Obletnica — prinesemo torto',
    },
  })
  await db.reservation.create({
    data: {
      id: nid('res-demo2'),
      customerName: 'G. Kos s sodelavci',
      customerPhone: '+386 41 987 654',
      dateTime: new Date(now + 26 * 3600_000),
      partySize: 8,
      status: 'confirmed',
      source: 'website',
      locationId,
      tableId: nid('tbl-17'),
    },
  })

  console.log('🎉 Demo seed zaključen!')
  console.log('   Login: admin@gostilnaprilipi.si (PIN 1234) ali DEMO vstop gumb')
  console.log(`   Artikli POS: ${mi} | Zaloga: ${ic} | Mize: ${tc} | Dobavitelji: ${supDefs.length}`)
}

main()
  .catch((e) => {
    console.error('❌ Seed napaka:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
