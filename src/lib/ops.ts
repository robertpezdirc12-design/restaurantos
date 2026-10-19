/**
 * Jedro operacij (issue #1 — offline/local-first).
 * Skupna logika za POST /api/orders IN POST /api/sync (replay offline operacij),
 * da offline ustvarjena naročila gredo skozi ISTEI preverjanja kot online.
 * Idempotencija: Order.idempotencyKey (unique) — isti clientOperationId vrne obstoječe naročilo.
 *
 * Issue #57 (P1): idempotencyKey je KLIENTOV identifikator operacije, NE dovoljenje.
 * Replay (pre-lookup in P2002 twin veja) vrne obstoječe naročilo SAMO, če pripada
 * TRENUTNO VALIDIRANEMU kontekstu (lokacija + miza + tip + vir). Drugačen kontekst
 * → 409 z generičnim sporočilom, BREZ podatkov tujega naročila. Enako pravilo kot
 * #50 (plačilni replay), #51 (kartice), #56 (popis), #65 (eSLOG): ključ ni poverilnica.
 *
 * NAMERNO PRAVILO (premik mize): če je bilo naročilo legitimno premaknjeno prek
 * /api/orders/[id]/move, retry starega konteksta (npr. QR mize) vrne 409 — klient
 * mora stanje ponovno prebrati (javna pot ima ločen status endpoint). Fail-closed.
 * EmployeeId NI del konteksta: sistemski viri (delivery webhook) razrešijo
 * zaposlenega nestabilno (findFirst nad aktivnimi), zato operater ne sme biti
 * identiteta replaya; kontekst = kanonična operacija (lokacija/miza/tip/vir).
 */
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { mapOrder, nid, num, r2, orderTypeToDB } from '@/lib/map'
import { nextSequence } from '@/lib/sequences'
import { loadModifierContext, validateItemModifiers, ResolvedModifierOut } from '@/lib/modifiers'
import { publishEvent } from '@/lib/events'
import { buildAllergenSnapshots, sanitizeAllergenWarning } from '@/lib/allergen-profile'
import { vatFromGross } from '@/lib/billing'

export const orderInclude = {
  OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } },
  Table: true,
  Employee_Order_employeeIdToEmployee: { select: { id: true, name: true, role: true } },
  Receipt: { orderBy: { createdAt: 'desc' as const } },
} as const

export function normalizeOrder(o: Record<string, unknown>) {
  return {
    ...o,
    items: o.OrderItem,
    table: o.Table,
    employee: o.Employee_Order_employeeIdToEmployee,
  } as Parameters<typeof mapOrder>[0]
}

export interface CreateOrderDeliveryInput {
  /** Kreira DeliveryInfo v ISTI transakciji (issue #2 — dostava uporablja kanonični Order) */
  address: string
  city?: string
  postCode?: string
  recipientName?: string
  recipientPhone?: string
  deliveryInstructions?: string
  deliveryFee?: number
  packagingFee?: number
  status?: string
  /** OPS-9 val 3 (v1.76.0): provider ETA (DeliveryInfo.estimatedTime, DateTime?) — opcionalno. */
  estimatedTime?: Date | null
}

export interface CreateOrderInput {
  /** Issue #3: gost (QR/kiosk) nima zaposlenega → null */
  employeeId: string | null
  locationId: string | null
  items: {
    menuItemId: string
    qty?: number
    note?: string
    /** Issue #7: izrecno alergensko opozorilo (gost prijavi alergijo / osebje) — ≤ 200 */
    allergenWarning?: string
    /** Issue #3: opcije/modifierji — cene se štejejo v linijo, vrste se zapišejo v OrderItemModifier */
    modifiers?: { modifierId: string; name: string; price: number; groupName?: string; modifierGroupId?: string }[]
  }[]
  tableId?: string | null
  type?: string
  note?: string
  guests?: number
  clientOperationId?: string | null
  delivery?: CreateOrderDeliveryInput | null
  /** Issue #3: izvor naročila (pos | qr | kiosk) */
  orderSource?: string
}

export interface CreateOrderResult {
  order: ReturnType<typeof mapOrder>
  replayed: boolean
}

