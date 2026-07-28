// Zero-content-loss primitives, shared by the mapping stage (lib/anthropic.ts), the deck
// validator (lib/validator.ts) and the fixture tests (scripts/validate-fixture.ts) so all
// three answer "did this brief line survive?" the same way.
//
// Kept dependency-light on purpose: types + compositions only, no SDK clients, so the
// fixture suite can compile and run it standalone.

import { PHASE0_COMPOSITIONS } from './compositions'
import type { Slide } from './types'

// Loose containment used to decide whether a source line survived into a slot.
// The render stage rewrites slot text in known ways (NBSP, \v soft line breaks,
// colon→em-dash, stripped trailing period, casing) — none of those are content loss.
export function looseNorm(s: string): string {
  return (s ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u000B/g, ' ')
    .replace(/ \u2014 /g, ': ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\u2026]+$/, '')
    .toLowerCase()
}

// Brief lines of this slide that appear in none of its slots — content about to vanish.
export function missingSourceLines(slide: Slide, lines: string[]): string[] {
  const blob = looseNorm(Object.values(slide.slots).join('\n'))
  return lines.filter(l => !blob.includes(looseNorm(l)))
}

// Last line of defence against silent content loss: rebuild the slide so every brief line
// is present. Prefers the composition's own body slot (a closing keeps looking like a
// closing); downgrades to title_body only when there is no body slot or the text
// physically exceeds that slot's limit.
export function applyCoverageFallback(slide: Slide, lines: string[], slideNum = 0): void {
  if (lines.length === 0) return
  const title = lines[0]
  const body  = lines.slice(1).join('\n')
  const own   = PHASE0_COMPOSITIONS.find(c => c.id === slide.composition)
  const ownBody = own?.slots.find(s =>
    s.type === 'text' && (s.name === 'ПІДЗАГОЛОВОК' || s.name === 'ТЕКСТ'))

  if (ownBody && body.length <= (ownBody.max_chars ?? Infinity)) {
    slide.slots = { 'ЗАГОЛОВОК': title }
    if (body) slide.slots[ownBody.name] = body
    console.warn(`[coverage-fallback] slide ${slideNum}: kept ${slide.composition}, ${lines.length} lines → ЗАГОЛОВОК + ${ownBody.name}`)
  } else {
    slide.composition = 'title_body'
    slide.slots = { 'ЗАГОЛОВОК': title }
    if (body) slide.slots['ТЕКСТ'] = body
    console.warn(`[coverage-fallback] slide ${slideNum}: downgraded to title_body, preserved ${lines.length} lines`)
  }
}
