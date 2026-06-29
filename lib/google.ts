import { google } from 'googleapis'
import type { slides_v1 } from 'googleapis'
import type { SlidePlan } from './types'
import { PHASE0_COMPOSITIONS, getComposition } from './compositions'
import { validateDeck, type ValidationReport } from './validator'
import { autoPushIfPass } from './auto-push'

// ─── Bento font-size auto-shrink ─────────────────────────────────────────────
// Layout constants must mirror create-master/route.ts
const _PAD = 100, _UW = 1720, _GAP = 30, _INN = 30, _TH = 100, _TG = 100, _H = 1080
const _CY = _PAD + _TH + _TG
const _CH = _H - _PAD - _CY

const _RBW = 860
const _RBH = _H - 2 * _PAD  // 880

// kpi_cards card width (mirrors create-master kw formula)
const _KW = Math.floor((_UW - 3 * _GAP) / 4)  // 407

function bentoDims(compId: string): { w: number; h: number } | null {
  if (compId === 'two_columns') {
    const cw = Math.floor((_UW - _GAP) / 2)
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN }
  }
  if (compId === 'three_columns') {
    const cw = Math.floor((_UW - 2 * _GAP) / 3)
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN }
  }
  if (compId === 'bento_right_2') {
    const cardH = Math.floor((_RBH - _GAP) / 2)
    return { w: _RBW - 2 * _INN, h: cardH - 2 * _INN }
  }
  if (compId === 'bento_right_3') {
    const cardH = Math.floor((_RBH - 2 * _GAP) / 3)
    return { w: _RBW - 2 * _INN, h: cardH - 2 * _INN }
  }
  if (compId === 'bento_right_2x2') {
    const cellW = Math.floor((_RBW - _GAP) / 2)
    const cellH = Math.floor((_RBH - _GAP) / 2)
    return { w: cellW - 2 * _INN, h: cellH - 2 * _INN }
  }
  return null
}

const BENTO_TOKENS: Record<string, string[]> = {
  two_columns:     ['КОЛОНКА_1', 'КОЛОНКА_2'],
  three_columns:   ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3'],
  bento_right_2:   ['КАРТКА_1', 'КАРТКА_2'],
  bento_right_3:   ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3'],
  bento_right_2x2: ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
}

const BENTO_DEFAULT_PT: Record<string, number> = {
  two_columns:     18,
  three_columns:   18,
  bento_right_2:   18,
  bento_right_3:   18,
  bento_right_2x2: 18,
}

const FONT_STEPS = [22, 18, 14, 10] as const

function textFits(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  const px = pt * 2.667
  const cpl = Math.max(1, Math.floor(wPx / (px * 0.48)))   // conservative: Cyrillic chars wider
  const maxLines = Math.max(1, Math.floor(hPx / (px * 1.4))) // conservative; ≥1 so tiny boxes are never 0
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) { cur = w.length }
    else if (cur + 1 + w.length <= cpl) { cur += 1 + w.length }
    else { lines++; cur = w.length }
  }
  return lines <= maxLines
}

// ─── bento_right ТЕКСТ font-shrink ───────────────────────────────────────────
const _LTW  = _UW - _RBW - _GAP  // 830 — left text zone width in bento_right
// ТЕКСТ box h = 480 after logo reserve (RBH-260-GAP-90-20 = 480); no INN padding
const _BENTO_RIGHT_TEXT_H = 480

function pickTextPt(compId: string, text: string): number | null {
  if (!compId.startsWith('bento_right_') || !text.trim()) return null
  const steps = FONT_STEPS.filter(s => s <= 22)  // 22pt default for ТЕКСТ
  for (const pt of steps) {
    if (textFits(text, _LTW, _BENTO_RIGHT_TEXT_H, pt)) return pt
  }
  return steps[steps.length - 1]
}

// ─── Logo ────────────────────────────────────────────────────────────────────
const _FPX    = 9144000 / 1920
const _W      = 1920
const _H_SLIDE = 1080
const _LOGO_W = 90
const _LOGO_H = 90
const _eL     = (px: number) => Math.round(px * _FPX)

// bento_right_* layouts occupy the top-right area — logo goes bottom-left instead
function _logoPos(compId: string): { x: number; y: number } {
  if (compId.startsWith('bento_right_')) {
    return { x: _PAD, y: _H_SLIDE - _PAD - _LOGO_H }
  }
  return { x: _W - _PAD - _LOGO_W, y: _PAD }
}

