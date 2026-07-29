// ─── Columns as an auto-layout ────────────────────────────────────────────────
// Shared by the mapping stage, the validator and the fixtures — kept free of any Next.js
// path alias so it compiles standalone (same reason lib/coverage.ts exists).

import type { Slide } from './types'

// Just the parts of a source sheet that describe its columns.
export type SourceColumns = { texts: string[]; columns?: (number | null)[] }

// How many real columns this source sheet has. Counts distinct column tags (assigned by
// fetch-doc from the boxes' horizontal placement), but only among fragments carrying
// substantial text — a one-word label or a stray caption sitting beside a paragraph is
// placement noise, not a column, and must not turn into a false FAIL.
const _COL_MIN_CHARS = 40
export function countSourceColumns(source: SourceColumns): number {
  const cols = new Set<number>()
  source.texts.forEach((t, i) => {
    const col = source.columns?.[i]
    if (col === null || col === undefined) return
    if (t.trim().length < _COL_MIN_CHARS) return
    cols.add(col)
  })
  return cols.size
}

// How many distinct columns this slide actually carries: filled КОЛОНКА_n / КАРТКА_n.
function countCarriedColumns(slots: Record<string, string>): number {
  const idx = new Set<string>()
  for (const [name, value] of Object.entries(slots)) {
    if (!value?.trim()) continue
    const m = name.match(/^(?:КОЛОНКА|КАРТКА)_(\d+)/)
    if (m) idx.add(m[1])
  }
  return idx.size
}

// Columns behave like a Figma auto-layout: 2–4 of them, width derived from the count.
// Only columns_flex was ever built that way — every other column layout has its slot
// count frozen into the master, so a sheet with more columns than the chosen layout has
// slots had nowhere to put the rest and arrived merged (three source columns rendered as
// two). columns_flex is the carrier of last resort: it creates exactly as many columns as
// the sheet has, so content is never squeezed into fewer places than it came in.
//
// Rebuilt from the SOURCE fragments and their column tags, not from the merged slots —
// once the mapping has joined two columns into one string there is no reliable way to
// split them again.
export function applyColumnCapacityFallback(slide: Slide, source: SourceColumns, slideNum: number): Slide {
  const want = slide.sourceColumns ?? 0
  if (want < 2 || want > 4) return slide
  if (countCarriedColumns(slide.slots) >= want) return slide

  // Group the sheet's fragments by their column tag, keeping source order inside a column.
  const byColumn = new Map<number, string[]>()
  const untagged: string[] = []
  source.texts.forEach((text, i) => {
    if (!text.trim()) return
    const col = source.columns?.[i]
    if (col === null || col === undefined) { untagged.push(text); return }
    if (!byColumn.has(col)) byColumn.set(col, [])
    byColumn.get(col)!.push(text)
  })
  const columns = [...byColumn.keys()].sort((a, b) => a - b).map(k => byColumn.get(k)!.join('\n'))
  if (columns.length < 2 || columns.length > 4) return slide

  // The title keeps whatever the LLM chose; anything else left untagged (a note under the
  // columns, say) is appended to the last column rather than dropped — the deck-level
  // coverage net exists for real losses, not for content we can still place.
  const title = slide.slots['ЗАГОЛОВОК']?.trim()
    || untagged.slice().sort((a, b) => a.length - b.length)[0]
    || ''
  const leftovers = untagged.filter(t => t !== title)
  if (leftovers.length) columns[columns.length - 1] += '\n' + leftovers.join('\n')

  const slots: Record<string, string> = { ЗАГОЛОВОК: title }
  columns.forEach((text, i) => { slots[`КОЛОНКА_${i + 1}`] = text })

  console.warn(
    `[column-capacity] slide ${slideNum}: ${slide.composition} carried ` +
    `${countCarriedColumns(slide.slots)} of ${want} source columns → columns_flex (${columns.length})`,
  )
  return { ...slide, composition: 'columns_flex', slots }
}

// A sheet's heading belongs on the slide built from that sheet. The prompt forbids
// repeating a ЗАГОЛОВОК on adjacent slides, and when a brief legitimately reuses one
// ("Цільові групи" on two sheets in a row) the model obeyed the ban by dropping the title
// altogether — the slide came out headless. The ban is about inventing repetition, not
// about erasing what the source says, so the heading is put back deterministically.
export function applyTitleFallback(
  slide: Slide,
  source: SourceColumns,
  titleMaxChars = 80,
): Slide {
  if ((slide.slots['ЗАГОЛОВОК'] ?? '').trim()) return slide
  const first = (source.texts[0] ?? '').trim()
  if (!first || first.includes('\n') || first.length > titleMaxChars) return slide
  const used = Object.values(slide.slots).some(v => (v ?? '').includes(first))
  if (used) return slide
  return { ...slide, slots: { ...slide.slots, ЗАГОЛОВОК: first } }
}
