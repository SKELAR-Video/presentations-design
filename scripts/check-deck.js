#!/usr/bin/env node
// Compares lib/validator.ts's checks (max_chars, bento_layout, bounds, ...) between
// the last deck you checked and a new one — same report the /result page shows at
// generation time, re-run post-hoc via /api/revalidate-deck (reconstructs the plan
// from each slide's ##SLOTS## speaker-notes, no need to re-supply the brief).
//
// Usage:
//   npm run check-deck -- <deckId> [baseUrl]
//
// One-time setup — the endpoint is behind your Google login, so the script needs
// your session cookie to call it on your behalf:
//   1. Open the app in your browser, logged in.
//   2. DevTools → Network tab → reload → click any request to the app.
//   3. Headers → Request Headers → copy the FULL "cookie" value.
//   4. Add to .env.local (create the file if it doesn't exist):
//        INSPECT_DECK_COOKIE="paste the whole cookie string here"
//   Never paste that value anywhere else — it's your live login session.
//
// Plain Node (no ts-node/tsx) — nothing extra to install, works with the Node
// version this repo already targets (fetch is built in since Node 18).

const fs = require('fs')
const path = require('path')

const SNAPSHOT_PATH = path.join(__dirname, '.last-inspect-snapshot.json')
const DEFAULT_BASE_URL = 'https://presentations-design.vercel.app'

// ─── tiny .env.local loader (no dotenv dependency) ─────────────────────────────
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

function slideKey(slide) {
  return `${slide.slideIndex}:${slide.composition}`
}

function flatten(deckId, validation) {
  const checks = []
  for (const slide of validation.slides) {
    const key = slideKey(slide)
    for (const c of slide.checks) {
      checks.push({
        key, slideIndex: slide.slideIndex, composition: slide.composition,
        check: c.check, pass: c.pass, detail: c.detail ?? '',
      })
    }
  }
  return { deckId, fetchedAt: new Date().toISOString(), checks }
}

async function fetchValidation(deckId, baseUrl, cookie) {
  const url = `${baseUrl}/api/revalidate-deck?id=${encodeURIComponent(deckId)}`
  const res = await fetch(url, { headers: { Cookie: cookie } })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 300)}`) }
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json.validation
}

function loadPrevious() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8')) } catch { return null }
}

function saveSnapshot(snap) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2))
}

function fingerprint(c) {
  return `${c.key}::${c.check}`
}

function printReport(prev, curr) {
  const prevMap = new Map((prev ? prev.checks : []).map(c => [fingerprint(c), c]))

  const resolved = []
  const fresh = []
  const stillBroken = []

  for (const c of curr.checks) {
    const before = prevMap.get(fingerprint(c))
    if (c.pass) {
      if (before && !before.pass) resolved.push(c)
    } else {
      if (!before || before.pass) fresh.push(c)
      else stillBroken.push({ before, after: c })
    }
  }

  console.log(`\n=== ${prev ? prev.deckId : '(немає попереднього прогону)'}  →  ${curr.deckId} ===`)

  console.log(`\n✅ Вирішено (${resolved.length})`)
  for (const c of resolved) {
    console.log(`  Slide ${c.slideIndex} [${c.composition}] ${c.check} → PASS`)
  }
  if (resolved.length === 0) console.log('  (нічого)')

  console.log(`\n🆕 Нове (${fresh.length})`)
  for (const c of fresh) {
    console.log(`  Slide ${c.slideIndex} [${c.composition}] ${c.check}: ${c.detail}`)
  }
  if (fresh.length === 0) console.log('  (нічого)')

  console.log(`\n🟡 Досі не виправлено (${stillBroken.length})`)
  for (const { before, after } of stillBroken) {
    const same = before.detail === after.detail
    console.log(`  Slide ${after.slideIndex} [${after.composition}] ${after.check}`)
    console.log(`    було:   ${before.detail}`)
    console.log(`    зараз:  ${after.detail}${same ? '  (без змін)' : ''}`)
  }
  if (stillBroken.length === 0) console.log('  (нічого)')

  const totalFails = curr.checks.filter(c => !c.pass).length
  console.log(`\n— Разом FAIL зараз: ${totalFails} —\n`)
}

async function main() {
  loadEnvLocal()

  const deckId = process.argv[2]
  const baseUrl = process.argv[3] || DEFAULT_BASE_URL
  if (!deckId) {
    console.error('Usage: npm run check-deck -- <deckId> [baseUrl]')
    process.exit(1)
  }

  const cookie = process.env.INSPECT_DECK_COOKIE
  if (!cookie) {
    console.error(
      'Set INSPECT_DECK_COOKIE in .env.local — see the comment at the top of scripts/check-deck.js for how to grab it from your browser.',
    )
    process.exit(1)
  }

  const validation = await fetchValidation(deckId, baseUrl, cookie)
  const curr = flatten(deckId, validation)
  const prev = loadPrevious()

  printReport(prev, curr)
  saveSnapshot(curr)
}

main().catch(err => {
  console.error('Error:', err.message || err)
  process.exit(1)
})
