import { google } from 'googleapis'
import type { slides_v1 } from 'googleapis'
import type { SlidePlan, DeckFact, SlideDeckFacts, DeckFactReport } from './types'
import { PHASE0_COMPOSITIONS, getComposition } from './compositions'
import { validateDeck, type ValidationReport } from './validator'
import { fixOverflowSlots } from './anthropic'
import { autoPushIfPass } from './auto-push'
import { listMarkerSignal, looksLikeAction, splitLeadingFigure } from './columns'
import {
  renderedHeight, renderedHeightUniform, wrappedLines,
  LIST_ITEM_GAP_EM, FIT_MARGIN,
  type Para,
} from './textfit'

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

// Timeline layout: the dots — and the text below them — sit under the ACTUAL title, so a
// one-line title leaves ~135px more text height than a three-line one. Single source of
// truth for both the layout (buildTimelineLayoutRequests) and the font search (bentoDims),
// which previously disagreed: the font search used a hard-coded worst case (300px title)
// and threw that extra height away on every slide whose title was short.
function timelineLayoutMetrics(titleText: string): { titleContentH: number; textY: number; textH: number } {
  const lines = titleText.trim() ? estimateLineCount(titleText, _TITLE_W, TCL_TITLE_PT) : 1
  const titleContentH = Math.min(
    Math.max(Math.ceil(lines * lineH(TCL_TITLE_PT)), Math.ceil(lineH(TCL_TITLE_PT))),
    TCL_TITLE_HMAX,
  )
  const textY = (_PAD - 1 + _INSET) + titleContentH + TCL_TITLE_GAP  // title box sits at y=99
  return { titleContentH, textY, textH: _H - _PAD - textY }
}

// ─── Slide subtitle (ПІДЗАГОЛОВОК on column layouts) ─────────────────────────
// A standalone sentence under the title, in MUTED grey, smaller than the title. The brief
// writes it as a full-width block between the title and the columns; without a slot of its
// own it was landing in ПІДПИС_N and captioning a column it had nothing to do with.
//
// Size is a RATIO, not a number: the title itself moves (44→28 on columns, 36 on
// title_body, up to 66 on sections), so a fixed pt would read differently on every slide.
// 0.7 × title, snapped to the allowed scale, floor 14pt:
//   44→28   40→28   36→22   32→22   28→18   66→48
const _SUB_SCALE   = [48, 36, 28, 22, 18, 14] as const
const _SUB_RATIO   = 0.7
const _SUB_MIN_PT  = 14
const _SUB_GAP     = 60         // = TITLE_GAP; title zone → subtitle → content, same everywhere
// Line counting for a subtitle: heading-scale text, so the body ruler's 0.5 is too
// optimistic here as well. 0.62 reproduces what Slides actually did with the 68-character
// subtitle on slide 20 — three lines at 28pt, where 0.5 predicted two.
const _SUB_WRAP_CHAR_W = 0.62
// A subtitle is a sentence under a title, not a second title. Past two lines it stops
// reading as one and starts crowding the content: on slide 20 it grew to three lines at
// 28pt (246px) and left the columns with almost no air above them.
const _SUB_MAX_LINES = 2

function subtitleRatioPt(titlePt: number): number {
  const target = titlePt * _SUB_RATIO
  let best = _SUB_MIN_PT
  let bestDiff = Infinity
  for (const pt of _SUB_SCALE) {
    const diff = Math.abs(pt - target)
    if (diff < bestDiff) { bestDiff = diff; best = pt }
  }
  return Math.max(_SUB_MIN_PT, Math.min(best, titlePt - 4))
}

// The same trade the bento row makes, one level up: the free space below the subtitle is
// not negotiable, so when the sentence is too long for its size, the SIZE gives way. It
// steps down the scale until it fits _SUB_MAX_LINES, never below half the title.
function subtitlePtFor(text: string, titlePt: number): number {
  const start = subtitleRatioPt(titlePt)
  const floor = Math.max(_SUB_MIN_PT, Math.round(titlePt / 2))
  if (!text.trim()) return start
  let pt = start
  for (const step of _SUB_SCALE) {
    if (step > start || step < floor) continue
    pt = step
    if (wrappedLines(text.trim(), _TITLE_W, step, _SUB_WRAP_CHAR_W) <= _SUB_MAX_LINES) break
  }
  return pt
}

// Height as it will actually render, at the subtitle's own wrap factor.
function subtitleHeight(text: string, pt: number): number {
  if (!text.trim()) return 0
  return Math.ceil(wrappedLines(text.trim(), _TITLE_W, pt, _SUB_WRAP_CHAR_W) * pt * 2.667 * 1.1)
}

// Gap between the title and its subtitle. Proportional, not fixed: both sizes move
// (44→28 on flat columns, 32→22 on rows, 66→48 on sections), and a constant that looks
// right under 44pt looks like a hole under 28pt. A quarter of the title's line height —
// half of what a full TITLE_GAP would be, which is what the eye asked for:
//   44pt → 32px   40pt → 29px   32pt → 23px   28pt → 21px   66pt → 48px
// ×0.6 on top of the quarter-line: the measured gap was reading larger than it looks,
// because a line box is taller than the glyphs inside it (see titleTextBottom).
function titleSubGap(titlePt: number): number {
  return Math.round(0.25 * 0.72 * titlePt * 2.667 * 1.1)
}

// Width factor for counting TITLE lines. The body ruler's 0.5 is right for 14–22pt text
// and too optimistic for a 44pt heading in Cyrillic caps: it read "Підтримка талановитих
// учнів" as one line where Slides wraps it to two, and the subtitle was placed on top of
// the title's second line. Anchors from real decks at 44pt in a 1610px box:
//   "Амбасадорська програма" (22 chars) — one line   → needs < 0.62
//   "Підтримка талановитих учнів" (27)  — two lines  → needs > 0.51
// 0.58 sits between them; a title guessed one line too tall only lowers the subtitle a
// little, while guessing one line too short puts text over text.
const _TITLE_WRAP_CHAR_W = 0.58

// A line box is not the text: at lineSpacing 90% the glyphs occupy about 0.85 of it, the
// rest is leading above the cap height and below the descender. Measuring the title's
// bottom at the bottom of its line box therefore carried that phantom strip into every
// gap below it — bigger fonts, bigger phantom, which is why the spacing looked different
// on slides whose title size differed. Only the LAST line's leading matters; the ones
// above it are real spacing between the title's own lines.
const _GLYPH_OF_LINE = 0.85

// Bottom of the TITLE TEXT — not of the title zone. The zone is a fixed 245px (flat) or
// 100px (rows) box; a one-line title leaves most of it empty, so measuring from the zone
// made the visual gap depend on how long the title happened to be. That is exactly the
// "distances walk between slides" the eye caught.
function titleTextBottom(titleText: string, titlePt: number): number {
  const text = titleText.trim()
  if (!text) return _PAD
  const lineBox = titlePt * 2.667 * 1.1
  const lines   = Math.max(1, wrappedLines(text, _TITLE_W, titlePt, _TITLE_WRAP_CHAR_W))
  // full line boxes for every line but the last, then only the visible part of the last
  return _PAD + Math.ceil((lines - 1) * lineBox + _GLYPH_OF_LINE * lineBox)
}

// Where the title zone ends per family — the content sits TITLE_GAP below it when there
// is no subtitle.
// The title pt these masters actually use — the ratio is taken from it.
// Every column family sizes its title the same way now: the largest step whose longest
// word still fits the full title width. The master's 32pt (two_columns) and 28pt
// (three/four columns) were constants that ignored the slide — on a slide with 391px of
// free room above the cards the heading sat at 32pt and half the zone stayed empty.
const _DYNAMIC_TITLE_COMPS = new Set([
  'two_columns', 'two_columns_labeled', 'two_columns_plain',
  'three_columns', 'three_columns_num',
  'four_columns', 'four_columns_num', 'four_columns_paren', 'four_columns_bubble',
  'bento_bottom_4', 'columns_flex',
])

function titlePtFor(compId: string, titleText?: string): number {
  // bento_right_* measures against its narrow left zone, everything else against the full
  // width up to the logo.
  if (compId.startsWith('bento_right_')) {
    return titleText?.trim() ? pickTitlePt(titleText.trim(), _LTW) : TITLE_PT_STEPS[0]
  }
  if (_DYNAMIC_TITLE_COMPS.has(compId)) {
    return titleText?.trim() ? pickTitlePt(titleText.trim(), _TITLE_W) : TITLE_PT_STEPS[0]
  }
  return compId === 'two_columns' ? 32 : 28
}

// Body text never comes closer than 20% below the title. Without a ceiling the fit search
// simply takes whatever room is free, and on a short slide it ended up at 36pt under a
// 40pt heading — the two read as one size and the slide loses its hierarchy (deck
// 1JVYC…tAek, slides 27/28/29: 32/28, 44/36, 40/36).
const _HIERARCHY_RATIO = 0.8
function hierarchyCapPt(titlePt: number, floorPt: number): number {
  return Math.max(floorPt, Math.floor(titlePt * _HIERARCHY_RATIO))
}

function titleZoneBottom(compId: string, titleText?: string): number {
  if (_DYNAMIC_TITLE_COMPS.has(compId) && titleText?.trim()) {
    return titleTextBottom(titleText, titlePtFor(compId, titleText))
  }
  if (compId === 'two_columns_labeled' || compId === 'two_columns_plain' ||
      compId === 'three_columns_num' || compId === 'columns_flex' ||
      compId === 'four_columns_paren' || compId === 'four_columns_bubble') {
    return _PAD + _FLAT_TITLE_H      // 345 — master's zone, when there is no title text
  }
  return _PAD + _TH                  // 200
}

// Height the subtitle occupies (0 when there is none), including the gap below it. This is
// what every content-top calculation has to move down by: the user's rule is that the
// subtitle keeps its size and the columns give way, never the other way round.
function subtitleY(slots: Record<string, string>, titlePt: number): number {
  return titleTextBottom(slots['ЗАГОЛОВОК'] ?? '', titlePt) + titleSubGap(titlePt)
}

// How much LOWER the content has to start because of the subtitle, relative to where it
// would start without one. Zero when the subtitle fits inside the slack the fixed title
// zone already had — a one-line title plus a one-line subtitle costs the columns nothing.
function subtitleBand(compId: string, slots: Record<string, string>, titlePt: number): number {
  const text = (slots['ПІДЗАГОЛОВОК'] ?? '').trim()
  if (!text) return 0
  const subH    = subtitleHeight(text, subtitlePtFor(text, titlePt))
  const withSub = subtitleY(slots, titlePt) + subH + _SUB_GAP
  const baseTop = titleZoneBottom(compId) + _SUB_GAP
  return Math.max(0, withSub - baseTop)
}

// The compositions whose geometry makes room for a subtitle (their content top moves down
// by subtitleBand). Everything else either has no room or renders its own.
const _SUBTITLE_COMPS = new Set([
  'two_columns', 'two_columns_labeled', 'two_columns_plain',
  'three_columns', 'three_columns_num',
  'four_columns', 'four_columns_num', 'four_columns_paren', 'four_columns_bubble',
  'bento_bottom_4', 'columns_flex',
])

