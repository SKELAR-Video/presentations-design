import type { slides_v1 } from 'googleapis'
import { getComposition } from './compositions'
import type { SlidePlan } from './types'

const _FPX   = 9144000 / 1920  // EMU per Figma px
const _SLIDE_W = 1920
const _SLIDE_H = 1080
const _BOUNDS_TOL = 4           // px — rounding slack

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

export type ValidationReport = {
  pass: boolean
  presentationId: string
  slides: SlideValidation[]
  summary: string
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
// Exemptions: image slots, closing composition (structural / default text).
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

    // (b) verbatim check — closing is structural, skip it
    if (!sourceText || compId === 'closing') continue
    const isKpiValue = /^КАРТКА_\d+_ЗНАЧЕННЯ$/.test(name)
    const lines = v.split('\n').map(l => l.trim()).filter(Boolean)
    for (const line of lines) {
      // NBSP (U+00A0) inserted by addNbsp is a display-only transform — treat as space for verbatim check.
      const normalized = line.replace(/ /g, ' ')
      const verbatimOk = sourceText.includes(normalized)
      const compactOk  = isKpiValue && isCompactNumberMatch(normalized, sourceText)
      // Allow first-letter capitalization when a leading stat was stripped into ЗНАЧЕННЯ
      // or when two_columns_plain body is auto-capitalised by extractColumnLabel.
      const isKpiLabel        = /^КАРТКА_\d+_ПІДПИС$/.test(name)
      const isColumnPlainBody = compId === 'two_columns_plain' && /^КОЛОНКА_\d+$/.test(name)
      const capitalizedOk = (isKpiLabel || isColumnPlainBody) && normalized.length > 0 &&
        sourceText.includes(normalized.charAt(0).toLowerCase() + normalized.slice(1))
      if (!verbatimOk && !compactOk && !capitalizedOk) {
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

function _vTextFits(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  const px = pt * 2.667
  const cpl = Math.max(1, Math.floor(wPx / (px * 0.48)))
  const maxLines = Math.max(1, Math.floor(hPx / (px * 1.4)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) { cur = w.length }
    else if (cur + 1 + w.length <= cpl) { cur += 1 + w.length }
    else { lines++; cur = w.length }
  }
  return lines <= maxLines
}

// Paragraph-aware: mirrors textFitsParagraphs in lib/google.ts.
function _vTextFitsParagraphs(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  const paras = text.split('\n').filter(p => p.trim())
  if (paras.length <= 1) return _vTextFits(text, wPx, hPx, pt)
  const totalLines = paras.reduce((s, p) => s + _vEstimateLines(p, wPx, pt), 0)
  const maxLines   = Math.max(1, Math.floor(hPx / (pt * 2.667 * 1.4)))
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
    if (items.length >= 2) return items.map(item => '• ' + item).join('\n')
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length >= 2) {
    return lines.map(line =>
      (line.startsWith('•') || line.startsWith('-') || line.startsWith('–')) ? line : '• ' + line,
    ).join('\n')
  }
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
  if (uniformPt < 12) fails.push(`font too small (${uniformPt}pt)`)

  const cardHInfo: string[] = []
  for (const tok of tokens) {
    const text = (processedSlots[tok] ?? '').trim()
    if (!text) continue
    if (!_vTextFitsParagraphs(text, dims.w, dims.h, uniformPt)) {
      fails.push(`${tok}: overflows at ${uniformPt}pt`)
      continue
    }
    // Check: bullet separators present when list items detected
    const raw = (slots[tok] ?? '').trim()
    if (raw.includes(' · ') && !text.includes('•')) {
      fails.push(`${tok}: list items joined with · instead of bullet lines`)
    }
    // Estimated card height vs max card zone height
    const paras = text.split('\n').filter(p => p.trim())
    const totalLines = paras.reduce((s, p) => s + _vEstimateLines(p, dims.w, uniformPt), 0)
    const contentH   = Math.round(totalLines * uniformPt * 2.667 * 1.4)
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
  const cur  = (plan.slides[slideIndex].slots['ЗАГОЛОВОК'] ?? '').trim()
  const prev = (plan.slides[slideIndex - 1].slots['ЗАГОЛОВОК'] ?? '').trim()
  const dup  = Boolean(cur && cur === prev)
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
): Promise<ValidationReport> {
  const pres      = await slidesApi.presentations.get({ presentationId })
  const allSlides = pres.data.slides ?? []
  const themeCheck = checkTheme(plan)
  const results: SlideValidation[] = []

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
    checks.push(checkAutofit(slide))
    checks.push(checkFont(slide))
    checks.push(checkMaxChars(planSlide.slots, compId))
    checks.push(checkContentIntegrity(planSlide.slots, compId, plan.sourceText))
    checks.push(checkBadge(slide, compId, planSlide.slots))
    checks.push(checkLogoOverlap(slide, compId, planSlide.slots))
    // Flat-list rules (plan-level, always run)
    checks.push(checkNoLiteralAsterisk(planSlide.slots))
    checks.push(checkNoDuplicateTitle(plan, i))

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

  return { pass, presentationId, slides: results, summary }
}