export interface CreateOrderOptions {
  /**
   * Issue #4 §10: findFirst() lokacijski fallback je DOVOLJEN samo za sistemske vire,
   * ki lokacije ne poznajo (delivery webhook pred vezavo). Staff javne poti ga NIKOLI ne smejo.
   */
  allowFirstLocationFallback?: boolean
}

/** Kanonični kontekst operacije za idempotentni replay (issue #57). */
export interface OrderReplayContext {
  locationId: string
  tableId: string | null
  /** DB-normaliziran tip (orderTypeToDB) */
  type: string
  /** izvor naročila: pos | qr | kiosk (privzeto 'pos') */
  orderSource: string
}

/**
 * Issue #57: obstoječe naročilo sme biti vrnjeno kot replay SAMO pri ujemanju
 * trenutno validiranega konteksta. Čistega jedra NE meče — vrača boolean, da ga
 * lahko testi in obe veji (pre-lookup + P2002 twin) uporabita enako.
 */
export function orderReplayContextMatches(
  existing: { locationId: string; tableId: string | null; type: string; orderSource: string },
  ctx: OrderReplayContext
): boolean {
  return (
    existing.locationId === ctx.locationId &&
    (existing.tableId ?? null) === ctx.tableId &&
    (existing.type || 'dine-in') === ctx.type &&
    (existing.orderSource || 'pos') === ctx.orderSource
  )
}

/**
 * Issue #57: replay-context varovalka — ob NE-ujemanju vrže 409 z generičnim
 * sporočilom (brez vrstic/zneskov/številke tujega naročila).
 */
function assertReplayContext(
  existing: { locationId: string; tableId: string | null; type: string; orderSource: string },
  ctx: OrderReplayContext
): void {
  if (!orderReplayContextMatches(existing, ctx)) {
    throw new OrderError(
      'Idempotency ključ je že uporabljen v drugem kontekstu (druga lokacija, miza, tip ali vir naročila) — naročilo ni bilo ustvarjeno.',
      409
    )
  }
}

