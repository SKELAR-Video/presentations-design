import type { slides_v1 } from 'googleapis'
import { getComposition } from './compositions'
import type { SlidePlan } from './types'
import { looseNorm as normLoose } from './coverage'
import { renderedHeight, renderedHeightUniform } from './textfit'

const _FPX   = 9144000 / 1920  // EMU per Figma px
const _SLIDE_W = 1920
const _SLIDE_H = 1080
const _BOUNDS_TOL = 4           // px — rounding slack
const _V_INSET = 19             // Google Slides' fixed inner padding; mirrors _INSET
const _V_OVERFLOW_TOL = 8       // px — rounding slack for text_overflow

// ─── Readable body size ──────────────────────────────────────────────────────
// See docs/rules/typography.md, "Читабельна підлога". Repeated here only as the numbers
// the check runs on; the reasoning lives in the rule, not in the code.
const _V_READABLE_PT   = 18     // the floor a body slot should reach
const _V_TOLERANCE     = 0.20   // below the floor by less than this — drawn, not reported
// Boxes that carry no reader-facing content and are legitimately small.
const _V_DECOR_ID = /^(vpill_|date_pill_|logo)/

export type CheckResult = {
  check: string
  pass: boolean
  detail?: string
}

export type SlideValidation = {
  slideIndex: number
  composition: string
  checks: CheckResult[]
  pass: boolean
}

// ─── Overload: the same finding as readable_font, in numbers instead of prose ──
// readable_font already knows everything needed to offer a person a choice — which slot,
// how short it fell, how many slides the text would need. It packed all of it into one
// English sentence, which is fine for a log and useless for anything else: an interface
// cannot lay out a sentence, and a splitter cannot divide by one.
//
// So the check now reports twice — the sentence for the diagnostics panel, these numbers
// for everyone else. Same measurement, taken once, from the finished file; there is no
// second estimate that could disagree with the first.
export type OverloadSlot = {
  slot: string          // slot name from the plan (ТЕКСТ, КАРТКА_2, …)
  pt: number            // size actually written into the file
  neededPx: number      // height this text needs at the readable floor
  availPx: number       // height the box actually has
  slidesNeeded: number  // how many slides the text would need, at the floor
  cutPct: number        // or how much of it would have to go, in one slide
}

export type SlideOverload = {
  slideIndex: number
  composition: string
  slots: OverloadSlot[]
  slidesNeeded: number  // the worst slot decides the slide
  // The person already saw this one and chose to keep the small type. Still measured and
  // still reported — a decision that vanishes from the screen is indistinguishable from one
  // that was never made — but it is no longer a question, and no longer a failure.
  accepted?: boolean
}

