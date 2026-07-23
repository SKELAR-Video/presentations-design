import { google } from 'googleapis'
import type { slides_v1 } from 'googleapis'
import type { SlidePlan, DeckFact, SlideDeckFacts, DeckFactReport } from './types'
import { PHASE0_COMPOSITIONS, getComposition } from './compositions'
import { validateDeck, type ValidationReport } from './validator'
import { fixOverflowSlots } from './anthropic'
import { autoPushIfPass } from './auto-push'

// ─── Bento font-size auto-shrink ─────────────────────────────────────────────
// Layout constants must mirror create-master/route.ts
const _PAD = 100, _UW = 1720, _GAP = 30, _INN = 30, _TH = 100, _TG = 100, _H = 1080
const _CY = _PAD + _TH + _TG
const _CH = _H - _PAD - _CY
// Bottom-bento default: cards top at center (H/2=540), bottom at H-PAD=980 → h=440
const _BOTTOM_BENTO_H_DEFAULT = _H - _PAD - Math.floor(_H / 2)  // 440

const _RBW = 860
const _RBH = _H - 2 * _PAD  // 880

// Bento card numbering layout (Figma: 98px number, 40px padding, 30px gap)
const _NUM_PAD      = 11   // px from card edge to number box — matches _INN-_INSET so visual top = visual left = 30px
const _NUM_H        = 100  // px height of number text box (fits 37pt single line)
const _NUM_GAP      = 30   // px gap between number and card text
const _NUM_TEXT_TOP = _NUM_PAD + _NUM_H + _NUM_GAP  // 170 — where card text starts
const _NUM_FONT_PT  = 37   // 98 Figma px / 2.667 ≈ 37pt
// Smaller variant for 3-card bento (cards are 273px — less vertical space)
const _NUM_H_3        = 70   // 26pt single line fits in 70px
const _NUM_GAP_3      = 20
const _NUM_FONT_PT_3  = 26
const _NUM_TEXT_TOP_3 = _NUM_PAD + _NUM_H_3 + _NUM_GAP_3  // 130

// kpi_cards card width (mirrors create-master kw formula)
const _KW = Math.floor((_UW - 3 * _GAP) / 4)  // 407

function bentoDims(compId: string): { w: number; h: number } | null {
  // h = usable inner height inside the TEXT_BOX (after _INN padding on each side).
  // Layout places TEXT_BOX at offset _INN from card edge (then _INSET-compensated),
  // so inner content height = cardH - 2*_INN — must match pickBentoPt's height check.
  if (compId === 'two_columns') {
    const cw = Math.floor((_UW - _GAP) / 2)
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN }
  }
  if (compId === 'two_columns_labeled' || compId === 'two_columns_plain') {
    const cw = Math.floor((_UW - 50) / 2)  // 50px gap, no INN (flat layout)
    return { w: cw, h: _H - _PAD - 540 }   // content area y=540→980
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
  if (compId === 'three_columns_num') {
    const cw = Math.floor((_UW - 2 * 50) / 3)  // 540 — no card INN padding
    return { w: cw, h: _H - _PAD - 540 }        // {w: 540, h: 440}
  }
  if (compId === 'three_columns_timeline') {
    // conservative: max title=300px → dotsY=textY=478 → h=502; w=zone_w-dot-gap=496
    return { w: 496, h: 502 }
  }
  if (compId === 'two_columns_timeline') {
    // conservative: max title=300px → dotsY=textY=478 → h=502
    return { w: 623, h: 502 }
  }
  if (compId === 'bento_bottom_4' || compId === 'four_columns' || compId === 'four_columns_num') {
    const cw = Math.floor((_UW - 3 * _GAP) / 4)  // 407
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN }  // {w: 347, h: 620}
  }
  if (compId === 'four_columns_paren' || compId === 'four_columns_bubble') {
    const cw = Math.floor((_UW - 3 * 50) / 4)  // 392 — flat style, gap=50, no card INN padding
    return { w: cw, h: _H - _PAD - 540 }        // {w: 392, h: 440}
  }
  return null
}

const BENTO_TOKENS: Record<string, string[]> = {
  two_columns:         ['КОЛОНКА_1', 'КОЛОНКА_2'],
  two_columns_labeled: ['КОЛОНКА_1', 'КОЛОНКА_2'],
  two_columns_plain:   ['КОЛОНКА_1', 'КОЛОНКА_2'],
  three_columns:          ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3'],
  three_columns_num:      ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3'],
  three_columns_timeline: ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3'],
  two_columns_timeline:   ['КОЛОНКА_1', 'КОЛОНКА_2'],
  four_columns:      ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
  four_columns_num:  ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
  bento_bottom_4:       ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
  four_columns_paren:   ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
  four_columns_bubble:  ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
  bento_right_2:     ['КАРТКА_1', 'КАРТКА_2'],
  bento_right_3:     ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3'],
  bento_right_2x2:   ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4'],
}

// Role-max font size per composition (start here; shrink only if text overflows).
// Values from Figma: 2-card → 48pt possible for short text, 3-card → 28pt ceiling.
const BENTO_MAX_PT: Record<string, number> = {
  two_columns:         28,
  two_columns_labeled: 36,
  two_columns_plain:   36,
  three_columns:          28,
  three_columns_num:      18,
  three_columns_timeline: 28,
  two_columns_timeline:   28,
  four_columns:      22,
  four_columns_num:  18,
  bento_bottom_4:      22,
  four_columns_paren:  22,
  four_columns_bubble: 22,
  bento_right_2:     36,
  bento_right_3:     22,
  bento_right_2x2:   22,
}

// Floor: chosen pt is never smaller than this value.
// If even floor pt overflows → log ⚠ TEXT_TOO_LONG (content is too long for this card type).
const BENTO_MIN_PT: Record<string, number> = {
  two_columns:         18,
  two_columns_labeled: 14,
  two_columns_plain:   14,
  three_columns:          14,
  three_columns_num:      10,
  three_columns_timeline: 14,
  two_columns_timeline:   14,
  four_columns:      10,
  four_columns_num:  10,
  bento_bottom_4:      10,
  four_columns_paren:  10,
  four_columns_bubble: 10,
  bento_right_2:     18,
  bento_right_3:     14,
  bento_right_2x2:   14,
}

const FONT_STEPS = [22, 18, 14, 10] as const
// Full scale including large sizes for upward scaling
const BENTO_SCALE = [48, 36, 28, 22, 18, 14, 10] as const

function textFits(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  if (longestWordPx(text, pt) * 1.1 > wPx) return false  // 1.1× safety margin
  // cpl uses same 0.65 factor as longestWordPx — consistent width estimate
  const cpl   = Math.max(1, Math.floor(wPx / (pt * 2.667 * 0.65)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) { cur = w.length }
    else if (cur + 1 + w.length <= cpl) { cur += 1 + w.length }
    else { lines++; cur = w.length }
  }
  return lines * lineH(pt) <= hPx  // exact height: lines × lineH ≤ inner_height
}

// Paragraph-aware variant: splits on \n first so each paragraph starts on a new line.
// textFits() treats \n as a space (wrong for bullet lists). This correctly sums lines per paragraph.
function textFitsParagraphs(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  if (longestWordPx(text, pt) * 1.1 > wPx) return false  // 1.1× safety margin
  const paras = text.split('\n').filter(p => p.trim())
  if (paras.length <= 1) return textFits(text, wPx, hPx, pt)
  // Multi-paragraph: same 0.65 factor for consistent line-count estimation
  const cpl = Math.max(1, Math.floor(wPx / (pt * 2.667 * 0.65)))
  const totalLines = paras.reduce((s, p) => {
    const words = p.split(/\s+/).filter(Boolean)
    let lines = 1, cur = 0
    for (const w of words) {
      if (!cur) cur = w.length
      else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
      else { lines++; cur = w.length }
    }
    return s + lines
  }, 0)
  return totalLines * lineH(pt) <= hPx  // exact height check
}

// ─── bento_right ТЕКСТ font-shrink ───────────────────────────────────────────
const _LTW  = _UW - _RBW - _GAP  // 830 — left text zone width in bento_right

// Font size steps for bento_right titles (narrowest zone: 830px).
// Largest pt where the longest word fits horizontally (no mid-word break).
const TITLE_PT_STEPS = [44, 40, 36, 32, 28] as const
type TitlePt = typeof TITLE_PT_STEPS[number]

// Returns estimated render width (px) of the longest whitespace-delimited word at given pt.
// Factor 0.65: conservative for Inter Medium with Cyrillic wide glyphs (Ф, Ш, Щ, Ж etc.).
// Strips leading/trailing punctuation before measuring — "активність," counts as 10 chars, not 11.
function longestWordPx(text: string, pt: number): number {
  const pxPerChar = pt * 2.667 * 0.65
  const words = text.trim().split(/\s+/).filter(Boolean)
  const coreLen = (w: string) => w.replace(/^[.,;:!?«»"'()\[\]{}\-–—]+|[.,;:!?«»"'()\[\]{}\-–—]+$/g, '').length || w.length
  return words.length === 0 ? 0 : Math.round(Math.max(...words.map(w => coreLen(w) * pxPerChar)))
}

// Logs word-fit check in the standard format for every text box.
// PASS iff longestWordPx(text, pt) × 1.1 ≤ innerW.
function logWordFit(label: string, text: string, innerW: number, pt: number): void {
  if (!text.trim()) return
  const words = text.trim().split(/\s+/).filter(Boolean)
  const longestWord = words.reduce((a, b) => a.length >= b.length ? a : b, '')
  const est  = longestWordPx(text, pt)
  const est11 = Math.round(est * 1.1)
  const pass  = est11 <= innerW
  console.log(
    `[word-fit] ${label}: longest_word_len=${longestWord.length} | est_width=${est} | est×1.1=${est11} | inner_width=${innerW} | chosen_font=${pt} → ${pass ? 'PASS' : 'FAIL'}`,
  )
}

// Choose largest title pt where the longest word (×1.2 safety margin) fits in wPx.
// Effective limit = wPx - 19 (same INSET offset used everywhere for rendering imprecision).
// Prevents borderline 9-char Cyrillic words (e.g. "щоденного") from visually breaking.
function pickTitlePt(text: string, wPx: number): TitlePt {
  for (const pt of TITLE_PT_STEPS) {
    if (longestWordPx(text, pt) * 1.2 <= wPx - 19) return pt  // 19 = _INSET buffer
  }
  return TITLE_PT_STEPS[TITLE_PT_STEPS.length - 1]
}

// Compute actual available height for ТЕКСТ given a (possibly long) title.
// Uses exact text height (no minimum floor) so textY is as high as possible.
function bentoRightTextAvailH(titleText: string): number {
  const titlePt  = pickTitlePt(titleText.trim(), _LTW)
  const tLines   = estimateLineCount(titleText.trim(), _LTW, titlePt)
  const logoY    = _H_SLIDE - _PAD - _LOGO_H
  const maxTitleH = logoY - TITLE_GAP - _PAD - 20  // 710 — mirrors buildBentoRightLeftColumnRequests cap
  const dynH     = Math.min(Math.ceil(tLines * lineH(titlePt)), maxTitleH)
  const textY    = _PAD + dynH + TITLE_GAP
  return Math.max(50, logoY - 20 - textY)
}

function pickTextPt(compId: string, text: string, availH?: number): number | null {
  if (!compId.startsWith('bento_right_') || !text.trim()) return null
  const h     = availH ?? (_H_SLIDE - _PAD - _LOGO_H - 20 - (_PAD + _H1_FIXED_44 + TITLE_GAP))
  const steps = FONT_STEPS.filter(s => s <= 22)  // 22pt default for ТЕКСТ
  for (const pt of steps) {
    if (textFits(text, _LTW, h, pt)) return pt
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
// Safe title width: right edge = LOGO_X − 20 = 1710, clears logo zone by LOGO_GAP
const _LOGO_X  = _W - _PAD - _LOGO_W  // 1730
const _TITLE_W = _LOGO_X - 20 - _PAD  // 1610 (20 = logo_gap)
const _INSET   = 19  // Figma px — Google Slides default content inset (~0.25cm); REST API v1 cannot set to 0

// Fixed title/subtitle box heights — 2-line comfortable capacity at role font size.
// Positions of elements below (ТЕКСТ, ПІДЗАГОЛОВОК, ДАТА) are therefore constant.
// software auto-shrink loop handles longer titles; positions stay fixed.
const _H1_FIXED_44  = 260  // 44pt headings: 2 × (44×2.667×1.08) ≈ 254 → 260
const _H1_FIXED_36  = 220  // 36pt headings: 2 × (36×2.667×1.08) ≈ 208 → 220
const _SUB_FIXED_22 = 130  // 22pt cover subtitle: 2-line comfortable capacity
const _DATE_FIXED   = 70   // 18pt cover date: 1-line comfortable capacity

// bento_right_* layouts occupy the top-right area — logo goes bottom-left instead
function _logoPos(compId: string): { x: number; y: number } {
  if (compId.startsWith('bento_right_') || compId === 'title_photo') {
    return { x: _PAD, y: _H_SLIDE - _PAD - _LOGO_H }
  }
  return { x: _W - _PAD - _LOGO_W, y: _PAD }
}

// Logo URL priority: LOGO_URL env → Vercel static → GitHub public repo
const _GITHUB_LOGO          = 'https://raw.githubusercontent.com/SKELAR-Video/presentations-design/main/public/assets/SKELAR%20Symbol.png'
const _GITHUB_LOGO_RED      = 'https://raw.githubusercontent.com/SKELAR-Video/presentations-design/main/public/assets/SKELAR%20Symbol%20for%20red.png'
const _GITHUB_LOGO_WORDMARK = 'https://raw.githubusercontent.com/SKELAR-Video/presentations-design/main/public/assets/SKELAR%20Logo.png'
// SKELAR Logo.png (full wordmark) dimensions — from Figma design
const _LOGO_WORDMARK_W = 357  // 357.49px → round to 357
const _LOGO_WORDMARK_X = _W - _PAD - _LOGO_WORDMARK_W  // 1463
const _LOGO_WORDMARK_Y = 99   // from Figma (= PAD - 1)

// Background images. Index 0–5 → Mountain 0–5.
// Priority: BG_BASE_URL env → Vercel static → GitHub public repo (private repo = won't work).
const _GITHUB_BG_BASE = 'https://raw.githubusercontent.com/SKELAR-Video/presentations-design/main/public/assets/backgrounds/'
const _BG_COUNT = 6
function getBgBaseUrl(): string {
  if (process.env.BG_BASE_URL) return process.env.BG_BASE_URL.replace(/\/?$/, '/')
  // VERCEL_PROJECT_PRODUCTION_URL is the stable production hostname (e.g. my-app.vercel.app).
  // VERCEL_URL is the per-deployment hostname — also works but changes each deploy.
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
  if (host) return `https://${host}/assets/backgrounds/`
  return _GITHUB_BG_BASE
}
function randomCoverBg(): string {
  const idx = Math.floor(Math.random() * _BG_COUNT)
  const url = `${getBgBaseUrl()}Mountain%20${idx}.png`
  console.log(`[bg] image URL: ${url}`)
  return url
}

// ── title_photo helpers ─────────────────────────────────────────────────────
const _TP_TITLE_W     = 827
const _TP_TITLE_H     = 341
const _TP_TITLE_SCALE = [33, 28, 22, 18, 14] as const
const _HALF_PHOTOS    = ['1.png', '2.png', '3.png', '4.png', '5.png'] as const

function getHalfPhotoBaseUrl(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
  if (host) return `https://${host}/assets/half%20screen%20photos/`
  return _GITHUB_BG_BASE.replace('backgrounds/', 'half%20screen%20photos/')
}

function getHalfPhotoUrl(customUrl?: string): string {
  if (customUrl?.startsWith('http')) return customUrl
  const base = getHalfPhotoBaseUrl()
  const file = _HALF_PHOTOS[Math.floor(Math.random() * _HALF_PHOTOS.length)]
  return `${base}${file}`
}

function pickTitlePhotoPt(title: string): number {
  for (const pt of _TP_TITLE_SCALE) {
    if (textFits(title, _TP_TITLE_W, _TP_TITLE_H, pt)) return pt
  }
  return 14
}

let _logoUrlCache: string | undefined
let _logoRedUrlCache: string | undefined

function getLogoUrl(): string {
  if (_logoUrlCache) return _logoUrlCache
  if (process.env.LOGO_URL) {
    _logoUrlCache = process.env.LOGO_URL
  } else {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
    _logoUrlCache = host ? `https://${host}/assets/SKELAR%20Symbol.png` : _GITHUB_LOGO
  }
  return _logoUrlCache
}

function getLogoRedUrl(): string {
  if (_logoRedUrlCache) return _logoRedUrlCache
  if (process.env.LOGO_RED_URL) {
    _logoRedUrlCache = process.env.LOGO_RED_URL
  } else {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
    _logoRedUrlCache = host ? `https://${host}/assets/SKELAR%20Symbol%20for%20red.png` : _GITHUB_LOGO_RED
  }
  return _logoRedUrlCache
}

let _logoWordmarkUrlCache: string | undefined
function getLogoWordmarkUrl(): string {
  if (_logoWordmarkUrlCache) return _logoWordmarkUrlCache
  if (process.env.LOGO_WORDMARK_URL) {
    _logoWordmarkUrlCache = process.env.LOGO_WORDMARK_URL
  } else if (process.env.LOGO_URL) {
    // Derive from LOGO_URL — strip filename after last '/', append wordmark filename
    const base = process.env.LOGO_URL.replace(/[^/]+$/, '')
    _logoWordmarkUrlCache = `${base}SKELAR%20Logo.png`
  } else {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
    _logoWordmarkUrlCache = host ? `https://${host}/assets/SKELAR%20Logo.png` : _GITHUB_LOGO_WORDMARK
  }
  return _logoWordmarkUrlCache
}

// Value+label split: if card text is "ЧИСЛО\nПідпис" or "ЧИСЛО: Підпис",
// returns split point so value gets large font and label gets small font.
// Only triggers when the first part contains a digit (metric/number indicator).
// Detects "Label — Body" or "Label: Body" in flat two-column content.
// Used to auto-populate ПІДПИС (gray) + trim КОЛОНКА (white) at generation time.
function extractColumnLabel(text: string): { label: string; body: string } | null {
  const hasLetter = /[a-zA-Zа-яА-ЯіІїЇєЄ'ʼ]/
  const emDash = text.search(/ [—–] /)  // em dash or en dash surrounded by spaces
  if (emDash > 0 && emDash <= 60) {
    const label = text.slice(0, emDash).trim()
    const body  = text.slice(emDash + 3).trim()
    // skip when label is a numeric metric — it's a value, not a category name
    if (label && body && hasLetter.test(label)) return { label, body: body.charAt(0).toUpperCase() + body.slice(1) }
  }
  const colon = text.indexOf(': ')
  if (colon > 0 && colon <= 60) {
    const label = text.slice(0, colon).trim()
    const body  = text.slice(colon + 2).trim()
    if (label && body && hasLetter.test(label)) return { label, body: body.charAt(0).toUpperCase() + body.slice(1) }
  }
  return null
}

function splitValueLabel(text: string): { valueEnd: number; labelStart: number } | null {
  const nlIdx = text.indexOf('\n')
  if (nlIdx > 0 && nlIdx <= 12 && /^\s*[\d$€£±~≈<>]/.test(text.slice(0, nlIdx))) {
    return { valueEnd: nlIdx, labelStart: nlIdx + 1 }
  }
  const colonIdx = text.indexOf(':')
  if (colonIdx > 0 && colonIdx <= 12 && /^\s*[\d$€£±~≈<>]/.test(text.slice(0, colonIdx))) {
    const labelStart = text[colonIdx + 1] === ' ' ? colonIdx + 2 : colonIdx + 1
    return { valueEnd: colonIdx + 1, labelStart }  // include ":" in value range
  }
  return null
}

// Large font size for the VALUE part of a value+label card
const BENTO_VALUE_PT: Record<string, number> = {
  two_columns:     36,
  three_columns:   28,
  bento_bottom_4:  28,
  bento_right_2:   36,
  bento_right_3:   28,
  bento_right_2x2: 32,
}

// ─── kpi_cards adaptive layout ───────────────────────────────────────────────
// Original master geometry (PAD+TH+subH+TG = 100+100+56+100 = 356; CH = H-PAD-kCY = 624)
// Must stay in sync with create-master/route.ts kpi_cards case.
const _KPI_CY0     = 356   // original kCY
const _KPI_CH0     = 624   // original kCH
const _R           = 30    // rounded-corner radius (same as create-master R)
const KPI_VERT_PAD = 30   // comfortable padding above value and below label in kpi_cards

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
  n: number            // active card count (1–4)
  cw: number           // dynamic card width: floor((UW - (n-1)*GAP) / n)
  activeIdxs: number[] // 0-based indices of non-empty cards
  bodyH: number
  bodyFontPt: number
  cardH: number
  valH: number
  lblH: number
  kCY: number
  valPt: number        // font pt for ЗНАЧЕННЯ (= largest from scale that fits)
}

function computeKpiAdaptive(
  slots: Record<string, string>,
  cardMinH: number,
  cardMaxH: number,
  _gapMin: number,
): KpiAdaptive {
  // ── Active cards: ordered 0-based indices of non-empty cards ─────────────
  const activeIdxs: number[] = []
  for (let i = 0; i < 4; i++) {
    if ((slots[`КАРТКА_${i + 1}_ЗНАЧЕННЯ`] ?? '').trim()) activeIdxs.push(i)
  }
  const n = Math.max(1, activeIdxs.length)

  // ── Dynamic card width: row fills PAD → PAD+UW ───────────────────────────
  // n=1→1720, n=2→845, n=3→553, n=4→407
  const cw = Math.floor((_UW - (n - 1) * _GAP) / n)
  const cardTextW = cw - 2 * _INN

  // ── Body text: shrink font until there is enough room below for cards ─────
  const bodyText = (slots['ТЕКСТ'] ?? '').trim()
  let bodyH = 0, bodyFontPt = 18
  if (bodyText) {
    let found = false
    for (const pt of [18, 14, 10] as const) {
      const h = Math.ceil(estimateLineCount(bodyText, _UW, pt) * lineH(pt)) + 4
      // Body must leave room for at least the default card height (center→bottom = 440px)
      if (_H - _PAD - (_PAD + _TH + h + _TG) >= _BOTTOM_BENTO_H_DEFAULT) {
        bodyFontPt = pt; bodyH = h; found = true; break
      }
    }
    if (!found) {
      bodyFontPt = 10
      bodyH = Math.min(
        Math.ceil(estimateLineCount(bodyText, _UW, 10) * lineH(10)) + 4,
        Math.max(0, _H - _PAD - _PAD - _TH - _TG - _BOTTOM_BENTO_H_DEFAULT),
      )
    }
  }

  // ── ЗНАЧЕННЯ font: UP to role size (48pt), DOWN only when text is too wide ──
  // Width-only check — height is content-driven (no fixed box to fit into).
  const VAL_SCALE = [48, 36, 28, 22, 18, 14] as const
  let valPt: number = VAL_SCALE[VAL_SCALE.length - 1]
  for (const pt of VAL_SCALE) {
    const allFit = activeIdxs.every(idx => {
      const val = (slots[`КАРТКА_${idx + 1}_ЗНАЧЕННЯ`] ?? '').trim()
      return !val || estimateLineCount(val, cardTextW, pt) <= 3  // max 3 lines for value
    })
    if (allFit) { valPt = pt; break }
  }

  // ── Card height: content-based, tight group (value + gap + label) ─────────
  let maxValH = 0, maxLblH = 0
  for (const idx of activeIdxs) {
    const valText = (slots[`КАРТКА_${idx + 1}_ЗНАЧЕННЯ`] ?? '').trim()
    const lblText = (slots[`КАРТКА_${idx + 1}_ПІДПИС`]   ?? '').trim()
    const vH = Math.ceil(estimateLineCount(valText, cardTextW, valPt) * lineH(valPt))
    const lH = Math.ceil(estimateLineCount(lblText, cardTextW, 14) * lineH(14))
    if (vH > maxValH) maxValH = vH
    if (lH > maxLblH) maxLblH = lH
  }
  const valH        = Math.max(Math.ceil(lineH(valPt)), maxValH)  // at least 1 line
  const lblH        = Math.max(Math.ceil(lineH(14)),    maxLblH)
  const contentCardH = valH + lblH + 2 * _INN + 2 * KPI_VERT_PAD

  // ── Card Y: bottom = 980 (fixed), top defaults to center (540), expands up as needed ──
  // minTopY = header area bottom = PAD+TH+bodyH+TG (hard ceiling; cards can't go above title)
  const minTopY  = _PAD + _TH + bodyH + _TG
  const desiredKCY = _H - _PAD - Math.max(contentCardH, _BOTTOM_BENTO_H_DEFAULT)
  const kCY = Math.max(desiredKCY, minTopY)
  const cardH = _H - _PAD - kCY

  return { n, cw, activeIdxs, bodyH, bodyFontPt, cardH, valH, lblH, kCY, valPt }
}

function buildKpiUpdateRequests(
  slide: slides_v1.Schema$Page,
  layout: KpiAdaptive,
  slots: Record<string, string>,
): object[] {
  const reqs: object[] = []
  const { cw, activeIdxs, bodyH, bodyFontPt, cardH, valH, lblH, kCY, valPt } = layout
  const TOL    = 8
  const LBL_PT = 14

  // Map original 0-based card index → display position (0..n-1)
  // e.g. if only cards 0 and 2 are active: {0→0, 2→1}
  const displayPos = new Map<number, number>(
    activeIdxs.map((origIdx, di) => [origIdx, di]),
  )

  for (const el of slide.pageElements ?? []) {
    if (!el.objectId || !el.transform || !el.size) continue
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    const elX = Math.round((el.transform.translateX ?? 0) / _FPX)
    const elY = Math.round((el.transform.translateY ?? 0) / _FPX)
    const elW = Math.round(sW * (el.transform.scaleX ?? 1) / _FPX)
    const elH = Math.round(sH * (el.transform.scaleY ?? 1) / _FPX)

    // ── TEXT_BOX: match by token ──────────────────────────────────────────
    if (el.shape?.shapeType === 'TEXT_BOX') {
      const rawText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')
      const token = rawText.match(/\{\{([^}]+)\}\}/)?.[1]

      if (token === 'ТЕКСТ') {
        // No top expansion: box y stays at _PAD+_TH to avoid overlapping logo zone (y=[100,190])
        reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD + _TH, _UW + 2 * _INSET, Math.max(bodyH, 1) + _INSET, sW, sH))
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
        const origIdx = parseInt(cardMatch[1]) - 1  // 0-based
        if (!displayPos.has(origIdx)) {
          reqs.push({ deleteObject: { objectId: el.objectId } })
          continue
        }
        const di    = displayPos.get(origIdx)!
        const cx    = _PAD + di * (cw + _GAP)
        const isVal = cardMatch[2] === 'ЗНАЧЕННЯ'
        // Tight group: KPI_VERT_PAD above value, value immediately above label
        const boxY  = isVal
          ? kCY + _INN + KPI_VERT_PAD
          : kCY + _INN + KPI_VERT_PAD + valH
        const boxH  = isVal ? valH : lblH
        reqs.push(makeElemTransform(el.objectId, cx + _INN - _INSET, boxY - _INSET, cw - 2 * _INN + 2 * _INSET, boxH + 2 * _INSET, sW, sH))
        // Apply font size only when it differs from the master default
        if (isVal && valPt !== 48) {
          reqs.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { fontSize: { magnitude: valPt, unit: 'PT' }, bold: false },
              fields: 'fontSize,bold',
              textRange: { type: 'ALL' },
            },
          })
        }
        if (!isVal && LBL_PT !== 14) {  // future-proof in case master changes
          reqs.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { fontSize: { magnitude: LBL_PT, unit: 'PT' }, bold: false },
              fields: 'fontSize,bold',
              textRange: { type: 'ALL' },
            },
          })
        }
        continue
      }
      continue
    }

    // ── Non-text shapes: only in original card zone ───────────────────────
    if (elY < _KPI_CY0 - TOL) continue

    // Identify original card index by x (master always uses 4-card _KW layout)
    let k = -1
    for (let ci = 0; ci < 4; ci++) {
      const origCx = _PAD + ci * (_KW + _GAP)
      if (elX >= origCx - TOL && elX <= origCx + _KW + TOL) { k = ci; break }
    }
    if (k < 0) continue

    if (!displayPos.has(k)) {
      reqs.push({ deleteObject: { objectId: el.objectId } })
      continue
    }

    const di      = displayPos.get(k)!
    const cx      = _PAD + di * (cw + _GAP)      // new display x
    const origCx  = _PAD + k  * (_KW + _GAP)     // original master x
    const isBottom = elY > _KPI_CY0 + _KPI_CH0 / 2

    if (el.shape?.shapeType === 'RECTANGLE') {
      if (Math.abs(elW - _KW) < TOL && Math.abs(elH - _KPI_CH0) < TOL) {
        // Card background: resize width + height, reposition
        reqs.push(makeElemTransform(el.objectId, cx, kCY, cw, cardH, sW, sH))
      } else if (Math.abs(elW - _R) < TOL && Math.abs(elH - _R) < TOL) {
        // Corner bg square (R×R): left vs right side
        const isRightCorner = Math.abs(elX - (origCx + _KW - _R)) < TOL
        const newX = isRightCorner ? cx + cw - _R : cx
        const newY = isBottom ? kCY + cardH - _R : kCY
        reqs.push(makeElemTransform(el.objectId, newX, newY, _R, _R, sW, sH))
      }
    }

    if (el.shape?.shapeType === 'ELLIPSE') {
      if (Math.abs(elW - 2 * _R) < TOL && Math.abs(elH - 2 * _R) < TOL) {
        // Corner ellipse (2R×2R)
        const isRightEllipse = Math.abs(elX - (origCx + _KW - 2 * _R)) < TOL
        const newX = isRightEllipse ? cx + cw - 2 * _R : cx
        const newY = isBottom ? kCY + cardH - 2 * _R : kCY
        reqs.push(makeElemTransform(el.objectId, newX, newY, 2 * _R, 2 * _R, sW, sH))
      }
    }
  }

  return reqs
}

