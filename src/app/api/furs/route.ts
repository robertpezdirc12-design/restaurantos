/**
 * AUDIT-FIX val 2 (v1.82.2) — POST (plačilo + fiskalni račun, 878 vrst. logike)
 * je izločen v src/lib/furs/issue.ts (issueFursReceipt); ta route je tanki
 * delegat (isti vzorec kot /api/purchase-orders/run-recurring → recurring-run).
 * Vedenje in odgovori so nespremenjeni; tests/furs-post.test.ts uva POST od tu
 * in s tem pokriva celotno delegat → jedro pot.
 */

import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { mapReceipt } from '@/lib/map'
import { issueFursReceipt } from '@/lib/furs/issue'

/**
 * Seznam izdanih računov (FURS). Najnovejši prvi, zadnjih 100.
 * Vključi povezavo na naročilo/mizo za prikaz v UI (zavihek Računi).
 *
 * N5 (revizija §4): finančni seznam izdanih računov — UI prikaže zavihek Računi
 * samo z 'reports.view' (TAB_PERM.racuni), zato backend uveljavlja isto kanonično
 * dovoljenje (prej: requireAuth — natakar je prek API-ja videl vse račune).
 * Izbira 'reports.view' (in ne 'furs.issue'): zavihek je ZA VPOGLED v izdane račune
 * (seznam + CSV izvoz), ne za izdajo — izdaja gre skozi POST z lastnim gatingom;
 * 'furs.issue' bi po nepotrebnem zaprl seznam tudi financial/accounting rolam,
 * ki izdajajo ne, a poročila smejo videti. Podrobnost računa (tisk po plačilu,
 * GET /api/furs/[id]) ostaja dostopna blagajni — ni del tega popravka.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const receipts = await db.receipt.findMany({
    // Issue #4 §10: izdani računi so location-scoped (prej: vse lokacije)
    where: await locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { Order: { include: { Table: true } } },
  })
  return ok({
    receipts: receipts.map((r) => ({
      ...mapReceipt(r),
      tableName: r.Order?.Table ? `Miza ${r.Order.Table.number ?? (r.Order.Table as unknown as { name?: string }).name ?? ''}` : null,
      orderNumber: r.Order?.orderNumber ?? null,
      // storno označba (P1 audit točka 1): UI skrije storno akcijo za že stornirane
      isStorno: r.isStorno === true,
      stornoOf: r.stornoOf || null,
    })),
  })
}

/**
 * Plačilo + FURS račun — ATOMARNO (issue #1: stabilnost/idempotencija).
 * - $transaction: CAS zaščita (order.paymentStatus IN ['unpaid','partial'] — Naloga 37:
 *   ojačano iz '!= paid', ki je spustilo tudi terminalna stanja 'storno'/'cancelled')
 *   + Check + Receipt + Payment + miza
 *   → dvojni račun/plačilo za isti naročilo NI več mogoč (tudi ob dvojnem kliku/retry)
 * - Naloga 37 (audit priporočilo Task 31-a): terminalna stanja ('storno', 'cancelled')
 *   so ZAVRJENA že v pred-transakcijski guardi (fail fast, nedvoumno sporočilo) —
 *   ponovno plačilo/fakturacija storniranega naročila NI več mogoča (prej: CAS '!= paid'
 *   je spustil 'storno' → nov fiskalni račun nad že negirano prodajo; replay zaščita
 *   deductStock sicer zadrži dvojno razknjižbo, a račun bi bil izdan). "Twin" replay
 *   (CAS izguba dirke) išče IZKLJUČNO originalni račun (isStorno=false) — nikoli
 *   storno negacije.
 * - Idempotencija: body.clientOperationId → Payment.idempotencyKey (unique); replay vrne
 *   ISTI račun (200, replayed) namesto novega
 * - Terminski POS: body.terminal.approvalCode → Payment.authorizationCode
 * - Issue #1 §6 deljeno plačilo: body.parts = [{ type, amount, terminal? }] — več delov
 *   z različnimi načini; vsota delov + vrednost unovčenih točk MORA biti = za plačanje
 *   (preprečitev preplačila/dvojnega plačila — validirano strežniško)
 * - Issue #1 §6 zvestoba: body.loyaltyAccountId + loyaltyPointsUsed → CAS odbitje točk +
 *   LoyaltyTransaction (redeem) + Payment(type='loyalty'); zaslužek po plačilu (earn)
 * - Issue #1 §6 popusti: ročni (Order.discount) + avtomatski (Happy Hour) izračunana
 *   kanonično prek billing.ts — Check/Receipt nosita discount razčlenbo
 * - Issue #1 triage ③ darilne kartice: del plačila type='giftcard' + giftCardId →
 *   pre-validacija (obstaja/aktivna/rok/saldo) + CAS odbitje v transakciji +
 *   GiftCardTransaction 'redeem' (podpisan −) + Payment.giftCardId; preplačilo kartice 409
 * - FURS: simulacija → ZOI=MD5, EOR=UUID, status 'verified'; produkcija → EOR='',
 *   status 'pending' (čaka pravo SOAP integracijo s certifikatom) + AuditLog INVOICE_ISSUE
 */

/**
 * Plačilo + FURS/CIS račun — ATOMARNO. Celotna logika (izstavki, popusti,
 * zvestoba, darilne kartice, ZOI/EOR/ZKI/JIR) je v src/lib/furs/issue.ts.
 * Pravica: orders.pay. Dokumentacija poteka: gl. src/lib/furs/issue.ts.
 */
export async function POST(req: NextRequest) {
  return issueFursReceipt(req)
}
