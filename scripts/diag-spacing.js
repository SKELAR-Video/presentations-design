#!/usr/bin/env node
// Prints the paragraph-spacing facts of one slide straight from the generated file, so
// the "90% inside a sentence / +0.5 line between sentences" rule can be checked against
// the deck instead of against the code that was supposed to write it.
//
// Usage:
//   node scripts/diag-spacing.js <deckId> [slideNumber]      (slideNumber is 1-based)
//   node scripts/diag-spacing.js <deckId> all                (every slide, summary only)
//
// Needs INSPECT_DECK_COOKIE in .env.local — same session cookie check-deck.js uses.

const fs = require('fs')
const path = require('path')

const DEFAULT_BASE_URL = 'https://presentations-design.vercel.app'

function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!process.env[m[1]]) process.env[m[1]] = v
  }
}

// Visible stand-ins so a soft line break can never be mistaken for a paragraph break.
function show(s, max = 70) {
  const t = s.replace(/\v/g, '⏎v').replace(/ /g, '·').replace(/\n/g, '⏎n')
  return t.length > max ? t.slice(0, max) + '…' : t
}

function fmt(n, unit) {
  return n === null || n === undefined ? '—' : `${n}${unit}`
}

async function main() {
  loadEnvLocal()
  const [deckId, slideArg] = process.argv.slice(2)
  if (!deckId) {
    console.error('Usage: node scripts/diag-spacing.js <deckId> [slideNumber|all]')
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

  if (slides.length && slides[0].textBoxes?.[0]?.paragraph_facts === undefined) {
    console.error('This deployment of inspect-deck does not return paragraph_facts yet.')
    process.exit(1)
  }

  const wanted = slideArg === 'all'
    ? slides
    : [slides[(parseInt(slideArg, 10) || 2) - 1]].filter(Boolean)

  for (const s of wanted) {
    const comp = s.content_check?.composition ?? '?'
    console.log(`\n══ slide #${s.slideIndex + 1}  composition=${comp} ══`)
    for (const tb of s.textBoxes) {
      const facts = tb.paragraph_facts ?? []
      if (!facts.length) continue
      const softTotal = facts.reduce((n, f) => n + f.soft_breaks, 0)
      console.log(
        `\n  box ${tb.objectId}  ${Math.round(tb.w)}×${Math.round(tb.h)}px  ` +
        `font=${tb.fontSize_pt ?? '—'}pt  all_fonts=[${(tb.all_fontSizes_pt ?? []).join(',')}]  ` +
        `paragraphs=${tb.paragraph_count}  soft_breaks(\\v)=${softTotal}`
      )
      for (const f of facts) {
        console.log(
          `    p${f.index}  lineSpacing=${fmt(f.lineSpacing_pct, '%')}  ` +
          `spaceAbove=${fmt(f.spaceAbove_pt, 'pt')}  spaceBelow=${fmt(f.spaceBelow_pt, 'pt')}  ` +
          `chars=${f.chars}  \\v=${f.soft_breaks}`
        )
        console.log(`         "${show(f.text)}"`)
      }
      // The verdict the rule is actually about: is a break between two items spaced
      // differently from a wrapped line inside one sentence?
      const pt = tb.fontSize_pt
      const ls = facts[0]?.lineSpacing_pct
      const sb = facts[0]?.spaceBelow_pt
      if (facts.length > 1 && pt && ls != null) {
        const insideLines = (ls / 100).toFixed(2)
        const betweenLines = ((ls / 100) + (sb ?? 0) / pt).toFixed(2)
        const verdict = (sb ?? 0) > 0 ? 'DIFFERENT ✅' : 'SAME ❌ (reads as one canvas)'
        console.log(
          `    → inside a sentence = ${insideLines} line | between items = ${betweenLines} line → ${verdict}`
        )
      } else if (softTotal > 0) {
        console.log(
          `    → ${softTotal} item break(s) live INSIDE one paragraph (\\v): ` +
          `spaceBelow cannot apply → SAME as a wrapped line ❌`
        )
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