// ─── Badges: pill layout constants ────────────────────────────────────────────
const _BADGE_PT     = 18
const _BADGE_H_PAD  = 30  // horizontal inner padding (px)
const _BADGE_V_PAD  = 30  // vertical inner padding (px)
// Single-line height with lineSpacing=90: pt × 2.667 × 0.9
const _BADGE_LINE_H = Math.round(_BADGE_PT * 2.667 * 0.9)  // ≈ 43px
const _BADGE_H      = _BADGE_V_PAD * 2 + _BADGE_LINE_H     // ≈ 103px
// Per-char width: space ≈13 px (narrow), regular Cyrillic ≈27 px (Inter 500 18pt = 48 display-px)
const _BADGE_LETTER_W = 27
const _BADGE_SPACE_W  = 13
const _BADGE_GAP_H  = 16  // horizontal gap between badges
const _BADGE_GAP_V  = 16  // vertical gap between rows
const _BADGE_BG  = { red: 26  / 255, green: 31  / 255, blue: 46  / 255 }  // #1A1F2E = CARD color
const _BADGE_FG  = { red: 162 / 255, green: 166 / 255, blue: 177 / 255 }  // #A2A6B1 = secondary text

// Float ЗАГОЛОВОК + delete ПУНКТИ placeholder + create pill shapes.
// ПУНКТИ slot: items separated by \n (strip any leading •/-/– prefix at display time).
// Uses ROUND_RECTANGLE for badge background — corner radius auto-proportional (~20px for h≈103px).
function buildBadgesRequests(
  slideIndex: number,
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
  pageId: string,
): object[] {
  const reqs: object[] = []

  const titleText  = (slots['ЗАГОЛОВОК'] ?? '').trim()
  const punkyText  = (slots['ПУНКТИ']    ?? '').trim()
  if (!titleText) return reqs

  // Float ЗАГОЛОВОК — fixed 2-line height; software auto-shrink handles longer titles
  const titleH = _H1_FIXED_36
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    if (!raw.includes('{{ЗАГОЛОВОК}}')) continue
    const sW = el.size.width?.magnitude  ?? 0
    const sH = el.size.height?.magnitude ?? 0
    reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, _TITLE_W + 2 * _INSET, titleH + 2 * _INSET, sW, sH))
  }

  if (!punkyText) return reqs

  // Delete ПУНКТИ placeholder text box
  for (const el of slide.pageElements ?? []) {
    if (!el.objectId) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    if (raw.includes('{{ПУНКТИ}}')) {
      reqs.push({ deleteObject: { objectId: el.objectId } })
      break
    }
  }

  const badgeZoneY = _PAD + titleH + TITLE_GAP

  const items = punkyText
    .split('\n')
    .map(s => s.replace(/^[•\-–*]\s*/, '').trim())
    .filter(Boolean)

  let x = _PAD
  let y = badgeZoneY

  for (let bi = 0; bi < items.length; bi++) {
    const label = items[bi]
    let textW = 0
    for (const ch of label) textW += ch === ' ' ? _BADGE_SPACE_W : _BADGE_LETTER_W
    const bw    = Math.round(textW + 2 * _BADGE_H_PAD)

    // Wrap row when badge doesn't fit
    if (bi > 0 && x + bw > _PAD + _UW) {
      x  = _PAD
      y += _BADGE_H + _BADGE_GAP_V
    }

    // Stop if outside slide safe area
    if (y + _BADGE_H > _H_SLIDE - _PAD) break

    const bgId  = `bdg_${slideIndex}_${bi}_b`
    const txtId = `bdg_${slideIndex}_${bi}_t`

    // Badge background: ROUND_RECTANGLE (auto-proportional corners ≈ 20px at this height)
    reqs.push({
      createShape: {
        objectId: bgId,
        shapeType: 'ROUND_RECTANGLE',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            width:  { magnitude: _eL(bw),      unit: 'EMU' },
            height: { magnitude: _eL(_BADGE_H), unit: 'EMU' },
          },
          transform: { scaleX: 1, shearX: 0, translateX: _eL(x), shearY: 0, scaleY: 1, translateY: _eL(y), unit: 'EMU' },
        },
      },
    })
    reqs.push({
      updateShapeProperties: {
        objectId: bgId,
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { rgbColor: _BADGE_BG } } },
          outline: { propertyState: 'NOT_RENDERED' },
        },
        fields: 'shapeBackgroundFill,outline',
      },
    })

    // Text box spans full badge width so text never wraps regardless of font metrics.
    // bw = textW + 60px → effective render zone ≥ actual text width even if per-char
    // estimate undershoots (e.g. wide Cyrillic glyphs like Ф, Ж at Inter 500 18pt).
    const txtX = x
    const txtY = y + _BADGE_V_PAD
    const txtW = bw
    const txtH = _BADGE_H - 2 * _BADGE_V_PAD
    reqs.push({
      createShape: {
        objectId: txtId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            width:  { magnitude: _eL(txtW + 2 * _INSET), unit: 'EMU' },
            height: { magnitude: _eL(txtH + 2 * _INSET), unit: 'EMU' },
          },
          transform: { scaleX: 1, shearX: 0, translateX: _eL(txtX - _INSET), shearY: 0, scaleY: 1, translateY: _eL(txtY - _INSET), unit: 'EMU' },
        },
      },
    })
    reqs.push({ insertText: { objectId: txtId, insertionIndex: 0, text: label } })
    reqs.push({
      updateTextStyle: {
        objectId: txtId,
        style: {
          weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
          foregroundColor: { opaqueColor: { rgbColor: _BADGE_FG } },
          fontSize: { magnitude: _BADGE_PT, unit: 'PT' },
          bold: false,
        },
        fields: 'weightedFontFamily,foregroundColor,fontSize,bold',
        textRange: { type: 'ALL' },
      },
    })
    reqs.push({
      updateParagraphStyle: {
        objectId: txtId,
        style: {
          lineSpacing: 90,
          alignment: 'CENTER',
          spaceAbove: { magnitude: 0, unit: 'PT' },
          spaceBelow: { magnitude: 0, unit: 'PT' },
        },
        fields: 'lineSpacing,alignment,spaceAbove,spaceBelow',
        textRange: { type: 'ALL' },
      },
    })
    reqs.push({
      updateShapeProperties: {
        objectId: txtId,
        shapeProperties: { contentAlignment: 'MIDDLE', autofit: { autofitType: 'NONE' } },
        fields: 'contentAlignment,autofit.autofitType',
      },
    })

    x += bw + _BADGE_GAP_H
  }

  return reqs
}

// ─── Universal fixed gap: ЗАГОЛОВОК bottom → ПІДЗАГОЛОВОК/ТЕКСТ top ─────────
// Applied to all compositions that have ЗАГОЛОВОК + subtitle/body below it.
// 60px on the 1920×1080 Figma grid. Must stay in sync with compositions.ts float_gap.
const TITLE_GAP = 60

// ─── Cover: float ПІДЗАГОЛОВОК below ЗАГОЛОВОК, ДАТА below ПІДЗАГОЛОВОК ──────
// Chain: ЗАГОЛОВОК → gap 60px → ПІДЗАГОЛОВОК (optional) → gap 30px → ДАТА
// All heights are fixed; positions of ПІДЗАГОЛОВОК and ДАТА are constants.
const _COVER_H1_W = _TITLE_W  // 1610 — avoids logo reserved zone
const _COVER_GAP  = 30        // gap between ПІДЗАГОЛОВОК and ДАТА

function buildCoverFloatRequests(
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
): object[] {
  const titleText = (slots['ЗАГОЛОВОК']    ?? '').trim()
  const subText   = (slots['ПІДЗАГОЛОВОК'] ?? '').trim()
  const dateText  = (slots['ДАТА']         ?? '').trim()
  if (!titleText && !subText && !dateText) return []

  const titleH = _H1_FIXED_44
  const subH   = subText ? _SUB_FIXED_22 : 1
  const subY   = _PAD + titleH + (subText ? TITLE_GAP : 0)
  const dateH  = _DATE_FIXED
  const dateY  = subText ? subY + subH + _COVER_GAP : _PAD + titleH + _COVER_GAP

  const reqs: object[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    if (raw.includes('{{ЗАГОЛОВОК}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, _COVER_H1_W + 2 * _INSET, titleH + 2 * _INSET, sW, sH))
    }
    if (raw.includes('{{ПІДЗАГОЛОВОК}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, subY - _INSET, _COVER_H1_W + 2 * _INSET, subH + 2 * _INSET, sW, sH))
    }
    if (raw.includes('{{ДАТА}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, dateY - _INSET, _COVER_H1_W + 2 * _INSET, dateH + 2 * _INSET, sW, sH))
    }
  }
  return reqs
}

// ─── cover_title_only: full-slide centered title + auto date pill ────────────
function formatCurrentDate(): string {
  const d  = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

const COVER_TITLE_ONLY_PT = [66, 54, 44, 36, 28, 22] as const
function pickCoverTitleOnlyPt(text: string): number {
  const boxW = _UW                    // 1720
  const boxH = _H_SLIDE - 2 * _PAD   // 880
  for (const pt of COVER_TITLE_ONLY_PT) {
    if (textFits(text, boxW, boxH, pt)) return pt
  }
  return COVER_TITLE_ONLY_PT[COVER_TITLE_ONLY_PT.length - 1]
}

// Date pill: width = 10 chars × 18pt × 2.667px/pt × 0.65 + 2×padding ≈ 350px
const _DATE_PILL_W = 350  // fits "дд.мм.рррр" (10 chars) on 1 line at 18pt

function buildCoverTitleOnlyRequests(
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
  pageId: string,
  slideIdx: number,
): object[] {
  const titleText = (slots['ЗАГОЛОВОК'] ?? '').trim()
  const reqs: object[] = []
  const boxW = _UW
  const boxH = _H_SLIDE - 2 * _PAD
  const pt   = pickCoverTitleOnlyPt(titleText)

  // 1. Resize ЗАГОЛОВОК + apply CENTER/MIDDLE alignment + dynamic font
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    if (!raw.includes('{{ЗАГОЛОВОК}}')) continue
    const sW = el.size.width?.magnitude  ?? 0
    const sH = el.size.height?.magnitude ?? 0
    reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, boxW + 2 * _INSET, boxH + 2 * _INSET, sW, sH))
    if (pt !== 66) {
      reqs.push({
        updateTextStyle: {
          objectId: el.objectId,
          style: { fontSize: { magnitude: pt, unit: 'PT' }, bold: false },
          fields: 'fontSize,bold',
          textRange: { type: 'ALL' },
        },
      })
    }
    reqs.push({
      updateParagraphStyle: {
        objectId: el.objectId,
        style: { alignment: 'CENTER', lineSpacing: 90 },
        fields: 'alignment,lineSpacing',
        textRange: { type: 'ALL' },
      },
    })
    reqs.push({
      updateShapeProperties: {
        objectId: el.objectId,
        shapeProperties: { contentAlignment: 'MIDDLE', autofit: { autofitType: 'NONE' } },
        fields: 'contentAlignment,autofit.autofitType',
      },
    })
  }

  // 2. Date pill: ROUND_RECTANGLE at (100, 99), white 60% opacity background, white text
  const pillId = `date_pill_${slideIdx}`
  const dateStr = formatCurrentDate()
  reqs.push({
    createShape: {
      objectId: pillId,
      shapeType: 'ROUND_RECTANGLE',
      elementProperties: {
        pageObjectId: pageId,
        size: {
          width:  { magnitude: _eL(_DATE_PILL_W), unit: 'EMU' },
          height: { magnitude: _eL(_LOGO_H), unit: 'EMU' },
        },
        transform: {
          scaleX: 1, shearX: 0, translateX: _eL(100),
          shearY: 0, scaleY: 1, translateY: _eL(99),
          unit: 'EMU',
        },
      },
    },
  })
  reqs.push({
    updateShapeProperties: {
      objectId: pillId,
      shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 1, green: 1, blue: 1 } }, alpha: 0.4 } },
        outline: { propertyState: 'NOT_RENDERED' },
        contentAlignment: 'MIDDLE',
        autofit: { autofitType: 'NONE' },
      },
      fields: 'shapeBackgroundFill,outline,contentAlignment,autofit.autofitType',
    },
  })
  reqs.push({ insertText: { objectId: pillId, insertionIndex: 0, text: dateStr } })
  reqs.push({
    updateTextStyle: {
      objectId: pillId,
      style: {
        weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
        foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 1, blue: 1 } } },
        fontSize: { magnitude: 18, unit: 'PT' },
        bold: false,
      },
      fields: 'weightedFontFamily,foregroundColor,fontSize,bold',
      textRange: { type: 'ALL' },
    },
  })
  reqs.push({
    updateParagraphStyle: {
      objectId: pillId,
      style: {
        alignment: 'CENTER',
        lineSpacing: 90,
        spaceAbove: { magnitude: 0, unit: 'PT' },
        spaceBelow: { magnitude: 0, unit: 'PT' },
      },
      fields: 'alignment,lineSpacing,spaceAbove,spaceBelow',
      textRange: { type: 'ALL' },
    },
  })

  return reqs
}