// Creates the subtitle box itself: full title width, MUTED grey (PINK on red), sitting
// TITLE_GAP under the title zone. The master has no box for it — these compositions never
// had a subtitle — so it is built from scratch, like the columns_flex columns.
function buildSubtitleRequests(
  pageId: string,
  slideIdx: number,
  text: string,
  compId: string,
  titlePt: number,
  theme: string,
  slots: Record<string, string>,
): object[] {
  const pt = subtitlePtFor(text, titlePt)
  const h  = subtitleHeight(text, pt)
  const y  = subtitleY(slots, titlePt)
  const id = `sub_${slideIdx}`
  const fg = theme === 'red'
    ? { red: 0xFC / 255, green: 0xCA / 255, blue: 0xCA / 255 }   // PINK on red
    : _BADGE_FG                                                 // MUTED on dark
  return [
    {
      createShape: {
        objectId: id,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            width:  { magnitude: _eL(_TITLE_W + 2 * _INSET), unit: 'EMU' },
            height: { magnitude: _eL(h + 2 * _INSET), unit: 'EMU' },
          },
          transform: {
            scaleX: 1, shearX: 0, translateX: _eL(_PAD - _INSET),
            shearY: 0, scaleY: 1, translateY: _eL(y - _INSET),
            unit: 'EMU',
          },
        },
      },
    },
    { insertText: { objectId: id, insertionIndex: 0, text } },
    {
      updateTextStyle: {
        objectId: id,
        style: {
          fontSize: { magnitude: pt, unit: 'PT' },
          bold: false,
          foregroundColor: { opaqueColor: { rgbColor: fg } },
          weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
        },
        fields: 'fontSize,bold,foregroundColor,weightedFontFamily',
        textRange: { type: 'ALL' },
      },
    },
    {
      updateParagraphStyle: {
        objectId: id,
        style: { lineSpacing: 90 },
        fields: 'lineSpacing',
        textRange: { type: 'ALL' },
      },
    },
  ]
}

// ─── Flat column families ────────────────────────────────────────────────────
// Columns with no card behind the text (two_columns_plain / two_columns_labeled). The
// master parks them at a fixed y=540 — 195px below the title zone, spacing drawn for a
// full two-line title — and every slide paid for it whether it needed it or not: 440px of
// area, font down at 13pt while 15–16pt fits.
//
// Same two variables as a bento row, same order (docs/rules/bento.md): the text area grows
// first (it costs nothing), the font gives way only after. The area can only grow — 540 is
// still the floor, so a short column looks exactly as it does today.
const _FLAT_TITLE_H    = 245   // create-master: flat-column ЗАГОЛОВОК box height
const _FLAT_LABEL_BAND = 120   // ПІДПИС_N band above the columns (was 89 in the master)
// Of that band, this much is the label BOX; the rest is the gap down to the column. The
// font search used to measure the whole 89px band while the master box stayed 50px tall,
// so a two-line label was sized for room it did not have (85px of text in a 50px box).
// A label is a short category, but it is allowed to wrap to a second line, and at the
// 10pt floor two lines plus their gap measure 85px — a 50px master box (or the 70px first
// guess) can only ever overflow. The box is what the font search measures, so it has to be
// the size that fits the floor; the remaining 20px of the band is the gap to the column.
const _FLAT_LABEL_BOX     = 100   // minimum — the master's own look for a one-line marker
const _FLAT_LABEL_BOX_MAX = 150   // two lines at 22pt fit here
const _FLAT_LABEL_GAP     = 20    // box → column
const _FLAT_LABEL_STEPS   = [22, 18, 14, 10] as const
const _FLAT_COL_Y_DEF     = 540   // master column top = the smallest area, never worse
const _FLAT_LABEL_H       = 50    // ПІДПИС_N box height in the master

// The markers of a row are one row: same size for all of them, chosen by the tightest —
// sized apart, "Що даємо / (крім стипендії)" landed at 10pt beside "Що отримуємо" at 22pt.
// And the box grows before the font shrinks, as everywhere else: equalising inside a
// fixed 100px box answers the wrong question, dragging both markers to 10pt instead of
// letting the two-line one have its second line.
function labelMetrics(slots: Record<string, string>): { pt: number; boxH: number; band: number } {
  const labels = Object.entries(slots)
    .filter(([k, v]) => /^ПІДПИС_\d$/.test(k) && (v ?? '').trim())
    .map(([, v]) => v.trim())
  if (!labels.length) {
    return { pt: _FLAT_LABEL_STEPS[0], boxH: _FLAT_LABEL_BOX, band: _FLAT_LABEL_BOX + _FLAT_LABEL_GAP }
  }
  const w = Math.floor((_UW - 50) / 2)
  let pt = _FLAT_LABEL_STEPS[_FLAT_LABEL_STEPS.length - 1]
  for (const step of _FLAT_LABEL_STEPS) {
    if (labels.every(t => textFitsParagraphs(t, w, _FLAT_LABEL_BOX_MAX, step))) { pt = step; break }
  }
  // Sized WITH the margin the fit check will apply: a box exactly as tall as the text
  // fails its own 95% check, and the marker then drops a step for nothing — that is how
  // 14pt labels came out at 10pt in a box built for 14.
  const needed = Math.ceil(Math.max(...labels.map(t => measuredTextHeight(t, w, pt))) / FIT_MARGIN)
  const boxH   = Math.min(_FLAT_LABEL_BOX_MAX, Math.max(_FLAT_LABEL_BOX, needed))
  return { pt, boxH, band: boxH + _FLAT_LABEL_GAP }
}

// The highest the columns may go: TITLE_GAP below the title zone, plus the label band for
// the labelled variant (its ПІДПИС rides along, keeping its 89px band).
function flatColumnsTopMin(compId: string, subBand = 0, labelBand = _FLAT_LABEL_BAND, titleText?: string): number {
  const firstContentY = titleZoneBottom(compId, titleText) + _SUB_GAP + subBand
  return compId === 'two_columns_labeled' ? firstContentY + labelBand : firstContentY
}
function flatColumnsMaxH(compId: string, subBand = 0, labelBand = _FLAT_LABEL_BAND, titleText?: string): number {
  return _H - _PAD - flatColumnsTopMin(compId, subBand, labelBand, titleText)
}

// `ctx` carries what a composition needs to know its REAL text area. Timelines need the
// slide's title (height) and which column this is (the two columns differ in width);
// without it they fall back to the narrowest/shortest worst case, as before.
// How much of a card the auto-numbering takes from its text. The layout moves the text
// down by _NUM_TEXT_TOP (or the 3-card variant) and pads the bottom, so a numbered card
// holds visibly less than an unnumbered one — while bentoDims kept reporting the full
// card. That gap is where slide 9's third card overflowed: the font was chosen for 213px
// of room in a box that ended up with 94.
function numberBandPx(compId: string, titleText: string | undefined, n: number): number {
  const numbered = compId.endsWith('_num') ||
    (!!titleText?.trim() && findCardinalInTitle(titleText) === n)
  if (!numbered) return 0
  const top = compId.startsWith('bento_right_') && n >= 3 ? _NUM_TEXT_TOP_3 : _NUM_TEXT_TOP
  return top - _NUM_PAD   // (cardH − 2·_INN) − (cardH − top − _NUM_PAD − 2·_INSET)
}

function bentoDims(
  compId: string,
  ctx?: { titleText?: string; tokenIdx?: number; subBand?: number },
): { w: number; h: number } | null {
  // A subtitle takes its height out of the content area. The layout already knew that;
  // the font search did not, so it kept choosing a size for a card 200px taller than the
  // one being drawn (text 418px in a 230px box). Same band, both sides.
  const sub = ctx?.subBand ?? 0
  // h = usable inner height inside the TEXT_BOX (after _INN padding on each side).
  // Layout places TEXT_BOX at offset _INN from card edge (then _INSET-compensated),
  // so inner content height = cardH - 2*_INN — must match pickBentoPt's height check.
  if (compId === 'two_columns') {
    const cw = Math.floor((_UW - _GAP) / 2)
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN - sub - numberBandPx(compId, ctx?.titleText, 2) }
  }
  if (compId === 'two_columns_labeled' || compId === 'two_columns_plain') {
    const cw = Math.floor((_UW - 50) / 2)  // 50px gap, no INN (flat layout)
    return { w: cw, h: flatColumnsMaxH(compId, sub, _FLAT_LABEL_BAND, ctx?.titleText) }
  }
  if (compId === 'three_columns') {
    const cw = Math.floor((_UW - 2 * _GAP) / 3)
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN - sub - numberBandPx(compId, ctx?.titleText, 3) }
  }
  if (compId === 'bento_right_2') {
    const cardH = Math.floor((_RBH - _GAP) / 2)
    return { w: _RBW - 2 * _INN, h: cardH - 2 * _INN - numberBandPx(compId, ctx?.titleText, 2) }
  }
  if (compId === 'bento_right_3') {
    const cardH = Math.floor((_RBH - 2 * _GAP) / 3)
    return { w: _RBW - 2 * _INN, h: cardH - 2 * _INN - numberBandPx(compId, ctx?.titleText, 3) }
  }
  if (compId === 'bento_right_2x2') {
    const cellW = Math.floor((_RBW - _GAP) / 2)
    const cellH = Math.floor((_RBH - _GAP) / 2)
    return { w: cellW - 2 * _INN, h: cellH - 2 * _INN - numberBandPx(compId, ctx?.titleText, 4) }
  }
  if (compId === 'three_columns_num') {
    const cw = Math.floor((_UW - 2 * 50) / 3)  // 540 — no card INN padding
    return { w: cw, h: _H - _PAD - 540 - sub }
  }
  if (compId === 'three_columns_timeline' || compId === 'two_columns_timeline') {
    const isThree = compId === 'three_columns_timeline'
    const w = isThree
      ? TCL_ZONE_W_THREE - _AG_DOT_SZ - 10                              // zone − dot − gap = 496
      : TCL_TEXT_W_TWO[ctx?.tokenIdx === 0 ? 0 : 1]                     // default: narrower column
    if (ctx?.titleText === undefined) return { w, h: 502 }              // worst case (300px title)
    return { w, h: timelineLayoutMetrics(ctx.titleText).textH }
  }
  if (compId === 'bento_bottom_4' || compId === 'four_columns' || compId === 'four_columns_num') {
    const cw = Math.floor((_UW - 3 * _GAP) / 4)  // 407
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN - sub - numberBandPx(compId, ctx?.titleText, 4) }
  }
  if (compId === 'four_columns_paren' || compId === 'four_columns_bubble') {
    const cw = Math.floor((_UW - 3 * 50) / 4)  // 392 — flat style, gap=50, no card INN padding
    return { w: cw, h: _H - _PAD - 540 - sub }
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
  two_columns:         10,
  two_columns_labeled: 10,
  two_columns_plain:   10,
  three_columns:          10,
  three_columns_num:      10,
  three_columns_timeline: 10,
  two_columns_timeline:   10,
  four_columns:      10,
  four_columns_num:  10,
  bento_bottom_4:      10,
  four_columns_paren:  10,
  four_columns_bubble: 10,
  bento_right_2:     10,
  bento_right_3:     10,
  bento_right_2x2:   10,
}

