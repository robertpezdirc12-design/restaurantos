#!/usr/bin/env bun
/** Branje Square release notes strani — ali je Vol 16 že ven? */
import ZAI from 'z-ai-web-dev-sdk'

const zai = await ZAI.create()
const r = await zai.functions.invoke('page_reader', { url: 'https://squareup.com/us/en/release-notes' })
const text = typeof r === 'string' ? r : (r.content || r.text || JSON.stringify(r).slice(0, 200))
console.log(String(text).slice(0, 3500))
