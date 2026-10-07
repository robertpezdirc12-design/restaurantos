/**
 * Atomarne sekvence prek modela Counter (issue #1 — stabilnost).
 * Zamenja ranljivi max+1 vzorec (dvojni številki ob sočasnosti).
 * Vzorec: upsert z increment; max obstoječih številkinga kot spodnja meja
 * (varno pri prvi uporabi Countera na bazi z obstoječimi dokumenti).
 */
import { nid } from '@/lib/map'

type Tx = {
  counter: {
    upsert: (args: {
      where: { name: string }
      create: { id: string; name: string; value: number }
      update: { value: { increment: number } }
    }) => Promise<{ value: number }>
  }
}

/**
 * Vrne naslednjo vrednost sekvence (1, 2, 3, …).
 * @param floor mínimalna naslednja vrednost (npr. max ObstojecihStevilk + 1)
 */
export async function nextSequence(tx: Tx, name: string, floor = 1): Promise<number> {
  const c = await tx.counter.upsert({
    where: { name },
    create: { id: nid(), name, value: Math.max(1, floor) },
    update: { value: { increment: 1 } },
  })
  return Math.max(c.value, floor)
}
