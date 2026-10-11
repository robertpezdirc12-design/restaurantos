import { describe, expect, test } from 'bun:test'
import { classifySync, type SyncState } from '../scripts/sync-check'

/**
 * Task 46: testi za sync-check klasifikacijo (scripts/sync-check.ts).
 * Čisti unit testi — brez omrežja/gita. SHA-ji so fiktivni, oblika polna
 * (40 znakov), kot jo vrnejo git rev-parse / ls-remote / health.
 */

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

function st(partial: Partial<SyncState>): SyncState {
  return {
    local: A,
    mirror: A,
    prod: A,
    dirtyTracked: 0,
    dirtyUntracked: 0,
    prodVersion: '1.50.0',
    prodDatabase: 'connected',
    ...partial,
  }
}

describe('sync-check: classifySync', () => {
  test('vse tri pike enake → synced, brez akcij', () => {
    const v = classifySync(st({}))
    expect(v.state).toBe('synced')
    expect(v.actions).toHaveLength(0)
  })

  test('lokal zaostaja, mirror == prod → local-behind z reset akcijami', () => {
    const v = classifySync(st({ local: '0'.repeat(40), mirror: B, prod: B }))
    expect(v.state).toBe('local-behind')
    expect(v.actions.some((a) => a.includes('git fetch origin'))).toBe(true)
    expect(v.actions.some((a) => a.includes('reset --hard origin/main'))).toBe(true)
  })

  test('mirror zaostaja, lokal == prod → local-ahead z push akcijo', () => {
    const v = classifySync(st({ mirror: '9'.repeat(40), prod: A }))
    expect(v.state).toBe('local-ahead')
    expect(v.actions).toContain('git push origin main')
  })

  test('mirror != prod → diverged z diagnoznimi koraki', () => {
    const v = classifySync(st({ local: B, mirror: B, prod: C }))
    expect(v.state).toBe('diverged')
    expect(v.actions.some((a) => a.toLowerCase().includes('avtoritativa'))).toBe(true)
  })

  test('nedosegljiva produkcija → unknown z infra akcijo', () => {
    const v = classifySync(st({ prod: null }))
    expect(v.state).toBe('unknown')
    expect(v.actions.length).toBeGreaterThan(0)
  })

  test('nedosegljiv mirror → unknown', () => {
    const v = classifySync(st({ mirror: null }))
    expect(v.state).toBe('unknown')
  })

  test('nedosegljiv lokal → unknown', () => {
    const v = classifySync(st({ local: null }))
    expect(v.state).toBe('unknown')
  })

  test('unknown je prednost pred drugimi klasifikacijami (katerakoli pika null)', () => {
    // lokal zaostaja, a produkcija nedosegljiva → ne smemo trditi local-behind
    const v = classifySync(st({ local: '0'.repeat(40), mirror: B, prod: null }))
    expect(v.state).toBe('unknown')
  })

  test('local-behind summary omenja peskovni rollback (typičen vzorec)', () => {
    const v = classifySync(st({ local: '0'.repeat(40), mirror: B, prod: B }))
    expect(v.summary).toContain('rollback')
  })
})
