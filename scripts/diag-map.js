#!/usr/bin/env node
// One-off diagnostic: runs the REAL production chain fetch-doc → map on a brief and
// reports, per slide, which source fragments never landed in any slot ("orphans").
// That orphan report is exactly the check the live pipeline is missing.
// Usage: node scripts/diag-map.js <urlOrId>

const fs = require('fs')
const path = require('path')
const DEFAULT_BASE_URL = 'https://presentations-design.vercel.app'

function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function norm(s) {
  return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

async function main() {
  loadEnvLocal()
  const arg = process.argv[2]
  if (!arg) { console.error('Usage: node scripts/diag-map.js <urlOrId>'); process.exit(1) }
  const url = arg.startsWith('http') ? arg : `https://docs.google.com/presentation/d/${arg}/edit`
  const cookie = process.env.INSPECT_DECK_COOKIE
  if (!cookie) { console.error('Set INSPECT_DECK_COOKIE in .env.local'); process.exit(1) }
  const H = { 'Content-Type': 'application/json', Cookie: cookie }

  const fd = await (await fetch(`${DEFAULT_BASE_URL}/api/fetch-doc`, {
    method: 'POST', headers: H, body: JSON.stringify({ url }),
  })).json()
  if (fd.error) throw new Error('fetch-doc: ' + fd.error)
  if (fd.type !== 'gslides') throw new Error('not a gslides brief — type=' + fd.type)

  const mp = await (await fetch(`${DEFAULT_BASE_URL}/api/map`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ mode: '1to1', slides: fd.slides, theme: 'dark' }),
  })).json()
  if (mp.error) throw new Error('map: ' + mp.error)

  let lostSlides = 0, lostLines = 0
  mp.plan.slides.forEach((slide, i) => {
    const src = fd.slides[i] || { texts: [] }
    const slotBlob = norm(Object.values(slide.slots).join(' \n '))
    // every non-empty LINE of every source fragment should appear somewhere in the slots
    const orphanLines = []
    src.texts.forEach((frag) => {
      frag.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        if (!slotBlob.includes(norm(line))) orphanLines.push(line)
      })
    })
    const srcLines = src.texts.reduce((n, t) => n + t.split('\n').filter(l => l.trim()).length, 0)
    const flag = orphanLines.length ? '  ❌ CONTENT LOST' : '  ✅'
    console.log(`--- slide ${i + 1} [${slide.composition}] src_lines=${srcLines} slots=${Object.keys(slide.slots).join(',') || '(none)'} orphan_lines=${orphanLines.length}${flag}`)
    if (orphanLines.length) {
      lostSlides++; lostLines += orphanLines.length
      orphanLines.slice(0, 12).forEach(l => console.log(`      LOST: ${JSON.stringify(l.slice(0, 90))}`))
    }
  })
  console.log(`\n=== TOTAL: ${lostSlides}/${mp.plan.slides.length} slides lose content, ${lostLines} source lines dropped ===`)
  fs.writeFileSync(path.join(__dirname, '.last-plan.json'), JSON.stringify(mp.plan, null, 2))
  console.log('plan saved → scripts/.last-plan.json')
}

main().catch(err => { console.error('Error:', err.message || err); process.exit(1) })
