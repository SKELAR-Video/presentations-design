#!/usr/bin/env node
// One-off helper (not part of the app) — downloads PNG thumbnails for every slide of a
// deck via /api/thumbnails, so slides can be visually reviewed as images.
// Usage: node scripts/fetch-thumbnails.js <deckId> [outDir]
// Reuses the same INSPECT_DECK_COOKIE from .env.local as scripts/check-deck.js.

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
  const deckId = process.argv[2]
  const outDir = process.argv[3] || path.join(__dirname, '.thumbnails')
  if (!deckId) {
    console.error('Usage: node scripts/fetch-thumbnails.js <deckId> [outDir]')
    process.exit(1)
  }
  const cookie = process.env.INSPECT_DECK_COOKIE
  if (!cookie) {
    console.error('Set INSPECT_DECK_COOKIE in .env.local (see scripts/check-deck.js).')
    process.exit(1)
  }

  const res = await fetch(`${DEFAULT_BASE_URL}/api/thumbnails?deckId=${encodeURIComponent(deckId)}`, {
    headers: { Cookie: cookie },
  })
  const json = await res.json()
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`)

  fs.mkdirSync(outDir, { recursive: true })
  const paths = []
  for (const t of json.thumbnails) {
    const imgRes = await fetch(t.imageUrl)
    const buf = Buffer.from(await imgRes.arrayBuffer())
    const filePath = path.join(outDir, `slide-${String(t.index + 1).padStart(2, '0')}.png`)
    fs.writeFileSync(filePath, buf)
    paths.push(filePath)
  }
  console.log(paths.join('\n'))
}

main().catch(err => {
  console.error('Error:', err.message || err)
  process.exit(1)
})
