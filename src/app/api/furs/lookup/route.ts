import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { mapReceipt } from '@/lib/map'
import { normalizeReceiptScan, receiptScanVariants } from '@/lib/barcode'

/**
 * v1.251.0 (PRIMERJAVA-VMESNIKOV-2026 §25) — ISKANJE RAČUNA PO ČRTNI KODI.
 *
 * Toast januar 2026 (»Look up checks by scanning the receipt barcode«):
 * gost prinese račun nazaj (vračilo/storno, tip, poizvedba), osebje skenira
 * črtno kodo z računa (Code128 receiptNumber) ali vnese številko ročno
 * (natisnjena zgoraj na računu) — dokument se najde BREZ ročnega brskanja
 * po seznamu zadnjih 100.
 *
 * Pravila:
 *  - Pravica: reports.sales — IDENTIČNO seznamu izdanih računov (/api/furs
 *    GET, N5 revizija §4): zavihek Računi je za VPOGLED v izdane račune;
 *    izdaja/storno imata svoji gating. Skeniranje je iskanje za vpogled.
 *  - Obseg: await locationScope(user) — isti lastnik kot seznam (Issue #4 §10:
 *    izdani računi so location-scoped; centralne vloge vidijo celo
 *    organizacijo, kjer je lahko ista številka na več lokacijah — zato je
 *    odgovor SEZNAM zadetkov, ne en dokument).
 *  - Vsebina kode = receiptNumber (leto-mesec-seq-premises, npr.
 *    »2026-11-42-BLG001«; stara shema »R-YYYY-NNNNN« se najde z ročnim
 *    vnosom — ujemanje je natančno po nizu). Normalizacija: trim + vsi
 *    presledki ven (skener/ročni vnos); velikost se ohrani, poizkusijo se
 *    tri variante (kot-vpišano / velike / male) v ENEM poizvedbi IN —
 *    pokrije odstopanje velikosti premises oznake pri ročnem vnosu.
 *  - Prazno / krajše od 4 znakov = 400 (isti prag kao EAN iskanje v1.229 —
 *    besedne poizvedbe ostanejo na seznamu, ne tukaj).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const raw = req.nextUrl.searchParams.get('code') ?? ''
  const code = normalizeReceiptScan(raw)
  if (code.length < 4) {
    return fail('Koda računa je prekratka (najmanj 4 znaki).', 400)
  }

  const receipts = await db.receipt.findMany({
    where: { receiptNumber: { in: receiptScanVariants(code) }, ...(await locationScope(user)) },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { Order: { include: { Table: true } } },
  })

  return ok({
    receipts: receipts.map((r) => ({
      ...mapReceipt(r),
      tableName: r.Order?.Table ? `Miza ${r.Order.Table.number ?? (r.Order.Table as unknown as { name?: string }).name ?? ''}` : null,
      orderNumber: r.Order?.orderNumber ?? null,
      // storno označba (ista kot seznam): UI skrije storno akcijo za že stornirane
      isStorno: r.isStorno === true,
      stornoOf: r.stornoOf || null,
    })),
  })
}