const FONT_STEPS = [22, 18, 14, 10] as const
// Full scale including large sizes for upward scaling
const BENTO_SCALE = [48, 36, 28, 22, 18, 14, 10] as const

// Line height for TITLE-side fits only (textFits below: covers, sections, kpi values,
// timeline titles — single blocks in fixed-height boxes, where a cautious budget is what
// keeps a long word or a second line from touching the edges).
// Body text and cards do NOT come through here any more: they are measured by the
// renderer's own ruler in lib/textfit.ts. See textFitsParagraphs.
const FIT_LINE_FACTOR = 1.2
function fitLineH(pt: number): number { return pt * 2.667 * FIT_LINE_FACTOR }

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
  return lines * fitLineH(pt) <= hPx  // exact height: lines × rendered line height
}

// Paragraph-aware variant: splits on \n (real paragraph break) AND \v (soft line break,
// U+000B — used for list items that share one paragraph but must still each start their
// own line, see preprocessBentoText) so each becomes its own forced line. textFits()
// treats all whitespace as a space (wrong for a list). This correctly sums lines per break.
// Vertical air placed AFTER each list item (spaceBelow, see listParagraphStyleRequest),
// as a fraction of the font size so it scales with the card. This is the whole point of
// the rule: a wrapped line inside one sentence gets only lineSpacing, an item boundary
// gets lineSpacing + this — which is what makes two sentences read as two sentences.
function listGapPx(pt: number): number { return LIST_ITEM_GAP_EM * pt * 2.667 }
function listGapPt(pt: number): number { return Math.round(LIST_ITEM_GAP_EM * pt * 10) / 10 }

// Is this text a list whose items must be visually separated?
//  - \v  — items sharing one paragraph (preprocessBentoText)
//  - \n  — compositions that skip that preprocessing and are already line-per-item
//          (two_columns_plain / two_columns_labeled), plus header + body cards
// A value+label card ("$5M\nнові клієнти") is NOT a list: those two lines belong
// together and must not be pushed apart.
function hasListItems(text: string): boolean {
  if (!text || !/[\n\v]/.test(text)) return false
  if (splitValueLabel(text)) return false
  return text.split(/[\n\v]/).filter(s => s.trim()).length >= 2
}

// THE height of a block of text — the single number both variables of a bento row are
// derived from: the font search asks "does this fit the card?", the layout asks "how tall
// must the card be?". They used to answer with two different formulas (the layout counted
// a 12-item list as one flowing paragraph and knew nothing about the gaps between items),
// so the font was chosen for 620px of card while the card was built 380px tall and the
// text spilled out of it. One function makes that divergence impossible.
//
// Counts every forced line start (\n and \v), wraps at the same 0.65 char-width factor as
// longestWordPx, and adds the inter-item air the renderer really writes.
function measuredTextHeight(text: string, wPx: number, pt: number): number {
  if (!text.trim()) return 0
  return renderedHeightUniform(text, wPx, pt, hasListItems(text))
}

// Does this body text fit its box? Two independent questions, deliberately answered by
// two different rulers:
//   width  — pessimistic (0.65 char width, see longestWordPx): a single word sticking out
//            of its card is a visible defect, so it keeps its safety margin.
//   height — the renderer's own ruler (lib/textfit.ts) with FIT_MARGIN of slack. The old
//            budget here assumed a 0.65-wide character and a 1.2 line box, i.e. ~30% more
//            width and ~10% more height per line than Slides actually draws — so a card
//            holding 410px of text was measured as 580px and the font was shrunk to fill
//            space that was never used (three_columns at 11pt where 13pt fits).
function textFitsParagraphs(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  if (longestWordPx(text, pt) * 1.1 > wPx) return false  // 1.1× safety margin
  return measuredTextHeight(text, wPx, pt) <= hPx * FIT_MARGIN
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
  // Floor matches the card floor for this composition — this ТЕКСТ sits beside the
  // same cards, so it must never end up smaller than they're allowed to be.
  const floor = BENTO_MIN_PT[compId] ?? 10
  const steps = FONT_STEPS.filter(s => s <= 22 && s >= floor)  // 22pt default for ТЕКСТ
  for (const pt of steps) {
    if (textFits(text, _LTW, h, pt)) return pt
  }
  return steps[steps.length - 1] ?? floor
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
// Is this column's first line a marker? Four answers, strongest first — because the same
// brief writes the same-looking column both ways and no single signal covers it:
//
//   1. list markup     the items carry bullets / dashes / trailing ";" — if the first line
//                      carries the same mark it IS an item, if it is clean it stands above
//                      them. Deterministic, and it settles the two columns that formatting
//                      could not (sheet 7 "…10 місяців;" vs sheet 4 "Викладачі/Голови…").
//   2. brief formatting the author made it bigger or bold (markerSlots, gslides only)
//   3. the model        neither of the above says anything — the question is about meaning
//                      ("a category for the lines below" vs "the first of equal items"),
//                      so the mapping model answers it (llmMarkers)
//   4. shape            fallback for Docs briefs, which carry no formatting at all
//
// The shape guard applies on top of all four at the call sites: a marker is never a
// sentence.
function slotHasMarker(
  slide: { markerSlots?: string[]; llmMarkers?: string[]; signalMarkers?: Record<string, boolean> },
  slotName: string,
  firstLine: string,
  fullText?: string,
): boolean {
  const key0 = slotName.match(/_(\d+)$/)?.[1]
  const recorded = key0 !== undefined ? slide.signalMarkers?.[key0] : undefined
  if (recorded !== undefined) return recorded          // read before the bullets were stripped
  const signal = fullText ? listMarkerSignal(fullText) : null
  if (signal === 'enumeration') return false
  if (signal === 'header') return true
  // Both lists are keyed by column index for exactly this reason: the slot's NAME changes
  // between compositions (КОЛОНКА_1 ↔ КАРТКА_1), the column it refers to does not.
  const key = slotName.match(/_(\d+)$/)?.[1] ?? slotName
  if (slide.markerSlots?.includes(key)) return true
  // The model's answer is accepted unless the line names an action — it read "Підтримка
  // проявів бренду" as a category over three other activities. The brief's own formatting
  // (above) is never second-guessed this way; only the judgement call is.
  if (slide.llmMarkers?.includes(key)) return !looksLikeAction(firstLine)
  // No markup, no formatting, and the model said nothing — which is indistinguishable
  // from the model saying "no". Silence used to mean "no marker", and that is how sheet 4
  // lost all three of its headings. The deterministic reading decides instead: a line
  // shaped like a marker that does not name an action IS one.
  return isColumnLabel(firstLine) && !looksLikeAction(firstLine)
}

// Does the first line work as the column's marker? A marker is a short noun phrase
// ("Залучення талантів", "Репутація"), not a sentence. Greying a full sentence just
// because it happens to be first invents a hierarchy that is not in the content.
function isColumnLabel(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > 40) return false
  if (/[.!?…]$/.test(t)) return false
  return t.split(/\s+/).filter(Boolean).length <= 5
}

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

  if (!titleText) {
    console.warn(`[cover-title-only-guard] slide ${slideIdx}: ЗАГОЛОВОК empty — skipping text-style requests to avoid API crash`)
  }

  // 1. Resize ЗАГОЛОВОК + apply CENTER/MIDDLE alignment + dynamic font
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    if (!raw.includes('{{ЗАГОЛОВОК}}')) continue
    const sW = el.size.width?.magnitude  ?? 0
    const sH = el.size.height?.magnitude ?? 0
    reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, boxW + 2 * _INSET, boxH + 2 * _INSET, sW, sH))
    // ЗАГОЛОВОК is required for cover_title_only/closing, but if the mapping stage ever
    // leaves it empty, the box has no text after replaceAllText — updateTextStyle/
    // updateParagraphStyle with textRange:'ALL' on an empty box is a hard Slides API 400
    // ("has no text") that kills the ENTIRE batchUpdate, not just this slide. Skip only
    // the text-range style requests so a missing slot degrades to a content_integrity
    // FAIL instead of crashing the whole deck; shape-level properties are still safe.
    if (titleText) {
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
    }
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
const _TB_TITLE_PT = 36  // ЗАГОЛОВОК pt fixed in title_body master template