// ─── bento_right left column: float ТЕКСТ below ЗАГОЛОВОК ────────────────────
// ЗАГОЛОВОК fixed height = _H1_FIXED_44 (260px). ТЕКСТ always at fixed y=420 (PAD+260+60).
// ТЕКСТ always at fixed y=420; software auto-shrink handles long titles.

function buildBentoRightLeftColumnRequests(
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
): object[] {
  const titleText = (slots['ЗАГОЛОВОК'] ?? '').trim()
  const bodyText  = (slots['ТЕКСТ']     ?? '').trim()

  if (!titleText) {
    // ЗАГОЛОВОК absent (e.g. deduped in normalizePlan) — pin ТЕКСТ to top of left column.
    if (!bodyText) return []
    const logoY = _H_SLIDE - _PAD - _LOGO_H  // 890
    const maxH  = Math.max(1, logoY - 20 - _PAD)  // 770
    const reqs: object[] = []
    for (const el of slide.pageElements ?? []) {
      if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
      const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
      if (!raw.includes('{{ТЕКСТ}}')) continue
      const sW = el.size.width?.magnitude  ?? 0
      const sH = el.size.height?.magnitude ?? 0
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, _LTW + 2 * _INSET, maxH + 2 * _INSET, sW, sH))
    }
    return reqs
  }

  // Title font stepping: largest pt where longest word fits in 830px (no mid-word break).
  const titlePt    = pickTitlePt(titleText, _LTW)
  const titleLines = estimateLineCount(titleText, _LTW, titlePt)
  const logoY      = _H_SLIDE - _PAD - _LOGO_H  // 890
  const maxTitleH  = logoY - TITLE_GAP - _PAD - 20  // 710 — cap: textY ≤ 870, collapsed ТЕКСТ bottom = 890 = logoY (no logo overlap)
  const titleH     = Math.min(Math.ceil(titleLines * lineH(titlePt)), maxTitleH)
  const textY      = _PAD + titleH + TITLE_GAP
  const textMaxH   = Math.max(1, logoY - 20 - textY)

  // ── Audit log ────────────────────────────────────────────────────────────────
  const titleWPass = longestWordPx(titleText, titlePt) * 1.1 <= _LTW - _INSET
  const computedGap = textY - _PAD - titleH          // must equal TITLE_GAP = 60
  const emptySpace  = titleH - Math.ceil(titleLines * lineH(titlePt))  // must be 0
  console.log(
    `[bento-fit] bento-right/ЗАГОЛОВОК: max_font=${TITLE_PT_STEPS[0]} | chosen_font=${titlePt} | floor=${TITLE_PT_STEPS[TITLE_PT_STEPS.length - 1]} | fits_width=${titleWPass ? '✓' : '✗'} | fits_height=N/A`,
  )
  console.log(
    `[bento-right-title] font=${titlePt} | lines=${titleLines} | gap=${computedGap} | empty_space=${emptySpace}`,
  )

  const reqs: object[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    if (raw.includes('{{ЗАГОЛОВОК}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, _LTW + 2 * _INSET, titleH + 2 * _INSET, sW, sH))
      // Apply stepped font size if it differs from the 44pt template default.
      if (titlePt !== 44) {
        reqs.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: titlePt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
      }
    }
    if (raw.includes('{{ТЕКСТ}}')) {
      // Always move ТЕКСТ below ЗАГОЛОВОК — even when slot is empty — so the box
      // doesn't overlap with ЗАГОЛОВОК. Collapse to h=1 when text is absent.
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, textY - _INSET, _LTW + 2 * _INSET, (bodyText ? textMaxH : 1) + 2 * _INSET, sW, sH))
    }
  }
  return reqs
}

// ─── section/section_red: float ПІДЗАГОЛОВОК below ЗАГОЛОВОК ─────────────────
// With subtitle: ЗАГОЛОВОК fixed 44pt, height = _H1_FIXED_44 (260px). ПІДЗАГОЛОВОК at fixed y=420.
// Without subtitle: ЗАГОЛОВОК dynamic up to 66pt, height computed from line count.
const _SECTION_SUB_MAX = 160  // from create-master/route.ts
const _SECTION_TITLE_PT = [66, 54, 44, 36, 28, 22] as const

function pickSectionTitlePt(text: string): number {
  const availH = _H_SLIDE - 2 * _PAD  // 880
  for (const pt of _SECTION_TITLE_PT) {
    if (textFits(text, _TITLE_W, availH, pt)) return pt
  }
  return _SECTION_TITLE_PT[_SECTION_TITLE_PT.length - 1]
}

function buildSectionFloatRequests(
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
): object[] {
  const titleText = (slots['ЗАГОЛОВОК']    ?? '').trim()
  const subText   = (slots['ПІДЗАГОЛОВОК'] ?? '').trim()
  if (!titleText) return []

  const dynPt  = !subText ? pickSectionTitlePt(titleText) : 44
  const dynH   = !subText
    ? Math.max(1, Math.ceil(estimateLineCount(titleText, _TITLE_W, dynPt) * lineH(dynPt)))
    : _H1_FIXED_44
  const subY   = _PAD + _H1_FIXED_44 + TITLE_GAP  // 420 (fixed, unchanged)

  const reqs: object[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    if (raw.includes('{{ЗАГОЛОВОК}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, _TITLE_W + 2 * _INSET, dynH + 2 * _INSET, sW, sH))
      if (!subText && dynPt !== 44) {
        reqs.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: dynPt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
      }
    }
    if (raw.includes('{{ПІДЗАГОЛОВОК}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, subY - _INSET, _UW + 2 * _INSET, (subText ? _SECTION_SUB_MAX : 1) + 2 * _INSET, sW, sH))
    }
  }
  return reqs
}

// ─── title_body: float ТЕКСТ below ЗАГОЛОВОК ──────────────────────────────────
// ЗАГОЛОВОК fixed height = _H1_FIXED_36 (220px). ТЕКСТ always at fixed y=380 (PAD+220+60).
// textMaxH = 518px (fixed: H-PAD-52-GAP-380).

const _TB_BODY_STEPS: number[] = [48, 36, 28, 22, 18, 14, 10]

function buildTitleBodyFloatRequests(
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
): object[] {
  const titleText = (slots['ЗАГОЛОВОК'] ?? '').trim()
  const bodyText  = (slots['ТЕКСТ']     ?? '').trim()
  if (!titleText) return []

  const titleH   = _H1_FIXED_36
  const textY    = _PAD + titleH + TITLE_GAP  // 380 (fixed)
  const textMaxH = Math.max(1, _H_SLIDE - _PAD - 52 - _GAP - textY)  // 488px

  // Auto-shrink ТЕКСТ: largest pt at which body text fits in the available box.
  let bodyPt = _TB_BODY_STEPS[0]
  if (bodyText) {
    for (const pt of _TB_BODY_STEPS) {
      if (textFitsParagraphs(bodyText, _UW, textMaxH, pt)) { bodyPt = pt; break }
    }
  }
  console.log(`[title-body-fit] bodyLen=${bodyText.length} | chosen_font=${bodyPt}`)

  const reqs: object[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    if (raw.includes('{{ЗАГОЛОВОК}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, _TITLE_W + 2 * _INSET, titleH + 2 * _INSET, sW, sH))
    }
    if (raw.includes('{{ТЕКСТ}}')) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, textY - _INSET, _UW + 2 * _INSET, (bodyText ? textMaxH : 1) + 2 * _INSET, sW, sH))
      if (bodyText) {
        reqs.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: bodyPt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
      }
    }
  }
  return reqs
}

// Returns the LARGEST pt (≤ BENTO_MAX_PT, ≥ BENTO_MIN_PT) at which every non-empty card fits.
// Algorithm: try from maxPt downward; stop at first pt where ALL cards pass word-fit + height.
// Floor (minPt): chosen pt is never below BENTO_MIN_PT; if even minPt overflows → log ⚠ TEXT_TOO_LONG.
// All cards in the group share ONE pt for visual uniformity.
// Returns uniform group font size for all bento cards:
// 1. Find the max fitting pt for each individual card.
// 2. Group pt = min of those per-card maxes (tightest card dictates the group).
// 3. Clamp to floor (minPt). Apply same pt to every filled card.
function pickBentoCardPts(compId: string, slots: Record<string, string>): Record<string, number> | null {
  const dims   = bentoDims(compId)
  const tokens = BENTO_TOKENS[compId]
  const maxPt  = BENTO_MAX_PT[compId]
  const minPt  = BENTO_MIN_PT[compId] ?? 10
  if (!dims || !tokens || !maxPt) return null
  const scale = (BENTO_SCALE as readonly number[]).filter(s => s <= maxPt)

  // Step 1: per-card max fitting pt
  let groupPt = maxPt  // shrink toward the tightest card
  for (const t of tokens) {
    const text = slots[t] ?? ''
    if (!text.trim()) continue
    let cardPt = minPt
    for (const pt of scale) {
      if (textFitsParagraphs(text, dims.w, dims.h, pt)) { cardPt = pt; break }
    }
    groupPt = Math.min(groupPt, cardPt)  // group = tightest of per-card maxes
  }
  groupPt = Math.max(groupPt, minPt)    // floor

  // Step 2: apply uniform groupPt to all filled cards + diagnostic
  const result: Record<string, number> = {}
  for (const [idx, t] of tokens.entries()) {
    const text = slots[t] ?? ''
    if (!text.trim()) continue
    result[t] = groupPt
    const wPass = longestWordPx(text, groupPt) * 1.1 <= dims.w
    const cpl   = Math.max(1, Math.floor(dims.w / (groupPt * 2.667 * 0.65)))
    const paras = text.split('\n').filter(p => p.trim())
    const totalLines = paras.reduce((s, p) => {
      const words = p.split(/\s+/).filter(Boolean)
      let lines = 1, cur = 0
      for (const w of words) {
        if (!cur) cur = w.length
        else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
        else { lines++; cur = w.length }
      }
      return s + lines
    }, 0)
    const hPass = totalLines * lineH(groupPt) <= dims.h
    console.log(
      `[bento-fit] ${compId}/card${idx + 1}: max_font=${maxPt} | group_font=${groupPt} | floor=${minPt} | fits_width=${wPass ? '✓' : '✗'} | fits_height=${hPass ? '✓' : '✗'}`,
    )
  }
  return result
}

// ─── Compact number formatting for KPI values ────────────────────────────────
// Applied ONLY to КАРТКА_N_ЗНАЧЕННЯ slots, never to regular paragraph text.
// Rules:
//   ≤ 4 digits (< 10 000, years, small counts) → unchanged
//   5–6 digits → K  (only if result is round: ≤ 1 decimal place, i.e. value % 100 === 0)
//   7+ digits  → M  (only if result is round: ≤ 1 decimal place, i.e. value % 100 000 === 0)
//   Non-round (e.g. 2 456 789) → unchanged (each digit matters)
// Examples: "2 000 000"→"2M"; "2 500 000"→"2.5M"; "150 000"→"150K"; "12 500"→"12.5K"
//           "1500"→"1500"; "2026"→"2026"; "2 456 789"→unchanged; "$2 000 000"→"$2M"
export function compactNumber(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return text
  const m = trimmed.match(/^([^0-9]*)(\d[\d\s]*)([^0-9]*)$/)
  if (!m) return text
  const [, prefix, rawNum, suffix] = m
  const digits = rawNum.replace(/\s/g, '')
  const digitCount = digits.length
  // ≤ 4 digits: years, small numbers — never compact
  if (digitCount <= 4) return text
  const value = parseFloat(digits)
  if (isNaN(value) || !isFinite(value)) return text
  // 5–6 digits → K, only when ≤ 1 decimal place (value divisible by 100)
  if (digitCount <= 6) {
    if (value % 100 !== 0) return text
    const v = value / 1_000
    return prefix + (v % 1 === 0 ? String(Math.round(v)) : v.toFixed(1)) + 'K' + suffix
  }
  // 7+ digits → M, only when ≤ 1 decimal place (value divisible by 100 000)
  if (value % 100_000 !== 0) return text
  const v = value / 1_000_000
  return prefix + (v % 1 === 0 ? String(Math.round(v)) : v.toFixed(1)) + 'M' + suffix
}

// ─── Non-breaking space: hanging short words ────────────────────────────────
// Replaces the regular space AFTER any all-letter word of 1–4 chars with NBSP
// so that word cannot be the last token on a wrapped line.
// Only all-letter words qualify; numeric tokens (digits) are never touched.
// Last word in text has no space following it → is not affected (correct).
// Applied to every text slot (titles, body, bullets, captions).
export function addNbsp(text: string): string {
  if (!text) return text
  // Negative lookbehind ensures we match only complete words, not fragments of longer words.
  // The space after the short word is replaced with U+00A0.
  return text.replace(
    /(?<![А-ЯЁІЇЄҐа-яёіїєґA-Za-z0-9])([А-ЯЁІЇЄҐа-яёіїєґA-Za-z]{1,4}) (?=\S)/g,
    (_, word) => word + ' ',
  )
}

// Strips a trailing period from heading text.
// Preserves '?', '!', '…' (U+2026), and '...' (last dot preceded by dot → kept).
function stripTrailingPeriod(text: string): string {
  return text.replace(/(?<!\.)\.$/u, '')
}

// ─── Bento card content preprocessing ────────────────────────────────────────
// Converts " · " list separators to proper bullet lines ("• item\n• item").
// Applied before replaceAllText so font sizing also accounts for the converted text.
// Exception: value+label cards ("$5M\nнові клієнти") are NOT converted.
function preprocessBentoText(text: string): string {
  if (!text.trim()) return text
  if (splitValueLabel(text)) return text  // value+label: leave as-is

  // Convert " · " list separator to bullet list; strip trailing period per item
  if (text.includes(' · ')) {
    const items = text.split(' · ').map(s => stripTrailingPeriod(s.trim())).filter(Boolean)
    if (items.length >= 2) {
      return items.map(item => '• ' + item).join('\n')
    }
  }

  // Existing multi-line content: add "• " prefix to lines that aren't already bulleted
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length >= 2) {
    return lines.map(line =>
      (line.startsWith('•') || line.startsWith('-') || line.startsWith('–')) ? line : '• ' + line,
    ).join('\n')
  }
  return text
}

// ─── Auto-numbering helpers ───────────────────────────────────────────────────
// Returns the cardinal number found in a slide title (1–10), or null.
// Matches digits ("3", "топ-3") and Ukrainian word numerals (case-insensitive).
function findCardinalInTitle(title: string): number | null {
  const lower = title.toLowerCase()
  const digitMatches = lower.match(/\b(\d+)\b/g)
  if (digitMatches) {
    for (const m of digitMatches) {
      const n = parseInt(m, 10)
      if (n >= 1 && n <= 10) return n
    }
  }
  const WORD_NUMS: Record<string, number> = {
    'один': 1, 'одна': 1, 'одне': 1,
    'два': 2, 'дві': 2,
    'три': 3, 'чотири': 4,
    "п'ять": 5, 'пять': 5,
    'шість': 6, 'сім': 7, 'вісім': 8,
    "дев'ять": 9, 'девять': 9, 'десять': 10,
  }
  for (const [word, n] of Object.entries(WORD_NUMS)) {
    if (lower.includes(word)) return n
  }
  return null
}

// Creates a small ordinal number label in the top-left corner of a bento card.
// numId must be unique across the deck. cardX/cardY are the card body top-left (Figma px).
function makeBentoNumRequests(numId: string, pageId: string, cardIdx: number, cardX: number, cardY: number, cardW: number, fontPt = _NUM_FONT_PT, numH = _NUM_H): object[] {
  const numText = String(cardIdx + 1).padStart(2, '0')  // "01", "02", ...
  // X/W match card text boxes (_INN-_INSET trick) so number and text share the same left axis
  const X = cardX + _INN - _INSET
  const Y = cardY + _NUM_PAD
  const W = cardW - 2 * _INN + 2 * _INSET
  return [
    {
      createShape: {
        objectId: numId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            width:  { magnitude: _eL(W),    unit: 'EMU' },
            height: { magnitude: _eL(numH), unit: 'EMU' },
          },
          transform: { scaleX: 1, shearX: 0, translateX: _eL(X), shearY: 0, scaleY: 1, translateY: _eL(Y), unit: 'EMU' },
        },
      },
    },
    { insertText: { objectId: numId, insertionIndex: 0, text: numText } },
    {
      updateTextStyle: {
        objectId: numId,
        style: {
          fontSize: { magnitude: fontPt, unit: 'PT' },
          bold: false,
          foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 1, blue: 1 } } },
          weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
        },
        fields: 'fontSize,bold,foregroundColor,weightedFontFamily',
        textRange: { type: 'ALL' },
      },
    },
    {
      updateShapeProperties: {
        objectId: numId,
        shapeProperties: {
          shapeBackgroundFill: { propertyState: 'NOT_RENDERED' },
          outline:             { propertyState: 'NOT_RENDERED' },
          autofit: { autofitType: 'NONE' },
          contentAlignment: 'TOP',
        },
        fields: 'shapeBackgroundFill,outline,autofit.autofitType,contentAlignment',
      },
    },
    {
      updateParagraphStyle: {
        objectId: numId,
        style: { alignment: 'START', lineSpacing: 90 },
        fields: 'alignment,lineSpacing',
        textRange: { type: 'ALL' },
      },
    },
  ]
}

