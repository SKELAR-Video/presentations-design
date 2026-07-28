#!/usr/bin/env node
// Why is THIS box at THIS font size? Takes the text and the box straight out of the
// generated file, measures them with the shared ruler (lib/textfit.ts), and prints what
// the font search would answer for every candidate pt — so "the font is too small" can be
// traced to a number instead of a guess.
//
// Usage:
//   node scripts/diag-fit.js <deckId> <slideNumber>        (1-based)
//
// Needs INSPECT_DECK_COOKIE in .env.local — same session cookie check-deck.js uses.

const fs = require('fs')
const path = require('path')

const DEFAULT_BASE_URL = 'https://presentations-design.vercel.app'
const INSET = 19
const CHAR_W = 0.5, LINE_FACTOR = 1.1, GAP_EM = 0.5, FIT_MARGIN = 0.95
const WORD_CHAR_W = 0.65, WORD_SAFETY = 1.1

function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!process.env[m[1]]) process.env[m[1]] = v
  }
}

const px = pt => pt * 2.667

function wrappedLines(text, wPx, pt, charW = CHAR_W) {
  if (!text.trim()) return 0
  const cpl = Math.max(1, Math.floor(wPx / (px(pt) * charW)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) cur = w.length
    else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
    else { lines++; cur = w.length }
  }
  return lines
}

function renderedHeight(items, wPx, pt, listGaps) {
  let h = 0
  for (const t of items) {
    h += wrappedLines(t, wPx, pt) * px(pt) * LINE_FACTOR
    if (listGaps) h += px(Math.round(GAP_EM * pt * 10) / 10)
  }
  return h
}

function longestWordPx(items, pt) {
  const words = items.join(' ').split(/\s+/).filter(Boolean)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
  return words.length ? Math.max(...words.map(w => w.length)) * px(pt) * WORD_CHAR_W : 0
}

async function main() {
  loadEnvLocal()
  const [deckId, slideArg] = process.argv.slice(2)
  if (!deckId || !slideArg) {
    console.error('Usage: node scripts/diag-fit.js <deckId> <slideNumber>')
    process.exit(1)
  }
  const cookie = process.env.INSPECT_DECK_COOKIE
  if (!cookie) {
    console.error('Missing INSPECT_DECK_COOKIE in .env.local — see scripts/check-deck.js header.')
    process.exit(1)
  }
  const base = process.env.INSPECT_BASE_URL || DEFAULT_BASE_URL
  const res = await fetch(`${base}/api/inspect-deck?id=${deckId}`, { headers: { cookie } })
  if (!res.ok) {
    console.error(`inspect-deck ${res.status}: ${(await res.text()).slice(0, 300)}`)
    process.exit(1)
  }
  const data = await res.json()
  const slides = data.slides ?? data
  const s = slides[parseInt(slideArg, 10) - 1]
  if (!s) { console.error(`no slide ${slideArg}`); process.exit(1) }

  console.log(`\n══ slide #${s.slideIndex + 1}  composition=${s.content_check?.composition ?? '?'} ══`)

  // Which box height would explain the font that was actually chosen? The search runs
  // against the composition's STATIC text area, which is not necessarily the box the
  // renderer ended up writing (a bento row shrinks to hug its content). Printing the
  // group pt for each candidate area turns "why 11pt?" into "it measured against 440px".
  {
    const boxes = s.textBoxes
      .map(tb => ({ tb, items: (tb.paragraph_facts ?? []).filter(f => f.text.trim()).map(f => f.text.replace(/\n$/, '')) }))
      .filter(b => b.items.length >= 2)
    if (boxes.length) {
      const innerW = Math.round(boxes[0].tb.w) - 2 * INSET
      // 440 = master flat-column area, 486/575 = grown labelled/plain area
      // (flatColumnsMaxH), 620 = bento row card, plus whatever the file actually has.
      const areas = [...new Set([440, 486, 575, 620, Math.round(boxes[0].tb.h) - 2 * INSET])].sort((a, b) => a - b)
      console.log(`\n  group pt vs assumed text area (width ${innerW}px, ${boxes.length} boxes, floor 10):`)
      for (const h of areas) {
        let group = 28
        for (const b of boxes) {
          let cardPt = 10
          for (let p = 28; p >= 10; p--) {
            if (renderedHeight(b.items, innerW, p, true) <= h * FIT_MARGIN &&
                longestWordPx(b.items, p) * WORD_SAFETY <= innerW) { cardPt = p; break }
          }
          group = Math.min(group, cardPt)
        }
        console.log(`    area ${String(h).padStart(3)}px (usable ${String(Math.round(h * FIT_MARGIN)).padStart(3)}) → group ${group}pt`)
      }
    }
  }

  for (const tb of s.textBoxes) {
    const facts = (tb.paragraph_facts ?? []).filter(f => f.text.trim())
    if (facts.length < 2) continue
    const items  = facts.map(f => f.text.replace(/\n$/, ''))
    const innerW = Math.round(tb.w) - 2 * INSET
    const innerH = Math.round(tb.h) - 2 * INSET
    const pt     = tb.fontSize_pt
    console.log(
      `\n  box ${tb.objectId}  inner ${innerW}×${innerH}px  font=${pt}pt ` +
      `all_fonts=[${(tb.all_fontSizes_pt ?? []).join(',')}]  items=${items.length}`,
    )
    console.log(`  pt | text_h | usable (${Math.round(innerH * FIT_MARGIN)}) | word_fit | verdict`)
    for (let p = 10; p <= 28; p++) {
      const h = Math.round(renderedHeight(items, innerW, p, true))
      const wOk = longestWordPx(items, p) * WORD_SAFETY <= innerW
      const hOk = h <= innerH * FIT_MARGIN
      const mark = (hOk && wOk) ? 'fits' : (!wOk ? 'WORD too wide' : 'too tall')
      const cur  = p === pt ? '   ← chosen' : ''
      console.log(`  ${String(p).padStart(2)} | ${String(h).padStart(6)} | ${hOk ? '  ok  ' : ' over '} | ${wOk ? '  ok  ' : ' over '} | ${mark}${cur}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
