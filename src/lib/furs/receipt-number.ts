/**
 * audit #14 (v1.146.0) — dodelitev številke računa na ENEM mestu.
 *
 * Izdaja (`issueFursReceipt`) in storno (`/api/receipts/[id]/storno`) si delita
 * ISTI Counter `receipt:<locationId>` in ISTI format `leto-mesec-seq-premises`,
 * zato si delita tudi numberjenje. Katera koli od dveh poti, ki bi numberila
 * drugače, podvoji številko in s tem rewinda celotno transakcijo.
 *
 * Zakaj ne zadošča samo `count() + 1`:
 *  - Counter je lahko V ZAJTU za obstoječimi številkami (zapisi, ki jih Counter
 *    ni ustvaril: seed, uvoz, ročni posegi). `count()` takšne reže NE vidi, zato
 *    vrne mejo, ki JE ŽE ZASEDENA → trk na `@@unique([locationId, receiptNumber])`
 *    → P2002 → rollback plačila/klica (kupec plača, računa pa ni).
 *  - Rollback razveljavi tudi sam increment Counterja, zato stanje NI enkraten
 *    spodrsljaj: vsak naslednji poskus vrne isto številko in lokacija ne more več
 *    izdati NITI ENEGA dokumenta, dokler Counter ročno ne popravijo.
 *
 * Zato: `nextSequence` mejo TRAJNO zapiše (Counter se ozdravi), ta funkcija pa
 * predhodno PREVERI, da izbrana številka še ni zasedena, in ob reži počaka na
 * naslednjo vrednost Counterja. Številki med seboj ne moreta trčiti tudi pri
 * sočasnem klicu: `upsert` drži zaklep vrstice Counterja do commita, zato
 * sočasni increment pade NAD mejo, ne na njo.
 */
import { nextSequence, type SequenceTx } from '@/lib/sequences'
import { localYearMonth } from '@/lib/fiscal-time'

export type ReceiptNumberTx = Pick<SequenceTx, 'counter'> & {
  receipt: {
    count: (args: { where: { locationId: string } }) => Promise<number>
    findFirst: (args: { where: { locationId: string; receiptNumber: string }; select: { id: true } }) => Promise<{ id: string } | null>
  }
}

export interface ReceiptLocationRef {
  id: string
  timezone?: string | null
  premisesId?: string | null
}

/** Največ poskusov, kolikor zaporednih zasedenih številk sme prečkati reža. */
const MAX_PROBES = 64

/**
 * Atomarno dodeli naslednjo številko računa za lokacijo.
 * Vrne `seq` (za fiskalne kode) IN `receiptNumber` (za `@@unique`).
 */
export async function allocateReceiptNumber(
  tx: ReceiptNumberTx,
  location: ReceiptLocationRef,
  issuedAt: Date,
): Promise<{ seq: number; receiptNumber: string }> {
  // audit #2: številka je po LOKALNEM koledarju lokacije — sicer se `leto-mesec`
  // iz številke in `IssueDateTime` razideta (nočna izdaja)
  const { y, m } = localYearMonth(issuedAt, location.timezone ?? null)
  const premises = location.premisesId || 'BLG001'
  const floor = (await tx.receipt.count({ where: { locationId: location.id } })) + 1
  for (let probe = 0; probe < MAX_PROBES; probe++) {
    const seq = await nextSequence(tx, `receipt:${location.id}`, floor)
    const receiptNumber = `${y}-${m}-${seq}-${premises}`
    const taken = await tx.receipt.findFirst({ where: { locationId: location.id, receiptNumber }, select: { id: true } })
    if (!taken) return { seq, receiptNumber }
    // Reža v obstoječem številčenju: vsak klic `nextSequence` Counter dvigne IN
    // zapiše mejo, zato se zanka vedno konča (največ MAX_PROBES zaporednih).
  }
  throw new Error(`Številke računa ni bilo mogoče dodeliti (prek ${MAX_PROBES} zaporednih zasedenih številk na lokaciji ${location.id}).`)
}