// ─── Bento row layout: grid-driven card geometry ─────────────────────────────
// Card dimensions are derived purely from grid constants — independent of font size.
// Text overflow is handled by TEXT_AUTOFIT (Google Slides shrinks if needed).
function buildBentoRowLayoutRequests(
  slide: slides_v1.Schema$Page,
  compId: string,
  processedSlots: Record<string, string>,
  pageId?: string,
  slideIdx?: number,
  titleText?: string,
): object[] {
  const tokens = BENTO_TOKENS[compId]
  if (!tokens) return []
  const TOL = 8

  // ── Horizontal row: two_columns / three_columns / bento_bottom_4 / four_columns / four_columns_num ──
  if (compId === 'two_columns' || compId === 'three_columns' || compId === 'bento_bottom_4' ||
      compId === 'four_columns' || compId === 'four_columns_num') {
    const n      = compId === 'two_columns' ? 2 : compId === 'three_columns' ? 3 : 4
    const cw     = Math.floor((_UW - (n - 1) * _GAP) / n)
    const innerW = cw - 2 * _INN

    // Content-driven: bottom pins to 980, top defaults to center (540), expands up if needed.
    // minTopY = _CY = 300 (title-to-bento gap; cards never overlap title).
    const VERT_PAD_ROW = 40
    const cardPts = pickBentoCardPts(compId, processedSlots)
    let maxTextH = 0
    for (const token of tokens) {
      const text = (processedSlots[token] ?? '').trim()
      if (!text) continue
      const pt = cardPts?.[token] ?? (BENTO_MIN_PT[compId] ?? 10)
      const lines = estimateLineCount(text, innerW, pt)
      const h = Math.ceil(lines * lineH(pt))
      if (h > maxTextH) maxTextH = h
    }
    const contentCardH  = maxTextH + 2 * _INN + 2 * VERT_PAD_ROW
    const desiredRowY   = _H - _PAD - Math.max(contentCardH, _BOTTOM_BENTO_H_DEFAULT)
    const rowY = Math.max(desiredRowY, _CY)   // _CY = 300 is the hard floor
    const cardH = _H - _PAD - rowY

    // four_columns_num: always numbered; four_columns/bento_bottom_4: never numbered;
    // three_columns: numbered only when title contains the matching cardinal number.
    const isNumbered = compId === 'four_columns_num' || (
      compId !== 'bento_bottom_4' && compId !== 'four_columns' &&
      !!(pageId && slideIdx !== undefined && titleText && findCardinalInTitle(titleText) === n)
    )
    // Text Y offset depends on whether numbering is active
    const textTopOff = isNumbered ? _NUM_TEXT_TOP : (_INN - _INSET)
    const textH      = isNumbered ? (cardH - _NUM_TEXT_TOP - _NUM_PAD) : (cardH - 2 * _INN + 2 * _INSET)

    const reqs: object[] = []
    // Auto-numbering: large "01"/"02"/... at top of each card
    if (isNumbered) {
      for (let ci = 0; ci < n; ci++) {
        const cx = _PAD + ci * (cw + _GAP)
        reqs.push(...makeBentoNumRequests(`bnum_${slideIdx}_${ci}`, pageId!, ci, cx, rowY, cw))
      }
    }
    for (const el of slide.pageElements ?? []) {
      if (!el.objectId || !el.transform || !el.size) continue
      const sW  = el.size.width?.magnitude  ?? 0
      const sH  = el.size.height?.magnitude ?? 0
      const elX = Math.round((el.transform.translateX ?? 0) / _FPX)
      const elY = Math.round((el.transform.translateY ?? 0) / _FPX)
      const elW = Math.round(sW * (el.transform.scaleX ?? 1) / _FPX)
      const elH = Math.round(sH * (el.transform.scaleY ?? 1) / _FPX)

      if (elY < _CY - TOL) continue  // header zone — skip

      // Which card column?
      let k = -1
      for (let ci = 0; ci < n; ci++) {
        const cx0 = _PAD + ci * (cw + _GAP)
        if (elX >= cx0 - TOL && elX <= cx0 + cw + TOL) { k = ci; break }
      }
      if (k < 0) continue
      const cx       = _PAD + k * (cw + _GAP)
      const isBottom = elY > _CY + _CH / 2

      if (el.shape?.shapeType === 'TEXT_BOX') {
        reqs.push(makeElemTransform(el.objectId, cx + _INN - _INSET, rowY + textTopOff, innerW + 2 * _INSET, textH, sW, sH))
      } else if (el.shape?.shapeType === 'RECTANGLE') {
        if (Math.abs(elW - cw) < TOL) {
          // Card body
          reqs.push(makeElemTransform(el.objectId, cx, rowY, cw, cardH, sW, sH))
        } else if (Math.abs(elW - _R) < TOL && Math.abs(elH - _R) < TOL) {
          // Corner square
          const isRight = Math.abs(elX - (cx + cw - _R)) < TOL
          const newX    = isRight ? cx + cw - _R : cx
          const newY    = isBottom ? rowY + cardH - _R : rowY
          reqs.push(makeElemTransform(el.objectId, newX, newY, _R, _R, sW, sH))
        }
      } else if (el.shape?.shapeType === 'ELLIPSE') {
        if (Math.abs(elW - 2 * _R) < TOL && Math.abs(elH - 2 * _R) < TOL) {
          // Corner ellipse
          const isRight = Math.abs(elX - (cx + cw - 2 * _R)) < TOL
          const newX    = isRight ? cx + cw - 2 * _R : cx
          const newY    = isBottom ? rowY + cardH - 2 * _R : rowY
          reqs.push(makeElemTransform(el.objectId, newX, newY, 2 * _R, 2 * _R, sW, sH))
        }
      }
    }
    return reqs
  }

  // ── Vertical column: bento_right_2 / bento_right_3 / bento_right_2x2 ────
  if (compId.startsWith('bento_right_')) {
    const isGrid = compId === 'bento_right_2x2'
    const nCards = compId === 'bento_right_2' ? 2 : compId === 'bento_right_3' ? 3 : 4
    const RBX    = _W - _PAD - _RBW  // 960 — right block left edge
    const innerW = _RBW - 2 * _INN  // 800

    // Grid-driven geometry: dimensions from constants, not from text content.
    const cellW      = isGrid ? Math.floor((_RBW - _GAP) / 2) : _RBW
    const cellInnerW = cellW - 2 * _INN

    if (isGrid) {
      // Cell height = exactly half of right-column height (fills _PAD → _H-_PAD)
      const cellH  = Math.floor((_RBH - _GAP) / 2)  // mCellH
      const gridY  = _PAD  // top of grid = top of content zone

      // 2 rows of cells; fills _PAD → _PAD+_RBH exactly
      const totalGridH = 2 * cellH + _GAP

      // Master cell dims (for detection)
      const mCellW = Math.floor((_RBW - _GAP) / 2)
      const mCellH = Math.floor((_RBH - _GAP) / 2)

      const isNumbered2x2 = !!(pageId && slideIdx !== undefined && titleText && findCardinalInTitle(titleText) === 4)
      const gridTextTopOff = isNumbered2x2 ? _NUM_TEXT_TOP : (_INN - _INSET)
      const gridTextH      = isNumbered2x2 ? (cellH - _NUM_TEXT_TOP - _NUM_PAD) : (cellH - 2 * _INN + 2 * _INSET)

      const reqs: object[] = []
      // Auto-numbering for bento_right_2x2 (4 cards)
      if (isNumbered2x2) {
        const positions = [
          { x: RBX,               y: gridY },
          { x: RBX + cellW + _GAP, y: gridY },
          { x: RBX,               y: gridY + cellH + _GAP },
          { x: RBX + cellW + _GAP, y: gridY + cellH + _GAP },
        ]
        for (let ci = 0; ci < 4; ci++) {
          reqs.push(...makeBentoNumRequests(`bnum_${slideIdx}_${ci}`, pageId!, ci, positions[ci].x, positions[ci].y, cellW))
        }
      }
      for (const el of slide.pageElements ?? []) {
        if (!el.objectId || !el.transform || !el.size) continue
        const sW  = el.size.width?.magnitude  ?? 0
        const sH  = el.size.height?.magnitude ?? 0
        const elX = Math.round((el.transform.translateX ?? 0) / _FPX)
        const elY = Math.round((el.transform.translateY ?? 0) / _FPX)
        const elW = Math.round(sW * (el.transform.scaleX ?? 1) / _FPX)
        const elH = Math.round(sH * (el.transform.scaleY ?? 1) / _FPX)
        if (elX < RBX - TOL) continue

        let col = -1, row = -1
        for (let c = 0; c < 2; c++) {
          const cx0 = RBX + c * (mCellW + _GAP)
          if (elX >= cx0 - TOL && elX <= cx0 + mCellW + TOL) { col = c; break }
        }
        for (let r = 0; r < 2; r++) {
          const cy0 = _PAD + r * (mCellH + _GAP)
          if (elY >= cy0 - TOL && elY <= cy0 + mCellH + TOL) { row = r; break }
        }
        if (col < 0 || row < 0) continue

        const cx       = RBX + col * (cellW + _GAP)
        const cy       = gridY + row * (cellH + _GAP)
        const origCx   = RBX + col * (mCellW + _GAP)
        const origCy   = _PAD + row * (mCellH + _GAP)
        const isBottom = elY > origCy + mCellH / 2

        if (el.shape?.shapeType === 'TEXT_BOX') {
          reqs.push(makeElemTransform(el.objectId, cx + _INN - _INSET, cy + gridTextTopOff, cellInnerW + 2 * _INSET, gridTextH, sW, sH))
        } else if (el.shape?.shapeType === 'RECTANGLE') {
          if (Math.abs(elW - mCellW) < TOL) {
            reqs.push(makeElemTransform(el.objectId, cx, cy, cellW, cellH, sW, sH))
          } else if (Math.abs(elW - _R) < TOL && Math.abs(elH - _R) < TOL) {
            const isRight = Math.abs(elX - (origCx + mCellW - _R)) < TOL
            reqs.push(makeElemTransform(el.objectId,
              isRight ? cx + cellW - _R : cx, isBottom ? cy + cellH - _R : cy, _R, _R, sW, sH))
          }
        } else if (el.shape?.shapeType === 'ELLIPSE') {
          if (Math.abs(elW - 2 * _R) < TOL && Math.abs(elH - 2 * _R) < TOL) {
            const isRight = Math.abs(elX - (origCx + mCellW - 2 * _R)) < TOL
            reqs.push(makeElemTransform(el.objectId,
              isRight ? cx + cellW - 2 * _R : cx, isBottom ? cy + cellH - 2 * _R : cy, 2 * _R, 2 * _R, sW, sH))
          }
        }
      }
      return reqs
    }

    // Linear column (bento_right_2 / bento_right_3)
    // Card height from grid constants. Last card absorbs floor() rounding so
    // bottom of last card = _PAD + _RBH = _H - _PAD exactly.
    const masterCardH = compId === 'bento_right_2'
      ? Math.floor((_RBH - _GAP) / 2)
      : Math.floor((_RBH - 2 * _GAP) / 3)
    const colY = _PAD  // top of card column = slide top margin

    // Diagnostic
    const filledTokens = tokens.filter(t => (processedSlots[t] ?? '').trim())
    console.log(`[bento-layout] ${compId}: ${filledTokens.length}/${tokens.length} slots filled | masterCardH=${masterCardH} colY=${colY}`)

    const isNumberedLin = !!(pageId && slideIdx !== undefined && titleText && findCardinalInTitle(titleText) === nCards)
    // 3-card bento has shorter cards (273px) — use smaller numbers to fit text comfortably
    const linNumFontPt  = nCards >= 3 ? _NUM_FONT_PT_3  : _NUM_FONT_PT
    const linNumH       = nCards >= 3 ? _NUM_H_3         : _NUM_H
    const linNumGap     = nCards >= 3 ? _NUM_GAP_3       : _NUM_GAP
    const linNumTextTop = nCards >= 3 ? _NUM_TEXT_TOP_3  : _NUM_TEXT_TOP
    const linTextTopOff = isNumberedLin ? linNumTextTop : (_INN - _INSET)

    const reqs: object[] = []
    // Auto-numbering for bento_right_2 / bento_right_3
    if (isNumberedLin) {
      for (let k = 0; k < nCards; k++) {
        const newCy = colY + k * (masterCardH + _GAP)
        reqs.push(...makeBentoNumRequests(`bnum_${slideIdx}_${k}`, pageId!, k, RBX, newCy, _RBW, linNumFontPt, linNumH))
      }
    }
    for (const el of slide.pageElements ?? []) {
      if (!el.objectId || !el.transform || !el.size) continue
      const sW  = el.size.width?.magnitude  ?? 0
      const sH  = el.size.height?.magnitude ?? 0
      const elX = Math.round((el.transform.translateX ?? 0) / _FPX)
      const elY = Math.round((el.transform.translateY ?? 0) / _FPX)
      const elW = Math.round(sW * (el.transform.scaleX ?? 1) / _FPX)
      const elH = Math.round(sH * (el.transform.scaleY ?? 1) / _FPX)
      if (elX < RBX - TOL) continue

      let k = -1
      for (let ci = 0; ci < nCards; ci++) {
        const origCy = _PAD + ci * (masterCardH + _GAP)
        if (elY >= origCy - TOL && elY <= origCy + masterCardH + TOL) { k = ci; break }
      }
      if (k < 0) continue

      const origCy   = _PAD + k * (masterCardH + _GAP)
      const newCy    = colY + k * (masterCardH + _GAP)
      // Last card absorbs Math.floor() remainder so bottom = _PAD + _RBH exactly
      const kCardH   = k < nCards - 1
        ? masterCardH
        : _RBH - (nCards - 1) * (masterCardH + _GAP)
      const isBottom = elY > origCy + masterCardH / 2

      const linTH = isNumberedLin ? (kCardH - linNumTextTop - _NUM_PAD) : (kCardH - 2 * _INN + 2 * _INSET)
      if (el.shape?.shapeType === 'TEXT_BOX') {
        reqs.push(makeElemTransform(el.objectId, RBX + _INN - _INSET, newCy + linTextTopOff, innerW + 2 * _INSET, linTH, sW, sH))
      } else if (el.shape?.shapeType === 'RECTANGLE') {
        if (Math.abs(elW - _RBW) < TOL) {
          reqs.push(makeElemTransform(el.objectId, RBX, newCy, _RBW, kCardH, sW, sH))
        } else if (Math.abs(elW - _R) < TOL && Math.abs(elH - _R) < TOL) {
          const isRight = Math.abs(elX - (RBX + _RBW - _R)) < TOL
          reqs.push(makeElemTransform(el.objectId,
            isRight ? RBX + _RBW - _R : RBX, isBottom ? newCy + kCardH - _R : newCy, _R, _R, sW, sH))
        }
      } else if (el.shape?.shapeType === 'ELLIPSE') {
        if (Math.abs(elW - 2 * _R) < TOL && Math.abs(elH - 2 * _R) < TOL) {
          const isRight = Math.abs(elX - (RBX + _RBW - 2 * _R)) < TOL
          reqs.push(makeElemTransform(el.objectId,
            isRight ? RBX + _RBW - 2 * _R : RBX, isBottom ? newCy + kCardH - 2 * _R : newCy, 2 * _R, 2 * _R, sW, sH))
        }
      }
    }
    return reqs
  }

  return []
}

// ─── Agenda layout ───────────────────────────────────────────────────────────
// Shared by agenda_3/4/5/6/7/8. Per-row column X positions (dot left edge, px).
// Font conversion: Figma px / 2.667 = Google Slides pt  (e.g. 48/2.667≈18, 36/2.667≈14)
const _AG_COL_X   = [90, 773, 1456] as const         // 3 cols (pitch=683)
const _AG8_COL_X  = [90, 545, 1000, 1455] as const   // 4 cols (pitch=455)
const _AG5_R1_X   = [90, 773] as const               // agenda_5 row 1: 2 cols
const _AG7_R1_X   = [90, 545, 1000] as const         // agenda_7 row 1: 3 cols

// Row definitions per composition: each entry is the colXs for that row.
// Single-element = single row (agenda_3/4); uses _AG_ROW_SINGLE Y positions.
const AGENDA_ROW_DEFS: Readonly<Record<string, readonly (readonly number[])[]>> = {
  agenda_3: [_AG_COL_X],               // 1 row × 3 cols
  agenda_4: [_AG8_COL_X],              // 1 row × 4 cols
  agenda_5: [_AG_COL_X, _AG5_R1_X],   // 2 rows: 3+2
  agenda_6: [_AG_COL_X, _AG_COL_X],   // 2 rows: 3+3 (unchanged)
  agenda_7: [_AG8_COL_X, _AG7_R1_X],  // 2 rows: 4+3
  agenda_8: [_AG8_COL_X, _AG8_COL_X], // 2 rows: 4+4 (unchanged)
}
const _AG_TEXT_W     = 374  // item text box content width (px)
const _AG_DOT_SZ     = 54   // dot ellipse diameter
const _AG_NUM_PT     = 18   // number font size (48 Figma px / 2.667)
const _AG_BODY_PT    = 14   // body text max (36 Figma px / 2.667 ≈ 13.5 → 14)
const _AG_BODY_MIN   = 8    // body text floor — below this text is unreadable
const _AG_BODY_SCALE = [14, 12, 10, 9, 8] as const  // shrink steps
const _AG_NUM_H      = 54   // number text box height
const _AG_TEXT_H     = 200  // item text box content height
const _AG_LINE_H  = 8    // line thickness (px) — 4× original 2px
// Y positions for two-row agendas (agenda_5/6/7/8)
const _AG_ROWS = [
  { numY: 337, dotY: 394, textY: 487 },
  { numY: 690, dotY: 747, textY: 840 },
] as const
// Y positions for single-row agendas (agenda_3/4) — vertically centred on slide
const _AG_ROW_SINGLE = { numY: 493, dotY: 550, textY: 643 } as const
const _AG_RED_RGB   = { red: 0xFD / 255, green: 0x34 / 255, blue: 0x33 / 255 }
const _AG_MUTED_RGB = { red: 162 / 255, green: 166 / 255, blue: 177 / 255 }

// Agenda uses 90% line-spacing — different lineH than bento's 140%
function agendaLineH(pt: number): number { return pt * 2.667 * 0.9 }

function agendaTextFits(text: string, pt: number): boolean {
  if (!text.trim()) return true
  if (longestWordPx(text, pt) * 1.1 > _AG_TEXT_W) return false
  const cpl = Math.max(1, Math.floor(_AG_TEXT_W / (pt * 2.667 * 0.65)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) { cur = w.length }
    else if (cur + 1 + w.length <= cpl) { cur += 1 + w.length }
    else { lines++; cur = w.length }
  }
  return lines * agendaLineH(pt) <= _AG_TEXT_H
}

// Returns the largest pt (≤ _AG_BODY_PT, ≥ _AG_BODY_MIN) at which every item fits.
// Tightest item dictates the group — all items on the slide share one font size.
function pickAgendaBodyPt(texts: string[]): number {
  let groupPt = _AG_BODY_PT
  for (const text of texts) {
    if (!text.trim()) continue
    let itemPt = _AG_BODY_MIN
    for (const pt of _AG_BODY_SCALE) {
      if (agendaTextFits(text, pt)) { itemPt = pt; break }
    }
    groupPt = Math.min(groupPt, itemPt)
  }
  return Math.max(groupPt, _AG_BODY_MIN)
}

function buildAgendaRequests(
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
  pageId: string,
  slideIdx: number,
  rowDefs: readonly (readonly number[])[],
): object[] {
  const reqs: object[] = []

  // Delete all {{ПУНКТ_N}} placeholder text boxes (tokens were NOT replaced — see skip in main loop)
  for (const el of slide.pageElements ?? []) {
    if (!el.objectId) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    if (/\{\{ПУНКТ_\d+\}\}/.test(raw)) {
      reqs.push({ deleteObject: { objectId: el.objectId } })
    }
  }

  // Pre-pass: collect all item texts → pick uniform font size for the slide
  const allTexts: string[] = []
  let _cnt = 0
  for (const cols of rowDefs) {
    for (let c = 0; c < cols.length; c++, _cnt++) {
      const raw = (slots[`ПУНКТ_${_cnt + 1}`] ?? '').trim().replace(/^\d+[\.\)\s]\s*/, '').trim()
      allTexts.push(raw)
    }
  }
  const bodyPt = pickAgendaBodyPt(allTexts)

  const isSingleRow = rowDefs.length === 1
  let itemIdx = 0  // global item counter across all rows

  for (let rowIdx = 0; rowIdx < rowDefs.length; rowIdx++) {
    const row = isSingleRow ? _AG_ROW_SINGLE : _AG_ROWS[rowIdx]
    const colXs = rowDefs[rowIdx]
    const ITEMS_PER_ROW = colXs.length

    // Horizontal red line:
    //   row 0 (incl. single-row) — from center of first dot to right slide edge
    //   row 1                    — from left slide edge to center of last dot
    const dotCenter0 = colXs[0] + _AG_DOT_SZ / 2
    const dotCenterLast = colXs[ITEMS_PER_ROW - 1] + _AG_DOT_SZ / 2
    const lineX = rowIdx === 0 ? dotCenter0 : 0
    const lineW = rowIdx === 0 ? 1920 - dotCenter0 : dotCenterLast
    const lineTopY = row.dotY + _AG_DOT_SZ / 2 - _AG_LINE_H / 2               // center on dot
    const lineId = `ag_line_${slideIdx}_r${rowIdx}`
    reqs.push(
      {
        createShape: {
          objectId: lineId,
          shapeType: 'RECTANGLE',
          elementProperties: {
            pageObjectId: pageId,
            size: {
              width:  { magnitude: _eL(lineW), unit: 'EMU' },
              height: { magnitude: _eL(_AG_LINE_H), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(lineX),
              shearY: 0, scaleY: 1, translateY: _eL(lineTopY),
              unit: 'EMU',
            },
          },
        },
      },
      {
        updateShapeProperties: {
          objectId: lineId,
          shapeProperties: {
            shapeBackgroundFill: { solidFill: { color: { rgbColor: _AG_RED_RGB } } },
            outline: { propertyState: 'NOT_RENDERED' },
          },
          fields: 'shapeBackgroundFill,outline',
        },
      },
    )

    for (let colIdx = 0; colIdx < ITEMS_PER_ROW; colIdx++, itemIdx++) {
      const slotName = `ПУНКТ_${itemIdx + 1}`
      // Strip leading "1." / "1) " / "1 " patterns — LLM copies numbered lists from source doc.
      // Numbers are already shown via red dots (01/02...).
      const itemText = stripTrailingPeriod(addNbsp(
        (slots[slotName] ?? '').trim().replace(/^\d+[\.\)\s]\s*/, '').trim()
      ))
      const colX     = colXs[colIdx]
      const numText  = String(itemIdx + 1).padStart(2, '0')

      // Red dot (ellipse) — sits on the line
      const dotId = `ag_dot_${slideIdx}_${itemIdx}`
      reqs.push(
        {
          createShape: {
            objectId: dotId,
            shapeType: 'ELLIPSE',
            elementProperties: {
              pageObjectId: pageId,
              size: {
                width:  { magnitude: _eL(_AG_DOT_SZ), unit: 'EMU' },
                height: { magnitude: _eL(_AG_DOT_SZ), unit: 'EMU' },
              },
              transform: {
                scaleX: 1, shearX: 0, translateX: _eL(colX),
                shearY: 0, scaleY: 1, translateY: _eL(row.dotY),
                unit: 'EMU',
              },
            },
          },
        },
        {
          updateShapeProperties: {
            objectId: dotId,
            shapeProperties: {
              shapeBackgroundFill: { solidFill: { color: { rgbColor: _AG_RED_RGB } } },
              outline: { propertyState: 'NOT_RENDERED' },
            },
            fields: 'shapeBackgroundFill,outline',
          },
        },
      )

      // Number text box (01, 02...) — centered on dot, above line
      const numId = `ag_num_${slideIdx}_${itemIdx}`
      reqs.push(
        {
          createShape: {
            objectId: numId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: pageId,
              size: {
                // 120px element → 82px content, safely fits "06" at 18pt (≈48px Figma)
                // Centered over dot: element_x = dot_center - 60 = colX + 27 - 60 = colX - 33
                width:  { magnitude: _eL(120), unit: 'EMU' },
                height: { magnitude: _eL(_AG_NUM_H + 2 * _INSET), unit: 'EMU' },
              },
              transform: {
                scaleX: 1, shearX: 0, translateX: _eL(colX + _AG_DOT_SZ / 2 - 60),
                shearY: 0, scaleY: 1, translateY: _eL(row.numY - _INSET),
                unit: 'EMU',
              },
            },
          },
        },
        { insertText: { objectId: numId, insertionIndex: 0, text: numText } },
        {
          updateTextStyle: {
            objectId: numId,
            style: {
              weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
              foregroundColor: { opaqueColor: { rgbColor: _AG_MUTED_RGB } },
              fontSize: { magnitude: _AG_NUM_PT, unit: 'PT' },
              bold: false,
            },
            fields: 'weightedFontFamily,foregroundColor,fontSize,bold',
            textRange: { type: 'ALL' },
          },
        },
        {
          updateParagraphStyle: {
            objectId: numId,
            style: { alignment: 'CENTER', lineSpacing: 90, spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: 0, unit: 'PT' } },
            fields: 'alignment,lineSpacing,spaceAbove,spaceBelow',
            textRange: { type: 'ALL' },
          },
        },
        {
          updateShapeProperties: {
            objectId: numId,
            shapeProperties: {
              shapeBackgroundFill: { propertyState: 'NOT_RENDERED' },
              outline:             { propertyState: 'NOT_RENDERED' },
              contentAlignment: 'MIDDLE',
              autofit: { autofitType: 'NONE' },
            },
            fields: 'shapeBackgroundFill,outline,contentAlignment,autofit.autofitType',
          },
        },
      )

      if (!itemText) continue  // dot+number always shown; text only if slot filled

      // Item text box — below line
      const textId = `ag_txt_${slideIdx}_${itemIdx}`
      reqs.push(
        {
          createShape: {
            objectId: textId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: pageId,
              size: {
                width:  { magnitude: _eL(_AG_TEXT_W + 2 * _INSET), unit: 'EMU' },
                height: { magnitude: _eL(_AG_TEXT_H + 2 * _INSET), unit: 'EMU' },
              },
              transform: {
                scaleX: 1, shearX: 0, translateX: _eL(colX - _INSET),
                shearY: 0, scaleY: 1, translateY: _eL(row.textY - _INSET),
                unit: 'EMU',
              },
            },
          },
        },
        { insertText: { objectId: textId, insertionIndex: 0, text: itemText } },
        {
          updateTextStyle: {
            objectId: textId,
            style: {
              weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
              foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 1, blue: 1 } } },
              fontSize: { magnitude: bodyPt, unit: 'PT' },
              bold: false,
            },
            fields: 'weightedFontFamily,foregroundColor,fontSize,bold',
            textRange: { type: 'ALL' },
          },
        },
        {
          updateParagraphStyle: {
            objectId: textId,
            style: { alignment: 'START', lineSpacing: 90, spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: 0, unit: 'PT' } },
            fields: 'alignment,lineSpacing,spaceAbove,spaceBelow',
            textRange: { type: 'ALL' },
          },
        },
        {
          updateShapeProperties: {
            objectId: textId,
            shapeProperties: {
              shapeBackgroundFill: { propertyState: 'NOT_RENDERED' },
              outline:             { propertyState: 'NOT_RENDERED' },
              contentAlignment: 'TOP',
              autofit: { autofitType: 'NONE' },
            },
            fields: 'shapeBackgroundFill,outline,contentAlignment,autofit.autofitType',
          },
        },
      )
    }
  }

  return reqs
}