// Logo URL priority: LOGO_URL env → Vercel static → GitHub public repo
const _GITHUB_LOGO = 'https://raw.githubusercontent.com/SKELAR-Video/presentations-design/main/public/assets/SKELAR%20Symbol.png'

let _logoUrlCache: string | undefined

function getLogoUrl(): string {
  if (_logoUrlCache) return _logoUrlCache
  if (process.env.LOGO_URL) {
    _logoUrlCache = process.env.LOGO_URL
  } else if (process.env.VERCEL_URL) {
    _logoUrlCache = `https://${process.env.VERCEL_URL}/assets/SKELAR%20Symbol.png`
  } else {
    _logoUrlCache = _GITHUB_LOGO
  }
  return _logoUrlCache
}

// Value+label split: if card text is "ЧИСЛО\nПідпис" or "ЧИСЛО: Підпис",
// returns split point so value gets large font and label gets small font.
// Only triggers when the first part contains a digit (metric/number indicator).
function splitValueLabel(text: string): { valueEnd: number; labelStart: number } | null {
  const nlIdx = text.indexOf('\n')
  if (nlIdx > 0 && nlIdx <= 35 && /\d/.test(text.slice(0, nlIdx))) {
    return { valueEnd: nlIdx, labelStart: nlIdx + 1 }
  }
  const colonIdx = text.indexOf(':')
  if (colonIdx > 0 && colonIdx <= 35 && /\d/.test(text.slice(0, colonIdx))) {
    const labelStart = text[colonIdx + 1] === ' ' ? colonIdx + 2 : colonIdx + 1
    return { valueEnd: colonIdx + 1, labelStart }  // include ":" in value range
  }
  return null
}

// Large font size for the VALUE part of a value+label card
const BENTO_VALUE_PT: Record<string, number> = {
  two_columns:     36,
  three_columns:   28,
  bento_right_2:   36,
  bento_right_3:   28,
  bento_right_2x2: 32,
}

// ─── kpi_cards adaptive layout ───────────────────────────────────────────────
// Original master geometry (PAD+TH+subH+TG = 100+100+56+100 = 356; CH = H-PAD-kCY = 624)
// Must stay in sync with create-master/route.ts kpi_cards case.
const _KPI_CY0 = 356   // original kCY
const _KPI_CH0 = 624   // original kCH
const _R       = 30    // rounded-corner radius (same as create-master R)

function estimateLineCount(text: string, wPx: number, pt: number): number {
  if (!text.trim()) return 0
  const px = pt * 2.667
  const cpl = Math.max(1, Math.floor(wPx / (px * 0.48)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) { cur = w.length }
    else if (cur + 1 + w.length <= cpl) { cur += 1 + w.length }
    else { lines++; cur = w.length }
  }
  return lines
}

function lineH(pt: number): number { return pt * 2.667 * 1.4 }

// Build an ABSOLUTE updatePageElementTransform request (intrinsic size = sW × sH EMU)
function makeElemTransform(
  objectId: string,
  x: number, y: number, w: number, h: number,
  intrW: number, intrH: number,
): object {
  const _FPX_LOCAL = 9144000 / 1920
  return {
    updatePageElementTransform: {
      objectId,
      transform: {
        scaleX: (w * _FPX_LOCAL) / intrW,
        shearX: 0, translateX: Math.round(x * _FPX_LOCAL),
        shearY: 0, scaleY: (h * _FPX_LOCAL) / intrH,
        translateY: Math.round(y * _FPX_LOCAL),
        unit: 'EMU',
      },
      applyMode: 'ABSOLUTE',
    },
  }
}

interface KpiAdaptive {
  bodyH: number
  bodyFontPt: number
  cardH: number
  valH: number
  lblH: number
  kCY: number
}