export type ValidationReport = {
  pass: boolean
  presentationId: string
  slides: SlideValidation[]
  summary: string
  // Slides where a human has a decision to make. Empty on a healthy deck — which is the
  // signal the result page uses to stay quiet.
  overloads: SlideOverload[]
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function rPx(mag: number | null | undefined, scale: number | null | undefined): number {
  return ((mag ?? 0) * (scale ?? 1)) / _FPX
}

function elBounds(el: slides_v1.Schema$PageElement) {
  const t = el.transform!
  const s = el.size!
  const x = (t.translateX ?? 0) / _FPX
  const y = (t.translateY ?? 0) / _FPX
  const w = rPx(s.width?.magnitude, t.scaleX)
  const h = rPx(s.height?.magnitude, t.scaleY)
  return { x, y, w, h, right: x + w, bottom: y + h }
}

// ─── text_overflow ────────────────────────────────────────────────────────────
// Reads the FINISHED file: how tall is the text that was actually written, versus the box
// it was written into. Nothing else checked this — max_chars caps characters, bounds
// checks the box, bento_layout works off the plan — so text spilling out of its card (and
// off the slide) was machine-invisible and reached production twice.
//
// Measured with lib/textfit.ts — the same ruler the generator picks fonts with, applied to
// the per-paragraph sizes and spaceBelow values actually recorded in the file. The only
// difference is the slack: the generator stops at FIT_MARGIN of the box, this asks the bare
// question "does it spill on screen". So a pass here means the two agreed, not that two
// similar formulas happened to land close. The defects it exists to catch were +132px,
// +77px and +57px — all far outside the tolerance.
//
// Scope: boxes holding 2+ paragraphs. Single-paragraph boxes (titles) are governed by the
// word-fit and fixed-height rules and would only add noise here.
// Is the body text big enough to read? text_overflow already asks whether the text stays
// inside its box — but a box always "fits" if the font is allowed to shrink far enough, so
// that check alone reports a wall of 10pt type as healthy. This one asks the question the
// audience asks.
//
// Reported per slide with the number of slides the content would need, and the share that
// would have to go, so the answer is actionable rather than "too much text".
// Rule and reasoning: docs/rules/typography.md, "Читабельна підлога".
function checkReadableFont(
  slide: slides_v1.Schema$Page,
  slotByObjectId?: Map<string, string>,
): { check: CheckResult; over: OverloadSlot[] } {
  const tight: string[] = []   // under the floor, inside tolerance — noted, not failed
  const over:  string[] = []   // past tolerance — a real decision for a human
  const overSlots: OverloadSlot[] = []

  for (const el of slide.pageElements ?? []) {
    if (!el.shape || el.shape.shapeType !== 'TEXT_BOX') continue
    if (!el.size || !el.transform) continue
    if (_V_DECOR_ID.test(el.objectId ?? '')) continue

    const runs = (el.shape.text?.textElements ?? []).map(te => te.textRun).filter(Boolean)
    const text = runs.map(r => r!.content ?? '').join('')
    if (!text.trim()) continue

    // The smallest size actually written decides: one oversized lead-in does not make a
    // card readable if the list under it is at 10pt.
    const sizes = runs.map(r => r!.style?.fontSize?.magnitude ?? 0).filter(s => s > 0)
    if (!sizes.length) continue
    const pt = Math.min(...sizes)
    if (pt >= _V_READABLE_PT) continue

    const { w, h } = elBounds(el)
    const innerW = w - 2 * _V_INSET
    const innerH = h - 2 * _V_INSET
    if (innerW <= 0 || innerH <= 0) continue

    // What the same text would need at the floor, in the same box.
    const needed = renderedHeightUniform(text, innerW, _V_READABLE_PT, /[\n\v]/.test(text.trim()))
    const deficit = needed <= innerH ? 0 : 1 - innerH / needed
    const slidesNeeded = Math.max(2, Math.ceil(needed / innerH))
    // The generator's own name for this box, when the caller supplied the map. The old
    // fallback chain stays for the sentence: {{TOKEN}} survives only in boxes that were
    // never filled, and an objectId at least identifies the shape in the file.
    const slotName = (el.objectId && slotByObjectId?.get(el.objectId)) ?? null
    const tok = slotName ?? elToken(el) ?? el.objectId ?? '?'
    const line =
      `${tok}: ${pt}pt (floor ${_V_READABLE_PT}) — at ${_V_READABLE_PT}pt needs ` +
      `${Math.round(needed)}px of ${Math.round(innerH)}px → split into ` +
      `${slidesNeeded} or cut ${Math.round(deficit * 100)}%`

    if (deficit > _V_TOLERANCE) {
      over.push(line)
      // Only slots the plan can address get into the structured list. A box we cannot name
      // is still worth reporting in the sentence, but offering to split something we can't
      // point at in the plan would be an offer we cannot keep.
      if (slotName) {
        overSlots.push({
          slot: slotName,
          pt,
          neededPx: Math.round(needed),
          availPx: Math.round(innerH),
          slidesNeeded,
          cutPct: Math.round(deficit * 100),
        })
      }
    } else {
      tight.push(`${tok}: ${pt}pt (within tolerance)`)
    }
  }

  if (over.length) {
    return {
      check: { check: 'readable_font', pass: false, detail: over.join(' | ') },
      over: overSlots,
    }
  }
  return {
    check: {
      check: 'readable_font',
      pass: true,
      detail: tight.length ? `below floor but inside tolerance — ${tight.join(' | ')}` : undefined,
    },
    over: [],
  }
}

function checkTextOverflow(slide: slides_v1.Schema$Page): CheckResult {
  const fails: string[] = []

  for (const el of slide.pageElements ?? []) {
    if (!el.shape || el.shape.shapeType !== 'TEXT_BOX') continue
    if (!el.size || !el.transform) continue

    // Rebuild paragraphs the way Slides stores them: a paragraphMarker opens each one.
    type P = { text: string; pt: number; spaceBelow: number }
    const paras: P[] = []
    let cur: P | null = null
    for (const te of el.shape.text?.textElements ?? []) {
      if (te.paragraphMarker) {
        cur = { text: '', pt: 0, spaceBelow: te.paragraphMarker.style?.spaceBelow?.magnitude ?? 0 }
        paras.push(cur)
        continue
      }
      const run = te.textRun
      if (!run?.content || !cur) continue
      cur.text += run.content
      cur.pt = Math.max(cur.pt, run.style?.fontSize?.magnitude ?? 0)
    }

    const filled = paras.filter(p => p.text.trim())
    if (filled.length < 2) continue

    const { w, h } = elBounds(el)
    const innerW = w - 2 * _V_INSET
    const innerH = h - 2 * _V_INSET
    if (innerW <= 0 || innerH <= 0) continue

    // Same function the generator picks fonts with (lib/textfit.ts). The generator keeps
    // FIT_MARGIN of slack, this asks the bare question — "does it actually spill?" — so a
    // pass here is not a coincidence of two similar formulas but the same answer twice.
    // ALL paragraphs are measured, blank ones included: a blank line between two groups
    // is drawn, so it counts. `filled` only decides whether this box is in scope.
    const measurable = paras.filter((p, i) => p.text.trim() || i < paras.length - 1)
    const needed = renderedHeight(
      measurable.map(p => ({
        text: p.text,
        pt: p.pt || filled[0]?.pt || 14,   // a blank paragraph carries no run of its own
        spaceBelowPt: p.spaceBelow,
      })),
      innerW,
    )

    if (needed > innerH + _V_OVERFLOW_TOL) {
      const tok = elToken(el) ?? el.objectId ?? '?'
      fails.push(
        `${tok}: text ${Math.round(needed)}px in a ${Math.round(innerH)}px box ` +
        `(+${Math.round(needed - innerH)}px, ${filled.length} paragraphs)`,
      )
    }
  }

  return { check: 'text_overflow', pass: fails.length === 0, detail: fails.join(' | ') || undefined }
}

// The rendered ruler itself now lives in lib/textfit.ts — the generator imports the same
// one. Keeping a private copy here is what let the two drift apart in the first place.

function elToken(el: slides_v1.Schema$PageElement): string | null {
  const raw = (el.shape?.text?.textElements ?? [])
    .map(te => te.textRun?.content ?? '').join('')
  return raw.match(/\{\{([^}]+)\}\}/)?.[1] ?? null
}

// ─── individual checks ────────────────────────────────────────────────────────

function checkBounds(slide: slides_v1.Schema$Page): CheckResult {
  const fails: string[] = []
  for (const el of slide.pageElements ?? []) {
    if (!el.transform || !el.size) continue
    const { x, y, right, bottom } = elBounds(el)
    if (
      x < -_BOUNDS_TOL || y < -_BOUNDS_TOL ||
      right > _SLIDE_W + _BOUNDS_TOL || bottom > _SLIDE_H + _BOUNDS_TOL
    ) {
      const tok = elToken(el) ?? el.objectId ?? '?'
      fails.push(`${tok} x=${Math.round(x)} y=${Math.round(y)} r=${Math.round(right)} b=${Math.round(bottom)}`)
    }
  }
  return { check: 'bounds', pass: fails.length === 0, detail: fails.join(' | ') || undefined }
}