function buildTitleBodyFloatRequests(
  slide: slides_v1.Schema$Page,
  slots: Record<string, string>,
  opts: { titleH: number; titlePt: number; titleSlot?: string; bodySlot?: string } = { titleH: _H1_FIXED_36, titlePt: _TB_TITLE_PT },
): { main: object[]; fixedRange: object[] } {
  const titleSlot = opts.titleSlot ?? 'ЗАГОЛОВОК'
  const bodySlot  = opts.bodySlot  ?? 'ТЕКСТ'
  const titleText = (slots[titleSlot] ?? '').trim()
  const bodyText  = (slots[bodySlot]  ?? '').trim()
  if (!titleText) return { main: [], fixedRange: [] }

  const titleH   = opts.titleH
  const textY    = _PAD + titleH + TITLE_GAP  // 380 (fixed)
  const textMaxH = Math.max(1, _H_SLIDE - _PAD - 52 - _GAP - textY)  // 488px

  // Auto-shrink body: largest pt at which body text fits in the available box.
  let bodyPt = _TB_BODY_STEPS[0]
  if (bodyText) {
    for (const pt of _TB_BODY_STEPS) {
      if (textFitsParagraphs(bodyText, _UW, textMaxH, pt)) { bodyPt = pt; break }
    }
  }
  // Typography hierarchy: body stays at least 20% below the title, not merely below it.
  {
    const cap = hierarchyCapPt(opts.titlePt, _TB_BODY_STEPS[_TB_BODY_STEPS.length - 1])
    if (bodyPt > cap) {
      const lower = _TB_BODY_STEPS.find(pt => pt <= cap)
      if (lower !== undefined) {
        console.log(`[title-body-hierarchy] bodyPt ${bodyPt} → ${lower} (title=${opts.titlePt}pt, cap=${cap})`)
        bodyPt = lower
      }
    }
  }
  console.log(`[title-body-fit] slot=${bodySlot} bodyLen=${bodyText.length} | chosen_font=${bodyPt}`)

  const reqs: object[] = []
  const fixedRange: object[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue
    const raw = (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join('')
    const sW  = el.size.width?.magnitude  ?? 0
    const sH  = el.size.height?.magnitude ?? 0
    if (raw.includes(`{{${titleSlot}}}`)) {
      reqs.push(makeElemTransform(el.objectId, _PAD - _INSET, _PAD - _INSET, _TITLE_W + 2 * _INSET, titleH + 2 * _INSET, sW, sH))
    }
    if (raw.includes(`{{${bodySlot}}}`)) {
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
        // formatTitleBodyText (applied upstream, before this text was inserted) splits
        // each blank-line-separated group into a header + \v-joined list, and pulls
        // out a short lead-in line as a header — style it WHITE here (default ТЕКСТ
        // color is MUTED gray, so this reads as a clear sub-heading). No hanging
        // indent needed: \v doesn't start a new paragraph, so every line already
        // starts flush at the paragraph's own left edge.
        // Items are written as real paragraphs (softBreaksToParagraphs), so the gap
        // between them comes from spaceBelow while lines inside one item stay tight.
        if (hasListItems(bodyText)) {
          reqs.push(listParagraphStyleRequest(el.objectId, bodyPt))
        }
        for (const range of findGroupHeaderRanges(bodyText)) {
          const endIndex = Math.min(range.end, bodyText.length)
          if (endIndex <= range.start) continue
          fixedRange.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 1, blue: 1 } } } },
              fields: 'foregroundColor',
              textRange: { type: 'FIXED_RANGE', startIndex: range.start, endIndex },
            },
          })
        }
      }
    }
  }
  return { main: reqs, fixedRange }
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
  const tokens = BENTO_TOKENS[compId]
  const maxPt  = BENTO_MAX_PT[compId]
  const minPt  = BENTO_MIN_PT[compId] ?? 10
  // Per-token dims: timeline columns differ in width and their height depends on this
  // slide's own title. Everything else returns the same box for every token.
  const titleText = slots['ЗАГОЛОВОК'] ?? ''
  const subBand   = subtitleBand(compId, slots, titlePtFor(compId, titleText))
  const dimsOf = (tokenIdx: number) => bentoDims(compId, { titleText, tokenIdx, subBand })
  const dims   = dimsOf(tokens ? tokens.length - 1 : 0)  // narrowest/shortest, for diagnostics
  if (!dims || !tokens || !maxPt) return null
  // 1pt-granularity search (not the coarse BENTO_SCALE steps) — the longest text should
  // comfortably fill its card, not jump straight from "doesn't fit at 18pt" to "fits
  // at 14pt with a third of the card empty" just because 15/16/17pt were never tried.
  const scale: number[] = []
  for (let pt = maxPt; pt >= minPt; pt--) scale.push(pt)

  // Step 1: per-card max fitting pt
  let groupPt = maxPt  // shrink toward the tightest card
  for (const [tIdx, t] of tokens.entries()) {
    const text = slots[t] ?? ''
    if (!text.trim()) continue
    const d = dimsOf(tIdx) ?? dims
    let cardPt = minPt
    for (const pt of scale) {
      if (textFitsParagraphs(text, d.w, d.h, pt)) { cardPt = pt; break }
    }
    groupPt = Math.min(groupPt, cardPt)  // group = tightest of per-card maxes
  }
  groupPt = Math.max(groupPt, minPt)    // floor
  const cap = hierarchyCapPt(titlePtFor(compId, titleText), minPt)
  if (groupPt > cap) {
    console.log(`[hierarchy] ${compId}: group ${groupPt}pt → ${cap}pt (заголовок ${titlePtFor(compId, titleText)}pt)`)
    groupPt = cap
  }

  // Step 2: apply uniform groupPt to all filled cards + diagnostic
  const result: Record<string, number> = {}
  for (const [idx, t] of tokens.entries()) {
    const text = slots[t] ?? ''
    if (!text.trim()) continue
    result[t] = groupPt
    const wPass = longestWordPx(text, groupPt) * 1.1 <= dims.w
    // Calls the very functions the search used, so the log can never claim a fit the
    // search denied (or hide one it granted).
    const boxH   = (dimsOf(idx) ?? dims).h
    const needed = Math.round(measuredTextHeight(text, dims.w, groupPt))
    const hPass  = textFitsParagraphs(text, dims.w, boxH, groupPt)
    console.log(
      `[bento-fit] ${compId}/card${idx + 1}: max_font=${maxPt} | group_font=${groupPt} | floor=${minPt} | ` +
      `text_h=${needed} | box_h=${boxH} (usable ${Math.round(boxH * FIT_MARGIN)}) | ` +
      `fits_width=${wPass ? '✓' : '✗'} | fits_height=${hPass ? '✓' : '✗'}`,
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
// Joins list items with U+000B (vertical tab — the character Google's text model uses
// for a Shift+Enter "soft line break") instead of a literal "• " character + "\n".
// Applied before replaceAllText so font sizing also accounts for the converted text.
//
// History: tried native Slides bullets (createParagraphBullets) — correct indent for
// free, but glyph/indent come from the presentation's internal List/nestingLevel
// definition, which the batchUpdate API has no request to customize, so it can't be
// resized. Tried a literal "• " character with a manually computed hanging indent
// (indentStart/indentFirstLine) — indent is then under our control, but every guess at
// "• "'s rendered width was visibly off (overshot, then undershot) with no way to
// verify short of a real render. A soft line break sidesteps the whole problem: \v
// doesn't start a new paragraph, so there's no per-item indent to compute at all — each
// item just starts flush at the paragraph's own left edge, same as line 1.
// Exception: value+label cards ("$5M\nнові клієнти") are NOT converted.
function preprocessBentoText(text: string): string {
  if (!text.trim()) return text
  if (splitValueLabel(text)) return text  // value+label: leave as-is

  // " · " list separator → one item per line (soft break), trailing period stripped
  if (text.includes(' · ')) {
    const items = text.split(' · ').map(s => stripTrailingPeriod(s.trim())).filter(Boolean)
    if (items.length >= 2) return items.join('\v')
  }

  // Existing multi-line content: strip any literal bullet marker already present
  // (e.g. typed "- item" in the source) and join with a soft break instead of "\n".
  const lines = text.split('\n').map(l => l.trim().replace(/^[•\-–]\s*/, '')).filter(Boolean)
  if (lines.length >= 2) return lines.join('\v')
  return text
}

// \v is the pipeline's internal marker for "next list item" — everything downstream
// (splitCardHeader/computeHeaderPt/findGroupHeaderRanges) relies on \n meaning "a header
// line ends here" and \v meaning "just another item", so the two must stay distinct all
// the way through. At WRITE time that distinction is no longer needed: \v is turned into
// a real paragraph break, because Slides only applies spaceAbove/spaceBelow BETWEEN
// paragraphs — a \v-joined block is one paragraph, so its only lever is lineSpacing,
// which spaces the wrapped continuation lines INSIDE a sentence exactly as much as the
// break between two sentences. That is what made the card read as one canvas of text.
// 1 char → 1 char, so every FIXED_RANGE offset computed on the \v text stays valid.
function softBreaksToParagraphs(text: string): string {
  return text.replace(/\v/g, '\n')
}

// Paragraph style for a list body: the air goes BETWEEN items (spaceBelow), not inside a
// sentence (tight 90% lineSpacing) — so a sentence wrapping to a second line stays welded
// into one visual block while adjacent items visibly separate.
// Height is not a hope here: textFitsParagraphs charges the same LIST_ITEM_GAP_EM per
// item when it picks pt, so a card too dense for the gap gets a smaller font instead of
// a clipped last item.
function listParagraphStyleRequest(objectId: string, pt: number): object {
  return {
    updateParagraphStyle: {
      objectId,
      style: {
        lineSpacing: 90,
        spaceBelow: { magnitude: listGapPt(pt), unit: 'PT' },
      },
      fields: 'lineSpacing,spaceBelow',
      textRange: { type: 'ALL' },
    },
  }
}

// Detects a short lead-in "header"/label line before a list within ONE card's text —
// e.g. "Залучення талантів" + 3 longer items, or "Що даємо:" + a list. Real source
// content often gives the header line the SAME (bullet) formatting as the rest (Slides
// has no "list header" role), so the only signal is: the line is either much shorter
// than what follows, or explicitly ends with ":". Runs on RAW (pre-preprocessBentoText)
// \n-separated lines — the header stays its own real paragraph (\n before the body),
// only the body items below it become one \v-joined paragraph.
function splitCardHeader(text: string): { header: string; bodyLines: string[] } | null {
  const lines = text.split('\n').map(l => l.trim().replace(/^[•\-–]\s*/, '')).filter(Boolean)
  if (lines.length < 2) return null
  const first = lines[0]
  const rest = lines.slice(1)
  if (!first || rest.length < 1) return null
  const endsWithColon = /[:：]\s*$/.test(first)
  // Whether a line is a marker is a property of that LINE, not of its neighbours. The old
  // test also demanded it be ≤70% of the average item length, so the same kind of heading
  // was a heading in one column and plain text in the next, purely because that column's
  // items happened to be shorter: "Викладачі/Голови студпарламентів" (32 chars) failed
  // against items averaging 29, while "Найкращі на курсі" passed against items averaging
  // 50. Same predicate as the flat columns use for their grey marker — one definition of
  // "marker" for the whole deck.
  if (!endsWithColon && !isColumnLabel(first)) return null
  const header = first.replace(/[:：]\s*$/, '').trim()
  if (!header) return null
  return { header, bodyLines: rest }
}

// title_body/title_photo ТЕКСТ can hold SEVERAL blank-line-separated groups (unlike a
// single bento card) — e.g. a brief with 3+ categories that's too big to fit any column
// composition, falling back to one flat text slot. Without this, that fallback reads as
// one undifferentiated wall of text with no bullets or hierarchy. Applies the same
// per-group header+bullet treatment as a bento card, group by group.
function formatTitleBodyText(text: string): string {
  if (!text.trim()) return text
  const groups = text.split(/\n\s*\n/).map(g => g.trim()).filter(Boolean)
  if (groups.length === 0) return text
  return groups.map(group => {
    const split = splitCardHeader(group)  // needs RAW \n-separated lines
    return split
      ? `${split.header}\n${split.bodyLines.join('\v')}`
      : preprocessBentoText(group)
  }).join('\n\n')
}

// Finds each group's header line (formatTitleBodyText) within the FINAL joined text,
// as {start, end} character offsets — for FIXED_RANGE white-color styling. By
// construction a group is either "header\nbody" (real \n = header present) or a plain
// \v-joined (or single-line) body with no \n at all.
function findGroupHeaderRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let offset = 0
  for (const group of text.split('\n\n')) {
    const nlIdx = group.indexOf('\n')
    if (nlIdx > 0) {
      ranges.push({ start: offset, end: offset + nlIdx })
    }
    offset += group.length + 2  // +2 accounts for the "\n\n" separator between groups
  }
  return ranges
}

// If `text` has a detected header (splitCardHeader) followed by a body list, try pt
// values above groupPt for JUST that header line, keeping the body at groupPt. Returns
// groupPt unchanged (no bump — the header still gets a WHITE color-only distinction at
// the call site) when there isn't enough slack to raise it without overflowing.
function computeHeaderPt(text: string, dims: { w: number; h: number }, groupPt: number, maxPt: number): number {
  // By construction (preprocessBentoText/splitCardHeader reconstruction above) a header
  // is present iff there's a real \n — the body itself is \v-joined, no \n left in it.
  if (text.indexOf('\n') <= 0) return groupPt
  const lines = text.split('\n')
  const headerLine = lines[0].trim()
  const body       = lines.slice(1).join('\n')
  // Measured with the SAME ruler that picked groupPt (lib/textfit.ts), header at the
  // candidate pt and the body at groupPt — and including the air between list items, which
  // this check used to ignore entirely. That omission is how a +8pt bump was granted to
  // text that then overflowed its card by 57px: the gaps it had to share the box with
  // were invisible here.
  const gapPt = (pt: number) => (hasListItems(text) ? listGapPt(pt) : 0)
  for (let pt = Math.min(groupPt + 8, maxPt); pt > groupPt; pt--) {
    if (longestWordPx(headerLine, pt) * 1.1 > dims.w) continue
    const paras: Para[] = [{ text: headerLine, pt, spaceBelowPt: gapPt(groupPt) }]
    for (const item of body.split(/[\n\v]/).filter(s => s.trim())) {
      paras.push({ text: item, pt: groupPt, spaceBelowPt: gapPt(groupPt) })
    }
    if (renderedHeight(paras, dims.w) <= dims.h * FIT_MARGIN) return pt
  }
  return groupPt
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
    // measuredTextHeight — the SAME function pickBentoCardPts just used to choose the
    // font. Growing the card is the free variable: nothing is lost by making it taller,
    // whereas a font drop costs legibility, so the row takes all the height it needs and
    // only then is the font asked to give way (down to the 10pt floor, see
    // docs/rules/bento.md). The previous estimate here ignored line breaks and the
    // inter-item gaps entirely, so the row stayed at its 440px minimum while holding
    // 500px+ of text.
    let maxTextH = 0
    for (const token of tokens) {
      const text = (processedSlots[token] ?? '').trim()
      if (!text) continue
      const pt = cardPts?.[token] ?? (BENTO_MIN_PT[compId] ?? 10)
      const h  = Math.ceil(measuredTextHeight(text, innerW, pt))
      if (h > maxTextH) maxTextH = h
    }
    const contentCardH  = maxTextH + 2 * _INN + 2 * VERT_PAD_ROW
    const desiredRowY   = _H - _PAD - Math.max(contentCardH, _BOTTOM_BENTO_H_DEFAULT)
    const subBand  = subtitleBand(compId, processedSlots, titlePtFor(compId, (processedSlots['ЗАГОЛОВОК'] ?? '').trim()))
    const topFloor = Math.max(_CY, titleZoneBottom(compId, titleText) + _SUB_GAP + subBand)
    const rowY = Math.max(desiredRowY, topFloor)   // _CY = 300, plus the subtitle if any
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

  // ── Flat columns: two_columns_plain / two_columns_labeled ───────────────────
  // No cards to resize — the text box itself IS the column, so the box grows upward and
  // the ПІДПИС band (labelled variant) rides along above it. Bottom stays on the page
  // margin, top never rises past flatColumnsTopMin, never sinks below the master's 540.
  if (compId === 'two_columns_plain' || compId === 'two_columns_labeled') {
    const cw      = Math.floor((_UW - 50) / 2)          // 835
    const cardPts = pickBentoCardPts(compId, processedSlots)

    let maxTextH = 0
    for (const token of tokens) {
      const text = (processedSlots[token] ?? '').trim()
      if (!text) continue
      const pt = cardPts?.[token] ?? (BENTO_MIN_PT[compId] ?? 10)
      const h  = Math.ceil(measuredTextHeight(text, cw, pt))
      if (h > maxTextH) maxTextH = h
    }
    // A group header is one step larger than its list (computeHeaderPt) — ask for that
    // step too, so the box is not sized for a font the header does not use.
    const headerSlack = Math.ceil(lineH(BENTO_MAX_PT[compId] ?? 22) * 0.25)
    const lm = labelMetrics(processedSlots)
    const flatTitle = (processedSlots['ЗАГОЛОВОК'] ?? '').trim()
    const topMin = flatColumnsTopMin(
      compId,
      subtitleBand(compId, processedSlots, titlePtFor(compId, flatTitle)),
      lm.band,
      flatTitle,
    )
    const textY = Math.max(
      topMin,
      Math.min(_FLAT_COL_Y_DEF, _H - _PAD - maxTextH - headerSlack),
    )
    const textH = _H - _PAD - textY

    const reqs: object[] = []
    for (const el of slide.pageElements ?? []) {
      if (!el.objectId || !el.transform || !el.size) continue
      if (el.shape?.shapeType !== 'TEXT_BOX') continue
      const sW  = el.size.width?.magnitude  ?? 0
      const sH  = el.size.height?.magnitude ?? 0
      const elX = Math.round((el.transform.translateX ?? 0) / _FPX)
      const elY = Math.round((el.transform.translateY ?? 0) / _FPX)
      const elW = Math.round(sW * (el.transform.scaleX ?? 1) / _FPX)
      const elH = Math.round(sH * (el.transform.scaleY ?? 1) / _FPX)
      // Column width identifies both the columns and their labels; the title box is
      // _TITLE_W wide and stays where it is.
      if (Math.abs(elW - (cw + 2 * _INSET)) > TOL) continue
      if (elY < _PAD + _FLAT_TITLE_H - TOL) continue     // anything inside the title zone

      const isLabel = elH <= _FLAT_LABEL_BOX_MAX + 2 * _INSET + TOL
      if (isLabel) {
        reqs.push(makeElemTransform(
          el.objectId, elX, textY - lm.band - _INSET,
          elW, lm.boxH + 2 * _INSET, sW, sH,
        ))
      } else {
        reqs.push(makeElemTransform(el.objectId, elX, textY - _INSET, elW, textH + 2 * _INSET, sW, sH))
      }
    }
    console.log(
      `[flat-columns] ${compId}: text_h=${maxTextH} | top ${_FLAT_COL_Y_DEF}→${textY} | ` +
      `area ${_H - _PAD - _FLAT_COL_Y_DEF}→${textH}px | font=${cardPts ? Object.values(cardPts)[0] : '—'}pt`,
    )
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
  // NOTE: no `if (!map) return {...slots}` early exit here — most same-shape column
  // transitions (two_columns_labeled↔two_columns/two_columns_plain/two_columns_timeline)
  // have no VARIANT_SLOT_MAPS entry at all (no rename needed), which used to skip the
  // orphan-ПІДПИС_N merge below entirely and pass every slot through unchanged/unfiltered.
  const map = VARIANT_SLOT_MAPS[`${fromComp}:${toComp}`] ?? {}
  const targetComp = getComposition(toComp)
  const validTarget = new Set(targetComp?.slots.map(s => s.name) ?? [])
  const result: Record<string, string> = {}
  const orphanCaptions: Record<string, string> = {}  // N → label text with no home slot in target
  for (const [slot, value] of Object.entries(slots)) {
    const targetSlot = map[slot] ?? slot
    if (validTarget.has(targetSlot)) {
      result[targetSlot] = value
      continue
    }
    const capMatch = slot.match(/^ПІДПИС_(\d)$/)
    if (capMatch && value.trim()) {
      orphanCaptions[capMatch[1]] = value.trim()
      continue
    }
    // else: slot absent in target composition → drop (e.g. ТЕКСТ when going to two_columns)
  }
  // ПІДПИС_N has no dedicated slot in the target composition (only two_columns_labeled
  // has one) — fuse it into the matching КОЛОНКА_N/КАРТКА_N body instead of losing it.
  for (const [n, label] of Object.entries(orphanCaptions)) {
    const bodyKey = [`КОЛОНКА_${n}`, `КАРТКА_${n}`].find(k => k in result)
    if (bodyKey) result[bodyKey] = `${label} — ${result[bodyKey]}`
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

  for (let slide of plan.slides) {
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

    // A column label (ПІДПИС_N) and a slide subtitle are the same thing twice: two
    // horizontal bands stacked above the columns, saying "this is what the block below is
    // about". Together they cost 344px of the 575 available and leave the columns unable
    // to fit their content at any font — sheet 9 needed 299px in the 230px that were left.
    // With a subtitle present the label is folded into its column ("Підпис — тіло", the
    // same move remapSlotsForVariant already makes), and no ПІДПИС-carrying layout is
    // offered as a variant.
    const hasSubtitle = (slide.slots['ПІДЗАГОЛОВОК'] ?? '').trim().length > 0
    const carriesLabel = (compId: string) =>
      (getComposition(compId)?.slots ?? []).some(sl => /^ПІДПИС_\d/.test(sl.name))

    // A layout that cannot draw a subtitle must not be offered for a slide that has one.
    // bento_right_* and the timelines are deliberately outside _SUBTITLE_COMPS (their
    // cards run the full height of the slide), and offering them anyway is how the same
    // sheet came out with the subtitle on one variant and silently without it on the next
    // two — deck-level coverage stays green because the text does exist, on another slide.
    // …but not for the compositions that own a ПІДЗАГОЛОВОК slot and draw it themselves
    // (cover, section, closing). They are outside _SUBTITLE_COMPS because their subtitle
    // is rendered by their own layout, not because they cannot carry one — and moving that
    // text into a ТЕКСТ slot they do not have is how a closing slide lost 622 characters.
    const ownsSubtitleSlot = (getComposition(slide.composition)?.slots ?? [])
      .some(sl => sl.name === 'ПІДЗАГОЛОВОК')
    if (hasSubtitle && !ownsSubtitleSlot && !_SUBTITLE_COMPS.has(slide.composition)) {
      const g = VARIANT_GROUPS.find(gr => gr.includes(slide.composition))
      const target = g?.find(c => _SUBTITLE_COMPS.has(c))
      if (target) {
        console.log(`[subtitle-capable] slide ${slide.id}: ${slide.composition} → ${target} (несе ПІДЗАГОЛОВОК)`)
        slide = {
          ...slide,
          composition: target,
          slots: remapSlotsForVariant(slide.slots, slide.composition, target),
        }
      } else if ((getComposition(slide.composition)?.slots ?? []).some(sl => sl.name === 'ТЕКСТ')) {
        // Whole group unable to draw one (title_body / title_photo). Rather than drop the
        // sentence, it joins the body text — the slide reads the same, and nothing is lost.
        // Only where a ТЕКСТ slot actually exists: writing into a slot the composition does
        // not have is not a rescue, it is the same loss with a different name (badges,
        // agenda_*, cover_title_only have neither).
        const body = (slide.slots['ТЕКСТ'] ?? '').trim()
        const sub  = (slide.slots['ПІДЗАГОЛОВОК'] ?? '').trim()
        const slots: Record<string, string> = { ...slide.slots, ТЕКСТ: body ? `${sub}\n${body}` : sub }
        delete slots['ПІДЗАГОЛОВОК']
        console.log(`[subtitle-capable] slide ${slide.id}: ${slide.composition} не несе ПІДЗАГОЛОВОК → текст приєднано до ТЕКСТ`)
        slide = { ...slide, slots }
      }
    }
    if (hasSubtitle && carriesLabel(slide.composition)) {
      const plain = 'two_columns_plain'
      console.log(`[subtitle-vs-label] slide ${slide.id}: ${slide.composition} → ${plain} (підпис склеєно з колонкою)`)
      slide = {
        ...slide,
        composition: plain,
        slots: remapSlotsForVariant(slide.slots, slide.composition, plain),
      }
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
      if (hasSubtitle && carriesLabel(varComp)) return false
      if (hasSubtitle && !_SUBTITLE_COMPS.has(varComp)) return false
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
      // Check 3.5: a variant may look different, it may never hold FEWER columns. The
      // variant groups are per-count silos, so this only bites for columns_flex — it can
      // carry 2, 3 or 4, and its group-mates are all fixed at 3. Offering a 3-slot layout
      // to a 4-column slide would drop the fourth column, which is the very loss
      // columns_flex exists to prevent.
      if (targetComp) {
        const filledCols = new Set(
          Object.entries(slide.slots)
            .filter(([, v]) => (v ?? '').trim())
            .map(([k]) => k.match(/^(?:КОЛОНКА|КАРТКА)_(\d+)/)?.[1])
            .filter(Boolean),
        ).size
        const targetCols = new Set(
          targetComp.slots
            .map(s => s.name.match(/^(?:КОЛОНКА|КАРТКА)_(\d+)/)?.[1])
            .filter(Boolean),
        ).size
        if (filledCols > 0 && targetCols > 0 && targetCols < filledCols) return false
      }

      // Check 4: skip variants that physically cannot hold their remapped content —
      // each slot's own max_chars is already calibrated to what fits at minimum font.
      // Prevents e.g. offering title_photo when title_body's ТЕКСТ is too long for the
      // half-width photo layout, or bento_right_2 when a merged "Label — Body" overflows a card.
      if (targetComp) {
        for (const s of targetComp.slots) {
          if (s.type !== 'text' || !s.max_chars) continue
          if ((remapped[s.name] ?? '').trim().length > s.max_chars) return false
        }
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
      // Same normalisation the mapping stage applies: whatever the remap table did or did
      // not cover, a slot must end up under the name its target composition declares.
      const varSlots = remapSlotsForVariant(slide.slots, slide.composition, varComp)
      const declared = new Set((getComposition(varComp)?.slots ?? []).map(sl => sl.name))
      for (const key of Object.keys(varSlots)) {
        if (declared.has(key)) continue
        const m = key.match(/^(КОЛОНКА|КАРТКА)_(\d+)$/)
        if (!m) continue
        const alt = `${m[1] === 'КОЛОНКА' ? 'КАРТКА' : 'КОЛОНКА'}_${m[2]}`
        if (!declared.has(alt) || (varSlots[alt] ?? '').trim()) continue
        varSlots[alt] = varSlots[key]
        delete varSlots[key]
      }
      expandedSlides.push({
        ...slide,
        id: `${slide.id}_v${vi + 1}`,
        composition: varComp,
        slots: varSlots,
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
  // The digit lives INSIDE the ellipse. It used to be a separate TEXT_BOX laid over the
  // circle and centred by arithmetic — (bubble − line height) / 2 — which is a guess about
  // where Slides puts a glyph inside its line box, and the guess sat low every time. A
  // shape with text centres itself: contentAlignment MIDDLE vertically, alignment CENTER
  // horizontally, and no number has to be computed at all.
  for (let k = 0; k < 3; k++) {
    const cx   = _PAD + k * (_3CN_COL_W + _3CN_GAP)
    const bgId = `${pageId}_3cnBubble_${k}`
    reqs.push(
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
            shapeBackgroundFill: { solidFill: { color: { rgbColor: _AG_RED_RGB }, alpha: 1 } },
            outline: { propertyState: 'NOT_RENDERED' },
            contentAlignment: 'MIDDLE',
            autofit: { autofitType: 'NONE' },
          },
          fields: 'shapeBackgroundFill,outline,contentAlignment,autofit.autofitType',
        },
      },
      { insertText: { objectId: bgId, insertionIndex: 0, text: `${k + 1}` } },
      {
        updateTextStyle: {
          objectId: bgId,
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
          objectId: bgId,
          style: {
            alignment: 'CENTER',
            lineSpacing: 90,
            spaceAbove: { magnitude: 0, unit: 'PT' },
            spaceBelow: { magnitude: 0, unit: 'PT' },
          },
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
  // Same metrics bentoDims() used to pick the font — one source of truth, so the box the
  // text is measured against and the box it is placed in can never drift apart.
  const { titleContentH, textY, textH } = timelineLayoutMetrics(titleText)
  const dotsY = textY  // text top aligned with dot top for both compositions

  const isThree = compId === 'three_columns_timeline'

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
  subBand = 0,
  markerCols: boolean[] = [],
): object[] {
  const _CF_GAP   = 50
  const _CF_X0    = _PAD        // 100
  const _CF_UW    = _UW         // 1720
  const _CF_NUM_H = 60

  const colW = Math.floor((_CF_UW - (n - 1) * _CF_GAP) / n)

  // These boxes are created here, not inherited from the master, so their size and their
  // font must be decided together — the old code wrote a hard-coded 18pt into a fixed
  // 440px box. That held while columns_flex was a niche pick for short lists; as the
  // default carrier for 2–4 columns it overflowed by up to +496px.
  // Same two variables and same order as everywhere else: the area grows first (up to
  // TITLE_GAP under the title zone, minus the "(N)" band), then the font gives way.
  const innerW  = colW - 2 * _INSET
  const maxAreaH = flatColumnsMaxH('two_columns_labeled', subBand)  // 486 − subtitle, same band above
  let pt = 22
  for (; pt > 10; pt--) {
    if (colTexts.every(t => textFitsParagraphs(t, innerW, maxAreaH, pt))) break
  }
  const neededH = Math.ceil(Math.max(...colTexts.map(t => measuredTextHeight(t, innerW, pt))))
  const colY    = Math.max(
    flatColumnsTopMin('two_columns_labeled', subBand),
    Math.min(_FLAT_COL_Y_DEF, _H - _PAD - neededH),
  )
  const colH    = _H - _PAD - colY
  const numY    = colY - _FLAT_LABEL_BAND
  console.log(
    `[columns_flex-fit] n=${n} colW=${colW} | font=${pt}pt | text_h=${neededH} | ` +
    `top ${_FLAT_COL_Y_DEF}→${colY} | area=${colH}px`,
  )

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
              shearY: 0, scaleY: 1, translateY: _eL(numY),
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
              height: { magnitude: _eL(colH + 2 * _INSET), unit: 'EMU' },
            },
            transform: {
              scaleX: 1, shearX: 0, translateX: _eL(cx),
              shearY: 0, scaleY: 1, translateY: _eL(colY - _INSET),
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
            fontSize: { magnitude: pt, unit: 'PT' },
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
    // The air between items is part of the height the font was chosen against — write it,
    // or the list reads as one canvas (docs/rules/typography.md) and the measurement and
    // the file disagree again, this time in our favour and just as wrong.
    if (hasListItems(colTexts[k])) reqs.push(listParagraphStyleRequest(colId, pt))
    // Marker, if this column has one: grey first line over white items — the same
    // convention the other flat columns use. columns_flex drew every line in one white
    // size, so a column that opened with "«Зіркові» учні шкіл" read as a flat list.
    const cfFirstNl = colTexts[k].indexOf('\n')
    if (cfFirstNl > 0 && markerCols?.[k]) {
      reqs.push({
        updateTextStyle: {
          objectId: colId,
          style: { foregroundColor: { opaqueColor: { rgbColor: _MUTED_CF } } },
          fields: 'foregroundColor',
          textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: cfFirstNl },
        },
      })
    }
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
      const bgId  = `flat_bubble_${slideIdx}_${k}`
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
              // Same as three_columns_num: the digit goes inside the circle and Slides
              // centres it, instead of a text box laid over it at a computed offset.
              contentAlignment: 'MIDDLE',
              autofit: { autofitType: 'NONE' },
            },
            fields: 'shapeBackgroundFill,outline,contentAlignment,autofit.autofitType',
          },
        },
        { insertText: { objectId: bgId, insertionIndex: 0, text: String(k + 1) } },
        {
          updateTextStyle: {
            objectId: bgId,
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
            objectId: bgId,
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

  // Step 2.0: Strip slots not in the closing composition (master has no image placeholder).
  for (const slide of plan.slides) {
    if (slide.composition !== 'closing') continue
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
      // …unless the brief itself heads this sheet that way. The dedupe exists for titles
      // that PROPAGATE (a section heading reused by the content slide after it); a sheet
      // that carries the heading in its own source lines is the author repeating himself,
      // and deleting it leaves the slide with no head at all — which is what happened to
      // the second "Цільові групи" sheet.
      const titleFromSource = (slide.fragments ?? []).some(f => f.trim() === title)
      if (!isAgendaSlide && title && title === prevFinalTitle && !titleFromSource) {
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

  // Snapshot slot text as the mapping stage left it — the steps below deliberately rewrite
  // it (number compaction, ПІДПИС de-duplication, label extraction). content_coverage
  // accepts a source line found in either state, so those rewrites don't read as loss.
  plan.preRenderSlots = plan.slides.flatMap(s => Object.values(s.slots))

  // Step 2.84: a number the layout is going to draw must not also stand in the text.
  // The brief writes its steps as "01" / "Відбір" / description; the numbered layouts draw
  // that 01 themselves, in their own big type, so leaving it in the card printed it twice.
  // Stripped only where the layout really numbers — elsewhere the digit IS the content.
  {
    const drawsOwnNumbers = (compId: string, titleText: string, n: number): boolean => {
      if (compId.endsWith('_num')) return true
      if (compId === 'columns_flex' || compId === 'four_columns_paren' || compId === 'four_columns_bubble') return true
      return !!titleText && findCardinalInTitle(titleText) === n
    }
    const LEADING_NUMBER = /^\s*\(?\s*0?\d{1,2}\s*[.)]?\s*$/
    for (const slide of plan.slides) {
      const tokens = BENTO_TOKENS[slide.composition]
        ?? (slide.composition === 'columns_flex' ? ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3', 'КОЛОНКА_4'] : [])
      const filled = tokens.filter(t => (slide.slots[t] ?? '').trim())
      if (!filled.length) continue
      if (!drawsOwnNumbers(slide.composition, (slide.slots['ЗАГОЛОВОК'] ?? '').trim(), filled.length)) continue
      filled.forEach((tok, ci) => {
        const lines = (slide.slots[tok] ?? '').split('\n')
        if (lines.length < 2 || !LEADING_NUMBER.test(lines[0])) return
        // …and only when the digit is this card's ORDINAL. A card that opens with a
        // figure of its own ("15" over "студентів отримали роботу") keeps it — the number
        // being removed has to be the same number the layout is about to draw.
        const value = parseInt(lines[0].replace(/\D/g, ''), 10)
        if (value !== ci + 1) return
        console.log(`[number-dedup] ${slide.id}/${tok}: прибрано «${lines[0].trim()}» — номер малює макет`)
        slide.slots[tok] = lines.slice(1).join('\n')
      })
    }
  }

  // Step 2.85: read the list markup, then strip it.
  // Bullets tell us whether the first line is one of the items ("• Цільові спеціальності"
  // among bulleted lines) or stands above them. That answer is recorded per column index
  // and the "• " prefixes are removed, because they are markup, not text — the bento path
  // stripped them later anyway, while the flat columns and columns_flex would have drawn
  // them on the slide.
  for (const slide of plan.slides) {
    const tokens = BENTO_TOKENS[slide.composition]
      ?? (slide.composition === 'columns_flex' ? ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3', 'КОЛОНКА_4'] : [])
    if (!tokens.length) continue
    const decided: Record<string, boolean> = {}
    for (const tok of tokens) {
      const raw = (slide.slots[tok] ?? '')
      if (!raw.trim()) continue
      const signal = listMarkerSignal(raw)
      const idx = tok.match(/_(\d+)$/)?.[1]
      if (signal && idx) decided[idx] = signal === 'header'
      slide.slots[tok] = raw
        .split('\n')
        .map(l => l.replace(/^\s*[•\-–—]\s+/, ''))
        .join('\n')
    }
    if (Object.keys(decided).length) {
      slide.signalMarkers = { ...(slide.signalMarkers ?? {}), ...decided }
    }
  }

  // Step 2.9: Auto-extract column labels for two_columns_labeled / two_columns_plain.
  // For "Label — Body" or "Label: Body" content in КОЛОНКА_N:
  //   two_columns_labeled → ПІДПИС_N = label (gray box), КОЛОНКА_N = capitalized body
  //   two_columns_plain   → КОЛОНКА_N = "label\nbody" for per-paragraph grey styling
  //   two_columns / bento_right_* → normalize "Label: Body" → "Label — Body" only
  const _hasLetter = /[a-zA-Zа-яА-ЯіІїЇєЄ'ʼ]/
  for (const slide of plan.slides) {
    let comp = slide.composition
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
      // Labels live in ПІДПИС_N only when the source wrote them as "Label — Body". When
      // they are simply the column's first line (this brief's shape), ПІДПИС stays empty
      // and the labelled layout draws the whole column in one white size — the marker
      // becomes indistinguishable from the items under it. That design is not offered:
      // the slide falls back to two_columns_plain, which greys the marker in place.
      if (comp === 'two_columns_labeled' &&
          ![1, 2].some(k => (slide.slots[`ПІДПИС_${k}`] ?? '').trim())) {
        console.log(`[label-fallback] ${slide.id}: two_columns_labeled without ПІДПИС → two_columns_plain`)
        slide.composition = 'two_columns_plain'
        comp = 'two_columns_plain'
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
  // Which (slide, token) pairs actually HAVE a group header — recorded here, where the
  // header is created, instead of being guessed later from "the text contains a \n".
  // That guess was wrong for two_columns_plain/two_columns_labeled: they skip the
  // preprocessing below (their label lives in its own ПІДПИС_N box), so their items stay
  // \n-separated and item #1 was styled as a header — one full step (+8pt) larger than the
  // rest of the list, on every such card in the deck.
  const bentoHeaderSlots = new Map<number, Set<string>>()
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
      // Header detection needs the RAW \n-separated lines (before preprocessBentoText
      // joins the list into one \v-separated paragraph) — pull a short lead-in line
      // (e.g. "Залучення талантів") out first so it can be styled as a header (white +
      // bigger, see the FIXED_RANGE requests below) instead of looking like just
      // another list item.
      // …and only when the brief itself marked that line (slotHasMarker). A column whose
      // lines are all one size in the source is a plain enumeration: nothing in it is a
      // heading, so nothing gets promoted to one.
      const firstLine   = processed[tok].split('\n')[0] ?? ''
      const headerSplit = slotHasMarker(plan.slides[i], tok, firstLine, processed[tok])
        ? splitCardHeader(processed[tok])
        : null
      processed[tok] = headerSplit
        ? `${headerSplit.header}\n${headerSplit.bodyLines.join('\v')}`
        : preprocessBentoText(processed[tok])
      if (headerSplit) {
        if (!bentoHeaderSlots.has(i)) bentoHeaderSlots.set(i, new Set())
        bentoHeaderSlots.get(i)!.add(tok)
      }
    }
    bentoProcessedSlots.set(i, processed)
  }

  // title_body/title_photo ТЕКСТ: same header+bullet treatment, per blank-line group
  // (see formatTitleBodyText). Stored in the SAME map — the replaceAllText loop below
  // already falls back to `processedSlots?.[slotName] ?? slotValue` for any slot.
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    if (compId !== 'title_body' && compId !== 'title_photo') continue
    const raw = plan.slides[i].slots['ТЕКСТ']
    if (!raw) continue
    const processed = bentoProcessedSlots.get(i) ?? { ...plan.slides[i].slots }
    processed['ТЕКСТ'] = formatTitleBodyText(raw)
    bentoProcessedSlots.set(i, processed)
  }

  // closing ПІДЗАГОЛОВОК: same header+bullet treatment when it carries a real body
  // (extra text beyond a short title) instead of a one-line subtitle.
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'closing') continue
    const raw = plan.slides[i].slots['ПІДЗАГОЛОВОК']
    if (!raw) continue
    const processed = bentoProcessedSlots.get(i) ?? { ...plan.slides[i].slots }
    processed['ПІДЗАГОЛОВОК'] = formatTitleBodyText(raw)
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
      replaceText = softBreaksToParagraphs(addNbsp(replaceText))
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
            replaceText: val ? softBreaksToParagraphs(addNbsp(stripTrailingPeriod(val))) : '',
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

  // fixedRangeStyleRequests isn't declared until later in this function (colon-split
  // batch) — buffered here and flushed into it right after that declaration below.
  const titleBodyFixedRange: object[] = []

  // ── Closing: either a substantial ПІДЗАГОЛОВОК (auto-shrink + list treatment, same
  // as title_body's ТЕКСТ) or a bare title (collapse to cover_title_only style). Must
  // run AFTER the section/closing loop so these requests come last (override the
  // subtitle-collapsed geometry set by buildSectionFloatRequests above).
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'closing') continue
    const slots = plan.slides[i].slots
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    if ((slots['ПІДЗАГОЛОВОК'] ?? '').trim()) {
      const pSlots = bentoProcessedSlots.get(i) ?? slots
      const { main, fixedRange } = buildTitleBodyFloatRequests(slide, pSlots, {
        titleH: _H1_FIXED_44, titlePt: 44, bodySlot: 'ПІДЗАГОЛОВОК',
      })
      requests.push(...main)
      titleBodyFixedRange.push(...fixedRange)
      continue
    }
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
    const pSlots = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
    const { main, fixedRange } = buildTitleBodyFloatRequests(slide, pSlots)
    requests.push(...main)
    titleBodyFixedRange.push(...fixedRange)
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


  // ── ПІДЗАГОЛОВОК: a standalone sentence under the title, MUTED, 0.7 × title ──
  // Only for the compositions whose geometry knows how to make room for it (their content
  // top already moves down by subtitleBand). A slot rendered nowhere is silent content
  // loss, which is why the other families do not offer it at all.
  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    const pageId = planPageIds[i]
    if (!pageId) continue
    // Explicit list, not "any composition with the slot": cover / section / closing have
    // carried a ПІДЗАГОЛОВОК of their own since day one and draw it themselves. Matching
    // on the slot name put a second, uninvited subtitle box on the closing slide — 1500
    // characters of it, ending 256px below the bottom of the page.
    if (!_SUBTITLE_COMPS.has(compId)) continue
    const text = (plan.slides[i].slots['ПІДЗАГОЛОВОК'] ?? '').trim()
    if (!text) continue
    const titlePt = titlePtFor(compId, (plan.slides[i].slots['ЗАГОЛОВОК'] ?? '').trim())
    requests.push(...buildSubtitleRequests(
      pageId, i, addNbsp(text), compId, titlePt, plan.theme, plan.slides[i].slots,
    ))
    console.log(
      `[subtitle] slide ${i + 1} (${compId}): title=${titlePt}pt → subtitle=${subtitlePtFor(text, titlePt)}pt | ` +
      `band=${subtitleBand(compId, plan.slides[i].slots, titlePt)}px`,
    )
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
    requests.push(...buildColumnsFlexRequests(
      pageId, n, colTexts, templateColIds,
      subtitleBand('columns_flex', slots, titlePtFor('columns_flex')),
      colTexts.map((t, k) => {
        const first = t.split('\n')[0] ?? ''
        return t.includes('\n') &&
          isColumnLabel(first) &&
          slotHasMarker(plan.slides[i], `КОЛОНКА_${k + 1}`, first, t)
      }),
    ))
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

    // Column families: the heading takes the room the slide actually has. Its size comes
    // from the same word-fit search every other title uses (cap 44pt), and its box is
    // resized to the lines it needs — the master's 100px/32pt zone described the template,
    // not the slide, and left 391px of free space above the cards unused.
    const compIdT = plan.slides[i].composition
    const titleTxt = (plan.slides[i].slots['ЗАГОЛОВОК'] ?? '').trim()
    if (_DYNAMIC_TITLE_COMPS.has(compIdT) && titleTxt) {
      const pt = titlePtFor(compIdT, titleTxt)
      const h  = Math.ceil(
        wrappedLines(titleTxt, _TITLE_W, pt, _TITLE_WRAP_CHAR_W) * pt * 2.667 * 1.1,
      )
      requests.push(
        makeElemTransform(titleObjId, _PAD - _INSET, _PAD - _INSET, _TITLE_W + 2 * _INSET, h + 2 * _INSET, sW, sH),
        {
          updateTextStyle: {
            objectId: titleObjId,
            style: { fontSize: { magnitude: pt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        },
      )
      console.log(`[title-fit] slide ${i + 1} (${compIdT}): ${pt}pt, ${h}px`)
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
  const fixedRangeStyleRequests: object[] = [...titleBodyFixedRange]
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
    // bento_right_2's older "card < title" guard is gone: hierarchyCapPt inside
    // pickBentoCardPts caps every card family at 80% of its title, not merely below it.
    expectedCardPts.set(i, cardPts)

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    const bentoTokens = BENTO_TOKENS[compId] ?? []

    // Group headers are a row too: one size for all of them, the tightest card deciding.
    // Sized per card, a four-item card had room for the full +8 while its five-item
    // neighbour only had room for +4 — two headings of the same rank at 24pt and 20pt.
    const headerTokens = bentoTokens.filter(t =>
      (bentoHeaderSlots.get(i)?.has(t) ?? false) && (pSlots[t] ?? '').includes('\n'))
    let groupHeaderPt: number | null = null
    for (const t of headerTokens) {
      const d = bentoDims(compId, {
        titleText: pSlots['ЗАГОЛОВОК'] ?? '',
        tokenIdx: bentoTokens.indexOf(t),
        subBand: subtitleBand(compId, pSlots, titlePtFor(compId, (pSlots['ЗАГОЛОВОК'] ?? '').trim())),
      })
      if (!d) continue
      const cardPt = cardPts[t] ?? (BENTO_MIN_PT[compId] ?? 10)
      const hp = computeHeaderPt(pSlots[t] ?? '', d, cardPt, BENTO_MAX_PT[compId] ?? cardPt)
      groupHeaderPt = groupHeaderPt === null ? hp : Math.min(groupHeaderPt, hp)
    }
    if (groupHeaderPt !== null && headerTokens.length > 1) {
      console.log(`[bento-header] slide ${i + 1} (${compId}): group header=${groupHeaderPt}pt across ${headerTokens.length} cards`)
    }

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
        // List items carry no bullet character and no hanging indent — every line starts
        // flush at the left edge — so the ONLY thing telling the reader where one item
        // ends is vertical space. softBreaksToParagraphs makes each item a real paragraph
        // so that space can live between items (spaceBelow) instead of being smeared over
        // every wrapped line by a flat lineSpacing. two_columns_plain/two_columns_labeled
        // skip preprocessBentoText, so their items arrive as real \n paragraphs already —
        // hasListItems covers both shapes (and excludes value+label cards).
        if (hasListItems(slotValue)) {
          requests.push(listParagraphStyleRequest(el.objectId, pt))
        }
        // Header line (splitCardHeader, applied during preprocessing): always WHITE;
        // bigger only if it fits without pushing the body into overflow (computeHeaderPt).
        // Whether a header exists is READ from what preprocessing recorded, never inferred
        // from the presence of a \n — in a list that keeps its items \n-separated the first
        // item is not a header, and enlarging it invents a hierarchy that isn't there.
        const headerNlIdx = slotValue.indexOf('\n')
        const hasHeader = headerNlIdx > 0 && (bentoHeaderSlots.get(i)?.has(matchedToken) ?? false)
        if (hasHeader) {
          const headerLen = Math.min(headerNlIdx, actualLen)
          if (headerLen > 0) {
            const headerPt = groupHeaderPt ?? pt
            const style: { foregroundColor: object; fontSize?: object } = {
              foregroundColor: { opaqueColor: { rgbColor: _WHITE } },
            }
            let fields = 'foregroundColor'
            if (headerPt > pt) {
              style.fontSize = { magnitude: headerPt, unit: 'PT' }
              fields += ',fontSize'
              // readDeckFacts reads fontSize off the shape's FIRST text run, which is
              // now the header — update the recorded expectation (same object stored
              // in expectedCardPts) so verification checks what's actually there
              // instead of flagging the intentional header/body size difference.
              cardPts[matchedToken] = headerPt
            }
            fixedRangeStyleRequests.push({
              updateTextStyle: {
                objectId: el.objectId,
                style,
                fields,
                textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: headerLen },
              },
            })
          }
        }
        // A card that opens with a figure ("80% часу…", "4.2 — середня оцінка…") gets that
        // figure in WHITE, in place. It stays on its own line — the number is the point of
        // the sentence, not a separate headline, and moving it down made two identical
        // shapes look like two different rules depending on where the line wrapped.
        const fig = splitLeadingFigure(slotValue)
        if (fig) {
          const figEnd = Math.min(fig.figure.length, actualLen)
          if (figEnd > 0) {
            fixedRangeStyleRequests.push({
              updateTextStyle: {
                objectId: el.objectId,
                style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
                fields: 'foregroundColor',
                textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: figEnd },
              },
            })
          }
        }

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
  // The box the font was chosen for and the box the text was written into were not the
  // same box: the search used a computed zone (830 wide × 479 high) while the master's
  // ТЕКСТ box is 765 × 400 at y=440 and nothing ever resized it. Everything the search
  // granted between those two rectangles left the box on screen (+157px and +243px on
  // deck slides 11 and 15).
  // Now both use the real one: the master's x/width, from its y down to the page margin.
  const _TP_BODY_X    = 100                              // create-master: ТЕКСТ box x
  const _TP_BODY_W    = 765                              // create-master: ТЕКСТ box width
  const _TP_BODY_Y    = 440                              // create-master: ТЕКСТ box y (title zone bottom)
  const _TP_BODY_MAX_H = _H_SLIDE - _PAD - _TP_BODY_Y    // 540 — down to the page margin
  for (let i = 0; i < plan.slides.length; i++) {
    if (plan.slides[i].composition !== 'title_photo') continue
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue
    const pSlots   = bentoProcessedSlots.get(i) ?? plan.slides[i].slots
    const title    = plan.slides[i].slots['ЗАГОЛОВОК'] ?? ''
    const bodyText = (pSlots['ТЕКСТ'] ?? '').trim()
    const titlePt  = pickTitlePhotoPt(title)

    // Body font auto-shrink (same steps as title_body)
    let bodyPt = _TB_BODY_STEPS[0]
    if (bodyText) {
      for (const pt of _TB_BODY_STEPS) {
        if (textFitsParagraphs(bodyText, _TP_BODY_W, _TP_BODY_MAX_H, pt)) { bodyPt = pt; break }
      }
      // Same 20% rule as everywhere else.
      {
        const cap = hierarchyCapPt(titlePt, _TB_BODY_STEPS[_TB_BODY_STEPS.length - 1])
        if (bodyPt > cap) {
          const lower = _TB_BODY_STEPS.find(pt => pt <= cap)
          if (lower !== undefined) {
            console.log(`[title-photo-hierarchy] bodyPt ${bodyPt} → ${lower} (title=${titlePt}pt, cap=${cap})`)
            bodyPt = lower
          }
        }
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
        // Give the box the zone the font was chosen for: master x/width, master y, down
        // to the page margin. Without this the search keeps measuring 540px of room the
        // box does not have (the master stops 140px short at y=840).
        if (el.size && el.transform) {
          const sW = el.size.width?.magnitude  ?? 0
          const sH = el.size.height?.magnitude ?? 0
          requests.push(makeElemTransform(
            el.objectId,
            _TP_BODY_X - _INSET, _TP_BODY_Y - _INSET,
            _TP_BODY_W + 2 * _INSET, _TP_BODY_MAX_H + 2 * _INSET,
            sW, sH,
          ))
        }
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { fontSize: { magnitude: bodyPt, unit: 'PT' }, bold: false },
            fields: 'fontSize,bold',
            textRange: { type: 'ALL' },
          },
        })
        // Same header+list treatment as title_body (formatTitleBodyText, applied
        // upstream): WHITE for a group's lead-in line. No hanging indent needed —
        // list items become real paragraphs at write time, so the gap lives between them.
        if (hasListItems(bodyText)) {
          requests.push(listParagraphStyleRequest(el.objectId, bodyPt))
        }
        for (const range of findGroupHeaderRanges(bodyText)) {
          const endIndex = Math.min(range.end, bodyText.length)
          if (endIndex <= range.start) continue
          fixedRangeStyleRequests.push({
            updateTextStyle: {
              objectId: el.objectId,
              style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
              fields: 'foregroundColor',
              textRange: { type: 'FIXED_RANGE', startIndex: range.start, endIndex },
            },
          })
        }
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
      let   elH = Math.round((el.size.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1) / _FPX)
      // two_columns_labeled ПІДПИС_N master box is a nominal 50px tag, not the real
      // available height — the label actually has the full gap down to where КОЛОНКА_N
      // starts (y=451→540=89px) before it visually collides with the body text below.
      const isFlatLabel = compId === 'two_columns_labeled' && /^ПІДПИС_\d$/.test(slotName)
      if (isFlatLabel) elH = labelMetrics(slots).boxH
      if (!elW || !elH) continue
      const innerW = Math.max(1, elW - 2 * _INSET)
      const innerH = Math.max(1, elH - (isFlatLabel ? 0 : 2 * _INSET))

      // Read default pt from template element's text style
      const defaultPt = (el.shape?.text?.textElements ?? [])
        .find(te => te.textRun?.style?.fontSize?.magnitude)
        ?.textRun?.style?.fontSize?.magnitude ?? 18

      const steps = (FONT_STEPS as readonly number[]).filter(s => s <= defaultPt)
      // ПІДПИС_1 and ПІДПИС_2 are one row of markers: they must be one size, chosen by
      // the tightest of them, exactly as the columns under them are. Sized apart, a
      // two-line marker dropped to 10pt next to a one-line marker at 22pt.
      // Markers are sized as a row by labelMetrics — one pt for all of them, box grown
      // first. Everything else answers only for itself.
      const labelPeers = isFlatLabel
        ? Object.entries(slots)
            .filter(([k, v]) => /^ПІДПИС_\d$/.test(k) && (v ?? '').trim())
            .map(([, v]) => v)
        : [slotValue]
      let chosenPt: number | null = null
      for (const pt of steps) {
        // Paragraph-aware: textFits() collapses \n/\v to spaces, so an 11-item list looked
        // like one flowing paragraph and kept a font far too large for the forced line
        // starts and the gaps between them.
        if (labelPeers.every(t => textFitsParagraphs(t, innerW, innerH, pt))) { chosenPt = pt; break }
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
      // The inter-item gap is a fraction of the FONT, and the font just changed. Whoever
      // queued listParagraphStyleRequest earlier sized it from the pre-shrink pt — on a
      // closing slide that left an 18pt gap (computed at 36pt) under 10pt text, i.e. 528px
      // of air in a 478px box. Re-emit it so the gap always matches the font on screen.
      if (hasListItems(slotValue)) {
        requests.push(listParagraphStyleRequest(el.objectId, chosenPt))
      }
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
      if (!colText) continue
      const objId = slotObjectIds[i]?.[`КОЛОНКА_${k}`]
      if (!objId) continue
      const nlIdx = colText.indexOf('\n')
      const grey  = { foregroundColor: { opaqueColor: { rgbColor: _AG_MUTED_RGB } } }
      // Marker present → it is grey and the items stay white. No marker → the column is
      // grey as a whole, rather than pretending its first sentence is a heading.
      // Flat columns are white on dark, so a figure is highlighted by muting what follows
      // it rather than by colouring it — the opposite direction to a bento card, same
      // result: the number reads first.
      const fig = splitLeadingFigure(colText)
      if (fig) {
        const figEnd = fig.figure.length
        if (figEnd > 0 && figEnd < colText.length) {
          fixedRangeStyleRequests.push({
            updateTextStyle: {
              objectId: objId,
              style: { foregroundColor: { opaqueColor: { rgbColor: _AG_MUTED_RGB } } },
              fields: 'foregroundColor',
              textRange: { type: 'FIXED_RANGE', startIndex: figEnd, endIndex: colText.length },
            },
          })
        }
        continue
      }

      const marked = nlIdx > 0 &&
        isColumnLabel(colText.slice(0, nlIdx)) &&
        slotHasMarker(plan.slides[i], `КОЛОНКА_${k}`, colText.slice(0, nlIdx), colText)
      if (marked) {
        fixedRangeStyleRequests.push({
          updateTextStyle: {
            objectId: objId, style: grey, fields: 'foregroundColor',
            textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: nlIdx },
          },
        })
      } else {
        fixedRangeStyleRequests.push({
          updateTextStyle: {
            objectId: objId, style: grey, fields: 'foregroundColor',
            textRange: { type: 'ALL' },
          },
        })
      }
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
