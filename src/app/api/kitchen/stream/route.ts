import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, locationScope } from '@/lib/api'
import { ORDER_ACTIVE_DB, ITEM_ACTIVE_DB } from '@/lib/map'
import { isMissingSchemaError } from '@/lib/prisma-missing'
import type { OrderItemStatus } from '@/lib/prisma-types'

/* CI typecheck-prod (Postgres klient): Enum filtri zahtevajo TIP enuma, ne string[]
   (SQLite klient lokalno sprejme oboje — isti cast kot glavna kuhinjska ruta). */
const ORDER_ACTIVE_PRISMA = ORDER_ACTIVE_DB as ('open' | 'sent' | 'prepared')[]
const ITEM_ACTIVE_PRISMA = ITEM_ACTIVE_DB as OrderItemStatus[]

/**
 * v1.232.0 (PRIMERJAVA-VMESNIKOV-2026 §3 »Push (ne polling)«, Toast/Square KDS
 * realtime) — SSE PRETOK SVEŽINE KUHINJE.
 *
 * GET /api/kitchen/stream → text/event-stream:
 *  - event:hello  ob odprtju (klient izrise LIVE oznako)
 *  - event:changed ob SPREMEMBI podpisa kuhinje (nov listek, prehod postavke,
 *    postajna naloga) — klient takoj pokliče obstoječi load('hot')
 *  - :ping komentar vsak tik (drži povezavo živo skozi proxy-je)
 *
 * Podpis = MAX(updatedAt) aktivnih naročil + aktivnih postavk + aktivnih postajnih
 * nalog (vse tri tabele imajo @updatedAt — vsak prehod/prejeta sprememba ga dvigne).
 * PRVI podpis ob povezavi se utiša (bazna črta — klient je ravnokar naložil vrsto;
 * changed pomeni NASLEDNJO spremembo). Brez tega bi vsaka PONOVNA povezava
 * (55 s življenjska doba / padec omrežja) takoj sprožila odvečen load('hot'),
 * ki bi prek setPerms razstrelil identiteto odvisnosti SSE efekta (E2E najdba:
 * close/open krog vsakih ~1,6 s). Vrzel med padcem in ponovno povezavo pokrije
 * 15-sekundni polling (vedno prisoten varnostni sloj).
 * Cena ~3 poceni indeksirane poizvedbe na tik (3 s) na povezavo — za 1–3 KDS zaslone
 * na lokacijo zanemarljivo, proti dobitku: listek novega naročila se pokaže v
 * ~3–5 s namesto do 15 s (polling).
 *
 * Življenjska doba toka je OMEJENA (55 s) — serverless (Vercel) funkcije se sicer
 * sile s časovno omejitvijo; EventSource se sam poveže nazaj (retry hint 5 s), zato
 * je doba nevidna uporabniku. Polling na 15 s ostane kot VEDNO prisoten fallback:
 *  - povezava ni mogoča (starejši brskalnik/proxy poje SSE) → nič se ne spremeni,
 *  - povezava pade → EventSource retry + polling pokrijejo vrzel,
 *  - stream 403 (vloga brez kitchen.update) → klient ga ne odpre (tabHasPerm gate).
 *
 * Pravice: kitchen.update — ISTITA kot GET /api/kitchen (KDS je enako občutljiv
 * v živo kot v polling načinu); lokacijski obseg prav tako (scope v obeh poizvedbah).
 */
export const dynamic = 'force-dynamic'

/** Tik podpisa (3 s) — kompromis svežina/strošek poizvedb. */
const TICK_MS = 3_000
/** Zgornja meja življenjske dobe toka — pod Vercel maxDuration, nad tipičnim proxyjem. */
const MAX_LIFETIME_MS = 55_000

async function kitchenSignature(scope: { locationId?: string | { in: string[] } }): Promise<string> {
  const itemScope = { Order: { ...scope, status: { in: ORDER_ACTIVE_PRISMA } }, status: { in: ITEM_ACTIVE_PRISMA } }
  const [lastOrder, lastItem, lastTask] = await Promise.all([
    db.order.findFirst({
      where: { ...scope, status: { in: ORDER_ACTIVE_PRISMA } },
      select: { updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    }),
    db.orderItem.findFirst({ where: itemScope, select: { updatedAt: true }, orderBy: { updatedAt: 'desc' } }),
    // postajne naloge (Issue #14) — pred DDL tabele ni: prazen podpis (graceful)
    db.stationTask
      .findFirst({
        where: scope.locationId
          ? { locationId: scope.locationId, status: { in: ['waiting', 'pending', 'preparing', 'ready'] } }
          : { status: { in: ['waiting', 'pending', 'preparing', 'ready'] } },
        select: { updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      })
      .catch((e: unknown) => {
        if (isMissingSchemaError(e)) return null
        throw e
      }),
  ])
  return [
    lastOrder?.updatedAt?.toISOString() ?? '',
    lastItem?.updatedAt?.toISOString() ?? '',
    lastTask?.updatedAt?.toISOString() ?? '',
  ].join('|')
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)) } catch { closed = true }
      }
      const ping = () => {
        if (closed) return
        try { controller.enqueue(encoder.encode(`: ping\n\n`)) } catch { closed = true }
      }
      const close = () => {
        if (closed) return
        closed = true
        try { controller.close() } catch { /* že zaprto */ }
      }
      const onAbort = () => close()
      req.signal.addEventListener('abort', onAbort)

      // retry hint + pozdrav — klient ve, da je pretok živ (LIVE oznaka)
      try { controller.enqueue(encoder.encode(`retry: 5000\n\n`)) } catch { /* naprava odšla */ }
      send('hello', 'connected')

      let lastSig: string | null = null // null = prvi odčitek (bazna črta, brez changed)
      const startedAt = Date.now()
      const loop = async () => {
        while (!closed && Date.now() - startedAt < MAX_LIFETIME_MS) {
          try {
            const sig = await kitchenSignature(scope)
            if (closed) break
            if (lastSig !== null && sig !== lastSig) {
              send('changed', sig)
            } else if (lastSig === null) {
              // prvi odčitek — samo utišano inicializiraj bazno črto
              send('baseline', sig)
            } else {
              ping()
            }
            lastSig = sig
          } catch {
            // napaka podpisa (preklicana poizvedba ipd.) — tok se ne sesuje,
            // naslednji tik poskusi znova; polling ostaja varnostna mreža
            ping()
          }
          await new Promise((r) => setTimeout(r, TICK_MS))
        }
        req.signal.removeEventListener('abort', onAbort)
        close()
      }
      void loop()
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // onemogoči medpomnjenje na Caddy/nginx prek proxy-ja (tunnels/cloud)
      'X-Accel-Buffering': 'no',
    },
  })
}
