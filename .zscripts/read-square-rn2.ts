#!/usr/bin/env bun
import ZAI from 'z-ai-web-dev-sdk'
const zai = await ZAI.create()
const r: any = await zai.functions.invoke('page_reader', { url: 'https://squareup.com/us/en/release-notes' })
const d = r?.data ?? r
const content = d?.markdown ?? d?.content ?? d?.text ?? JSON.stringify(d)
// izlušči datume in naslove
const m = String(content)
console.log(m.slice(0, 6000))
