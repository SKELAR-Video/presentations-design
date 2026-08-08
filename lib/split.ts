import type { Slide } from './types'
import type { SlideOverload } from './validator'

// ─── Splitting an overloaded sheet across slides ──────────────────────────────
// The one repair that loses nothing. When a sheet holds more text than fits at a readable
// size, exactly one of three things has to give (docs/rules/typography.md): the sheet-per-
// slide rule, the words, or the type size. Splitting gives up the first — every word stays,
// every word stays readable, there are simply more slides.
//
// Deterministic on purpose, per docs/rules/content-mapping.md: no model is asked anything
// here. The items are already known and the capacity was already measured from the finished
// file, so this is packing, not authoring. That also makes it repeatable — the same slide
// splits the same way every time, which is what lets a person undo it by regenerating.
//
// Only ever called on an explicit human decision. Nothing in the generator reaches for this
// on its own.

const NUMBERED = /_(\d+)$/

// A row of cards is a row. Two cards split into one and one are two slides that each look
// like a mistake, so a sheet is only dealt across parts when every part keeps a real row.
const MIN_CARDS_PER_PART = 2
const MIN_CARDS_TO_SPLIT = MIN_CARDS_PER_PART * 2

// Slots that are not the content being divided: they identify the sheet rather than carry
// its body. The title rides along on every part (unnumbered — a reader should not be told
// they are looking at "3/5 of a thought"); the subtitle introduces the sheet once and would
// only repeat itself.
const TITLE_SLOT = 'ЗАГОЛОВОК'
const INTRO_SLOTS = new Set(['ПІДЗАГОЛОВОК', 'ПІДЗАГОЛОВК', 'ОПИС'])

export type SplitResult = {
  slides: Slide[]
  strategy: 'cards' | 'lines'
  note: string
}

// Cut a list of items into `parts` groups of roughly equal weight, never cutting an item.
// Balanced by length rather than by count because four one-word bullets and one paragraph
// are not two halves of anything.
function balancedGroups<T>(items: T[], parts: number, weight: (item: T) => number): T[][] {
  const n = Math.max(1, Math.min(parts, items.length))
  if (n === 1) return [items]

  const total = items.reduce((sum, it) => sum + weight(it), 0)
  const groups: T[][] = []
  let current: T[] = []
  let acc = 0

  for (let i = 0; i < items.length; i++) {
    current.push(items[i])
    acc += weight(items[i])
    const groupsLeft = n - groups.length - 1
    const itemsLeft  = items.length - i - 1
    // Close the group once it has reached its share — unless the remaining items are only
    // just enough to give every later group something. An empty group is a blank slide.
    const reachedShare = acc >= (total * (groups.length + 1)) / n
    if (groupsLeft > 0 && (reachedShare || itemsLeft === groupsLeft)) {
      groups.push(current)
      current = []
    }
  }
  if (current.length) groups.push(current)
  return groups
}

// Strategy A — the sheet already came in pieces (columns, cards). Deal those pieces across
// the parts and let the generator do the rest: it already downgrades a composition to match
// the number of filled cards, so three cards on a four-card layout become a three-card
// layout without anything here knowing the composition table. Fewer cards per slide also
// means wider cards, which is what buys back the height.
function splitByCards(slide: Slide, parts: number): SplitResult | null {
  const numbered = Object.keys(slide.slots)
    .filter(k => NUMBERED.test(k) && slide.slots[k]?.trim())
    .sort((a, b) => Number(a.match(NUMBERED)![1]) - Number(b.match(NUMBERED)![1]))

  // Fewer than four cards cannot be dealt into parts without leaving a part holding one.
  // A single card on a layout built for a row reads as a mistake — the first real run split
  // ten such sheets and the person's word for the result was "купа пустих слайдів".
  // Below four, splitting is refused so the panel offers shortening instead, which is the
  // repair that actually helps a short row.
  if (numbered.length < MIN_CARDS_TO_SPLIT) return null

  // Capped so no part ends up with a single card, whatever the measurement asked for.
  const maxParts = Math.floor(numbered.length / MIN_CARDS_PER_PART)
  const groups = balancedGroups(numbered, Math.min(parts, maxParts), k => slide.slots[k].length)
  if (groups.length < 2 || groups.some(g => g.length < MIN_CARDS_PER_PART)) return null

  const slides = groups.map((group, gi) => {
    const slots: Record<string, string> = {}
    if (slide.slots[TITLE_SLOT]) slots[TITLE_SLOT] = slide.slots[TITLE_SLOT]
    for (const key of Object.keys(slide.slots)) {
      if (NUMBERED.test(key) || key === TITLE_SLOT) continue
      // Everything that is neither title nor card — subtitle, image, note. Introductions
      // belong to the first part only; anything else is carried along unchanged.
      if (INTRO_SLOTS.has(key) && gi > 0) continue
      slots[key] = slide.slots[key]
    }
    // Renumbered from 1 inside each part: the master has no КОЛОНКА_4 token on a two-card
    // layout, and a slot the master cannot place is a slot whose text disappears.
    group.forEach((key, idx) => {
      const prefix = key.replace(NUMBERED, '')
      slots[`${prefix}_${idx + 1}`] = slide.slots[key]
    })
    return { ...slide, id: `${slide.id}__${gi + 1}`, slots }
  })

  return {
    slides,
    strategy: 'cards',
    note: `${numbered.length} карток → ${groups.map(g => g.length).join(' + ')}`,
  }
}

