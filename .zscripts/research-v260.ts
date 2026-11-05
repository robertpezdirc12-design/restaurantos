#!/usr/bin/env bun
/** Enkratna raziskava vala v1.260.0: Square Vol 16? Toast/Lightspeed nove objave? */
import ZAI from 'z-ai-web-dev-sdk'

const q = async (query: string) => {
  const zai = await ZAI.create()
  const res = await zai.functions.invoke('web_search', { query, num: 8 })
  console.log('\n════════', query, '════════')
  for (const r of res) {
    console.log('-', (r.name || '').slice(0, 90))
    console.log(' ', (r.url || '').slice(0, 110))
    console.log(' ', (r.snippet || '').slice(0, 220).replace(/\n/g, ' '))
  }
}

await q('Square for Restaurants release notes Vol 16 winter 2026')
await q('Square for Restaurants "Vol 16" what\'s new December 2026')
await q('Toast restaurant POS new features announcement November December 2026')
await q('Lightspeed Restaurant K-Series What\'s New December 2026')