function computeKpiAdaptive(
  slots: Record<string, string>,
  cardMinH: number,
  cardMaxH: number,
  gapMin: number,
): KpiAdaptive {
  const cardTextW = _KW - 2 * _INN  // 347 — inner text zone width
  const VAL_PT = 48, LBL_PT = 14

  // Step 1: Required card height — minimum that fits value + label content
  let reqValLines = 1, reqLblLines = 1
  for (let n = 1; n <= 4; n++) {
    const valText = (slots[`КАРТКА_${n}_ЗНАЧЕННЯ`] ?? '').trim()
    const lblText = (slots[`КАРТКА_${n}_ПІДПИС`] ?? '').trim()
    if (valText) reqValLines = Math.max(reqValLines, estimateLineCount(valText, cardTextW, VAL_PT))
    if (lblText) reqLblLines = Math.max(reqLblLines, estimateLineCount(lblText, cardTextW, LBL_PT))
  }
  const reqInner = Math.ceil(reqValLines * lineH(VAL_PT)) + Math.ceil(reqLblLines * lineH(LBL_PT)) + 16
  const reqCardH = reqInner + 2 * _INN
  const cardH    = Math.max(cardMinH, Math.min(cardMaxH, reqCardH))

  // Step 2: Body available space (cards stick to bottom: kCY = H-PAD-cardH)
  const kpiAvail  = _H - 2 * _PAD - _TH  // 780
  const bodyAvail = kpiAvail - gapMin - cardH

  // Step 3: Body font — reduce only when text doesn't fit at 18pt
  const bodyText = slots['ТЕКСТ'] ?? ''
  let bodyH = 0, bodyFontPt = 18
  if (bodyText.trim()) {
    let found = false
    for (const pt of [18, 14, 10] as const) {
      const h = Math.ceil(estimateLineCount(bodyText, _UW, pt) * lineH(pt)) + 4
      if (h <= Math.max(1, bodyAvail)) {
        bodyFontPt = pt; bodyH = h; found = true; break
      }
    }
    if (!found) {
      bodyFontPt = 10
      bodyH = Math.min(
        Math.ceil(estimateLineCount(bodyText, _UW, 10) * lineH(10)) + 4,
        Math.max(0, bodyAvail),
      )
    }
  }

  // Step 4: Card inner proportions for actual height
  const inner = cardH - 2 * _INN
  const valH  = Math.round(inner * 0.55)
  const lblH  = inner - valH
  const kCY   = _H - _PAD - cardH  // cards stick to bottom of slide

  return { bodyH, bodyFontPt, cardH, valH, lblH, kCY }
}

function buildKpiUpdateRequests(
  slide: slides_v1.Schema$Page,
  layout: KpiAdaptive,
  slots: Record<string, string>,
): object[] {
  const reqs: object[] = []
  const { bodyH, bodyFontPt, cardH, valH, lblH, kCY } = layout
  const TOL = 8

  // 0-indexed card numbers whose ЗНАЧЕННЯ was cleared (non-numeric or absent)
  const emptyCards = new Set<number>()
  for (let n = 1; n <= 4; n++) {
    if (!(slots[`КАРТКА_${n}_ЗНАЧЕННЯ`] ?? '').trim()) emptyCards.add(n - 1)
  }

  for (const el of slide.pageElements ?? []) {
    if (!el.objectId || !el.transform || !el.size) continue
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    const scX = el.transform.scaleX ?? 1
    const scY = el.transform.scaleY ?? 1
    const elX = Math.round((el.transform.translateX ?? 0) / _FPX)
    const elY = Math.round((el.transform.translateY ?? 0) / _FPX)
    const elW = Math.round(sW * scX / _FPX)
    const elH = Math.round(sH * scY / _FPX)

    // ── TEXT_BOX: match by token ──────────────────────────────────────────
    if (el.shape?.shapeType === 'TEXT_BOX') {
      const rawText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')
      const token = rawText.match(/\{\{([^}]+)\}\}/)?.[1]

      if (token === 'ТЕКСТ') {
        reqs.push(makeElemTransform(el.objectId, elX, elY, _UW, Math.max(bodyH, 1), sW, sH))
        if (bodyFontPt !== 18) {
          reqs.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { fontSize: { magnitude: bodyFontPt, unit: 'PT' }, bold: false },
              fields: 'fontSize,bold',
              textRange: { type: 'ALL' },
            },
          })
        }
        continue
      }

      const cardMatch = token?.match(/^КАРТКА_(\d+)_(ЗНАЧЕННЯ|ПІДПИС)$/)
      if (cardMatch) {
        const n  = parseInt(cardMatch[1]) - 1  // 0-indexed
        if (emptyCards.has(n)) {
          reqs.push({ deleteObject: { objectId: el.objectId } })
          continue
        }
        const isVal = cardMatch[2] === 'ЗНАЧЕННЯ'
        const cx    = _PAD + n * (_KW + _GAP)
        const boxY  = isVal ? kCY + _INN : kCY + _INN + valH
        const boxH  = isVal ? valH : lblH
        reqs.push(makeElemTransform(el.objectId, cx + _INN, boxY, _KW - 2 * _INN, boxH, sW, sH))
      }
      continue
    }

    // Only process non-text shapes in the original card zone
    if (elY < _KPI_CY0 - TOL) continue

    // Identify card index by x position
    let k = -1
    for (let ci = 0; ci < 4; ci++) {
      const cx = _PAD + ci * (_KW + _GAP)
      if (elX >= cx - TOL && elX <= cx + _KW + TOL) { k = ci; break }
    }
    if (k < 0) continue

    // Delete all non-text shapes belonging to empty cards
    if (emptyCards.has(k)) {
      reqs.push({ deleteObject: { objectId: el.objectId } })
      continue
    }

    const cx       = _PAD + k * (_KW + _GAP)
    const isBottom = elY > _KPI_CY0 + _KPI_CH0 / 2

    if (el.shape?.shapeType === 'RECTANGLE') {
      if (Math.abs(elW - _KW) < TOL && Math.abs(elH - _KPI_CH0) < TOL) {
        // Card background: resize height + reposition
        reqs.push(makeElemTransform(el.objectId, cx, kCY, _KW, cardH, sW, sH))
      } else if (Math.abs(elW - _R) < TOL && Math.abs(elH - _R) < TOL) {
        // Corner bg square (R×R): move Y only
        const newY = isBottom ? kCY + cardH - _R : kCY
        reqs.push(makeElemTransform(el.objectId, elX, newY, _R, _R, sW, sH))
      }
    }

    if (el.shape?.shapeType === 'ELLIPSE') {
      if (Math.abs(elW - 2 * _R) < TOL && Math.abs(elH - 2 * _R) < TOL) {
        // Corner ellipse (2R×2R): move Y only
        const newY = isBottom ? kCY + cardH - 2 * _R : kCY
        reqs.push(makeElemTransform(el.objectId, elX, newY, 2 * _R, 2 * _R, sW, sH))
      }
    }
  }

  return reqs
}

