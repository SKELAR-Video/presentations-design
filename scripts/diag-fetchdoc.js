#!/usr/bin/env node
// Calls the REAL /api/fetch-doc extraction (extractSlides/extractElementBlocks — the
// same code path production uses) so we see exactly what the mapping stage was given,
// instead of a simplified/incomplete re-read. Usage: node scripts/diag-fetchdoc.js <urlOrId>
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

async function main() {
  loadEnvLocal()
  const arg = process.argv[2]
  if (!arg) { console.error('Usage: node scripts/diag-fetchdoc.js <urlOrId>'); process.exit(1) }
  const url = arg.startsWith('http') ? arg : `https://docs.google.com/presentation/d/${arg}/edit`
  const cookie = process.env.INSPECT_DECK_COOKIE
  if (!cookie) { console.error('Set INSPECT_DECK_COOKIE in .env.local'); process.exit(1) }

  const res = await fetch(`${DEFAULT_BASE_URL}/api/fetch-doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ url }),
  })
  const json = await res.json()
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`)

  if (json.type === 'gslides' && json.slides) {
    json.slides.forEach((s, i) => {
      console.log(`--- slide ${i + 1} (${s.texts.length} fragments) ---`)
      s.texts.forEach((t, ti) => {
        const col = s.columns?.[ti]
        const colTag = col !== null && col !== undefined ? ` (колонка ${col + 1})` : ''
        console.log(`  [${ti}]${colTag} ${JSON.stringify(t)}`)
      })
    })
  } else {
    console.log(json.text)
  }
}

main().catch(err => { console.error('Error:', err.message || err); process.exit(1) })