/** Idempotentno ustvarjanje naročila (transakcija: sekvenca + naročilo + artikli + miza) */
export async function createOrderCore(
  input: CreateOrderInput,
  opts?: CreateOrderOptions
): Promise<CreateOrderResult> {
  if (!input.items || input.items.length === 0) {
    throw new OrderError('Naročilo mora vsebovati vsaj en artikel.')
  }
  const menuItemIds = input.items.map((i) => i.menuItemId)
  const locationId = input.locationId || (opts?.allowFirstLocationFallback ? (await db.location.findFirst())?.id : null)
  if (!locationId) throw new OrderError('Ni lokacije. Najprej ustvari lokacijo.')

  // Issue #4 §5: cene/imeni opcij VEDNO iz DB + relacija artikel→skupina→modifier
  // (prej je POS pot zaupala client ceni modifierja — cena manipulacija)
  const modIds = [...new Set(input.items.flatMap((i) => (i.modifiers || []).map((m) => String(m.modifierId || ''))))].filter(Boolean)
  const [menuItems, modCtx] = await Promise.all([
    db.menuItem.findMany({
      where: { id: { in: menuItemIds }, isAvailable: true },
      include: {
        PrepStation: true,
        Category: { include: { Menu: { select: { locationId: true } } } },
      },
    }),
    loadModifierContext(menuItemIds, modIds),
  ])
  const visibleItems = menuItems.filter(
    (mi) => (mi as unknown as { Category?: { Menu?: { locationId?: string } } })?.Category?.Menu?.locationId === locationId
  )
  if (menuItems.length === 0) throw new OrderError('Artikli ne obstajajo.')

  const idempotencyKey =
    typeof input.clientOperationId === 'string' && input.clientOperationId.trim().length >= 8
      ? input.clientOperationId.trim().slice(0, 64)
      : null

  // Issue #57: kanonični kontekst operacije — replay je dovoljen SAMO zanj
  const replayCtx: OrderReplayContext = {
    locationId,
    tableId: input.tableId || null,
    type: orderTypeToDB(input.delivery ? 'DELIVERY' : (input.type || 'DINE_IN')),
    orderSource: input.orderSource || 'pos',
  }

  // Idempotentni replay: isti clientOperationId + ISTI kontekst → vrni obstoječe
  // naročilo (ne ustvari dvojnega). Drug kontekst → 409 (assertReplayContext).
  if (idempotencyKey) {
    const existing = await db.order.findUnique({
      where: { idempotencyKey },
      include: orderInclude,
    })
    if (existing) {
      assertReplayContext(existing, replayCtx)
      return { order: mapOrder(normalizeOrder(existing)), replayed: true }
    }
  }

  // Issue #7 (P1, v1.104.0): posnetek alergenskih informacij OB NASTANKU naročila
  // (kode jedi ∪ kode IZBRANIH opcij; kasnejša sprememba recepta NE spremeni
  // zgodovine). Izračun IZVEN transakcije (branje, pred TX spodaj).
  const allergenSnapshots = await buildAllergenSnapshots(
    input.items.map((i) => ({
      menuItemId: i.menuItemId,
      chosenModifierIds: (i.modifiers || []).map((m) => String(m.modifierId || '')).filter(Boolean),
    }))
  ).catch(() => input.items.map(() => '{}'))

  let subtotal = 0
  let tax = 0
  const itemRows = input.items.map((i, itemIdx) => {
    const mi = visibleItems.find((m) => m.id === i.menuItemId)
    if (!mi) {
      throw new OrderError(
        menuItems.some((m) => m.id === i.menuItemId)
          ? 'Artikel ni na voljo na tej lokaciji.'
          : 'Artikel ne obstaja ali ni več na voljo.'
      )
    }
    const qty = Math.max(1, Math.round(Number(i.qty) || 1))
    const price = num(mi.price)
    const vatRate = num(mi.vatRate, 22)
    // Issue #4 §5: opcije se validirajo proti relaciji in se ocenijo IZ DB
    // (client name/price se ignorira)
    const v = validateItemModifiers({
      allowedGroupIds: modCtx.allowedByItem.get(mi.id) || [],
      groupById: modCtx.groupById,
      modById: modCtx.modById,
      chosenIds: (i.modifiers || []).map((m) => String(m.modifierId || '')),
    })
    if (!v.ok) throw new OrderError(v.error || 'Opcije niso veljavne.')
    const mods = v.resolved.map((m: ResolvedModifierOut, idx: number) => ({
      id: nid(),
      name: m.name.slice(0, 120),
      price: Math.max(0, m.price),
      modifierGroupId: m.modifierGroupId || null,
      modifierGroupName: String(m.groupName || '').slice(0, 120),
      sortOrder: idx,
    }))
    const modsTotal = mods.reduce((s, m) => s + m.price, 0)
    const line = (price + modsTotal) * qty
    // Naloga #6: cena je končna (z DDV) — DDV se izvleče, neto je osnova za FURS.
    const vat = vatFromGross(line, vatRate)
    subtotal += r2(line - vat)
    tax += vat
    return {
      id: nid(),
      menuItemId: mi.id,
      quantity: qty,
      price: price + modsTotal,
      vatRate,
      vatAmount: vat,
      menuItemName: mi.name,
      status: 'pending' as const,
      notes: i.note || '',
      modifiersJson: '[]',
      // Issue #7: posnetek (kode/status ob nastanku) + izrecno opozorilo postavke
      allergenSnapshot: allergenSnapshots[itemIdx] || '{}',
      allergenWarning: sanitizeAllergenWarning(i.allergenWarning),
      mods,
    }
  })

  // Dostava (issue #2): pristojbine grejo v total (niso obdavčene — standardna pravila platform)
  const deliveryFee = input.delivery ? Math.max(0, Number(input.delivery.deliveryFee) || 0) : 0
  const packagingFee = input.delivery ? Math.max(0, Number(input.delivery.packagingFee) || 0) : 0

  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const order = await db.$transaction(async (tx) => {
        const maxNumber = await tx.order.aggregate({ where: { locationId }, _max: { orderNumber: true } })
        const floor = (maxNumber._max.orderNumber || 0) + 1
        const orderNumber = await nextSequence(tx, `order:${locationId}`, floor)
        let deliveryInfoId: string | null = null
        if (input.delivery) {
          const di = await tx.deliveryInfo.create({
            data: {
              id: nid(),
              address: input.delivery.address || '',
              city: input.delivery.city || '',
              postCode: input.delivery.postCode || '',
              recipientName: input.delivery.recipientName || '',
              recipientPhone: input.delivery.recipientPhone || '',
              deliveryInstructions: input.delivery.deliveryInstructions || '',
              deliveryFee: deliveryFee,
              packagingFee: packagingFee,
              status: input.delivery.status || 'pending',
              ...(input.delivery.estimatedTime ? { estimatedTime: input.delivery.estimatedTime } : {}),
            },
          })
          deliveryInfoId = di.id
        }
        const created = await tx.order.create({
          data: {
            id: nid(),
            orderNumber,
            locationId,
            tableId: input.tableId || null,
            employeeId: input.employeeId,
            type: orderTypeToDB(input.delivery ? 'DELIVERY' : (input.type || 'DINE_IN')),
            status: 'open',
            paymentStatus: 'unpaid',
            notes: input.note || '',
            subtotal: r2(subtotal),
            tax: r2(tax),
            total: r2(subtotal + tax + deliveryFee + packagingFee),
            splitCount: Number(input.guests) || 1,
            idempotencyKey,
            deliveryInfoId,
            // Issue #3: izvor naročila (pos | qr | kiosk)
            orderSource: input.orderSource || 'pos',
            OrderItem: {
              create: itemRows.map((r) => {
                const { mods, ...itemData } = r
                return {
                  ...itemData,
                  // Issue #3: opcije/modifierji linije (cene iz DB, ne iz clienta)
                  OrderItemModifier: mods?.length
                    ? {
                        create: mods.map((m) => ({
                          id: m.id,
                          name: m.name,
                          price: m.price,
                          modifierGroupId: m.modifierGroupId,
                          modifierGroupName: m.modifierGroupName,
                          sortOrder: m.sortOrder,
                        })),
                      }
                    : undefined,
                }
              }),
            },
          },
          include: orderInclude,
        })
        if (created.tableId) {
          // Issue #4 §1: miza MORA pripadati lokaciji naročila (prej: naročilo loc A je zasedlo mizo loc B)
          const table = await tx.table.findFirst({
            where: { id: created.tableId, locationId },
            select: { id: true },
          })
          if (!table) throw new OrderError('Miza ne pripada lokaciji naročila.')
          // R6 popravek (P0 audit): atomarna zasedba mize (CAS: samo nezasedena miza) —
          // prej: brezpogojni update → POS + QR gost sta lahko hkrati "zasedla" isto mizo
          const claim = await tx.table.updateMany({
            where: { id: created.tableId, status: { not: 'occupied' } },
            data: { status: 'occupied' },
          })
          if (claim.count === 0) {
            // dovoljeno le, če je drugo aktivno naročilo na mizi replay istega klika
            const activeOthers = await tx.order.count({
              where: { tableId: created.tableId, id: { not: created.id }, paymentStatus: { not: 'paid' }, status: { not: 'cancelled' } },
            })
            if (activeOthers > 0) throw new OrderError('Miza je že zasedena (aktivno naročilo).', 409)
          }
        }
        return created
      })
      // Issue #11 §3 — dogodek za event-driven temelj (nikoli ne poruši toka)
      // Issue #38: locationId iz verifikovanega konteksta (requireUserLocation pred TX)
      await publishEvent('OrderCreated', {
        entityType: 'Order',
        entityId: order.id,
        payload: { orderNumber: order.orderNumber, locationId, total: order.total, type: order.type },
        locationId,
      }).catch(() => undefined)
      return { order: mapOrder(normalizeOrder(order)), replayed: false }
    } catch (e) {
      lastErr = e
      const code = (e as { code?: string })?.code
      // P2002 na idempotencyKey → vzporedni dvojnik je zmagal: vrni njegovo naročilo
      // SAMO, če pripada trenutnemu kontekstu (issue #57 — isti guard kot pre-lookup;
      // tuji dvojnik = kollision ključa → 409, ne tujih podatkov)
      if (code === 'P2002' && idempotencyKey) {
        const twin = await db.order.findUnique({ where: { idempotencyKey }, include: orderInclude })
        if (twin) {
          assertReplayContext(twin, replayCtx)
          return { order: mapOrder(normalizeOrder(twin)), replayed: true }
        }
      }
      // P2002 na orderNumber (sočasna sekvenca na Postgresu) → ponovi z svežim max
      if (code !== 'P2002') break
    }
  }
  throw lastErr instanceof OrderError
    ? lastErr
    : new OrderError('Naročila ni bilo mogoče ustvariti. Poskusite znova.')
}