// Returns the largest step (≤ defaultPt) at which every bento card on the slide fits.
function pickBentoPt(compId: string, slots: Record<string, string>): number | null {
  const dims = bentoDims(compId)
  const tokens = BENTO_TOKENS[compId]
  const defPt = BENTO_DEFAULT_PT[compId]
  if (!dims || !tokens || !defPt) return null
  const steps = FONT_STEPS.filter(s => s <= defPt)
  for (const pt of steps) {
    if (tokens.every(t => textFits(slots[t] ?? '', dims.w, dims.h, pt))) return pt
  }
  return steps[steps.length - 1]  // 14 pt — smallest step, use regardless
}

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

function getSlideNotes(slide: slides_v1.Schema$Page): string {
  return (
    slide.slideProperties?.notesPage?.pageElements
      ?.find(
        (el) =>
          el.shape?.placeholder?.type === 'BODY' ||
          el.shape?.shapeType === 'TEXT_BOX',
      )
      ?.shape?.text?.textElements?.map((te) => te.textRun?.content ?? '')
      .join('') ?? ''
  )
}

export async function buildPresentation(
  accessToken: string,
  plan: SlidePlan,
  title: string,
): Promise<{ url: string; validation: ValidationReport }> {
  const auth = getOAuth2Client(accessToken)
  const drive = google.drive({ version: 'v3', auth })
  const slidesApi = google.slides({ version: 'v1', auth })
  const logoUrl = getLogoUrl()
  const masterDeckId = process.env.MASTER_DECK_ID
  if (!masterDeckId) throw new Error('MASTER_DECK_ID не заданий у .env.local — оновіть його і перезапустіть сервер')

  // Step 1: Copy master deck
  const copyRes = await drive.files.copy({
    fileId: masterDeckId,
    supportsAllDrives: true,
    requestBody: { name: title },
  })
  const presentationId = copyRes.data.id!

  // Step 2: Read slides, build composition → pageId map
  const presentation = await slidesApi.presentations.get({ presentationId })
  const allSlides = presentation.data.slides ?? []

  // Build composition → slide ID map.
  // Primary: speaker notes "composition:<id>".
  // Fallback: slide position matches PHASE0_COMPOSITIONS order.
  const templateCompIds = PHASE0_COMPOSITIONS.map(c => c.id)
  const compMap: Record<string, string[]> = {}
  for (let i = 0; i < allSlides.length; i++) {
    const slide = allSlides[i]
    const notes = getSlideNotes(slide)
    const match = notes.match(/composition:(\w+)/)
    const compId = match?.[1] ?? templateCompIds[i]
    if (compId) {
      if (!compMap[compId]) compMap[compId] = []
      compMap[compId].push(slide.objectId!)
    }
  }

  // Step 2.5: Downgrade over-specified bento/column compositions to match filled card count.
  // Prevents ghost empty cards when LLM picks a layout with more slots than content.
  {
    const DOWNGRADE: Record<string, Record<number, string>> = {
      bento_right_2:   { 0: 'title_body', 1: 'title_body' },
      bento_right_3:   { 0: 'title_body', 1: 'title_body', 2: 'bento_right_2' },
      bento_right_2x2: { 0: 'title_body', 1: 'title_body', 2: 'bento_right_2', 3: 'bento_right_3' },
      two_columns:     { 0: 'title_body', 1: 'title_body' },
      three_columns:   { 0: 'title_body', 1: 'title_body', 2: 'two_columns' },
    }
    for (const slide of plan.slides) {
      const tokens = BENTO_TOKENS[slide.composition]
      if (!tokens) continue
      const filled = tokens.filter(t => !!slide.slots[t]).length
      if (filled >= tokens.length) continue
      const target = DOWNGRADE[slide.composition]?.[filled]
      if (target) slide.composition = target
    }
  }

  // Step 2.6: Enforce max_chars — truncate slot values that exceed composition limits.
  // Applied before any replaceAllText so the API never receives content larger than the slot can display.
  for (const slide of plan.slides) {
    const compDef = getComposition(slide.composition)
    if (!compDef) continue
    for (const slotDef of compDef.slots) {
      if (slotDef.type !== 'text' || !slotDef.max_chars) continue
      const val = slide.slots[slotDef.name]
      if (val && val.length > slotDef.max_chars) {
        console.warn(`[overflow] ${slide.composition}.${slotDef.name}: ${val.length} chars > max ${slotDef.max_chars} — truncated`)
        slide.slots[slotDef.name] = val.slice(0, slotDef.max_chars - 1) + '…'
      }
    }
  }

  // Step 2.65: Sanitise kpi_cards — remove non-numeric КАРТКА_N_ЗНАЧЕННЯ.
  // Non-numeric values pass through Step 2.6 (truncated but still non-numeric).
  // Clearing them here ensures buildKpiUpdateRequests deletes the card elements,
  // preventing a card from rendering with list/sentence text.
  const _KPI_NUMERIC_RE = /^[\d\s+\-±×x.,/%$€£<>≤≥~≈MKBmkb]+$/i
  for (const slide of plan.slides) {
    if (slide.composition !== 'kpi_cards') continue
    for (let n = 1; n <= 4; n++) {
      const key = `КАРТКА_${n}_ЗНАЧЕННЯ`
      const val = (slide.slots[key] ?? '').trim()
      if (!val) continue
      if (!_KPI_NUMERIC_RE.test(val)) {
        console.warn(`[kpi_sanitise] ${slide.id}: ${key} non-numeric ("${val.slice(0, 20)}") — card ${n} removed`)
        delete slide.slots[key]
        delete slide.slots[`КАРТКА_${n}_ПІДПИС`]
      }
    }
  }

  // Step 3: Assign one real pageId to each plan slide; track what needs duplication
  const planPageIds: string[] = []
  const compUsage: Record<string, number> = {}
  const toDuplicate: Array<{ sourceId: string; planIndex: number }> = []

  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    const available = compMap[compId] ?? []
    const useIdx = compUsage[compId] ?? 0
    compUsage[compId] = useIdx + 1

    if (available[useIdx]) {
      planPageIds.push(available[useIdx])
    } else if (available[0]) {
      toDuplicate.push({ sourceId: available[0], planIndex: i })
      planPageIds.push(`__dup_${i}`)
    } else {
      planPageIds.push('')
    }
  }

  // Step 4: Duplicate slides that need it
  if (toDuplicate.length > 0) {
    const dupRes = await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: toDuplicate.map(({ sourceId }) => ({
          duplicateObject: { objectId: sourceId },
        })),
      },
    })
    const newIds = (dupRes.data.replies ?? []).map(
      (r) => r.duplicateObject?.objectId ?? '',
    )
    for (let i = 0; i < toDuplicate.length; i++) {
      planPageIds[toDuplicate[i].planIndex] = newIds[i]
    }
  }

  // Step 5: Build batchUpdate — delete unused slides + replace tokens
  const updatedPres = await slidesApi.presentations.get({ presentationId })
  const updatedSlides = updatedPres.data.slides ?? []

  const keepSet = new Set(planPageIds.filter(Boolean))

  const requests: object[] = []

  // Delete slides not needed by the plan
  for (const slide of updatedSlides) {
    if (!keepSet.has(slide.objectId!)) {
      requests.push({ deleteObject: { objectId: slide.objectId } })
    }
  }

  // Token replacement per slide (scoped to its pageObjectId)
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slideSlots = plan.slides[i].slots
    const compId = plan.slides[i].composition

    // Replace filled slots
    for (const [slotName, slotValue] of Object.entries(slideSlots)) {
      if (!slotValue || slotName.startsWith('ЗОБРАЖЕННЯ')) continue
      requests.push({
        replaceAllText: {
          containsText: { text: `{{${slotName}}}`, matchCase: true },
          replaceText: slotValue,
          pageObjectIds: [pageId],
        },
      })
    }

    // Clear any tokens the LLM didn't fill — avoids visible {{PLACEHOLDER}} in output
    const comp = getComposition(compId)
    if (comp) {
      for (const slot of comp.slots) {
        if (slot.type !== 'text') continue
        const hasValue = !!slideSlots[slot.name]
        if (!hasValue) {
          requests.push({
            replaceAllText: {
              containsText: { text: `{{${slot.name}}}`, matchCase: true },
              replaceText: '',
              pageObjectIds: [pageId],
            },
          })
        }
      }
    }
  }

  // ── kpi_cards adaptive layout ────────────────────────────────────────────────
  // Must run AFTER replaceAllText (so token text is real) but before auto-shrink
  // (so auto-shrink doesn't override the font we choose here).
  const kpiAdaptiveSlides = new Set<number>()
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'kpi_cards') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compDef = getComposition('kpi_cards')
    const slide   = updatedSlides.find(s => s.objectId === pageId)
    if (!compDef || !slide) continue

    const layout = computeKpiAdaptive(
      plan.slides[i].slots,
      compDef.card_min_h ?? 180,
      compDef.card_max_h ?? 624,
      compDef.gap_min   ?? 30,
    )
    requests.push(...buildKpiUpdateRequests(slide, layout, plan.slides[i].slots))
    kpiAdaptiveSlides.add(i)
  }

  // Font-size auto-shrink + colon-split colouring.
  // Runs AFTER replaceAllText — object IDs stay valid, text is already real content.
  const _WHITE = { red: 1, green: 1, blue: 1 }
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const slots  = plan.slides[i].slots
    const pt     = pickBentoPt(compId, slots)
    if (pt === null) continue

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    const bentoTokens = BENTO_TOKENS[compId] ?? []
    for (const el of slide.pageElements ?? []) {
      if (!el.objectId) continue
      const elText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')

      const matchedToken = bentoTokens.find(t => elText.includes(`{{${t}}}`))
      if (!matchedToken) continue
      if (!slots[matchedToken]) continue  // empty card will be deleted — skip style updates

      // 1. Font size (applied to all text in the box)
      requests.push({
        updateTextStyle: {
          objectId: el.objectId,
          style: { fontSize: { magnitude: pt, unit: 'PT' }, bold: false },
          fields: 'fontSize,bold',
          textRange: { type: 'ALL' },
        },
      })

      // 2. Value+label (number + description) OR plain colon-split
      const slotValue = slots[matchedToken] ?? ''
      const split = splitValueLabel(slotValue)
      if (split) {
        // Large value (number/metric) → white; small label → inherits muted from template
        const valuePt = BENTO_VALUE_PT[compId] ?? 36
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: {
              fontSize: { magnitude: valuePt, unit: 'PT' },
              bold: false,
              foregroundColor: { opaqueColor: { rgbColor: _WHITE } },
            },
            fields: 'fontSize,bold,foregroundColor',
            textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: split.valueEnd },
          },
        })
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: 14, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'FIXED_RANGE', startIndex: split.labelStart, endIndex: slotValue.length },
          },
        })
      } else {
        // Plain colon-split: prefix up to and including ":" → WHITE
        const colonIdx = slotValue.indexOf(':')
        if (colonIdx >= 0) {
          requests.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
              fields: 'foregroundColor',
              textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: colonIdx + 1 },
            },
          })
        }
      }
    }
  }

  // ТЕКСТ font-size auto-shrink for bento_right layouts (left column body text)
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const textPt = pickTextPt(compId, plan.slides[i].slots['ТЕКСТ'] ?? '')
    if (textPt === null) continue

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    for (const el of slide.pageElements ?? []) {
      if (!el.objectId) continue
      const elText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')
      if (!elText.includes('{{ТЕКСТ}}')) continue

      requests.push({
        updateTextStyle: {
          objectId: el.objectId,
          style: { fontSize: { magnitude: textPt, unit: 'PT' }, bold: false },
          fields: 'fontSize,bold',
          textRange: { type: 'ALL' },
        },
      })
    }
  }

  // General colon-split for all non-title, non-bento text slots.
  // Rule: prefix up to and including ':' → WHITE (same rule as bento above).
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const slots  = plan.slides[i].slots
    const comp   = getComposition(compId)
    if (!comp) continue

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    for (const slot of comp.slots) {
      if (slot.type !== 'text') continue
      if (slot.name === 'ЗАГОЛОВОК') continue
      if (BENTO_TOKENS[compId]?.includes(slot.name)) continue  // already handled above

      const slotValue = slots[slot.name] ?? ''
      const colonIdx  = slotValue.indexOf(':')
      if (colonIdx < 0) continue

      for (const el of slide.pageElements ?? []) {
        if (!el.objectId) continue
        const elText = (el.shape?.text?.textElements ?? [])
          .map(te => te.textRun?.content ?? '').join('')
        if (!elText.includes(`{{${slot.name}}}`)) continue

        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
            fields: 'foregroundColor',
            textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: colonIdx + 1 },
          },
        })
      }
    }
  }

  // General auto-shrink for text slots that might overflow (all except ЗАГОЛОВОК and bento cards)
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const slots  = plan.slides[i].slots
    const bentoTokens = BENTO_TOKENS[compId] ?? []

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    for (const el of slide.pageElements ?? []) {
      if (!el.objectId || !el.size || !el.transform) continue
      const elText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')

      const tokenMatch = elText.match(/\{\{([^}]+)\}\}/)
      if (!tokenMatch) continue
      const slotName = tokenMatch[1]

      // Skip ЗАГОЛОВОК (large box, multi-line is intentional)
      if (slotName === 'ЗАГОЛОВОК') continue
      // Skip image slots
      if (slotName.startsWith('ЗОБРАЖЕННЯ')) continue
      // Skip bento CARDS (handled by pickBentoPt above)
      if (bentoTokens.includes(slotName)) continue
      // Skip ТЕКСТ in bento_right (handled by pickTextPt above)
      if (compId.startsWith('bento_right_') && slotName === 'ТЕКСТ') continue
      // Skip kpi_cards ТЕКСТ — handled by adaptive layout above
      if (compId === 'kpi_cards' && slotName === 'ТЕКСТ' && kpiAdaptiveSlides.has(i)) continue

      const slotValue = slots[slotName] ?? ''
      if (!slotValue.trim()) continue

      // Use RENDERED dimensions: size.magnitude × transform.scale (intrinsic alone = always 630px)
      const wPx = Math.round((el.size.width?.magnitude  ?? 0) * (el.transform?.scaleX ?? 1) / _FPX)
      const hPx = Math.round((el.size.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1) / _FPX)
      if (!wPx || !hPx) continue

      // Read default pt from template element's text style
      const defaultPt = (el.shape?.text?.textElements ?? [])
        .find(te => te.textRun?.style?.fontSize?.magnitude)
        ?.textRun?.style?.fontSize?.magnitude ?? 18

      const steps = (FONT_STEPS as readonly number[]).filter(s => s <= defaultPt)
      let chosenPt: number | null = null
      for (const pt of steps) {
        if (textFits(slotValue, wPx, hPx, pt)) { chosenPt = pt; break }
      }
      if (chosenPt === null) chosenPt = steps[steps.length - 1] ?? 10
      if (chosenPt >= defaultPt) continue  // already fits at default, no change

      requests.push({
        updateTextStyle: {
          objectId: el.objectId,
          style: { fontSize: { magnitude: chosenPt, unit: 'PT' }, bold: false },
          fields: 'fontSize,bold',
          textRange: { type: 'ALL' },
        },
      })
    }
  }

  // Delete shapes for empty bento card slots — removes ghost cards (rect + corners)
  {
    const deletedIds = new Set<string>()
    for (let i = 0; i < plan.slides.length; i++) {
      const pageId = planPageIds[i]
      if (!pageId) continue
      const compId = plan.slides[i].composition
      const slots  = plan.slides[i].slots
      const bentoTokens = BENTO_TOKENS[compId]
      if (!bentoTokens) continue

      const slide = updatedSlides.find(s => s.objectId === pageId)
      if (!slide) continue

      for (const el of slide.pageElements ?? []) {
        if (!el.objectId || !el.transform || !el.size) continue
        const elText = (el.shape?.text?.textElements ?? [])
          .map(te => te.textRun?.content ?? '').join('')

        const matchedToken = bentoTokens.find(t => elText.includes(`{{${t}}}`))
        if (!matchedToken) continue
        if (slots[matchedToken]) continue  // slot has content, keep card

        // Card is empty — derive card bounds by expanding text-box by INN on all sides
        const tbX = Math.round((el.transform.translateX ?? 0) / _FPX) - _INN
        const tbY = Math.round((el.transform.translateY ?? 0) / _FPX) - _INN
        const tbW = Math.round((el.size.width?.magnitude ?? 0) / _FPX) + 2 * _INN
        const tbH = Math.round((el.size.height?.magnitude ?? 0) / _FPX) + 2 * _INN

        // Delete every element whose centre falls strictly inside the card bounds
        for (const other of slide.pageElements ?? []) {
          if (!other.objectId || !other.transform || !other.size) continue
          if (deletedIds.has(other.objectId)) continue
          const ox = Math.round((other.transform.translateX ?? 0) / _FPX)
          const oy = Math.round((other.transform.translateY ?? 0) / _FPX)
          const ow = Math.round((other.size.width?.magnitude ?? 0) / _FPX)
          const oh = Math.round((other.size.height?.magnitude ?? 0) / _FPX)
          const cx = ox + ow / 2
          const cy = oy + oh / 2
          if (cx > tbX && cx < tbX + tbW && cy > tbY && cy < tbY + tbH) {
            requests.push({ deleteObject: { objectId: other.objectId } })
            deletedIds.add(other.objectId)
          }
        }
      }
    }
  }

  if (requests.length > 0) {
    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    })
  }

  // Logo — separate batch so a bad URL never breaks text replacement
  if (logoUrl) {
    const logoRequests: object[] = []
    for (let i = 0; i < planPageIds.length; i++) {
      const pageId = planPageIds[i]
      if (!pageId) continue
      const lp = _logoPos(plan.slides[i].composition)
      logoRequests.push({
        createImage: {
          objectId: `logo_pl_${i}`,
          url: logoUrl,
          elementProperties: {
            pageObjectId: pageId,
            size: {
              width:  { magnitude: _eL(_LOGO_W), unit: 'EMU' },
              height: { magnitude: _eL(_LOGO_H), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(lp.x),
              shearY: 0, scaleY: 1, translateY: _eL(lp.y),
              unit: 'EMU',
            },
          },
        },
      })
    }
    if (logoRequests.length > 0) {
      try {
        await slidesApi.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: logoRequests },
        })
        console.log(`[logo] inserted ${logoRequests.length} logo(s) ok`)
      } catch (logoErr: unknown) {
        const msg = logoErr instanceof Error ? logoErr.message : String(logoErr)
        console.warn('[logo] logo insertion failed (URL not accessible to Slides API):', msg)
        console.warn('[logo] Set LOGO_URL in .env.local to fix.')
      }
    }
  }

  // Step 6: Reorder slides to match plan order
  const desiredOrder = planPageIds.filter(Boolean)
  if (desiredOrder.length > 1) {
    const moveRequests = desiredOrder.map((slideId, idx) => ({
      updateSlidesPosition: {
        slideObjectIds: [slideId],
        insertionIndex: idx,
      },
    }))
    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: moveRequests },
    })
  }

  const url = `https://docs.google.com/presentation/d/${presentationId}/edit`

  const validation = await validateDeck(slidesApi, presentationId, plan, planPageIds)
  console.log('[validator]', validation.summary)
  for (const sv of validation.slides) {
    if (!sv.pass) {
      const fails = sv.checks
        .filter(c => !c.pass)
        .map(c => `${c.check}${c.detail ? ': ' + c.detail : ''}`)
        .join(' | ')
      console.warn(`[validator] slide ${sv.slideIndex} (${sv.composition}): ${fails}`)
    }
  }

  const compositions = [...new Set(plan.slides.map(s => s.composition))].join(', ')
  autoPushIfPass(validation, `feat(deck): ${plan.slides.length} slides [${compositions}] — validation PASS`)

  return { url, validation }
}