function checkAutofit(slide: slides_v1.Schema$Page): CheckResult {
  // SHAPE_AUTOFIT expands the box to fit text — shifts layout, forbidden.
  // NONE is the only settable value via REST API v1; TEXT_AUTOFIT is read-only in the API.
  const fails: string[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX') continue
    const aft = el.shape.shapeProperties?.autofit?.autofitType
    if (aft === 'SHAPE_AUTOFIT') {
      fails.push(`${elToken(el) ?? el.objectId}: SHAPE_AUTOFIT`)
    }
  }
  return { check: 'autofit_no_expand', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

function checkFont(slide: slides_v1.Schema$Page): CheckResult {
  const fails: string[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX') continue
    const tok = elToken(el) ?? el.objectId ?? '?'
    for (const te of el.shape?.text?.textElements ?? []) {
      const style = te.textRun?.style
      if (!style) continue
      const family = style.weightedFontFamily?.fontFamily
      if (family && !family.toLowerCase().startsWith('inter')) {
        fails.push(`${tok}: font="${family}"`)
      }
      if (style.bold === true) {
        fails.push(`${tok}: bold=true`)
      }
    }
  }
  return { check: 'font_inter_medium', pass: fails.length === 0, detail: fails.slice(0, 5).join('; ') || undefined }
}

// ─── source_columns_covered ───────────────────────────────────────────────────
// "1 аркуш = 1 слайд" was only ever checked as text: content_coverage asks whether a line
// exists somewhere in the deck. It stays green while three columns are flattened into
// one — nothing is missing, the structure is. That is exactly what happened to the sheet
// "Цільові групи": three grouped columns arrived as one blob and rendered as two columns.
//
// This asks the structural question instead: the sheet had N columns of real content —
// does the slide built from it carry N places to put them?
//   carried = distinct КОЛОНКА_n / КАРТКА_n indices that are filled,
//             or 1 when the composition has a single body slot (title_body & friends).
// A variant is allowed to look different, never to hold less.
export function checkSourceColumns(planSlide: SlidePlan['slides'][number]): CheckResult {
  const want = planSlide.sourceColumns ?? 0
  if (want < 2) return { check: 'source_columns_covered', pass: true, detail: 'n/a' }

  const indices = new Set<string>()
  let hasBody = false
  for (const [name, value] of Object.entries(planSlide.slots)) {
    if (!value || !value.trim()) continue
    const m = name.match(/^(?:КОЛОНКА|КАРТКА)_(\d+)/)
    if (m) { indices.add(m[1]); continue }
    if (name === 'ЗАГОЛОВОК' || name.startsWith('ЗОБРАЖЕННЯ') || name.startsWith('ПІДПИС')) continue
    hasBody = true
  }
  const carried = indices.size || (hasBody ? 1 : 0)

  return {
    check: 'source_columns_covered',
    pass: carried >= want,
    detail: `source_columns=${want} | carried=${carried} (${planSlide.composition})` +
      (carried >= want ? '' : ' → структуру аркуша втрачено: колонки склеєні в один слот'),
  }
}

function checkMaxChars(slots: Record<string, string>, compId: string): CheckResult {
  // Agenda items are auto-truncated at generation time — static check would always false-positive
  if (compId.startsWith('agenda_')) return { check: 'max_chars', pass: true, detail: 'agenda — truncated at generation' }
  const comp = getComposition(compId)
  if (!comp) return { check: 'max_chars', pass: true, detail: 'composition not found — skipped' }
  const fails: string[] = []
  for (const def of comp.slots) {
    if (def.type !== 'text' || !def.max_chars) continue
    const val = slots[def.name] ?? ''
    if (val.length > def.max_chars) {
      fails.push(`${def.name}: ${val.length}>${def.max_chars}`)
    }
  }
  return { check: 'max_chars', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

// Compact number match: "2M" is a valid equivalent of "2 000 000" in sourceText.
// Only applies to КАРТКА_N_ЗНАЧЕННЯ slots (the sole allowed text transformation).
// Guards: only accepts compact form for 5+ digit originals (4-digit numbers are never compacted).
function isCompactNumberMatch(value: string, sourceText: string): boolean {
  const m = value.trim().match(/^([^0-9]*)(\d+(?:\.\d+)?)(K|M)([^0-9]*)$/i)
  if (!m) return false
  const [, prefix, numStr, unit, suffix] = m
  const factor = unit.toUpperCase() === 'M' ? 1_000_000 : 1_000
  const expanded = Math.round(parseFloat(numStr) * factor)
  if (!isFinite(expanded)) return false
  // 4-digit originals (< 10 000) are never compacted under the current rules
  const expandedStr = String(expanded)
  if (expandedStr.length <= 4) return false
  // Allow "2000000" or "2 000 000" (space-separated thousands) in sourceText
  const withOptSpaces = expandedStr.replace(/(\d)(?=(\d{3})+$)/g, '$1 ?')
  const re = new RegExp(
    prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    withOptSpaces +
    suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return re.test(sourceText)
}

// Invariant 9 — zero content loss:
//   (a) every non-empty slot must be defined in the composition (no silently-lost text)
//   (b) when sourceText is available: every non-empty line of each slot value must be
//       a verbatim substring of the original input (LLM never invented / paraphrased)
// Exception: КАРТКА_N_ЗНАЧЕННЯ may contain compact number form (e.g. "2M" ↔ "2 000 000").
// Exemption: image slots only. closing used to be exempt too, which is exactly how a
// closing slide with invented/dropped body text passed validation unnoticed.
function checkContentIntegrity(
  slots: Record<string, string>,
  compId: string,
  sourceText?: string,
): CheckResult {
  const comp = getComposition(compId)
  if (!comp) return { check: 'content_integrity', pass: true, detail: 'composition not found — skipped' }

  const known = new Set(comp.slots.map(s => s.name))
  const fails: string[] = []

  for (const [name, value] of Object.entries(slots)) {
    const v = (value ?? '').trim()
    if (!v) continue
    if (name.startsWith('ЗОБРАЖЕННЯ_')) continue  // image slots always ignored

    // (a) slot must exist in the composition
    if (!known.has(name)) {
      const preview = v.length > 40 ? v.slice(0, 40) + '…' : v
      fails.push(`unmapped "${name}" (content lost): "${preview}"`)
      continue
    }

    // (b) verbatim check — needs the original brief to compare against
    if (!sourceText) continue
    const isKpiValue = /^КАРТКА_\d+_ЗНАЧЕННЯ$/.test(name)
    const lines = v.split('\n').map(l => l.trim()).filter(Boolean)
    for (const line of lines) {
      // NBSP (U+00A0) inserted by addNbsp is a display-only transform — treat as space for verbatim check.
      const normalized = line.replace(/\u00A0/g, ' ')
      const verbatimOk = sourceText.includes(normalized)
      const compactOk  = isKpiValue && isCompactNumberMatch(normalized, sourceText)
      // Allow first-letter capitalization when a leading stat was stripped into ЗНАЧЕННЯ
      // or when two_columns_plain body is auto-capitalised by extractColumnLabel.
      const isKpiLabel        = /^КАРТКА_\d+_ПІДПИС$/.test(name)
      const isColumnPlainBody = compId === 'two_columns_plain' && /^КОЛОНКА_\d+$/.test(name)
      const capitalizedOk = (isKpiLabel || isColumnPlainBody) && normalized.length > 0 &&
        sourceText.includes(normalized.charAt(0).toLowerCase() + normalized.slice(1))
      // Allow colon→em-dash normalization applied to two_columns / bento_right_* slots
      const colonNormalizedOk = normalized.includes(' — ') &&
        sourceText.includes(normalized.replace(/ — /g, ': '))
      if (!verbatimOk && !compactOk && !capitalizedOk && !colonNormalizedOk) {
        const preview = line.length > 60 ? line.slice(0, 60) + '…' : line
        fails.push(`${name}: non-verbatim line — "${preview}"`)
        break  // one report per slot is enough
      }
    }
  }

  return {
    check: 'content_integrity',
    pass: fails.length === 0,
    detail: fails.length > 0 ? fails.join('; ') : undefined,
  }
}

function checkBadge(slide: slides_v1.Schema$Page, compId: string, slots: Record<string, string>): CheckResult {
  // bento_right_* + title_photo: logo bottom-left (100, 890)
  // cover_title_only + title-only closing: wordmark logo top-right at (1463, 99)
  // default: symbol logo top-right (1730, 100)
  const isBentoRight = compId.startsWith('bento_right_')
  const isCoverTitleStyle = compId === 'cover_title_only' || compId === 'closing'
  const isBottomLeft  = isBentoRight || compId === 'title_photo'
  const BADGE_X   = isBottomLeft ? 100 : isCoverTitleStyle ? 1463 : 1730
  const BADGE_Y   = isBottomLeft ? 890 : isCoverTitleStyle ? 99   : 100
  const BADGE_TOL = 25
  for (const el of slide.pageElements ?? []) {
    if (!el.transform) continue
    const x = Math.round((el.transform.translateX ?? 0) / _FPX)
    const y = Math.round((el.transform.translateY ?? 0) / _FPX)
    if (Math.abs(x - BADGE_X) <= BADGE_TOL && Math.abs(y - BADGE_Y) <= BADGE_TOL) {
      return { check: 'skelar_badge', pass: true }
    }
  }
  return { check: 'skelar_badge', pass: false, detail: `badge not found near (${BADGE_X}, ${BADGE_Y})` }
}

// kpi_cards: КАРТКА_N_ЗНАЧЕННЯ must be numeric (digits / ± / % / math prefixes / units).
// Non-round numbers with spaces (e.g. "2 456 789") are valid — they cannot be compacted.
const KPI_NUMERIC_RE = /^[\d\s+\-±×x.,/%$€£<>≤≥~≈MKBmkb]+$/i

function checkKpiNumeric(slots: Record<string, string>): CheckResult {
  const fails: string[] = []
  for (let n = 1; n <= 4; n++) {
    const val = (slots[`КАРТКА_${n}_ЗНАЧЕННЯ`] ?? '').trim()
    if (!val) continue
    if (!KPI_NUMERIC_RE.test(val)) {
      fails.push(`КАРТКА_${n}_ЗНАЧЕННЯ: "${val.slice(0, 30)}"`)
    }
  }
  return { check: 'kpi_numeric_values', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

function checkKpiGap(slide: slides_v1.Schema$Page, gapMin: number): CheckResult {
  // After replaceAllText, tokens are gone. Identify elements by geometry:
  //   body (ТЕКСТ): TEXT_BOX with x≈PAD(100), w≈UW(1720), y in [150, 500]
  //   card text: TEXT_BOX with x>120, w<600, y>300 (card inner zone)
  let bodyBottom = -1
  let cardTop    = Infinity
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.transform || !el.size) continue
    const { x, y, w, bottom } = elBounds(el)
    if (Math.abs(x - 100) <= 20 && w > 1500 && y > 150 && y < 500) {
      bodyBottom = Math.max(bodyBottom, bottom)
    }
    if (x > 120 && w < 600 && y > 300) {
      cardTop = Math.min(cardTop, y)
    }
  }
  if (bodyBottom < 0 || cardTop === Infinity) {
    return { check: 'kpi_gap', pass: true, detail: 'layout elements not identifiable — skipped' }
  }
  const gap = Math.round(cardTop - bodyBottom)
  return {
    check: 'kpi_gap',
    pass: gap >= gapMin - _BOUNDS_TOL,
    detail: `gap=${gap}px (min=${gapMin})`,
  }
}

// kpi_cards: card row is bottom-anchored at H-PAD=980.
// Verifies: left=PAD, right=PAD+UW, bottom≈980, top clears title+TG zone.
function checkKpiCardRowGeometry(slide: slides_v1.Schema$Page): CheckResult {
  const PAD = 100, UW = 1720, H = 1080, TG = 100, TH = 100
  const TOL = 20

  // Card backgrounds: RECTANGLE, left-anchored (x≈PAD), wider than 350px, taller than 150px
  const cardBgs: { x: number; w: number; y: number; h: number }[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'RECTANGLE' || !el.transform || !el.size) continue
    const b = elBounds(el)
    if (b.x >= PAD - TOL && b.w > 350 && b.h > 150) {
      cardBgs.push({ x: Math.round(b.x), w: Math.round(b.w), y: Math.round(b.y), h: Math.round(b.h) })
    }
  }
  if (cardBgs.length === 0) {
    return { check: 'kpi_row_geometry', pass: true, detail: 'no card backgrounds — skipped' }
  }

  const fails: string[] = []

  // Row must span PAD → PAD+UW (left-to-right, no gaps at edges)
  const minX     = Math.min(...cardBgs.map(c => c.x))
  const maxRight = Math.max(...cardBgs.map(c => c.x + c.w))
  if (Math.abs(minX - PAD) > TOL) {
    fails.push(`left edge x=${minX} ≠ PAD(${PAD})`)
  }
  if (Math.abs(maxRight - (PAD + UW)) > TOL) {
    fails.push(`right edge x=${maxRight} ≠ PAD+UW(${PAD + UW})`)
  }

  // Bottom edge must be at H-PAD=980 (bottom-anchored layout)
  const maxBottom = Math.max(...cardBgs.map(c => c.y + c.h))
  if (maxBottom < H - PAD - TOL) {
    fails.push(`bottom=${maxBottom} < H-PAD(${H - PAD})`)
  }

  // Top must clear the title+TG zone (comfortable gap)
  const cardTopY = Math.min(...cardBgs.map(c => c.y))
  if (cardTopY < PAD + TH + TG - TOL) {
    fails.push(`card top=${cardTopY} < PAD+TH+TG(${PAD + TH + TG})`)
  }

  return { check: 'kpi_row_geometry', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

// logo_overlap: no TEXT_BOX may intersect the logo reserved zone.
// Non-bento_right: zone = x∈[1730,1820], y∈[100,190].
// bento_right_*:   zone = x∈[100,190],  y∈[890,980].
// A correctly-built title box (right=1710) leaves 20px gap before logo starts at 1730.
function checkLogoOverlap(slide: slides_v1.Schema$Page, compId: string, slots: Record<string, string>): CheckResult {
  // cover_title_only and title-only closing: full-slide title intentionally fills the slide — no overlap check
  const isTitleOnlyClosing = compId === 'closing'
  if (compId === 'cover_title_only' || isTitleOnlyClosing) return { check: 'logo_overlap', pass: true }
  const isBR   = compId.startsWith('bento_right_')
  const LOGO_W = 90, LOGO_H = 90
  const lX = isBR ? 100  : 1730
  const lY = isBR ? 890  : 100
  const lR = lX + LOGO_W   // 190 or 1820
  const lB = lY + LOGO_H   // 980 or 190

  const fails: string[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.transform || !el.size) continue
    const { x, y, right, bottom } = elBounds(el)
    if (right > lX && x < lR && bottom > lY && y < lB) {
      const tok = elToken(el) ?? el.objectId ?? '?'
      fails.push(`${tok} right=${Math.round(right)} intersects logo zone x=[${lX},${lR}] y=[${lY},${lB}]`)
    }
  }
  return { check: 'logo_overlap', pass: fails.length === 0, detail: fails.join(' | ') || undefined }
}

// cover: ДАТА must be full-width (≈ UW) and NOT stuck in the bottom corner.
// Catches old-master decks where ДАТА was at y≈928, w=500.
function checkCoverLayout(slide: slides_v1.Schema$Page): CheckResult {
  const MIN_DATE_W = 1400  // ДАТА width must be close to UW (1720), not 500
  const MAX_DATE_Y = 800   // ДАТА must not be near the bottom of the slide

  let narrowOrLow = false
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.transform || !el.size) continue
    const x = Math.round((el.transform.translateX ?? 0) / _FPX)
    const y = Math.round((el.transform.translateY ?? 0) / _FPX)
    const w = Math.round((el.size.width?.magnitude ?? 0) * (el.transform.scaleX ?? 1) / _FPX)
    const h = Math.round((el.size.height?.magnitude ?? 0) * (el.transform.scaleY ?? 1) / _FPX)
    // Match ДАТА: left-anchored, below the title area (y > PAD+some gap), small height
    if (Math.abs(x - 100) < 20 && y > 150 && h < 150) {
      if (w < MIN_DATE_W || y > MAX_DATE_Y) {
        narrowOrLow = true
        break
      }
    }
  }

  return {
    check: 'cover_layout',
    pass: !narrowOrLow,
    detail: narrowOrLow
      ? `ДАТА box is narrow or in the bottom corner — regenerate from updated master`
      : undefined,
  }
}

// ── Bento card layout (plan-level) ───────────────────────────────────────────
// Verifies that the uniform font size chosen for a bento row is > 10pt and that
// the longest card text doesn't overflow. Fills cannot be checked here (spacing
// is applied by the generation pipeline; see lib/google.ts bentoParagraphSpacingPt).
const _V_PAD = 100, _V_UW = 1720, _V_GAP = 30, _V_INN = 30, _V_TH = 100, _V_TG = 100, _V_CH = 1080 - _V_PAD - (_V_PAD + _V_TH + _V_TG)  // 680
const _V_RBW = 860, _V_RBH = 1080 - 2 * _V_PAD  // 880
const _V_VERT_PAD = 40   // must match BENTO_VERT_PAD in lib/google.ts

function _vBentoDims(compId: string): { w: number; h: number } | null {
  // h = max content height; mirrors bentoDims() in lib/google.ts (uses VERT_PAD not INN).
  if (compId === 'two_columns')     { const cw = Math.floor((_V_UW - _V_GAP) / 2);   return { w: cw - 2*_V_INN, h: _V_CH - 2*_V_VERT_PAD } }
  if (compId === 'three_columns')   { const cw = Math.floor((_V_UW - 2*_V_GAP) / 3); return { w: cw - 2*_V_INN, h: _V_CH - 2*_V_VERT_PAD } }
  if (compId === 'bento_right_2')   { const ch = Math.floor((_V_RBH - _V_GAP) / 2);  return { w: _V_RBW - 2*_V_INN, h: ch - 2*_V_VERT_PAD } }
  if (compId === 'bento_right_3')   { const ch = Math.floor((_V_RBH - 2*_V_GAP) / 3);return { w: _V_RBW - 2*_V_INN, h: ch - 2*_V_VERT_PAD } }
  if (compId === 'bento_right_2x2') { const cw = Math.floor((_V_RBW - _V_GAP) / 2); const ch = Math.floor((_V_RBH - _V_GAP) / 2); return { w: cw - 2*_V_INN, h: ch - 2*_V_VERT_PAD } }
  if (compId === 'three_columns_num') { const cw = Math.floor((_V_UW - 2 * 50) / 3); return { w: cw, h: 1080 - 100 - 540 } }
  if (compId === 'bento_bottom_4')   { const cw = Math.floor((_V_UW - 3 * _V_GAP) / 4); return { w: cw - 2*_V_INN, h: _V_CH - 2*_V_VERT_PAD } }
  return null
}

const _V_BENTO_TOKENS: Record<string, string[]> = {
  two_columns:       ['КОЛОНКА_1', 'КОЛОНКА_2'],
  three_columns:     ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3'],
  three_columns_num: ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3'],
  bento_bottom_4:    ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
  bento_right_2:     ['КАРТКА_1', 'КАРТКА_2'],
  bento_right_3:     ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3'],
  bento_right_2x2:   ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
}

const _V_BENTO_MAX_PT: Record<string, number> = {
  two_columns: 48, three_columns: 28, three_columns_num: 18, bento_bottom_4: 22, bento_right_2: 36, bento_right_3: 22, bento_right_2x2: 22,
}

// Must track lib/google.ts: FIT_LINE_FACTOR (body text renders at lineSpacing 90%, not the
// old 140%) and LIST_ITEM_GAP_EM (spaceBelow after each list item). If this stays at the
// old 1.4 while the generator budgets 1.2, the validator fails cards the generator
// deliberately allowed to grow.
const _V_FIT_LINE_FACTOR = 1.2
const _V_LIST_ITEM_GAP_EM = 0.5

function _vTextFits(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  const px = pt * 2.667
  const cpl = Math.max(1, Math.floor(wPx / (px * 0.48)))
  const maxLines = Math.max(1, Math.floor(hPx / (px * _V_FIT_LINE_FACTOR)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) { cur = w.length }
    else if (cur + 1 + w.length <= cpl) { cur += 1 + w.length }
    else { lines++; cur = w.length }
  }
  return lines <= maxLines
}

// Paragraph-aware: mirrors textFitsParagraphs in lib/google.ts. \v = soft line break
// (Shift+Enter) for list items sharing one paragraph — forces its own line like \n.
function _vTextFitsParagraphs(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  const paras = text.split(/[\n\v]/).filter(p => p.trim())
  if (paras.length <= 1) return _vTextFits(text, wPx, hPx, pt)
  const totalLines = paras.reduce((s, p) => s + _vEstimateLines(p, wPx, pt), 0)
  // The air between list items is real height — subtract it before counting lines
  const gapPx      = paras.length * _V_LIST_ITEM_GAP_EM * pt * 2.667
  const maxLines   = Math.max(1, Math.floor((hPx - gapPx) / (pt * 2.667 * _V_FIT_LINE_FACTOR)))
  return totalLines <= maxLines
}

function _vEstimateLines(text: string, wPx: number, pt: number): number {
  if (!text.trim()) return 0
  const cpl = Math.max(1, Math.floor(wPx / (pt * 2.667 * 0.48)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) cur = w.length
    else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
    else { lines++; cur = w.length }
  }
  return lines
}

// Mirrors preprocessBentoText in lib/google.ts
function _vPreprocessBentoText(text: string, compId: string, tok: string): string {
  if (!text.trim()) return text
  // Value+label cards (checked via splitValueLabel heuristic): skip
  const nlIdx = text.indexOf('\n')
  const isValLabel = nlIdx > 0 && nlIdx <= 35 && /\d/.test(text.slice(0, nlIdx))
  if (isValLabel) return text
  const colonIdx = text.indexOf(':')
  const isValColon = colonIdx > 0 && colonIdx <= 35 && /\d/.test(text.slice(0, colonIdx))
  if (isValColon) return text

  if (text.includes(' · ')) {
    const items = text.split(' · ').map(s => s.trim()).filter(Boolean)
    if (items.length >= 2) return items.join('\v')
  }
  const lines = text.split('\n').map(l => l.trim().replace(/^[•\-–]\s*/, '')).filter(Boolean)
  if (lines.length >= 2) return lines.join('\v')
  return text
}

function checkBentoLayout(compId: string, slots: Record<string, string>): CheckResult {
  const dims   = _vBentoDims(compId)
  const tokens = _V_BENTO_TOKENS[compId]
  const maxPt  = _V_BENTO_MAX_PT[compId]
  if (!dims || !tokens || !maxPt) return { check: 'bento_layout', pass: true, detail: 'n/a' }

  // Use preprocessed text (same conversion applied at generation time)
  const processedSlots: Record<string, string> = {}
  for (const tok of tokens) {
    processedSlots[tok] = _vPreprocessBentoText(slots[tok] ?? '', compId, tok)
  }

  const scale = [48, 36, 28, 22, 18, 14, 10].filter(s => s <= maxPt)
  let uniformPt = scale[scale.length - 1]
  for (const pt of scale) {
    if (tokens.every(t => _vTextFitsParagraphs(processedSlots[t] ?? '', dims.w, dims.h, pt))) { uniformPt = pt; break }
  }

  const fails: string[] = []
  // 10pt is the intentional universal floor (lib/google.ts BENTO_MIN_PT) — content is
  // never dropped/shortened, it shrinks instead. Below that would mean the floor itself
  // was violated somewhere, which is the real bug worth catching.
  if (uniformPt < 10) fails.push(`font too small (${uniformPt}pt)`)

  const cardHInfo: string[] = []
  for (const tok of tokens) {
    const text = (processedSlots[tok] ?? '').trim()
    if (!text) continue
    if (!_vTextFitsParagraphs(text, dims.w, dims.h, uniformPt)) {
      fails.push(`${tok}: overflows at ${uniformPt}pt`)
      continue
    }
    // Check: " · " separators got converted to a real per-item line break (\v soft
    // break — see preprocessBentoText in lib/google.ts), not left as inline " · " text.
    const raw = (slots[tok] ?? '').trim()
    if (raw.includes(' · ') && !text.includes('\v') && !text.includes('\n')) {
      fails.push(`${tok}: list items joined with · instead of separate lines`)
    }
    // Estimated card height vs max card zone height
    const paras = text.split(/[\n\v]/).filter(p => p.trim())
    const totalLines = paras.reduce((s, p) => s + _vEstimateLines(p, dims.w, uniformPt), 0)
    const contentH   = Math.round(
      totalLines * uniformPt * 2.667 * _V_FIT_LINE_FACTOR
      + paras.length * _V_LIST_ITEM_GAP_EM * uniformPt * 2.667,
    )
    const cardH      = contentH + 2 * _V_VERT_PAD
    cardHInfo.push(`${tok}:h=${cardH}`)
  }

  const detail = fails.length > 0
    ? fails.join('; ')
    : `pt=${uniformPt} ${cardHInfo.join(' ')}`
  return { check: 'bento_layout', pass: fails.length === 0, detail }
}

// bento_right_*: ЗАГОЛОВОК and ТЕКСТ must not overlap.
// After rendering, ЗАГОЛОВОК box bottom must be above ТЕКСТ box top.
function checkBentoLeftOverlap(slide: slides_v1.Schema$Page, compId: string): CheckResult {
  if (!compId.startsWith('bento_right_')) return { check: 'bento_left_overlap', pass: true, detail: 'n/a' }
  const RBX = 960, TOL = _BOUNDS_TOL

  // Collect left-column text boxes (x≈PAD, w≈LTW≈830, left of RBX)
  const leftBoxes: Array<{ y: number; bottom: number }> = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.transform || !el.size) continue
    const content = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('').trim()
    if (!content) continue  // skip empty boxes (e.g. collapsed ЗАГОЛОВОК after dedup)
    const { x, y, w, bottom } = elBounds(el)
    if (x < RBX - 50 && Math.abs(x - 100) < 30 && w > 500) {
      leftBoxes.push({ y, bottom })
    }
  }
  leftBoxes.sort((a, b) => a.y - b.y)

  const fails: string[] = []
  for (let i = 0; i + 1 < leftBoxes.length; i++) {
    const a = leftBoxes[i], b = leftBoxes[i + 1]
    if (a.bottom > b.y + TOL) {
      fails.push(`box bottom=${Math.round(a.bottom)} > next top=${Math.round(b.y)} (overlap ${Math.round(a.bottom - b.y)}px)`)
    }
  }
  return { check: 'bento_left_overlap', pass: fails.length === 0, detail: fails.join(' | ') || undefined }
}

// Bento card text must not end with a single trailing period (periods are auto-stripped in pipeline).
// Checks the plan-level value after applying the same strip logic.
function checkBentoTrailingPeriod(compId: string, slots: Record<string, string>): CheckResult {
  const tokens = _V_BENTO_TOKENS[compId]
  if (!tokens) return { check: 'bento_trailing_period', pass: true, detail: 'n/a' }
  const fails: string[] = []
  for (const tok of tokens) {
    const val = (slots[tok] ?? '').trim()
    if (!val) continue
    // Apply same strip as pipeline: last char '.' that is not preceded by '.'
    const stripped = val.replace(/(?<!\.)\.$/, '')
    if (stripped !== val && stripped.endsWith('.')) {
      // Edge case: e.g. "text.." — strip removed one '.' but '..' remains
      fails.push(`${tok}: ends with '.' after strip — "${val.slice(-10)}"`)
    }
  }
  return { check: 'bento_trailing_period', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

function checkTheme(plan: SlidePlan): CheckResult {
  const themes = new Set(plan.slides.map(s => s.theme ?? plan.theme))
  const pass   = themes.size <= 1
  return {
    check: 'theme_consistency',
    pass,
    detail: pass ? undefined : `mixed themes: ${[...themes].join(', ')}`,
  }
}

// Flat-list rules — plan-level, no Slides API required.

// Reject literal "*" in any slot (LLM bullet bug: "* item" instead of "• item" or badges).
function checkNoLiteralAsterisk(slots: Record<string, string>): CheckResult {
  const fails: string[] = []
  for (const [name, value] of Object.entries(slots)) {
    if (name.startsWith('ЗОБРАЖЕННЯ_')) continue
    if ((value ?? '').includes('*')) {
      fails.push(`${name}: contains literal "*"`)
    }
  }
  return { check: 'no_literal_asterisk', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

// Returns true if two slides are variant siblings (same original slide, different layout).
// Variant IDs are "<original_id>_v1", "<original_id>_v2", etc.
function areVariantSiblings(a: SlidePlan['slides'][0], b: SlidePlan['slides'][0]): boolean {
  const m = (id: string) => id.match(/^(.+)_v\d+$/)
  const mA = m(a.id ?? ''), mB = m(b.id ?? '')
  return !!(mA && mB && mA[1] === mB[1])
}

// Detect duplicated ЗАГОЛОВОК between consecutive slides (flat list split into multiple slides).
// Variant siblings share the same ЗАГОЛОВОК intentionally — skip the check for them.
function checkNoDuplicateTitle(plan: SlidePlan, slideIndex: number): CheckResult {
  if (slideIndex === 0) return { check: 'no_duplicate_title', pass: true }
  // Agenda slides always share "Адженда" as the canonical title — not a content duplication.
  if (plan.slides[slideIndex].composition.startsWith('agenda_')) {
    return { check: 'no_duplicate_title', pass: true, detail: 'agenda — canonical title expected' }
  }
  if (areVariantSiblings(plan.slides[slideIndex - 1], plan.slides[slideIndex])) {
    return { check: 'no_duplicate_title', pass: true, detail: 'variant siblings — shared title expected' }
  }
  // Parts of one sheet a human chose to split. The repeated heading is the point: the rule
  // bans a title invented twice, not one sheet continuing onto the next slide.
  const group = plan.slides[slideIndex].splitGroup
  if (group && plan.slides[slideIndex - 1].splitGroup === group) {
    return { check: 'no_duplicate_title', pass: true, detail: 'split parts — shared title expected' }
  }
  const cur  = (plan.slides[slideIndex].slots['ЗАГОЛОВОК'] ?? '').trim()
  const prev = (plan.slides[slideIndex - 1].slots['ЗАГОЛОВОК'] ?? '').trim()
  // The rule bans INVENTED repetition. When the brief itself heads two sheets the same
  // way, repeating it is 1:1 fidelity — and treating it as an error is what made the
  // model drop the second title entirely, leaving a headless slide.
  const fromSource = (plan.slides[slideIndex].fragments ?? []).some(f => f.trim() === cur)
  const dup  = Boolean(cur && cur === prev && !fromSource)
  return {
    check: 'no_duplicate_title',
    pass: !dup,
    detail: dup ? `ЗАГОЛОВОК "${cur.slice(0, 40)}" duplicated from slide ${slideIndex}` : undefined,
  }
}

// badges: each item in ПУНКТИ must be ≤ MAX_BADGE_CHARS (1–3 words, label-sized).
// Longer items indicate the wrong composition was chosen — use title_body instead.
const MAX_BADGE_CHARS = 20
function checkBadgesItems(slots: Record<string, string>): CheckResult {
  const items = (slots['ПУНКТИ'] ?? '').split('\n').map(s => s.trim()).filter(Boolean)
  if (items.length === 0) return { check: 'badge_item_max_chars', pass: false, detail: 'ПУНКТИ is empty' }
  const fails = items.filter(it => it.length > MAX_BADGE_CHARS)
    .map(it => `"${it.slice(0, 25)}" (${it.length}>${MAX_BADGE_CHARS})`)
  return {
    check: 'badge_item_max_chars',
    pass: fails.length === 0,
    detail: fails.length > 0 ? fails.join('; ') : `${items.length} items OK`,
  }
}

// ─── Plan-only validation (no Slides API needed) ─────────────────────────────
// Useful for fixture tests and pre-generation sanity checks.

export type PlanCheckResult = CheckResult & { slideIndex: number }

// Checks that every source fragment for a slide appears in at least one slot value.
// Requires plan.fragmentGroups (set when hasSheets=true in mapToPlan).
function checkFragmentCoverage(
  slots: Record<string, string>,
  slideFragments: string[] | undefined,
  slideIndex: number,
): CheckResult {
  if (!slideFragments || slideFragments.length === 0) {
    return { check: 'fragment_coverage', pass: true, detail: 'no fragments (non-sheet mode)' }
  }
  const allSlotText = Object.values(slots).join('\n')
  const missing = slideFragments.filter(frag => frag && !allSlotText.includes(frag))
  const mapped  = slideFragments.length - missing.length
  const pass    = missing.length === 0
  const detail  = `input_blocks=${slideFragments.length} | mapped_blocks=${mapped} | missing_texts=${JSON.stringify(missing.map(t => t.slice(0, 50)))} → ${pass ? 'PASS' : 'FAIL'}`
  if (!pass) {
    console.warn(`[validatePlan] slide ${slideIndex + 1} fragment_coverage FAIL: ${detail}`)
  }
  return { check: 'fragment_coverage', pass, detail }
}

// Deck-level zero-content-loss check — the live counterpart of fragment_coverage.
//
// Deliberately deck-level, not per-slide: expandPlanWithVariants duplicates a slide into
// several layout variants, and a variant is allowed to structurally drop a slot (e.g. ТЕКСТ
// when moving to two_columns). Asking "does this line still exist anywhere in the deck"
// therefore reports real loss without flagging legitimate per-variant drops.
//
// Matching is loose on purpose: the render stage rewrites slot text in known ways (NBSP,
// \v soft line breaks, colon→em-dash, stripped trailing period, capitalisation), and those
// transforms must not read as content loss.

export function checkContentCoverage(plan: SlidePlan): CheckResult {
  const owners = plan.slides
    .map((s, i) => ({ i, lines: s.fragments ?? [] }))
    .filter(o => o.lines.length > 0)
  if (owners.length === 0) {
    return { check: 'content_coverage', pass: true, detail: 'no source fragments attached — skipped' }
  }

  // Every slot value of the whole deck, normalised once — final slots plus the
  // pre-render snapshot, so deliberate render-time rewrites are not read as loss.
  const deckBlob = normLoose([
    ...plan.slides.flatMap(s => Object.values(s.slots)),
    ...(plan.preRenderSlots ?? []),
  ].join(' \n '))

  // Variant copies of a slide carry the same fragments — count each distinct source line
  // once, so the reported number is the brief's real line count.
  const seen = new Set<string>()
  const lost: string[] = []
  let total = 0
  for (const { i, lines } of owners) {
    for (const line of lines) {
      const key = normLoose(line)
      if (!key || seen.has(key)) continue
      seen.add(key)
      total++
      if (!deckBlob.includes(key)) {
        lost.push(`slide ${i + 1}: "${line.slice(0, 60)}${line.length > 60 ? '…' : ''}"`)
      }
    }
  }

  const pass = lost.length === 0
  const detail = pass
    ? `source_lines=${total} | all present in deck`
    : `source_lines=${total} | LOST ${lost.length}: ${lost.slice(0, 8).join('; ')}${lost.length > 8 ? ` …+${lost.length - 8}` : ''}`
  if (!pass) console.warn(`[content_coverage] FAIL: ${detail}`)
  return { check: 'content_coverage', pass, detail }
}

export function validatePlan(plan: SlidePlan): PlanCheckResult[] {
  const results: PlanCheckResult[] = []

  // Deck-level: slide count must be >= sheet count (variants add extra slides)
  if (plan.sheetCount !== undefined) {
    const pass = plan.slides.length >= plan.sheetCount
    results.push({
      slideIndex: -1,
      check: 'slide_count_matches_sheets',
      pass,
      detail: pass
        ? `${plan.slides.length} slides ≥ ${plan.sheetCount} sheets`
        : `${plan.slides.length} slides < ${plan.sheetCount} sheets (slides lost)`,
    })
  }

  for (let i = 0; i < plan.slides.length; i++) {
    const slide  = plan.slides[i]
    const compId = slide.composition
    const slots  = slide.slots
    results.push({ slideIndex: i, ...checkNoLiteralAsterisk(slots) })
    results.push({ slideIndex: i, ...checkNoDuplicateTitle(plan, i) })
    results.push({ slideIndex: i, ...checkFragmentCoverage(slots, plan.fragmentGroups?.[i], i) })
    if (compId === 'badges') {
      results.push({ slideIndex: i, ...checkBadgesItems(slots) })
    }
  }
  return results
}

// ─── main export ─────────────────────────────────────────────────────────────

export async function validateDeck(
  slidesApi: slides_v1.Slides,
  presentationId: string,
  plan: SlidePlan,
  planPageIds: string[],
  slotObjectIds?: Array<Record<string, string>>,
): Promise<ValidationReport> {
  const pres      = await slidesApi.presentations.get({ presentationId })
  const allSlides = pres.data.slides ?? []
  const themeCheck = checkTheme(plan)
  const results: SlideValidation[] = []
  const overloads: SlideOverload[] = []

  for (let i = 0; i < plan.slides.length; i++) {
    const pageId    = planPageIds[i]
    const planSlide = plan.slides[i]
    const compId    = planSlide.composition
    const slide     = allSlides.find(s => s.objectId === pageId)
    const checks: CheckResult[] = []

    if (!slide) {
      checks.push({ check: 'slide_found', pass: false, detail: `pageId ${pageId} missing` })
      results.push({ slideIndex: i, composition: compId, checks, pass: false })
      continue
    }

    checks.push(checkBounds(slide))
    checks.push(checkTextOverflow(slide))

    // Slot names come from the generator's own token → objectId map, inverted. Guessing
    // them back from the file is not possible: by the time the deck exists the {{TOKEN}}
    // placeholders have been replaced by the very text we are measuring.
    const slotByObjectId = new Map<string, string>()
    for (const [slotName, objId] of Object.entries(slotObjectIds?.[i] ?? {})) {
      if (objId) slotByObjectId.set(objId, slotName)
    }
    const readable = checkReadableFont(slide, slotByObjectId)
    // An accepted slide is not a passing slide that happens to be small — it is a slide
    // whose size stopped being the machine's call. docs/rules/typography.md puts it as
    // "readability is the default state; departing from it is a person's decision, not the
    // code's", and a check that keeps failing after that decision is arguing with its own
    // rule. The measurement is untouched; only the verdict is.
    const accepted = Boolean(planSlide.keepSmall)
    checks.push(
      accepted && !readable.check.pass
        ? { check: 'readable_font', pass: true, detail: `дрібний шрифт лишено за рішенням людини — ${readable.check.detail ?? ''}`.trim() }
        : readable.check,
    )
    if (readable.over.length) {
      overloads.push({
        slideIndex: i,
        composition: compId,
        slots: readable.over,
        slidesNeeded: Math.max(...readable.over.map(s => s.slidesNeeded)),
        accepted,
      })
    }

    checks.push(checkAutofit(slide))
    checks.push(checkFont(slide))
    checks.push(checkMaxChars(planSlide.slots, compId))
    checks.push(checkContentIntegrity(planSlide.slots, compId, plan.sourceText))
    checks.push(checkBadge(slide, compId, planSlide.slots))
    checks.push(checkLogoOverlap(slide, compId, planSlide.slots))
    // Flat-list rules (plan-level, always run)
    checks.push(checkNoLiteralAsterisk(planSlide.slots))
    checks.push(checkNoDuplicateTitle(plan, i))
    checks.push(checkSourceColumns(planSlide))

    if (compId === 'kpi_cards') {
      const comp = getComposition('kpi_cards')
      checks.push(checkKpiNumeric(planSlide.slots))
      checks.push(checkKpiGap(slide, comp?.gap_min ?? 30))
      checks.push(checkKpiCardRowGeometry(slide))
    }

    if (compId === 'cover') {
      checks.push(checkCoverLayout(slide))
    }

    if (compId === 'badges') {
      checks.push(checkBadgesItems(planSlide.slots))
    }

    if (_V_BENTO_TOKENS[compId]) {
      checks.push(checkBentoLayout(compId, planSlide.slots))
      checks.push(checkBentoTrailingPeriod(compId, planSlide.slots))
    }

    if (compId.startsWith('bento_right_')) {
      checks.push(checkBentoLeftOverlap(slide, compId))
    }

    // deck-level checks — attach to slide 0
    if (i === 0) {
      checks.push(themeCheck)
      checks.push(checkContentCoverage(plan))
      if (plan.sheetCount !== undefined) {
        const pass = plan.slides.length >= plan.sheetCount
        checks.push({
          check: 'slide_count_matches_sheets',
          pass,
          detail: pass
            ? `${plan.slides.length} slides ≥ ${plan.sheetCount} sheets`
            : `${plan.slides.length} slides < ${plan.sheetCount} sheets (slides lost)`,
        })
      }
    }

    const pass = checks.every(c => c.pass)
    results.push({ slideIndex: i, composition: compId, checks, pass })
  }

  const failCount = results.filter(r => !r.pass).length
  const pass      = failCount === 0
  const summary   = pass
    ? `✅ PASS — all ${results.length} slides valid`
    : `❌ FAIL — ${failCount}/${results.length} slides have issues`

  return { pass, presentationId, slides: results, summary, overloads }
}