// ─── Post-generation self-repair ─────────────────────────────────────────────
// After validateDeck, if max_chars FAILs remain, collect them with objectIds so
// fixOverflowSlots can patch the live slide without re-running the full pipeline.
type SlotRepairTarget = {
  slideIndex: number
  slotName: string
  objectId: string
  currentText: string
  limit: number
}

function collectRepairTargets(
  report: ValidationReport,
  plan: SlidePlan,
  slotObjectIds: Array<Record<string, string>>,
): SlotRepairTarget[] {
  const targets: SlotRepairTarget[] = []
  for (const sv of report.slides) {
    if (sv.pass) continue
    if (!sv.checks.some(c => c.check === 'max_chars' && !c.pass)) continue
    const comp = getComposition(sv.composition)
    if (!comp) continue
    const planSlide = plan.slides[sv.slideIndex]
    if (!planSlide) continue
    for (const slotDef of comp.slots) {
      if (slotDef.type !== 'text' || !slotDef.max_chars) continue
      const val = planSlide.slots[slotDef.name] ?? ''
      if (val.length <= slotDef.max_chars) continue
      const objectId = slotObjectIds[sv.slideIndex]?.[slotDef.name]
      if (!objectId) {
        console.warn(`[repair] no objectId for ${sv.composition}.${slotDef.name} slide ${sv.slideIndex} — skipped`)
        continue
      }
      targets.push({ slideIndex: sv.slideIndex, slotName: slotDef.name, objectId, currentText: val, limit: slotDef.max_chars })
    }
  }
  return targets
}

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

function getServerGoogleAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY не заданий в env — вставте JSON сервіс-акаунту в цю змінну')
  let credentials: unknown
  try {
    const decoded = Buffer.from(keyJson.trim(), 'base64').toString('utf-8')
    credentials = JSON.parse(decoded)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_KEY: помилка декодування base64 або JSON: ${msg}`)
  }
  return new google.auth.GoogleAuth({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentials: credentials as any,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  })
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

// ─── Post-generation fact verification: reads actual deck, checks real numbers ─
async function readDeckFacts(
  slidesApi: slides_v1.Slides,
  presentationId: string,
  plan: SlidePlan,
  planPageIds: string[],
  slotObjectIds: Array<Record<string, string>>,
  expectedCardPts: Map<number, Record<string, number>>,
): Promise<DeckFactReport> {
  const pres = await slidesApi.presentations.get({ presentationId })
  const allSlides = pres.data.slides ?? []

  const slideResults: SlideDeckFacts[] = []

  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const pSlide = plan.slides[i]
    const actualSlide = allSlides.find(s => s.objectId === pageId)
    const facts: DeckFact[] = []

    if (!actualSlide) {
      facts.push({ slotName: 'slide', text: '', pass: false, reason: `pageId ${pageId} missing from deck` })
      slideResults.push({ slideIndex: i, composition: compId, pass: false, facts })
      continue
    }

    // Build objectId → shape lookup
    const shapeById = new Map<string, slides_v1.Schema$PageElement>()
    for (const el of actualSlide.pageElements ?? []) {
      if (el.objectId) shapeById.set(el.objectId, el)
    }

    const objIds = slotObjectIds[i] ?? {}
    const cardPts = expectedCardPts.get(i)
    const bentoTokens: string[] = BENTO_TOKENS[compId] ?? []
    const isKpi = compId === 'kpi_cards'

    // Only check slots we care about: bento cards + kpi ЗНАЧЕННЯ
    const slotsToCheck = [
      ...bentoTokens,
      ...(isKpi ? ['КАРТКА_1_ЗНАЧЕННЯ', 'КАРТКА_2_ЗНАЧЕННЯ', 'КАРТКА_3_ЗНАЧЕННЯ', 'КАРТКА_4_ЗНАЧЕННЯ'] : []),
    ]

    for (const slotName of slotsToCheck) {
      const expectedText = (pSlide.slots[slotName] ?? '').trim()
      if (!expectedText) continue  // slot absent from plan — skip

      const objId = objIds[slotName]
      if (!objId) {
        facts.push({ slotName, text: '', pass: false, reason: 'objectId not tracked (slot missing from master?)' })
        continue
      }

      const shape = shapeById.get(objId)
      if (!shape) {
        facts.push({ slotName, text: '', pass: false, reason: 'shape deleted from deck (empty card)' })
        continue
      }

      const actualText = (shape.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('').replace(/\n$/, '').trim()

      if (!actualText) {
        facts.push({ slotName, text: '', pass: false, reason: 'shape exists but text is empty' })
        continue
      }

      const displayText = actualText.slice(0, 40)

      // bento card: check fontSize
      if (bentoTokens.includes(slotName) && cardPts) {
        const expectedPt = cardPts[slotName]
        const fontSizes = (shape.shape?.text?.textElements ?? [])
          .map(te => te.textRun?.style?.fontSize?.magnitude ?? null)
          .filter((n): n is number => n !== null)
        const actualPt = fontSizes[0] ?? null

        const ptPass = expectedPt !== undefined && actualPt === expectedPt
        facts.push({
          slotName,
          text: displayText,
          fontSize: actualPt ?? undefined,
          expectedFontSize: expectedPt,
          pass: ptPass,
          reason: ptPass ? undefined : actualPt === null
            ? 'fontSize not found in shape'
            : `fontSize ${actualPt}pt ≠ expected ${expectedPt}pt`,
        })
        continue
      }

      // kpi ЗНАЧЕННЯ: just confirm content is present
      if (isKpi && slotName.endsWith('_ЗНАЧЕННЯ')) {
        facts.push({ slotName, text: displayText, pass: true })
        continue
      }
    }

    const slidePass = facts.length === 0 || facts.every(f => f.pass)
    slideResults.push({ slideIndex: i, composition: compId, pass: slidePass, facts })
  }

  const failCount = slideResults.filter(s => !s.pass).length
  const pass = failCount === 0
  const summary = pass
    ? `PASS — ${slideResults.length} slides | content + fontSize verified from file`
    : `FAIL — ${failCount}/${slideResults.length} slides have discrepancies`

  return { pass, slides: slideResults, summary }
}

// ─── Variant layout expansion ─────────────────────────────────────────────────
// Compositions in the same group render the same N-column content with a different layout.
// Slides whose composition belongs to a group get expanded into one slide per group member
// so the user can pick their preferred layout and delete the rest.

const VARIANT_GROUPS: readonly (readonly string[])[] = [
  ['title_body', 'title_photo'],
  ['two_columns', 'two_columns_labeled', 'two_columns_plain', 'bento_right_2', 'two_columns_timeline'],
  ['three_columns', 'bento_right_3', 'three_columns_num', 'columns_flex', 'three_columns_timeline'],
  ['four_columns', 'four_columns_num', 'bento_right_2x2', 'four_columns_paren', 'four_columns_bubble'],
]

const VARIANT_SLOT_MAPS: Record<string, Record<string, string>> = {
  'title_body:title_photo': {},   // ЗАГОЛОВОК+ТЕКСТ pass through; ПІДПИС dropped (filters via validTarget)
  'title_photo:title_body': {},   // ЗАГОЛОВОК+ТЕКСТ pass through; ФОТО dropped
  'two_columns:bento_right_2':         { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2' },
  'bento_right_2:two_columns':         { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2' },
  'two_columns_labeled:bento_right_2': { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2' },
  'bento_right_2:two_columns_labeled': { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2' },
  'two_columns_plain:bento_right_2':   { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2' },
  'bento_right_2:two_columns_plain':   { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2' },
  'three_columns:bento_right_3':     { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3' },
  'bento_right_3:three_columns':     { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3' },
  'bento_right_3:three_columns_num': { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3' },
  'three_columns_num:bento_right_3': { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3' },
  'three_columns_timeline:bento_right_3': { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3' },
  'bento_right_3:three_columns_timeline': { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3' },
  'two_columns_timeline:bento_right_2':   { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2' },
  'bento_right_2:two_columns_timeline':   { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2' },
  'four_columns:bento_right_2x2':     { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3', 'КОЛОНКА_4': 'КАРТКА_4' },
  'four_columns:bento_bottom_4':      { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3', 'КОЛОНКА_4': 'КАРТКА_4' },
  'four_columns_num:bento_right_2x2': { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3', 'КОЛОНКА_4': 'КАРТКА_4' },
  'four_columns_num:bento_bottom_4':  { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3', 'КОЛОНКА_4': 'КАРТКА_4' },
  'bento_right_2x2:four_columns':        { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3', 'КАРТКА_4': 'КОЛОНКА_4' },
  'bento_right_2x2:four_columns_num':    { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3', 'КАРТКА_4': 'КОЛОНКА_4' },
  'bento_right_2x2:four_columns_paren':  { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3', 'КАРТКА_4': 'КОЛОНКА_4' },
  'bento_right_2x2:four_columns_bubble': { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3', 'КАРТКА_4': 'КОЛОНКА_4' },
  'four_columns_paren:bento_right_2x2':  { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3', 'КОЛОНКА_4': 'КАРТКА_4' },
  'four_columns_bubble:bento_right_2x2': { 'КОЛОНКА_1': 'КАРТКА_1', 'КОЛОНКА_2': 'КАРТКА_2', 'КОЛОНКА_3': 'КАРТКА_3', 'КОЛОНКА_4': 'КАРТКА_4' },
  'bento_bottom_4:four_columns':      { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3', 'КАРТКА_4': 'КОЛОНКА_4' },
  'bento_bottom_4:four_columns_num':  { 'КАРТКА_1': 'КОЛОНКА_1', 'КАРТКА_2': 'КОЛОНКА_2', 'КАРТКА_3': 'КОЛОНКА_3', 'КАРТКА_4': 'КОЛОНКА_4' },
}

function remapSlotsForVariant(
  slots: Record<string, string>,
  fromComp: string,
  toComp: string,
): Record<string, string> {
  if (fromComp === toComp) return { ...slots }
  const map = VARIANT_SLOT_MAPS[`${fromComp}:${toComp}`]
  if (!map) return { ...slots }
  const targetComp = getComposition(toComp)
  const validTarget = new Set(targetComp?.slots.map(s => s.name) ?? [])
  const result: Record<string, string> = {}
  for (const [slot, value] of Object.entries(slots)) {
    const targetSlot = map[slot] ?? slot
    if (validTarget.has(targetSlot)) result[targetSlot] = value
    // else: slot absent in target composition → drop (e.g. ТЕКСТ when going to two_columns)
  }
  return result
}

type VariantInfo = { variantIdx: number; totalVariants: number }

function expandPlanWithVariants(plan: SlidePlan): {
  expanded: SlidePlan
  variantMap: Map<number, VariantInfo>
} {
  const expandedSlides: SlidePlan['slides'] = []
  const variantMap = new Map<number, VariantInfo>()

  for (const slide of plan.slides) {
    // Drop two-column slides with no ЗАГОЛОВОК whose column values already appear in other slides.
    // This removes AI-generated fragments that duplicate content from a bento_bottom_4 slide.
    if (
      (slide.composition === 'two_columns' ||
       slide.composition === 'two_columns_labeled' ||
       slide.composition === 'two_columns_plain') &&
      !(slide.slots['ЗАГОЛОВОК'] ?? '').trim()
    ) {
      const colVals = ['КОЛОНКА_1', 'КОЛОНКА_2']
        .map(k => (slide.slots[k] ?? '').trim())
        .filter(Boolean)
      const allCoveredElsewhere = colVals.length > 0 && colVals.every(val =>
        plan.slides.some(other => other !== slide &&
          Object.values(other.slots).some(v => (v ?? '').trim() === val))
      )
      if (allCoveredElsewhere) continue
    }

    const group = VARIANT_GROUPS.find(g => g.includes(slide.composition))
    if (!group) {
      expandedSlides.push(slide)
      continue
    }

    // Only include variants that preserve ALL non-empty content from the original.
    // Slots that are structurally absent from the target composition (e.g. ТЕКСТ when going to
    // two_columns) are intentional layout differences — those drops are allowed.
    const validVariants = group.filter(varComp => {
      if (varComp === slide.composition) return true  // original always valid
      const remapped = remapSlotsForVariant(slide.slots, slide.composition, varComp)
      const remappedVals = new Set(Object.values(remapped).filter(v => (v ?? '').trim()))
      const targetComp = getComposition(varComp)
      const targetSlotNames = new Set(targetComp?.slots.map(s => s.name) ?? [])
      const transitionMap = VARIANT_SLOT_MAPS[`${slide.composition}:${varComp}`] ?? {}
      // Check 1: non-empty values from explicitly mapped (or same-named) slots must be preserved.
      // Slots whose mapped name doesn't exist in the target are structural drops → allowed.
      if (Object.entries(slide.slots).some(([slot, val]) => {
        if (!(val ?? '').trim()) return false
        if (slot.startsWith('ЗОБРАЖЕННЯ_')) return false
        const mappedName = transitionMap[slot] ?? slot
        if (!targetSlotNames.has(mappedName)) return false  // structural drop → OK
        return !remappedVals.has(val)
      })) return false
      // Check 2: all required (non-optional) slots of the target composition are non-empty
      if (targetComp) {
        for (const s of targetComp.slots) {
          if (!s.optional && !(remapped[s.name] ?? '').trim()) return false
        }
      }
      // Check 3: skip variants that are visually identical to a simpler variant in the same group.
      // two_columns_labeled with no ПІДПИС renders identically to two_columns_plain.
      if (varComp === 'two_columns_labeled' && group.includes('two_columns_plain')) {
        if (!(remapped['ПІДПИС_1'] ?? '').trim() && !(remapped['ПІДПИС_2'] ?? '').trim()) return false
      }
      return true
    })

    if (validVariants.length <= 1) {
      // No meaningful alternatives — keep the original slide as-is (no pill, no expansion)
      expandedSlides.push(slide)
      continue
    }

    for (let vi = 0; vi < validVariants.length; vi++) {
      const varComp = validVariants[vi]
      const newIdx = expandedSlides.length
      variantMap.set(newIdx, { variantIdx: vi + 1, totalVariants: validVariants.length })
      expandedSlides.push({
        ...slide,
        id: `${slide.id}_v${vi + 1}`,
        composition: varComp,
        slots: remapSlotsForVariant(slide.slots, slide.composition, varComp),
        flags: { ...(slide.flags ?? {}) },
      })
    }
  }

  return { expanded: { ...plan, slides: expandedSlides }, variantMap }
}

function buildThreeColumnsNumRequests(pageId: string): object[] {
  const _3CN_GAP    = 50
  const _3CN_COL_W  = Math.floor((_UW - 2 * _3CN_GAP) / 3)  // 540
  const _3CN_BUBBLE_D = 75
  const _3CN_BUBBLE_Y = 411
  const reqs: object[] = []
  const _3CN_NUM_H = 52  // one line of 18pt at lineSpacing:90 in slide px; TEXT_BOX has ~0 default inset
  const _3CN_NUM_Y = _3CN_BUBBLE_Y + Math.floor((_3CN_BUBBLE_D - _3CN_NUM_H) / 2)  // 422
  for (let k = 0; k < 3; k++) {
    const cx    = _PAD + k * (_3CN_COL_W + _3CN_GAP)
    const bgId  = `${pageId}_3cnBubble_${k}`
    const numId = `${pageId}_3cnNum_${k}`
    reqs.push(
      // Red circle (no text — ELLIPSE inset=19px makes text area too small for 18pt)
      {
        createShape: {
          objectId: bgId,
          shapeType: 'ELLIPSE',
          elementProperties: {
            pageObjectId: pageId,
            size: {
              width:  { magnitude: _eL(_3CN_BUBBLE_D), unit: 'EMU' },
              height: { magnitude: _eL(_3CN_BUBBLE_D), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(cx),
              shearY: 0, scaleY: 1, translateY: _eL(_3CN_BUBBLE_Y),
              unit: 'EMU',
            },
          },
        },
      },
      {
        updateShapeProperties: {
          objectId: bgId,
          shapeProperties: {
            shapeBackgroundFill: {
              solidFill: { color: { rgbColor: { red: 0xFD / 255, green: 0x34 / 255, blue: 0x33 / 255 } }, alpha: 1 },
            },
            outline: { propertyState: 'NOT_RENDERED' },
          },
          fields: 'shapeBackgroundFill,outline',
        },
      },
      // Number overlay: TEXT_BOX (0 inset) centered vertically on the circle
      {
        createShape: {
          objectId: numId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: pageId,
            size: {
              width:  { magnitude: _eL(_3CN_BUBBLE_D), unit: 'EMU' },
              height: { magnitude: _eL(_3CN_NUM_H), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(cx),
              shearY: 0, scaleY: 1, translateY: _eL(_3CN_NUM_Y),
              unit: 'EMU',
            },
          },
        },
      },
      {
        updateShapeProperties: {
          objectId: numId,
          shapeProperties: {
            shapeBackgroundFill: { propertyState: 'NOT_RENDERED' },
            outline: { propertyState: 'NOT_RENDERED' },
            autofit: { autofitType: 'NONE' },
          },
          fields: 'shapeBackgroundFill,outline,autofit.autofitType',
        },
      },
      { insertText: { objectId: numId, insertionIndex: 0, text: `${k + 1}` } },
      {
        updateTextStyle: {
          objectId: numId,
          style: {
            fontSize: { magnitude: 18, unit: 'PT' },
            bold: false,
            foregroundColor: { opaqueColor: { rgbColor: { red: 0xFC / 255, green: 0xCA / 255, blue: 0xCA / 255 } } },
            weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
          },
          fields: 'fontSize,bold,foregroundColor,weightedFontFamily',
          textRange: { type: 'ALL' },
        },
      },
      {
        updateParagraphStyle: {
          objectId: numId,
          style: { alignment: 'CENTER', lineSpacing: 90, spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: 0, unit: 'PT' } },
          fields: 'alignment,lineSpacing,spaceAbove,spaceBelow',
          textRange: { type: 'ALL' },
        },
      },
    )
  }
  return reqs
}

// Resize ЗАГОЛОВОК + reposition КОЛОНКА_N text boxes for timeline compositions.
// Returns layout requests + computed dotsY so buildTimelineRequests can place dots correctly.
// Title uses 44pt (narrower than bento 66pt) with full TITLE_W width → fewer lines → less overflow risk.
const TCL_TITLE_PT       = 44
const TCL_TITLE_HMAX     = 300   // cap in px; prevents dots from being pushed off-slide
const TCL_TITLE_GAP      = 60   // gap: title content bottom → dot top
const TCL_DOT_TEXT_GAP   = 20   // gap: dot bottom → text top (three_columns_timeline only)
const TCL_ZONE_X_THREE   = [100, 680, 1260] as const
const TCL_ZONE_W_THREE   = 560
const TCL_TEXT_X_TWO     = [175, 1045] as const
const TCL_TEXT_W_TWO     = [674, 623] as const

function buildTimelineLayoutRequests(
  slide: slides_v1.Schema$Page,
  compId: string,
  pSlots: Record<string, string>,
): { requests: object[]; dotsY: number } {
  const titleText = (pSlots['ЗАГОЛОВОК'] ?? '').trim()
  const titleLines  = titleText ? estimateLineCount(titleText, _TITLE_W, TCL_TITLE_PT) : 1
  const titleContentH = Math.min(
    Math.max(Math.ceil(titleLines * lineH(TCL_TITLE_PT)), Math.ceil(lineH(TCL_TITLE_PT))),
    TCL_TITLE_HMAX,
  )

  // Title box at y=99 (master) → content starts at y=99+_INSET=118
  const titleContentY = _PAD - 1 + _INSET  // 118
  const dotsY = titleContentY + titleContentH + TCL_TITLE_GAP

  const isThree = compId === 'three_columns_timeline'
  const textY   = dotsY  // text top aligned with dot top for both compositions
  const textH   = _H - _PAD - textY

  const bentoTokens = BENTO_TOKENS[compId] ?? []
  const reqs: object[] = []

  for (const el of slide.pageElements ?? []) {
    if (!el.objectId || !el.transform || !el.size) continue
    const sW = el.size.width?.magnitude ?? 0
    const sH = el.size.height?.magnitude ?? 0
    const elX = Math.round((el.transform.translateX ?? 0) / _FPX)
    const elY = Math.round((el.transform.translateY ?? 0) / _FPX)

    const elText = (el.shape?.text?.textElements ?? [])
      .map(te => te.textRun?.content ?? '').join('')

    if (elText.includes('{{ЗАГОЛОВОК}}')) {
      reqs.push(makeElemTransform(el.objectId,
        elX, elY,
        _TITLE_W + 2 * _INSET, titleContentH + 2 * _INSET,
        sW, sH,
      ))
      continue
    }

    const tokenIdx = bentoTokens.findIndex(t => elText.includes(`{{${t}}}`))
    if (tokenIdx < 0) continue

    if (isThree) {
      const txtX = TCL_ZONE_X_THREE[tokenIdx] + _AG_DOT_SZ + 10  // after dot (54px) + 10px gap
      const txtW = TCL_ZONE_W_THREE - _AG_DOT_SZ - 10             // zone_w - dot - gap = 496
      reqs.push(makeElemTransform(el.objectId,
        txtX - _INSET, textY - _INSET,
        txtW + 2 * _INSET, textH + 2 * _INSET,
        sW, sH,
      ))
    } else {
      reqs.push(makeElemTransform(el.objectId,
        TCL_TEXT_X_TWO[tokenIdx] - _INSET, textY - _INSET,
        TCL_TEXT_W_TWO[tokenIdx] + 2 * _INSET, textH + 2 * _INSET,
        sW, sH,
      ))
    }
  }

  return { requests: reqs, dotsY }
}

// three_columns_timeline / two_columns_timeline: create red circles + vertical lines.
// dotsY is computed by buildTimelineLayoutRequests (dynamic, title-height-aware).
function buildTimelineRequests(pageId: string, slideIdx: number, colXs: readonly number[], dotsY: number): object[] {
  const reqs: object[] = []
  const TCL_DOT_Y  = dotsY
  const TCL_LINE_Y = TCL_DOT_Y + _AG_DOT_SZ
  const TCL_LINE_H = 1080 - TCL_LINE_Y
  for (let k = 0; k < colXs.length; k++) {
    const cx      = colXs[k]
    const centerX = cx + _AG_DOT_SZ / 2                  // circle center x
    const dotId   = `tcl_dot_${slideIdx}_${k}`
    const lineId  = `tcl_line_${slideIdx}_${k}`
    reqs.push(
      { createShape: { objectId: dotId, shapeType: 'ELLIPSE', elementProperties: {
        pageObjectId: pageId,
        size: { width:  { magnitude: _eL(_AG_DOT_SZ), unit: 'EMU' },
                height: { magnitude: _eL(_AG_DOT_SZ), unit: 'EMU' } },
        transform: { scaleX: 1, shearX: 0, translateX: _eL(cx),
                     shearY: 0, scaleY: 1, translateY: _eL(TCL_DOT_Y), unit: 'EMU' },
      } } },
      { updateShapeProperties: { objectId: dotId, shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: _AG_RED_RGB } } },
        outline: { propertyState: 'NOT_RENDERED' },
      }, fields: 'shapeBackgroundFill,outline' } },
      { createShape: { objectId: lineId, shapeType: 'RECTANGLE', elementProperties: {
        pageObjectId: pageId,
        size: { width:  { magnitude: _eL(_AG_LINE_H), unit: 'EMU' },
                height: { magnitude: _eL(TCL_LINE_H), unit: 'EMU' } },
        transform: { scaleX: 1, shearX: 0, translateX: _eL(centerX - _AG_LINE_H / 2),
                     shearY: 0, scaleY: 1, translateY: _eL(TCL_LINE_Y), unit: 'EMU' },
      } } },
      { updateShapeProperties: { objectId: lineId, shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: _AG_RED_RGB } } },
        outline: { propertyState: 'NOT_RENDERED' },
      }, fields: 'shapeBackgroundFill,outline' } },
    )
  }
  return reqs
}

// columns_flex: dynamic 2–4 column layout with gray "(N)" labels.
// Deletes the three_columns_num template column boxes and recreates N fresh boxes
// at dynamic widths. Title stays in the template (already filled via replaceAllText).
function buildColumnsFlexRequests(
  pageId: string,
  n: number,
  colTexts: string[],
  templateColIds: (string | undefined)[],
): object[] {
  const _CF_GAP   = 50
  const _CF_X0    = _PAD        // 100
  const _CF_UW    = _UW         // 1720
  const _CF_NUM_Y = 451         // matches four_columns_paren label Y
  const _CF_NUM_H = 60
  const _CF_COL_Y = 540
  const _CF_COL_H = _H_SLIDE - _PAD - _CF_COL_Y  // 440

  const colW = Math.floor((_CF_UW - (n - 1) * _CF_GAP) / n)
  const reqs: object[] = []

  // Delete template column text boxes
  for (const objId of templateColIds) {
    if (objId) reqs.push({ deleteObject: { objectId: objId } })
  }

  const _MUTED_CF = _BADGE_FG   // #A2A6B1

  for (let k = 0; k < n; k++) {
    const cx  = _CF_X0 + k * (colW + _CF_GAP)
    const numId = `${pageId}_cf_num${k + 1}`
    const colId = `${pageId}_cf_col${k + 1}`

    // "(N)" label in muted gray
    reqs.push(
      {
        createShape: {
          objectId: numId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: pageId,
            size: {
              width:  { magnitude: _eL(Math.min(colW, 120)), unit: 'EMU' },
              height: { magnitude: _eL(_CF_NUM_H), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(cx),
              shearY: 0, scaleY: 1, translateY: _eL(_CF_NUM_Y),
              unit: 'EMU',
            },
          },
        },
      },
      { insertText: { objectId: numId, insertionIndex: 0, text: `(${k + 1})` } },
      {
        updateTextStyle: {
          objectId: numId,
          style: {
            fontSize: { magnitude: 18, unit: 'PT' },
            bold: false,
            foregroundColor: { opaqueColor: { rgbColor: _MUTED_CF } },
            weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
          },
          fields: 'fontSize,bold,foregroundColor,weightedFontFamily',
          textRange: { type: 'ALL' },
        },
      },
    )

    // Column text box in white
    reqs.push(
      {
        createShape: {
          objectId: colId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: pageId,
            size: {
              width:  { magnitude: _eL(colW), unit: 'EMU' },
              height: { magnitude: _eL(_CF_COL_H), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(cx),
              shearY: 0, scaleY: 1, translateY: _eL(_CF_COL_Y),
              unit: 'EMU',
            },
          },
        },
      },
      { insertText: { objectId: colId, insertionIndex: 0, text: colTexts[k] } },
      {
        updateTextStyle: {
          objectId: colId,
          style: {
            fontSize: { magnitude: 18, unit: 'PT' },
            bold: false,
            foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 1, blue: 1 } } },
            weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
          },
          fields: 'fontSize,bold,foregroundColor,weightedFontFamily',
          textRange: { type: 'ALL' },
        },
      },
      {
        updateParagraphStyle: {
          objectId: colId,
          style: { lineSpacing: 90 },
          fields: 'lineSpacing',
          textRange: { type: 'ALL' },
        },
      },
    )
  }

  return reqs
}

// ─── Flat 4-column layouts: four_columns_paren / four_columns_bubble ────────
// These reuse the bento_bottom_4 master (КАРТКА_1..4 tokens) but render WITHOUT
// card background rectangles. Text boxes are repositioned to a wider flat grid
// (gap=50px vs 30px) starting at y=540. Number indicators are created from scratch.
const _FLAT4_LEFT    = 90    // left edge of first column (matches Figma)
const _FLAT4_GAP     = 50    // wider gap for flat style
const _FLAT4_CW      = Math.floor((_UW - 3 * _FLAT4_GAP) / 4)  // 392
const _FLAT4_TEXT_Y  = 540   // top of text columns
const _FLAT4_TEXT_H  = _H - _PAD - _FLAT4_TEXT_Y   // 440
const _FLAT4_PAREN_Y = 451   // y of "(1)" labels
const _FLAT4_BUBBLE_Y = 411  // y of circle tops
const _FLAT4_BUBBLE_D = 75   // circle diameter (px)
const _FLAT4_MUTED_RGB = { red: 162 / 255, green: 166 / 255, blue: 177 / 255 }  // #A2A6B1
const _FLAT4_PINK_RGB  = { red: 0xFC / 255, green: 0xCA / 255, blue: 0xCA / 255 }  // #FCCACA

function buildFlatColumnsRequests(
  slide: slides_v1.Schema$Page,
  compId: string,
  processedSlots: Record<string, string>,
  pageId: string,
  slideIdx: number,
): object[] {
  const reqs: object[] = []
  const TOL = 8

  for (const el of slide.pageElements ?? []) {
    if (!el.objectId || !el.transform || !el.size) continue
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    const elY = Math.round((el.transform.translateY ?? 0) / _FPX)

    // Delete card RECTANGLE / ELLIPSE backgrounds (they live in the card zone ≥ _CY)
    if ((el.shape?.shapeType === 'RECTANGLE' || el.shape?.shapeType === 'ELLIPSE') && elY >= _CY - TOL) {
      reqs.push({ deleteObject: { objectId: el.objectId } })
      continue
    }

    // Reposition КАРТКА_N text boxes to flat layout
    if (el.shape?.shapeType === 'TEXT_BOX') {
      const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
      const m = raw.match(/\{\{КАРТКА_(\d+)\}\}/)
      if (!m) continue
      const k = parseInt(m[1]) - 1
      const cx = _FLAT4_LEFT + k * (_FLAT4_CW + _FLAT4_GAP)
      reqs.push(makeElemTransform(el.objectId, cx - _INSET, _FLAT4_TEXT_Y - _INSET, _FLAT4_CW + 2 * _INSET, _FLAT4_TEXT_H + 2 * _INSET, sW, sH))
      reqs.push(
        {
          updateTextStyle: {
            objectId: el.objectId,
            style: {
              foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 1, blue: 1 } } },
            },
            fields: 'foregroundColor',
            textRange: { type: 'ALL' },
          },
        },
        {
          updateParagraphStyle: {
            objectId: el.objectId,
            style: { lineSpacing: 90 },
            fields: 'lineSpacing',
            textRange: { type: 'ALL' },
          },
        },
      )
    }
  }

  // Create number indicators for each filled column
  for (let k = 0; k < 4; k++) {
    const token = `КАРТКА_${k + 1}`
    if (!(processedSlots[token] ?? '').trim()) continue
    const cx = _FLAT4_LEFT + k * (_FLAT4_CW + _FLAT4_GAP)

    if (compId === 'four_columns_paren') {
      const numId = `flat_paren_${slideIdx}_${k}`
      reqs.push(
        {
          createShape: {
            objectId: numId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: pageId,
              size: {
                width:  { magnitude: _eL(120), unit: 'EMU' },
                height: { magnitude: _eL(60),  unit: 'EMU' },
              },
              transform: { scaleX: 1, shearX: 0, translateX: _eL(cx - _INSET), shearY: 0, scaleY: 1, translateY: _eL(_FLAT4_PAREN_Y), unit: 'EMU' },
            },
          },
        },
        { insertText: { objectId: numId, insertionIndex: 0, text: `(${k + 1})` } },
        {
          updateTextStyle: {
            objectId: numId,
            style: {
              weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
              foregroundColor: { opaqueColor: { rgbColor: _FLAT4_MUTED_RGB } },
              fontSize: { magnitude: 18, unit: 'PT' },
              bold: false,
            },
            fields: 'weightedFontFamily,foregroundColor,fontSize,bold',
            textRange: { type: 'ALL' },
          },
        },
        {
          updateShapeProperties: {
            objectId: numId,
            shapeProperties: { autofit: { autofitType: 'NONE' } },
            fields: 'autofit.autofitType',
          },
        },
      )
    }

    if (compId === 'four_columns_bubble') {
      const _F4_NUM_H = 52
      const _F4_NUM_Y = _FLAT4_BUBBLE_Y + Math.floor((_FLAT4_BUBBLE_D - _F4_NUM_H) / 2)  // 422
      const bgId  = `flat_bubble_${slideIdx}_${k}`
      const numId = `flat_bubble_num_${slideIdx}_${k}`
      reqs.push(
        // Red circle (no text)
        {
          createShape: {
            objectId: bgId,
            shapeType: 'ELLIPSE',
            elementProperties: {
              pageObjectId: pageId,
              size: {
                width:  { magnitude: _eL(_FLAT4_BUBBLE_D), unit: 'EMU' },
                height: { magnitude: _eL(_FLAT4_BUBBLE_D), unit: 'EMU' },
              },
              transform: { scaleX: 1, shearX: 0, translateX: _eL(cx), shearY: 0, scaleY: 1, translateY: _eL(_FLAT4_BUBBLE_Y), unit: 'EMU' },
            },
          },
        },
        {
          updateShapeProperties: {
            objectId: bgId,
            shapeProperties: {
              shapeBackgroundFill: { solidFill: { color: { rgbColor: _AG_RED_RGB } } },
              outline: { propertyState: 'NOT_RENDERED' },
            },
            fields: 'shapeBackgroundFill,outline',
          },
        },
        // Number overlay: TEXT_BOX centered on circle
        {
          createShape: {
            objectId: numId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: pageId,
              size: {
                width:  { magnitude: _eL(_FLAT4_BUBBLE_D), unit: 'EMU' },
                height: { magnitude: _eL(_F4_NUM_H), unit: 'EMU' },
              },
              transform: { scaleX: 1, shearX: 0, translateX: _eL(cx), shearY: 0, scaleY: 1, translateY: _eL(_F4_NUM_Y), unit: 'EMU' },
            },
          },
        },
        {
          updateShapeProperties: {
            objectId: numId,
            shapeProperties: {
              shapeBackgroundFill: { propertyState: 'NOT_RENDERED' },
              outline: { propertyState: 'NOT_RENDERED' },
              autofit: { autofitType: 'NONE' },
            },
            fields: 'shapeBackgroundFill,outline,autofit.autofitType',
          },
        },
        { insertText: { objectId: numId, insertionIndex: 0, text: String(k + 1) } },
        {
          updateTextStyle: {
            objectId: numId,
            style: {
              weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
              foregroundColor: { opaqueColor: { rgbColor: _FLAT4_PINK_RGB } },
              fontSize: { magnitude: 18, unit: 'PT' },
              bold: false,
            },
            fields: 'weightedFontFamily,foregroundColor,fontSize,bold',
            textRange: { type: 'ALL' },
          },
        },
        {
          updateParagraphStyle: {
            objectId: numId,
            style: { alignment: 'CENTER', lineSpacing: 90, spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: 0, unit: 'PT' } },
            fields: 'alignment,lineSpacing,spaceAbove,spaceBelow',
            textRange: { type: 'ALL' },
          },
        },
      )
    }
  }

  return reqs
}

function makeVariantPillRequests(pillId: string, pageId: string, variantIdx: number): object[] {
  const PILL_W = 500
  const PILL_H = 70
  const PILL_X = _W - _PAD - PILL_W   // 1320 — right-aligned with slide padding
  const PILL_Y = _H_SLIDE - _PAD + 8  // 988 — below content area, above slide bottom
  const pillText = `Варіант дизайну ${variantIdx}`

  return [
    {
      createShape: {
        objectId: pillId,
        shapeType: 'ROUND_RECTANGLE',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            width:  { magnitude: _eL(PILL_W), unit: 'EMU' },
            height: { magnitude: _eL(PILL_H), unit: 'EMU' },
          },
          transform: {
            scaleX: 1, shearX: 0, translateX: _eL(PILL_X),
            shearY: 0, scaleY: 1, translateY: _eL(PILL_Y),
            unit: 'EMU',
          },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId: pillId,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: {
              color: { rgbColor: { red: 1.0, green: 0.745, blue: 0.0 } }, // amber #FFBE00
              alpha: 1,
            },
          },
          outline: { propertyState: 'NOT_RENDERED' },
          contentAlignment: 'MIDDLE',
        },
        fields: 'shapeBackgroundFill,outline,contentAlignment',
      },
    },
    { insertText: { objectId: pillId, insertionIndex: 0, text: pillText } },
    {
      updateTextStyle: {
        objectId: pillId,
        style: {
          fontSize: { magnitude: 12, unit: 'PT' },
          bold: false,
          foregroundColor: { opaqueColor: { rgbColor: { red: 0.106, green: 0.114, blue: 0.137 } } }, // dark #1B1D23
          weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
        },
        fields: 'fontSize,bold,foregroundColor,weightedFontFamily',
        textRange: { type: 'ALL' },
      },
    },
    {
      updateParagraphStyle: {
        objectId: pillId,
        style: { alignment: 'CENTER', lineSpacing: 90 },
        fields: 'alignment,lineSpacing',
        textRange: { type: 'ALL' },
      },
    },
  ]
}

export async function buildPresentation(
  accessToken: string,
  plan: SlidePlan,
  title: string,
): Promise<{ url: string; presentationId: string; validation: ValidationReport; deckFacts: DeckFactReport }> {
  // Guard: fix LLM slot-naming mistakes. Uses /_\d+$/ (ASCII-only) — immune to
  // Cyrillic/Latin lookalike homoglyphs that break direct string-key access.
  plan = {
    ...plan,
    slides: plan.slides.map(slide => {
      let composition = slide.composition
      const slots: Record<string, string> = { ...slide.slots }

      // three_columns/three_columns_num: max 3 numeric-suffix slots allowed.
      // Count all keys ending in _N regardless of prefix encoding.
      if (composition === 'three_columns' || composition === 'three_columns_num') {
        const numericKeyCount = Object.keys(slots).filter(k => /_\d+$/.test(k)).length
        if (numericKeyCount > 3) {
          const target = composition === 'three_columns_num' ? 'four_columns_num' : 'four_columns'
          console.warn(`[guard] ${composition}: ${numericKeyCount} numeric slots → ${target}`)
          composition = target
        }
      }

      // bento_right_*: all _N keys must be КАРТКА_N (Cyrillic from source).
      // Rename any _N key whose exact string !== the Cyrillic КАРТКА_N we'd create.
      if (composition.startsWith('bento_right_')) {
        const numKeys = Object.keys(slots).filter(k => /_\d+$/.test(k) && slots[k])
        let renamed = false
        for (const k of numKeys) {
          const num = k.match(/_(\d+)$/)?.[1]
          if (!num) continue
          const correct = `КАРТКА_${num}`
          if (k !== correct) {
            slots[correct] = slots[k]
            delete slots[k]
            renamed = true
          }
        }
        if (renamed) {
          const n = Object.keys(slots).filter(k => /_\d+$/.test(k) && slots[k]).length
          const fixed = n >= 4 ? 'bento_right_2x2' : n === 2 ? 'bento_right_2' : 'bento_right_3'
          console.warn(`[guard] bento: renamed wrong keys → ${n} КАРТКА, ${fixed}`)
          composition = fixed
        }
      }

      return composition === slide.composition && slots === slide.slots
        ? slide
        : { ...slide, composition, slots }
    }),
  }

  const auth = getOAuth2Client(accessToken)
  const drive = google.drive({ version: 'v3', auth })
  const slidesApi = google.slides({ version: 'v1', auth })
  const logoUrl = getLogoUrl()
  const masterDeckId = process.env.MASTER_DECK_ID
  if (!masterDeckId) throw new Error('MASTER_DECK_ID не заданий у .env.local — оновіть його і перезапустіть сервер')

  // Step 1: Copy master deck — user token with drive scope, file owned by user
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

  // Step 2.0: Strip slots not in the closing composition (closing = only ЗАГОЛОВОК).
  for (const slide of plan.slides) {
    if (slide.composition !== 'closing') continue
    delete slide.slots['ПІДЗАГОЛОВОК']
    delete slide.slots['ЗОБРАЖЕННЯ_1']
  }

  // Step 2.1: Normalize plan slots.
  // (a) Strip leading "* " bullet markers — verbatim source texts may use markdown bullets.
  // (b) Dedup consecutive identical ЗАГОЛОВОК — section→content slides often share the same heading.
  //     Uses "prevFinalTitle" (what the previous slide WILL show) so a repeated section heading
  //     after an intervening null slide is not incorrectly deleted.
  {
    let prevFinalTitle: string | undefined
    for (const slide of plan.slides) {
      for (const [k, v] of Object.entries(slide.slots)) {
        const stripped = v.replace(/^\*\s+/gm, '').trim()
        if (stripped !== v) slide.slots[k] = stripped || undefined as unknown as string
        if (stripped === '') delete slide.slots[k]
      }
      const isAgendaSlide = slide.composition.startsWith('agenda_')
      const title = (slide.slots['ЗАГОЛОВОК'] ?? '').trim()
      if (!isAgendaSlide && title && title === prevFinalTitle) {
        delete slide.slots['ЗАГОЛОВОК']
        prevFinalTitle = undefined  // this slide now has no title — next slide is compared to null
      } else {
        // Agenda slides never set prevFinalTitle — their canonical "Адженда" title
        // must never cause the next slide's title to be deduped.
        prevFinalTitle = isAgendaSlide ? undefined : (title || undefined)
      }
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
    // columns_flex: needs ≥2 filled КОЛОНКА_N; otherwise downgrade to title_body.
    // Handled separately since it's not in BENTO_TOKENS (avoid bento layout interference).
    for (const slide of plan.slides) {
      if (slide.composition !== 'columns_flex') continue
      const filled = ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3', 'КОЛОНКА_4'].filter(t => !!slide.slots[t]).length
      if (filled < 2) slide.composition = 'title_body'
    }
    // four_columns/four_columns_num: КОЛОНКА_N slots — downgrade if < 4 filled.
    for (const slide of plan.slides) {
      if (slide.composition !== 'four_columns' && slide.composition !== 'four_columns_num') continue
      const filled = ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3', 'КОЛОНКА_4'].filter(t => !!slide.slots[t]).length
      if (filled < 4) {
        if (slide.composition === 'four_columns_num') {
          slide.composition = filled >= 3 ? 'three_columns_num' : filled === 2 ? 'two_columns' : 'title_body'
        } else {
          slide.composition = filled >= 3 ? 'three_columns' : filled === 2 ? 'two_columns' : 'title_body'
        }
      }
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

  // Step 2.51: Downgrade badges → title_body if any ПУНКТИ item exceeds 20 chars.
  // LLM sometimes copies long source text verbatim despite prompt instructions.
  for (const slide of plan.slides) {
    if (slide.composition !== 'badges') continue
    const items = (slide.slots['ПУНКТИ'] ?? '').split('\n').map(s => s.trim()).filter(Boolean)
    const hasOverflow = items.some(item => item.length > 20)
    if (hasOverflow) {
      console.warn(`[badges-downgrade] item exceeds 20 chars — switching to title_body`)
      slide.composition = 'title_body'
      slide.slots['ТЕКСТ'] = items.join('\n')
      delete slide.slots['ПУНКТИ']
    }
  }

  // Step 2.6: Log max_chars violations — DO NOT truncate.
  // Text content belongs to the user; silent truncation corrupts meaning.
  // Violations surface as FAIL in validateDeck (max_chars check).
  // Fix: tighten the LLM prompt so it never generates over-length values.
  for (const slide of plan.slides) {
    const compDef = getComposition(slide.composition)
    if (!compDef) continue
    for (const slotDef of compDef.slots) {
      if (slotDef.type !== 'text' || !slotDef.max_chars) continue
      const val = slide.slots[slotDef.name]
      if (val && val.length > slotDef.max_chars) {
        console.warn(`[overflow] ${slide.composition}.${slotDef.name}: ${val.length} chars > max ${slotDef.max_chars}`)
      }
    }
  }

  // Step 2.60: Compact large numbers in КАРТКА_N_ЗНАЧЕННЯ slots.
  // "2 000 000" → "2M"; "150 000" → "150K" — only for kpi_cards value slots.
  for (const slide of plan.slides) {
    if (slide.composition !== 'kpi_cards') continue
    for (let n = 1; n <= 4; n++) {
      const key = `КАРТКА_${n}_ЗНАЧЕННЯ`
      const val = (slide.slots[key] ?? '').trim()
      if (!val) continue
      const compacted = compactNumber(val)
      if (compacted !== val) {
        slide.slots[key] = compacted
        console.log(`[kpi_compact] ${slide.id}: ${key} "${val}" → "${compacted}"`)
        // Strip the original (long) number from ПІДПИС if it appears at the start — it's now shown in ЗНАЧЕННЯ as the compact form.
        const subKey = `КАРТКА_${n}_ПІДПИС`
        const sub = (slide.slots[subKey] ?? '').trim()
        for (const prefix of [val, compacted]) {
          if (sub.startsWith(prefix)) {
            const stripped = sub.slice(prefix.length).replace(/^[\s,.:;—–-]+/, '').trim()
            if (stripped) slide.slots[subKey] = stripped.charAt(0).toUpperCase() + stripped.slice(1)
            break
          }
        }
      }
    }
  }

  // Step 2.61: Strip ЗНАЧЕННЯ prefix from ПІДПИС — exact OR compact-equivalent.
  // Case A (exact):   val="20+",  sub="20+ офіційних..."       → "Офіційних..."
  // Case B (compact): val="2M+",  sub="2 000 000+ застосунків" → "Застосунків..."
  for (const slide of plan.slides) {
    if (slide.composition !== 'kpi_cards') continue
    for (let n = 1; n <= 4; n++) {
      const val = (slide.slots[`КАРТКА_${n}_ЗНАЧЕННЯ`] ?? '').trim()
      const subKey = `КАРТКА_${n}_ПІДПИС`
      const sub = (slide.slots[subKey] ?? '').trim()
      if (!val || !sub) continue

      let stripLen = 0
      if (sub.startsWith(val)) {
        stripLen = val.length
      } else {
        // Leading non-letter token in ПІДПИС (e.g. "2 000 000+ ") — compact it and compare
        const leadMatch = sub.match(/^[^а-яА-ЯіїєґА-Яa-zA-Z]+/)
        if (leadMatch && compactNumber(leadMatch[0].trim()) === val) {
          stripLen = leadMatch[0].length
        }
      }

      if (stripLen > 0) {
        const stripped = sub.slice(stripLen).replace(/^[\s,.:;—–-]+/, '').trim()
        if (stripped) slide.slots[subKey] = stripped.charAt(0).toUpperCase() + stripped.slice(1)
      }
    }
  }

  // Step 2.62: Always capitalize first letter of КАРТКА_N_ПІДПИС.
  // Covers cases where LLM already produced a stripped label (lowercase) without a leading number.
  for (const slide of plan.slides) {
    if (slide.composition !== 'kpi_cards') continue
    for (let n = 1; n <= 4; n++) {
      const subKey = `КАРТКА_${n}_ПІДПИС`
      const sub = (slide.slots[subKey] ?? '').trim()
      if (!sub) continue
      slide.slots[subKey] = sub.charAt(0).toUpperCase() + sub.slice(1)
    }
  }

  // Step 2.65: Sanitise kpi_cards — ensure КАРТКА_N_ЗНАЧЕННЯ is a clean metric.
  // If the value is a phrase like "35 категорій у магазині", extract the numeric
  // prefix ("35") and promote the text remainder to ПІДПИС (if ПІДПИС not already set).
  // Only delete the card when no usable numeric portion exists at all.
  const _KPI_NUMERIC_RE = /^[\d\s+\-±×x.,/%$€£<>≤≥~≈MKBmkb]+$/i
  for (const slide of plan.slides) {
    if (slide.composition !== 'kpi_cards') continue
    for (let n = 1; n <= 4; n++) {
      const key = `КАРТКА_${n}_ЗНАЧЕННЯ`
      const val = (slide.slots[key] ?? '').trim()
      if (!val) continue
      if (_KPI_NUMERIC_RE.test(val)) continue  // already a clean metric

      // Try numeric prefix extraction: "35 категорій" → head="35", "2 000 000+ застосунків" → head="2 000 000+"
      const numericMatch = val.match(/^[\d\s+\-±×x.,/%$€£<>≤≥~≈MKBmkb]+/i)
      if (numericMatch) {
        const head = numericMatch[0].trim()
        const tail = val.slice(numericMatch[0].length).trim()
        if (head && tail && _KPI_NUMERIC_RE.test(head)) {
          slide.slots[key] = head
          const pKey = `КАРТКА_${n}_ПІДПИС`
          if (!slide.slots[pKey] && tail) {
            slide.slots[pKey] = tail.slice(0, 40)
          }
          console.log(`[kpi_sanitise] ${slide.id}: ${key} extracted "${head}" from "${val.slice(0, 30)}"`)
          continue
        }
      }

      // No usable numeric portion — remove card entirely
      console.warn(`[kpi_sanitise] ${slide.id}: ${key} non-numeric ("${val.slice(0, 20)}") — card ${n} removed`)
      delete slide.slots[key]
      delete slide.slots[`КАРТКА_${n}_ПІДПИС`]
    }
  }

  // Step 2.8: Expand slides with multiple compatible layouts into variant copies.
  // Runs AFTER all slot sanitization so variants inherit clean content.
  // Result: for each two_columns/three_columns/bento_right_2/3 slide, insert
  // one slide per composition in its VARIANT_GROUP (adjacent in the deck).
  const { expanded: _expandedPlan, variantMap } = expandPlanWithVariants(plan)
  plan = _expandedPlan

  // Step 2.9: Auto-extract column labels for two_columns_labeled / two_columns_plain.
  // For "Label — Body" or "Label: Body" content in КОЛОНКА_N:
  //   two_columns_labeled → ПІДПИС_N = label (gray box), КОЛОНКА_N = capitalized body
  //   two_columns_plain   → КОЛОНКА_N = "label\nbody" for per-paragraph grey styling
  //   two_columns / bento_right_* → normalize "Label: Body" → "Label — Body" only
  const _hasLetter = /[a-zA-Zа-яА-ЯіІїЇєЄ'ʼ]/
  for (const slide of plan.slides) {
    const comp = slide.composition
    if (comp === 'two_columns_labeled' || comp === 'two_columns_plain') {
      for (const k of [1, 2]) {
        const col = (slide.slots[`КОЛОНКА_${k}`] ?? '').trim()
        if (!col) continue
        const split = extractColumnLabel(col)
        if (!split) continue
        if (comp === 'two_columns_labeled' && !(slide.slots[`ПІДПИС_${k}`] ?? '').trim()) {
          slide.slots[`ПІДПИС_${k}`] = split.label
          slide.slots[`КОЛОНКА_${k}`] = split.body
        } else if (comp === 'two_columns_plain') {
          slide.slots[`КОЛОНКА_${k}`] = `${split.label}\n${split.body}`
        }
      }
    } else if (comp === 'two_columns' || comp.startsWith('bento_right_')) {
      // For these compositions: colon→em-dash normalization only (no gray-label rendering)
      const slotNames = comp === 'two_columns'
        ? ['КОЛОНКА_1', 'КОЛОНКА_2']
        : ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4']
      for (const slotName of slotNames) {
        const val = (slide.slots[slotName] ?? '').trim()
        if (!val) continue
        const colonIdx = val.indexOf(': ')
        if (colonIdx <= 0 || colonIdx > 60) continue
        const label = val.slice(0, colonIdx).trim()
        if (!_hasLetter.test(label)) continue
        const body = val.slice(colonIdx + 2).trim()
        if (!body) continue
        slide.slots[slotName] = `${label} — ${body}`
      }
    }
  }

  // Step 3: Assign one real pageId to each plan slide; track what needs duplication
  const planPageIds: string[] = []
  const compUsage: Record<string, number> = {}
  const toDuplicate: Array<{ sourceId: string; planIndex: number }> = []

  // columns_flex reuses three_columns_num template (same ЗАГОЛОВОК + 3-column layout).
  // The custom rendering step deletes and recreates the column text boxes dynamically.
  // IMPORTANT: compUsage must be keyed by effectiveCompId so that columns_flex and
  // three_columns_num compete for the same pool of template slides (avoiding duplicate pageIds).
  const TEMPLATE_ALIAS: Record<string, string> = {
    columns_flex:          'three_columns_num',
    four_columns:          'bento_bottom_4',
    four_columns_num:      'bento_bottom_4',
    four_columns_paren:    'bento_bottom_4',
    four_columns_bubble:   'bento_bottom_4',
  }

  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    const effectiveCompId = TEMPLATE_ALIAS[compId] ?? compId
    const available = compMap[effectiveCompId] ?? []
    const useIdx = compUsage[effectiveCompId] ?? 0
    compUsage[effectiveCompId] = useIdx + 1

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

  // Build token → objectId map for post-generation repair.
  // Must be built from updatedSlides (still has {{TOKEN}} before batchUpdate).
  const slotObjectIds: Array<Record<string, string>> = plan.slides.map(() => ({}))
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    for (const el of slide.pageElements ?? []) {
      if (!el.objectId) continue
      const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
      const tok = raw.match(/\{\{([^}]+)\}\}/)?.[1]
      if (tok) slotObjectIds[i][tok] = el.objectId
    }
  }

  const keepSet = new Set(planPageIds.filter(Boolean))

  const requests: object[] = []

  // Pre-process bento card slots: convert " · " list separators to bullet lines.
  // Done BEFORE replaceAllText so font sizing also uses the converted text.
  const bentoProcessedSlots = new Map<number, Record<string, string>>()
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    const tokens = BENTO_TOKENS[compId]
    if (!tokens) continue
    const processed = { ...plan.slides[i].slots }
    // four_columns/four_columns_num/four_columns_paren/four_columns_bubble: LLM writes КОЛОНКА_N, template has {{КАРТКА_N}} (bento_bottom_4 alias)
    if (compId === 'four_columns' || compId === 'four_columns_num' ||
        compId === 'four_columns_paren' || compId === 'four_columns_bubble') {
      for (let k = 1; k <= 4; k++) {
        if (processed[`КОЛОНКА_${k}`] !== undefined) {
          processed[`КАРТКА_${k}`] = processed[`КОЛОНКА_${k}`]
          delete processed[`КОЛОНКА_${k}`]
        }
      }
    }
    for (const tok of tokens) {
      if (!processed[tok]) continue
      // two_columns_plain/labeled: КОЛОНКА body uses label\nbody pattern — no bullet conversion
      if (compId === 'two_columns_plain' || compId === 'two_columns_labeled') continue
      processed[tok] = preprocessBentoText(processed[tok])
    }
    bentoProcessedSlots.set(i, processed)
  }

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
    const processedSlots = bentoProcessedSlots.get(i)

    // Replace filled slots (bento card tokens use preprocessed text)
    for (const [slotName, slotValue] of Object.entries(slideSlots)) {
      if (!slotValue || slotName.startsWith('ЗОБРАЖЕННЯ')) continue
      // badges: ПУНКТИ is deleted and replaced with pill shapes — skip replaceAllText
      if (compId === 'badges' && slotName === 'ПУНКТИ') continue
      // agenda_6/8: ПУНКТ_N placeholders are deleted and recreated by buildAgendaRequests — skip replaceAllText
      if (compId.startsWith('agenda_') && slotName.startsWith('ПУНКТ_')) continue
      // four_columns/four_columns_num/paren/bubble: КОЛОНКА_N slots are remapped to КАРТКА_N in bentoProcessedSlots — handled below
      if ((compId === 'four_columns' || compId === 'four_columns_num' ||
           compId === 'four_columns_paren' || compId === 'four_columns_bubble') && /^КОЛОНКА_\d+$/.test(slotName)) continue
      let replaceText = processedSlots?.[slotName] ?? slotValue
      if (slotName === 'ЗАГОЛОВОК' || BENTO_TOKENS[compId]?.includes(slotName)) {
        replaceText = stripTrailingPeriod(replaceText)
      }
      // Failsafe: strip leading numeric from kpi_cards ПІДПИС that duplicates ЗНАЧЕННЯ.
      // Runs at write-time so no upstream bug can bypass it.
      if (compId === 'kpi_cards') {
        const kpiM = slotName.match(/^КАРТКА_(\d+)_ПІДПИС$/)
        if (kpiM) {
          const kpiVal = (slideSlots[`КАРТКА_${kpiM[1]}_ЗНАЧЕННЯ`] ?? '').trim()
          if (kpiVal) {
            let stripLen = 0
            if (replaceText.startsWith(kpiVal)) {
              stripLen = kpiVal.length
            } else {
              const lm = replaceText.match(/^[^а-яА-ЯіїєґА-Яa-zA-Z]+/)
              if (lm && compactNumber(lm[0].trim()) === kpiVal) stripLen = lm[0].length
            }
            if (stripLen > 0) {
              const s = replaceText.slice(stripLen).replace(/^[\s,.:;—–-]+/, '').trim()
              if (s) {
                replaceText = s.charAt(0).toUpperCase() + s.slice(1)
                slideSlots[slotName] = replaceText  // keep slot in sync for buildKpiUpdateRequests
              }
            }
          }
        }
      }
      replaceText = addNbsp(replaceText)
      requests.push({
        replaceAllText: {
          containsText: { text: `{{${slotName}}}`, matchCase: true },
          replaceText,
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

    // four_columns/four_columns_num/paren/bubble: write remapped КАРТКА_N tokens into bento_bottom_4 template.
    // All 4 slots must be written (or cleared) because the template always has {{КАРТКА_1..4}}.
    if (compId === 'four_columns' || compId === 'four_columns_num' ||
        compId === 'four_columns_paren' || compId === 'four_columns_bubble') {
      const pSlots = bentoProcessedSlots.get(i) ?? {}
      for (let k = 1; k <= 4; k++) {
        const val = pSlots[`КАРТКА_${k}`]
        requests.push({
          replaceAllText: {
            containsText: { text: `{{КАРТКА_${k}}}`, matchCase: true },
            replaceText: val ? addNbsp(stripTrailingPeriod(val)) : '',
            pageObjectIds: [pageId],
          },
        })
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
      compDef.card_max_h ?? 680,
      compDef.gap_min   ?? 30,
    )
    requests.push(...buildKpiUpdateRequests(slide, layout, plan.slides[i].slots))
    kpiAdaptiveSlides.add(i)
  }

  // ── Cover adaptive: grow ЗАГОЛОВОК to fit text, float ДАТА below ─────────────
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'cover') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildCoverFloatRequests(slide, plan.slides[i].slots))
  }

  // ── Cover title only: centered title + date pill ──────────────────────────
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'cover_title_only') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildCoverTitleOnlyRequests(slide, plan.slides[i].slots, pageId, i))
  }

  // ── bento_right left column: float ТЕКСТ strictly below ЗАГОЛОВОК ───────────────
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    if (!compId.startsWith('bento_right_')) continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildBentoRightLeftColumnRequests(slide, plan.slides[i].slots))
  }

  // ── section/section_red: float ПІДЗАГОЛОВОК below ЗАГОЛОВОК (gap = TITLE_GAP) ────
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    if (compId !== 'section' && compId !== 'section_red' && compId !== 'closing') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildSectionFloatRequests(slide, plan.slides[i].slots))
    // section slides always get red background (#FD3433)
    if (compId === 'section') {
      requests.push({
        updatePageProperties: {
          objectId: pageId,
          pageProperties: {
            pageBackgroundFill: {
              solidFill: {
                color: { rgbColor: { red: 0xFD / 255, green: 0x34 / 255, blue: 0x33 / 255 } },
              },
            },
          },
          fields: 'pageBackgroundFill',
        },
      })
      // Red bg → ПІДЗАГОЛОВОК must be FCCACA — only when slot is non-empty
      // (updateTextStyle on an element with no text causes API error)
      if ((plan.slides[i].slots['ПІДЗАГОЛОВОК'] ?? '').trim()) {
        for (const el of slide.pageElements ?? []) {
          if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId) continue
          const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
          if (!raw.includes('{{ПІДЗАГОЛОВОК}}')) continue
          requests.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { foregroundColor: { opaqueColor: { rgbColor: { red: 0xFC / 255, green: 0xCA / 255, blue: 0xCA / 255 } } } },
              fields: 'foregroundColor',
              textRange: { type: 'ALL' },
            },
          })
        }
      }
    }
  }

  // ── Closing title-only: override section-float ЗАГОЛОВОК with cover_title_only style ──
  // Must run AFTER section/closing loop so these requests come last (override subtitle-collapsed
  // geometry set by buildSectionFloatRequests above).
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'closing') continue
    const slots = plan.slides[i].slots
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildCoverTitleOnlyRequests(slide, slots, pageId, i))
    // Master always has {{ПІДЗАГОЛОВОК}} box — replace with '' so the token doesn't show
    requests.push({
      replaceAllText: {
        containsText: { text: '{{ПІДЗАГОЛОВОК}}', matchCase: true },
        replaceText: '',
        pageObjectIds: [pageId],
      },
    })
  }

  // ── title_body: float ТЕКСТ below ЗАГОЛОВОК (gap = TITLE_GAP) ────────────────────
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'title_body') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildTitleBodyFloatRequests(slide, plan.slides[i].slots))
  }

  // ── badges: float title + delete ПУНКТИ placeholder + create pill shapes ────
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'badges') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildBadgesRequests(i, slide, plan.slides[i].slots, pageId))
  }

  // ── agenda_*: delete placeholder items + create timeline shapes ─────────────
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    const rowDefs = AGENDA_ROW_DEFS[compId]
    if (!rowDefs) continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    requests.push(...buildAgendaRequests(slide, plan.slides[i].slots, pageId, i, rowDefs))
  }

  // ── three_columns_num: create numbered red pills ──────────────────────────────
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'three_columns_num') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    requests.push(...buildThreeColumnsNumRequests(pageId))
  }


  // ── columns_flex: delete template columns, build N dynamic white columns + gray "(N)" labels ──
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'columns_flex') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slots = plan.slides[i].slots
    const colTexts: string[] = []
    const templateColIds: (string | undefined)[] = []
    for (let k = 1; k <= 4; k++) {
      const val = slots[`КОЛОНКА_${k}`]
      if (val) colTexts.push(stripTrailingPeriod(val))
      templateColIds.push(slotObjectIds[i]?.[`КОЛОНКА_${k}`])
    }
    const n = colTexts.length
    if (n < 2) continue
    requests.push(...buildColumnsFlexRequests(pageId, n, colTexts, templateColIds))
    console.log(`[columns_flex] slide ${i + 1}: ${n} columns, colW=${Math.floor((1720 - (n - 1) * 50) / n)}px`)
  }

  // ── four_columns_paren / four_columns_bubble: flat columns, delete card BGs, add number elements ──
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    if (compId !== 'four_columns_paren' && compId !== 'four_columns_bubble') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    const pSlots = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
    requests.push(...buildFlatColumnsRequests(slide, compId, pSlots, pageId, i))
  }

  // ── *_timeline: resize title + reposition text boxes + create circles + lines ─
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    const colXs = compId === 'three_columns_timeline' ? [100, 680, 1260]
                : compId === 'two_columns_timeline'   ? [90, 960]
                : null
    if (!colXs) continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    const pSlots = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
    const { requests: layoutReqs, dotsY } = buildTimelineLayoutRequests(slide, compId, pSlots)
    requests.push(...layoutReqs)
    requests.push(...buildTimelineRequests(pageId, i, colXs, dotsY))
  }

  // ── Title logo-safe resize: clamp ЗАГОЛОВОК to _TITLE_W=1610 ────────────────────
  // Fixes old-master slides (title right=1820) without requiring master regeneration.
  // Cover / bento_right / section / closing / title_body: handled above by their float functions.
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    if (compId === 'cover' || compId === 'cover_title_only' || compId.startsWith('bento_right_') ||
        compId === 'section' || compId === 'section_red' || compId === 'closing' ||
        compId === 'title_body' || compId === 'badges' || compId === 'three_columns_num' || compId === 'columns_flex' ||
        compId === 'agenda_6' || compId === 'agenda_8') continue
    const titleObjId = slotObjectIds[i]?.['ЗАГОЛОВОК']
    if (!titleObjId) continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    const titleEl = slide.pageElements?.find(el => el.objectId === titleObjId)
    if (!titleEl?.transform || !titleEl.size) continue
    const sW  = titleEl.size.width?.magnitude  ?? 0
    const sH  = titleEl.size.height?.magnitude ?? 0
    const elX = Math.round((titleEl.transform.translateX ?? 0) / _FPX)
    const elY = Math.round((titleEl.transform.translateY ?? 0) / _FPX)
    const elW = Math.round(sW * (titleEl.transform.scaleX ?? 1) / _FPX)
    const elH = Math.round(sH * (titleEl.transform.scaleY ?? 1) / _FPX)
    if (elW > _TITLE_W + 2 * _INSET + 4) {
      requests.push(makeElemTransform(titleObjId, elX, elY, _TITLE_W + 2 * _INSET, elH, sW, sH))
    }
  }

  // ── Bento row layout: resize cards to content height, centre row in zone ─────
  // Must run BEFORE the font-size loop so element dimensions are already set.
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    if (!BENTO_TOKENS[compId]) continue
    // flat column styles have their own render loop below
    if (compId === 'four_columns_paren' || compId === 'four_columns_bubble') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    const pSlots = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
    if (!BENTO_TOKENS[compId]) continue
    const titleText = (plan.slides[i].slots['ЗАГОЛОВОК'] ?? '').trim()
    requests.push(...buildBentoRowLayoutRequests(slide, compId, pSlots, pageId, i, titleText))
  }

  // Font-size auto-shrink + colon-split colouring.
  // Runs AFTER replaceAllText — object IDs stay valid, text is already real content.
  // FIXED_RANGE requests are isolated in a separate batch so a bad endIndex never kills the main batch.
  const fixedRangeStyleRequests: object[] = []
  const _WHITE = { red: 1, green: 1, blue: 1 }
  // Save per-slide expected card pts for readDeckFacts verification.
  const expectedCardPts = new Map<number, Record<string, number>>()
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const pSlots  = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
    const cardPts = pickBentoCardPts(compId, pSlots)
    if (cardPts === null) continue
    expectedCardPts.set(i, cardPts)

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    const bentoTokens = BENTO_TOKENS[compId] ?? []
    for (const el of slide.pageElements ?? []) {
      if (!el.objectId) continue
      const elText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')

      const matchedToken = bentoTokens.find(t => elText.includes(`{{${t}}}`))
      if (!matchedToken) continue
      if (!pSlots[matchedToken]) continue  // empty card will be deleted — skip style updates

      const pt = cardPts[matchedToken]
      if (pt === undefined) continue

      const slotValue = pSlots[matchedToken] ?? ''

      // Value+label (number + description) OR plain colon-split.
      // actualLen = length of the string replaceAllText will insert:
      //   replaceAllText uses stripTrailingPeriod(pSlots[tok]) for BENTO_TOKEN slots,
      //   then addNbsp (same code-unit count). Any text transformation that ran
      //   before this point (compactNumber, de-dup, stripTrailingPeriod) is already
      //   reflected in pSlots[matchedToken], so actualLen is the post-transform length.
      const actualLen = stripTrailingPeriod(slotValue).length
      const split = splitValueLabel(slotValue)
      if (split) {
        // Step 1 (ALL): label style for the whole box — 14pt, bold:false.
        // Step 2 (FIXED_RANGE [0, safeEnd]): override value portion — large pt, white.
        const valuePt = BENTO_VALUE_PT[compId] ?? 36
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: 14, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
        const safeEnd = Math.min(split.valueEnd, actualLen)
        if (safeEnd > 0) {
          fixedRangeStyleRequests.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: {
                fontSize: { magnitude: valuePt, unit: 'PT' },
                bold: false,
                foregroundColor: { opaqueColor: { rgbColor: _WHITE } },
              },
              fields: 'fontSize,bold,foregroundColor',
              textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: safeEnd },
            },
          })
        }
      } else {
        // Plain text: base card font size for the whole box
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: pt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
        // Plain colon-split: prefix up to and including ":" → WHITE
        const colonIdx = slotValue.indexOf(':')
        const safeColonEnd = Math.min(colonIdx + 1, actualLen)
        if (colonIdx >= 0 && safeColonEnd > 0) {
          fixedRangeStyleRequests.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
              fields: 'foregroundColor',
              textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: safeColonEnd },
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
    const compId   = plan.slides[i].composition
    const titleTxt = plan.slides[i].slots['ЗАГОЛОВОК'] ?? ''
    const availH   = bentoRightTextAvailH(titleTxt)
    const textPt   = pickTextPt(compId, plan.slides[i].slots['ТЕКСТ'] ?? '', availH)
    console.log(`[bento-right-text] slide ${i}: titleLines=${estimateLineCount(titleTxt.trim(),_LTW,44)}, availH=${availH}, textPt=${textPt}`)
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

  // ── title_photo: title + body ТЕКСТ auto-shrink ─────────────────────────────
  // Left half: _LTW=830px wide. Title zone h=_TP_TITLE_H=341px. Body zone below.
  // Body textY ≈ _PAD + _TP_TITLE_H + TITLE_GAP = 100+341+60 = 501; textMaxH ≈ 1080-100-501 = 479px.
  const _TP_BODY_MAX_H = _H_SLIDE - _PAD - (_PAD + _TP_TITLE_H + TITLE_GAP)  // ~479px
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'title_photo') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    const title    = plan.slides[i].slots['ЗАГОЛОВОК'] ?? ''
    const bodyText = (plan.slides[i].slots['ТЕКСТ'] ?? '').trim()
    const titlePt  = pickTitlePhotoPt(title)

    // Body font auto-shrink (same steps as title_body)
    let bodyPt = _TB_BODY_STEPS[0]
    if (bodyText) {
      for (const pt of _TB_BODY_STEPS) {
        if (textFitsParagraphs(bodyText, _LTW, _TP_BODY_MAX_H, pt)) { bodyPt = pt; break }
      }
      console.log(`[title-photo-fit] bodyLen=${bodyText.length} | chosen_font=${bodyPt}`)
    }

    for (const el of slide.pageElements ?? []) {
      if (!el.objectId) continue
      const elText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')
      if (elText.includes('{{ЗАГОЛОВОК}}') && titlePt < 33) {
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: titlePt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
      }
      if (elText.includes('{{ТЕКСТ}}') && bodyText) {
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: bodyPt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
      }
    }
  }

  // Build a set of objectIds already scheduled for deletion — prevents later style
  // requests from referencing elements that will no longer exist when the batch runs.
  const _pendingDeletes = new Set<string>(
    (requests as Array<Record<string, unknown>>)
      .map(r => (r['deleteObject'] as Record<string, string> | undefined)?.objectId)
      .filter((id): id is string => !!id)
  )

  // General colon-split for all non-title, non-bento text slots.
  // Rule: prefix up to and including ':' → WHITE (same rule as bento above).
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    // columns_flex column boxes are deleted and recreated in buildColumnsFlexRequests.
    // Referencing their template objectIds here would cause "not found" in the fixedRange batch.
    if (compId === 'columns_flex') continue
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
        if (_pendingDeletes.has(el.objectId)) continue  // element already scheduled for deletion
        const elText = (el.shape?.text?.textElements ?? [])
          .map(te => te.textRun?.content ?? '').join('')
        if (!elText.includes(`{{${slot.name}}}`)) continue

        // Clamp endIndex to actual text length that replaceAllText will insert.
        // slotValue reflects all pre-batch mutations (compactNumber, de-dup, etc.).
        // addNbsp (applied in replaceAllText loop) keeps the same code-unit count.
        const rawEnd = colonIdx + 1
        const endIdx = Math.min(rawEnd, slotValue.length)
        if (endIdx <= 0) continue
        if (rawEnd !== endIdx) {
          console.warn(`[colon-split] clamped endIndex ${rawEnd}→${endIdx} for ${compId}/${slot.name}`)
        }
        fixedRangeStyleRequests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
            fields: 'foregroundColor',
            textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: endIdx },
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
      // Skip kpi_cards — all slots handled by adaptive layout above
      if (compId === 'kpi_cards' && kpiAdaptiveSlides.has(i)) continue
      // Skip badges ПУНКТИ — placeholder is deleted and replaced with pill shapes
      if (compId === 'badges' && slotName === 'ПУНКТИ') continue
      // Skip agenda_6/8 ПУНКТ_N — placeholders are deleted and recreated by buildAgendaRequests
      if (compId.startsWith('agenda_') && slotName.startsWith('ПУНКТ_')) continue
      // Skip columns_flex column slots — boxes are deleted and recreated by buildColumnsFlexRequests
      if (compId === 'columns_flex' && slotName.startsWith('КОЛОНКА_')) continue
      // Skip elements already scheduled for deletion
      if (_pendingDeletes.has(el.objectId)) continue

      const slotValue = slots[slotName] ?? ''
      if (!slotValue.trim()) continue

      // Use RENDERED dimensions: size.magnitude × transform.scale (intrinsic alone = always 630px)
      // All master elements are created with _INSET compensation: element = content + 2*_INSET.
      // Subtract 2*_INSET to get the actual text content area.
      const elW = Math.round((el.size.width?.magnitude  ?? 0) * (el.transform?.scaleX ?? 1) / _FPX)
      const elH = Math.round((el.size.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1) / _FPX)
      if (!elW || !elH) continue
      const innerW = Math.max(1, elW - 2 * _INSET)
      const innerH = Math.max(1, elH - 2 * _INSET)

      // Read default pt from template element's text style
      const defaultPt = (el.shape?.text?.textElements ?? [])
        .find(te => te.textRun?.style?.fontSize?.magnitude)
        ?.textRun?.style?.fontSize?.magnitude ?? 18

      const steps = (FONT_STEPS as readonly number[]).filter(s => s <= defaultPt)
      let chosenPt: number | null = null
      for (const pt of steps) {
        if (textFits(slotValue, innerW, innerH, pt)) { chosenPt = pt; break }
      }
      if (chosenPt === null) chosenPt = steps[steps.length - 1] ?? 10
      logWordFit(`${compId}/${slotName}`, slotValue, innerW, chosenPt)
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
      const compId  = plan.slides[i].composition
      const pSlots  = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
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
        if (pSlots[matchedToken]) continue  // slot has content, keep card

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


  // Speaker notes: store processed slots JSON for content verification via inspect-deck.
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    const notesObjId = slide?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId
    if (!notesObjId) continue
    const slots = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
    const payload = JSON.stringify({ composition: plan.slides[i].composition, slots })
    requests.push({ insertText: { objectId: notesObjId, insertionIndex: 0, text: `##SLOTS##\n${payload}\n` } })
  }

  // Variant pill + speaker notes for every variant slide.
  for (const [slideIdx, varInfo] of variantMap.entries()) {
    const pageId = planPageIds[slideIdx]
    if (!pageId) continue

    // Visible pill element in bottom-right corner of the slide.
    const pillId = `vpill_${slideIdx}`
    requests.push(...makeVariantPillRequests(pillId, pageId, varInfo.variantIdx))

    // Speaker notes reminder.
    const slide = updatedSlides.find(s => s.objectId === pageId)
    const notesObjId = slide?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId
    if (notesObjId) {
      requests.push({ insertText: { objectId: notesObjId, insertionIndex: 0, text: 'Лиши один слайд, видали інші варіанти та цю позначку.\n' } })
    }
  }

  if (requests.length > 0) {
    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    })
  }

  // ── two_columns_plain: grey label on first line when label\nbody pattern was applied in Step 2.9 ──
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'two_columns_plain') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    for (const k of [1, 2]) {
      const colText = (plan.slides[i].slots[`КОЛОНКА_${k}`] ?? '').trim()
      const nlIdx = colText.indexOf('\n')
      if (nlIdx <= 0) continue
      const objId = slotObjectIds[i]?.[`КОЛОНКА_${k}`]
      if (!objId) continue
      fixedRangeStyleRequests.push({
        updateTextStyle: {
          objectId: objId,
          style: { foregroundColor: { opaqueColor: { rgbColor: _AG_MUTED_RGB } } },
          fields: 'foregroundColor',
          textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: nlIdx },
        },
      })
    }
  }

  // FIXED_RANGE colon-split colouring — separate batch so a bad endIndex never aborts text replacement.
  // If this fails (e.g. a token was not replaced and text is shorter than expected), log and continue.
  if (fixedRangeStyleRequests.length > 0) {
    try {
      await slidesApi.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: fixedRangeStyleRequests },
      })
      console.log(`[colon-style] FIXED_RANGE batch ok (${fixedRangeStyleRequests.length} requests)`)
    } catch (styleErr: unknown) {
      const msg = styleErr instanceof Error ? styleErr.message : String(styleErr)
      console.warn('[colon-style] FIXED_RANGE batch failed — colon colouring skipped:', msg)
    }
  }

  // Background images — separate batch so a bad URL never breaks text replacement
  {
    const bgRequests: object[] = []
    for (let i = 0; i < planPageIds.length; i++) {
      const pageId = planPageIds[i]
      if (!pageId) continue
      const compId = plan.slides[i].composition
      const _bgSlots = plan.slides[i].slots
      const _isTitleOnlyClosing = compId === 'closing'
      if (compId !== 'cover' && compId !== 'cover_title_only' && !_isTitleOnlyClosing) continue
      bgRequests.push({
        updatePageProperties: {
          objectId: pageId,
          pageProperties: {
            pageBackgroundFill: {
              stretchedPictureFill: { contentUrl: randomCoverBg() },
            },
          },
          fields: 'pageBackgroundFill',
        },
      })
    }
    if (bgRequests.length > 0) {
      try {
        await slidesApi.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: bgRequests },
        })
        console.log(`[bg] inserted ${bgRequests.length} background(s) ok`)
      } catch (bgErr: unknown) {
        const msg = bgErr instanceof Error ? bgErr.message : String(bgErr)
        console.warn('[bg] background insertion failed (URL not accessible):', msg)
        console.warn('[bg] Set BG_BASE_URL in .env.local to fix.')
      }
    }
  }

  // title_photo: right-half image insertion — separate batch so a bad URL never breaks main batch
  {
    const photoRequests: object[] = []
    for (let i = 0; i < plan.slides.length; i++) {
      if (plan.slides[i].composition !== 'title_photo') continue
      const pageId = planPageIds[i]
      if (!pageId) continue
      const photoUrl = getHalfPhotoUrl(plan.slides[i].slots['ФОТО'])
      console.log(`[title_photo] slide ${i + 1} photo URL: ${photoUrl}`)
      photoRequests.push({
        createImage: {
          url: photoUrl,
          elementProperties: {
            pageObjectId: pageId,
            size: {
              width:  { magnitude: _eL(960),  unit: 'EMU' },
              height: { magnitude: _eL(1080), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(960),
              shearY: 0, scaleY: 1, translateY: 0,
              unit: 'EMU',
            },
          },
        },
      })
      // Bring variant pill to front — photo is inserted last and would cover it otherwise
      if (variantMap.has(i)) {
        photoRequests.push({
          updatePageElementsZOrder: {
            pageElementObjectIds: [`vpill_${i}`],
            operation: 'BRING_TO_FRONT',
          },
        })
      }
    }
    if (photoRequests.length > 0) {
      try {
        await slidesApi.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: photoRequests },
        })
        console.log(`[title_photo] inserted ${photoRequests.length} photo(s) ok`)
      } catch (photoErr: unknown) {
        const msg = photoErr instanceof Error ? photoErr.message : String(photoErr)
        console.warn('[title_photo] photo insertion failed:', msg)
      }
    }
  }

  // Logo — separate batch so a bad URL never breaks text replacement.
  // Symbol logos and wordmark logos are in independent batches so one failure doesn't kill the other.
  if (logoUrl) {
    const symbolRequests: object[] = []
    const wordmarkRequests: object[] = []
    for (let i = 0; i < planPageIds.length; i++) {
      const pageId = planPageIds[i]
      if (!pageId) continue
      const compId = plan.slides[i].composition

      const _logoSlots = plan.slides[i].slots
      const _isWordmarkSlide = compId === 'cover_title_only' || compId === 'closing'
      if (_isWordmarkSlide) {
        // SKELAR Logo.png wordmark — wider, placed at top-right touching the grid
        wordmarkRequests.push({
          createImage: {
            objectId: `logo_pl_${i}`,
            url: getLogoWordmarkUrl(),
            elementProperties: {
              pageObjectId: pageId,
              size: {
                width:  { magnitude: _eL(_LOGO_WORDMARK_W), unit: 'EMU' },
                height: { magnitude: _eL(_LOGO_H), unit: 'EMU' },
              },
              transform: {
                scaleX: 1, shearX: 0, translateX: _eL(_LOGO_WORDMARK_X),
                shearY: 0, scaleY: 1, translateY: _eL(_LOGO_WORDMARK_Y),
                unit: 'EMU',
              },
            },
          },
        })
      } else {
        const lp = _logoPos(compId)
        const isSection = compId === 'section'
        symbolRequests.push({
          createImage: {
            objectId: `logo_pl_${i}`,
            url: isSection ? getLogoRedUrl() : logoUrl,
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
    }
    if (symbolRequests.length > 0) {
      console.log(`[logo] symbol URL: ${getLogoUrl()} (${symbolRequests.length} slides)`)
      try {
        await slidesApi.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: symbolRequests },
        })
        console.log(`[logo] symbol: inserted ${symbolRequests.length} logo(s) ok`)
      } catch (logoErr: unknown) {
        const msg = logoErr instanceof Error ? logoErr.message : String(logoErr)
        console.warn('[logo] symbol insertion failed:', msg)
        console.warn('[logo] Set LOGO_URL in .env.local to fix.')
      }
    }
    if (wordmarkRequests.length > 0) {
      console.log(`[logo] wordmark URL: ${getLogoWordmarkUrl()} (${wordmarkRequests.length} slides)`)
      try {
        await slidesApi.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: wordmarkRequests },
        })
        console.log(`[logo] wordmark: inserted ${wordmarkRequests.length} logo(s) ok`)
      } catch (logoErr: unknown) {
        const msg = logoErr instanceof Error ? logoErr.message : String(logoErr)
        console.warn('[logo] wordmark insertion failed:', msg)
        console.warn('[logo] Set LOGO_WORDMARK_URL in .env.local to fix.')
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

  let validation = await validateDeck(slidesApi, presentationId, plan, planPageIds)
  console.log('[validator]', validation.summary)
  for (const sv of validation.slides) {
    if (!sv.pass) {
      const fails = sv.checks.filter(c => !c.pass).map(c => `${c.check}${c.detail ? ': ' + c.detail : ''}`).join(' | ')
      console.warn(`[validator] slide ${sv.slideIndex} (${sv.composition}): ${fails}`)
    }
  }

  // ── Post-generation self-repair: fix max_chars FAILs in the live deck ────────
  for (let repairPass = 0; repairPass < 2 && !validation.pass; repairPass++) {
    const targets = collectRepairTargets(validation, plan, slotObjectIds)
    if (targets.length === 0) break

    console.warn(`[repair] pass ${repairPass + 1}: ${targets.length} max_chars violation(s) — calling LLM`)
    let fixes: Array<{ id: string; value: string }> = []
    try {
      fixes = await fixOverflowSlots(targets.map(t => ({
        id:          t.objectId,
        slotName:    t.slotName,
        currentText: t.currentText,
        limit:       t.limit,
      })))
    } catch (e) {
      console.warn('[repair] LLM call failed:', e instanceof Error ? e.message : String(e))
      break
    }

    const validFixes = fixes.filter(f => {
      const t = targets.find(t => t.objectId === f.id)
      if (!t) return false
      if (f.value.length > t.limit) {
        console.warn(`[repair] ${t.slotName}: LLM fix still ${f.value.length}>${t.limit}`)
        return false
      }
      return true
    })

    if (validFixes.length === 0) { console.warn('[repair] no valid fixes produced'); break }

    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: validFixes.flatMap(f => [
          { deleteText: { objectId: f.id, textRange: { type: 'ALL' } } },
          { insertText: { objectId: f.id, insertionIndex: 0, text: f.value } },
        ]),
      },
    })

    for (const f of validFixes) {
      const t = targets.find(t => t.objectId === f.id)!
      plan.slides[t.slideIndex].slots[t.slotName] = f.value
    }

    console.log(`[repair] applied ${validFixes.length}/${targets.length} fix(es) — re-validating`)
    validation = await validateDeck(slidesApi, presentationId, plan, planPageIds)
    console.log('[validator after repair]', validation.summary)
  }

  const compositions = [...new Set(plan.slides.map(s => s.composition))].join(', ')
  autoPushIfPass(validation, `feat(deck): ${plan.slides.length} slides [${compositions}] — validation PASS`)

  const deckFacts = await readDeckFacts(
    slidesApi, presentationId, plan, planPageIds, slotObjectIds, expectedCardPts,
  )
  console.log('[deck-facts]', deckFacts.summary)
  for (const sf of deckFacts.slides) {
    if (!sf.pass) {
      const fails = sf.facts.filter(f => !f.pass).map(f => `${f.slotName}: ${f.reason}`).join(' | ')
      console.warn(`[deck-facts] slide ${sf.slideIndex} (${sf.composition}): ${fails}`)
    }
  }

  return { url, presentationId, validation, deckFacts }
}