// Strategy B — one body of text. Divided on line boundaries, which in these briefs are the
// list items and paragraphs; a split inside a sentence would be a rewrite, and rewriting is
// the one thing this repair promises not to do.
function splitByLines(slide: Slide, parts: number, slotName: string): SplitResult | null {
  const text = slide.slots[slotName] ?? ''
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 2) return null

  const groups = balancedGroups(lines, parts, l => l.length)
  if (groups.length < 2) return null

  const slides = groups.map((group, gi) => {
    const slots: Record<string, string> = { ...slide.slots }
    slots[slotName] = group.join('\n')
    for (const key of Object.keys(slots)) {
      if (INTRO_SLOTS.has(key) && gi > 0) delete slots[key]
    }
    return { ...slide, id: `${slide.id}__${gi + 1}`, slots }
  })

  return {
    slides,
    strategy: 'lines',
    note: `${lines.length} рядків → ${groups.map(g => g.length).join(' + ')}`,
  }
}

// The number of parts comes from the measurement of the real file, but it is a starting
// point, not a promise: once the cards are dealt the boxes are different boxes, so the true
// answer is only known after the deck is rebuilt and measured again. That is the intended
// shape of this loop — measure, act, measure — rather than a formula that predicts the
// outcome and is believed without checking.
export function splitSlide(slide: Slide, overload: SlideOverload): SplitResult | null {
  const parts = Math.max(2, overload.slidesNeeded)

  const byCards = splitByCards(slide, parts)
  if (byCards) return byCards

  // Line-splitting copies every other slot onto every part, which is right for a sheet whose
  // body is one block and wrong for a row of cards: the untouched cards would be duplicated
  // onto each part. So once a sheet has a row, cards are the only way it may be divided —
  // and if the row is too short for that, it is not divided at all.
  const cardCount = Object.keys(slide.slots)
    .filter(k => NUMBERED.test(k) && slide.slots[k]?.trim()).length
  if (cardCount > 1) return null

  // Widest overloaded slot first — with a single body slot there is normally just one.
  const target = [...overload.slots].sort((a, b) => b.neededPx - a.neededPx)[0]
  if (!target) return null
  return splitByLines(slide, parts, target.slot)
}

// Applies the chosen splits to a whole plan, in one pass, keeping slide order.
// Parts of one sheet are tied together by `splitGroup` so the checks that care about
// repetition — no_duplicate_title above all — can tell a deliberate split from the model
// accidentally heading two different sheets the same way.
export type Decision = 'split' | 'shorten' | 'keep'

export function applySplits(
  slides: Slide[],
  overloads: SlideOverload[],
  decisions: Map<number, Decision>,
): { slides: Slide[]; notes: string[] } {
  const byIndex = new Map(overloads.map(o => [o.slideIndex, o]))
  const out: Slide[] = []
  const notes: string[] = []

  slides.forEach((slide, i) => {
    const decision = decisions.get(i)
    // Not offered, or already handled elsewhere. Shortening happens before this runs and
    // rewrites the slot in place, so those slides need nothing here — least of all a
    // keepSmall marker, which would silence the next measurement of a slide that was just
    // rewritten precisely so it could be measured again.
    if (!decision || decision === 'shorten') { out.push(slide); return }

    if (decision === 'keep') {
      // Offered and declined. Recorded on the slide so the rebuild does not report the
      // answer back as a fresh problem and ask again.
      out.push({ ...slide, keepSmall: true })
      return
    }

    const overload = byIndex.get(i)
    if (!overload) { out.push(slide); return }
    const result = splitSlide(slide, overload)
    if (!result) {
      // Nothing divisible on this slide — a single unbroken paragraph, or one card. Kept
      // whole rather than cut mid-sentence, and said out loud instead of silently ignored.
      // Not marked as accepted: the person asked for a repair and did not get one, so the
      // question is still open and should be asked again.
      notes.push(`слайд ${i + 1}: нема на чому ділити, лишено як є`)
      out.push(slide)
      return
    }
    const group = `split_${i}`
    // keepSmall is cleared on the parts: these are new slides with new boxes, and an answer
    // given about the slide they came from was not given about them.
    out.push(...result.slides.map(s => ({ ...s, splitGroup: group, keepSmall: undefined })))
    notes.push(`слайд ${i + 1}: ${result.note}`)
  })

  return { slides: out, notes }
}
