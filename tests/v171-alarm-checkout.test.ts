import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const WF = join(import.meta.dir, '..', '.github', 'workflows')

/**
 * Struktur, ne prose: komentarji v workflowih opisujejo prav ta antipattern,
 * zato surov `indexOf('uses: ./.github/actions/ci-alarm')` zadene pojasnilo in
 * datoteko obtoži, čeprav je korak pravilen (izmerjeno 23. 10. — pin je po
 * lastnem popravku ostal rdeč). Odstrani komentarne vrstice, preden iščeš
 * vrstni red.
 */
const kod = (f: string) =>
  readFileSync(join(WF, f), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

/**
 * v1.171.0 — alarmna plast, ki je ne more doseči noben popravek kode.
 *
 * Dokaz, ne hipoteza: run 39920450748 (`Neon backup (pg_dump production)`,
 * 23. 10. 2026 ob 08:03:05 UTC). Job je padel na `POST /roles` → „quota
 * exceeded", nato je šele zadnji korak rekel:
 *
 *   ##[error]Can't find 'action.yml', 'action.yaml' or 'Dockerfile' under
 *   '.../.github/actions/ci-alarm'. Did you forget to run actions/checkout
 *   before running your local action?
 *
 * `uses: ./.github/actions/...` se naloži iz DELOVNEGA prostora. Brez
 * `actions/checkout` datoteka akcije na runnerju preprosto ne obstaja, zato
 * se alarm ne more zgoditi — ne issue, ne komentar, ne povzetek koraka. Job
 * odpove in ostane tiho. Odgovor na vprašanje „zakaj izpadlega backupa nihče
 * ni videl, čeprav ima alarmni korak" je torej: korak je res bil napisan,
 * samo nikoli ni bil izvedljiv.
 *
 * Enako strukturo ima `prod-smoke.yml`. Njegovi zadnji štirje runi (19.–22.
 * 10.) so bili cancelled brez katerekoli `workflow_job`, torej do alarmnega
 * koraka sploh ni prišlo — luknje tam ni pokazala življenjska odpoved,
 * pokazala jo je enaka struktura datoteke.
 */
describe('v1.171.0 — lokalna akcija zahteva checkout', () => {
  const files = readdirSync(WF).filter((f) => f.endsWith('.yml')).sort()

  it('vsak workflow, ki kliče ./.github/actions/ci-alarm, ima actions/checkout pred njim', () => {
    expect(files.length).toBeGreaterThan(5)
    const manjkajo: string[] = []
    for (const f of files) {
      const src = kod(f)
      const alarm = src.indexOf('uses: ./.github/actions/ci-alarm')
      if (alarm === -1) continue
      const checkout = src.indexOf('uses: actions/checkout@')
      if (checkout === -1 || checkout > alarm) manjkajo.push(f)
    }
    expect(manjkajo).toEqual([])
  })

  it('vsak workflow s `schedule:` ima alarmni korak — nihče ga ne gleda živega', () => {
    expect(files.length).toBeGreaterThan(5)
    const brez: string[] = []
    for (const f of files) {
      const src = kod(f)
      if (!/^[ \t]*schedule:/m.test(src)) continue
      if (!src.includes('uses: ./.github/actions/ci-alarm')) brez.push(f)
    }
    expect(brez).toEqual([])
  })
})
