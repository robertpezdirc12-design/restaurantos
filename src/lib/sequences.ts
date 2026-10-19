/**
 * Atomarne sekvence prek modela Counter (issue #1 — stabilnost).
 * Zamenja ranljivi max+1 vzorec (dvojni številki ob sočasnosti).
 * Vzorec: upsert z increment; max obstoječih številk kot spodnja meja
 * (varno pri prvi uporabi Countera na bazi z obstoječimi dokumenti).
 * audit #13/#14 (v1.146.0): spodnja meja se MORA zapisati, ne samo upoštevati —
 * sicer se zaostanek Counterja nikoli ne ozdravi in številke se podvajajo.
 */
import { nid } from '@/lib/map'

export type SequenceTx = {
  counter: {
    upsert: (args: {
      where: { name: string }
      create: { id: string; name: string; value: number }
      update: { value: { increment: number } }
    }) => Promise<{ value: number }>
    updateMany: (args: {
      where: { name: string; value?: { lt: number } }
      data: { value: number }
    }) => Promise<{ count: number }>
  }
}

/**
 * Vrne naslednjo vrednost sekvence (1, 2, 3, …).
 * @param floor mínimalna naslednja vrednost (npr. max ObstojecihStevilk + 1)
 */
export async function nextSequence(tx: SequenceTx, name: string, floor = 1): Promise<number> {
  const seed = Math.max(1, floor)
  const c = await tx.counter.upsert({
    where: { name },
    create: { id: nid(), name, value: seed },
    update: { value: { increment: 1 } },
  })
  if (c.value >= seed) return c.value
  // Counter ZAOSTAJA za spodnjo mejo (obstoječe številke so nastale tudi brez
  // Counterja — seed, uvoz, ročni zapisi). Meje ni dovolj samo UPOŠTEVATI ob
  // vrnitvi: increment se je zgodil na vrednosti POD mejo, zato naslednji klic
  // spet vrne ISTO številko. Trk na @@unique (npr. [locationId, receiptNumber])
  // dvigne P2002 in razveljavi CELO transakcijo — tudi svoj increment, torej
  // zaostanek obstane in noben nov dokument ne more več nastati.
  // Zapis meje (vrstica je zaklenjena z upsertom) jo trajno ozdravi: sočasni
  // klic incrementa zato pripelje NAD mejo, ne na njo.
  await tx.counter.updateMany({ where: { name, value: { lt: seed } }, data: { value: seed } })
  return seed
}
