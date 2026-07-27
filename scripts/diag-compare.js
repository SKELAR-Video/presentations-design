#!/usr/bin/env node
// One-off diagnostic: dumps raw source-slide text (from the brief) side by side with
// the generated deck's stored ##SLOTS## plan, so missing/dropped content is visible
// directly instead of guessed at. Not a permanent tool.
// Usage: node scripts/diag-compare.js <sourceDeckId> <generatedDeckId>

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
  const [sourceId, genId] = process.argv.slice(2)
  if (!sourceId || !genId) {
    console.error('Usage: node scripts/diag-compare.js <sourceDeckId> <generatedDeckId>')
    process.exit(1)
  }
  const cookie = process.env.INSPECT_DECK_COOKIE
  if (!cookie) { console.error('Set INSPECT_DECK_COOKIE in .env.local'); process.exit(1) }

  const inspectRes = await fetch(`${DEFAULT_BASE_URL}/api/inspect-deck?id=${encodeURIComponent(genId)}`, { headers: { Cookie: cookie } })
  const inspect = await inspectRes.json()
  if (inspect.error) throw new Error('inspect-deck: ' + inspect.error)

  console.log('=== GENERATED DECK — parsed ##SLOTS## per slide ===')
  inspect.slides.forEach((s, i) => {
    const marker = '##SLOTS##\n'
    const idx = s.notes.indexOf(marker)
    let parsed = null
    if (idx >= 0) {
      const jsonStart = idx + marker.length
      const jsonEnd = s.notes.indexOf('\n', jsonStart)
      const raw = jsonEnd >= 0 ? s.notes.slice(jsonStart, jsonEnd) : s.notes.slice(jsonStart)
      try { parsed = JSON.parse(raw) } catch {}
    }
    console.log(`--- slide ${i + 1} [${parsed ? parsed.composition : '?'}] ---`)
    if (parsed) {
      for (const [k, v] of Object.entries(parsed.slots)) {
        console.log(`  ${k}: ${JSON.stringify(v.slice(0, 200))}`)
      }
    } else {
      console.log('  (no ##SLOTS## payload)')
    }
  })

  // Fetch source deck raw text per slide (whatever type it is — try slides API directly)
  console.log('\n=== SOURCE BRIEF — raw text per slide (via inspect-deck-style read) ===')
  const srcRes = await fetch(`${DEFAULT_BASE_URL}/api/inspect-deck?id=${encodeURIComponent(sourceId)}`, { headers: { Cookie: cookie } })
  const src = await srcRes.json()
  if (src.error) {
    console.log('(source is not a Slides deck inspect-deck can read, or error):', src.error)
  } else {
    src.slides.forEach((s, i) => {
      const texts = s.textBoxes.map(tb => tb.text).filter(Boolean)
      console.log(`--- source slide ${i + 1} ---`)
      texts.forEach(t => console.log('  ' + JSON.stringify(t.slice(0, 300))))
    })
  }
}

main().catch(err => { console.error('Error:', err.message || err); process.exit(1) })