/**
 * Issue #5 (komentar #3): preureditev zneskov naročila — prej LOKALNA funkcija v
 * orders/[id]/route.ts; sedaj skupni vir za PATCH naročila IN preklic posamezne
 * postavke (/api/orders/[id]/void). Upošteva SAMO ne-preklicane postavke (voided).
 */
export async function recalcOrderTotals(orderId: string, tx?: Prisma.TransactionClient) {
  const dbx = tx ?? db
  const items = await dbx.orderItem.findMany({ where: { orderId, voided: false } })
  let subtotal = 0
  let tax = 0
  for (const it of items) {
    const line = num(it.price) * (it.quantity || 0)
    const vat = num(it.vatAmount)
    subtotal += line - vat
    tax += vat
  }
  return { subtotal: r2(subtotal), tax: r2(tax), total: r2(subtotal + tax) }
}

export class OrderError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * Bela lista stanj, iz katerih je SOCASNI zapis v naročilo še zakonit
 * (issue #48 matrika; v1.145.0 centralizirana — audit #10/#11/#12).
 * Isti seznam uporablja addItems CAS (orders/[id]) — tu je edini vir, da se
 * matrika ne razide med ruto in jedrom.
 */
export const ORDER_MUTABLE_STATUS = ['open', 'sent', 'prepared'] as const
export const ORDER_MUTABLE_PAYMENT = ['unpaid', 'partial'] as const

/** Write-time preverba: ali je stanje naročila še mutabilno (NE bereno prej). */
export function isMutableOrderState(o: { status: string; paymentStatus: string } | null | undefined) {
  if (!o) return false
  return (ORDER_MUTABLE_STATUS as readonly string[]).includes(o.status) &&
    (ORDER_MUTABLE_PAYMENT as readonly string[]).includes(o.paymentStatus)
}

/**
 * CAS posodobi mutabilno naročilo (v1.145.0, audit #10/#11/#12).
 *
 * Prej: rute so naročilo PREBRALE, preverile terminalna stanja in nato napisale
 * z BREZPOGOJNIM `order.update` — med branjem in zapisom je dirka (plačilo,
 * storno, preklic, drug klik) lahko commitnila, zapis pa jo je POBRIŠAL:
 * fiskaliziran račun z EOR-jem je ostal na 'cancelled' naročilu, plačano
 * naročilo se je vrnilo v 'prepared' (KDS/zakasnel klik), združeno naročilo je
 * prepisalo totale že plačanega cilja.
 *
 * Zdaj: zapis uspeje SAMO, če je vrstica ob zapisu (a) še v mutabilnem stanju in
 * (b) — kadar je podan `read` — še v ISTEM stanju, kot ga je klicatelj prebral
 * (optimistična zaščita pred izgubljenim posodobljenim zapisom, vzorec #39).
 * `ok: false` = dirka → klicatelj vrne 409; znotraj `$transaction` to razveljavi
 * tudi stranske učinke (plačilne povezave, miza, revizijski zapis), ki jih ruta
 * opravi za uspehom claims — zato smejo biti SHUPIRANI za claimom.
 *
 * @param read sveža ali vonjsko prebrana vrstica (status/paymentStatus [+ tableId])
 *               — brez = stanje se prebere ZNOTRAJ klica (npr. izven tx)
 */
export async function claimMutableOrder(
  client: Prisma.TransactionClient,
  id: string,
  data: Prisma.OrderUncheckedUpdateManyInput,
  read?: { status: string; paymentStatus: string; tableId?: string | null } | null,
): Promise<{ ok: boolean; tableId: string | null }> {
  const cur =
    read ??
    (await client.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true, tableId: true } }))
  if (!isMutableOrderState(cur)) return { ok: false, tableId: null }
  const claim = await client.order.updateMany({
    where: { id, status: cur!.status, paymentStatus: cur!.paymentStatus },
    data,
  })
  if (claim.count === 0) return { ok: false, tableId: null }
  return { ok: true, tableId: cur!.tableId ?? null }
}

