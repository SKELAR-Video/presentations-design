// ─── One rule for the top of a slide ──────────────────────────────────────────
// Where the title ends and the content begins used to be answered in eight places, each
// with its own constants: 32pt in a 100px zone for one family, 44pt in 245px for another,
// 44pt inside a 300px cap for the timelines. Every one of them described the TEMPLATE
// rather than the slide, and every new composition rediscovered the same two bugs — a
// constant that ignores the text, and a box measured with one font and filled with
// another. Eleven consecutive fixes in this area were the same defect wearing different
// clothes.
//
// This module answers the question once, for every composition:
//
//   dead zone  → title → (subtitle) → content
//
// Nothing else may compute those positions. Renderers, the font search and the validator
// all read the same object, so "the box we measured" and "the box we wrote" are the same
// box by construction.

import { wrappedLines } from './textfit'

// ─── Slide geometry (Figma px, mirrors lib/google.ts) ────────────────────────
const PAD        = 100
const H          = 1080
const BOTTOM     = H - PAD              // 980 — content never crosses this
const TITLE_W    = 1610                 // right edge 1710; the logo starts at 1730
const TITLE_GAP  = 60                   // title → subtitle → content, the same everywhere

// A heading is measured with a heading-sized ruler: at 44pt Cyrillic the body ruler's 0.5
// reads a two-line title as one (see docs/rules/typography.md).
const TITLE_CHAR_W  = 0.58
const LINE_FACTOR   = 1.1               // lineSpacing 90% × Inter's ~1.21em
const GLYPH_OF_LINE = 0.85              // glyphs fill about this much of a line box
const WORD_CHAR_W   = 0.65              // width guard stays pessimistic: no broken words
const WORD_SAFETY   = 1.1

export const TITLE_PT_STEPS = [44, 40, 36, 32, 28] as const

// The content's own floor: a column row is never shorter than this, so a heading may take
// at most what is left above it. 980 − 440 − 60 − 100 = 380.
const CONTENT_MIN_H = 440
const TITLE_MAX_H   = BOTTOM - CONTENT_MIN_H - TITLE_GAP - PAD

// Timelines cap their zone tighter: below it the dots would leave the slide.
const TIMELINE_TITLE_MAX_H = 300

// Subtitle: a ratio of the title, snapped to the scale, never past two lines.
const SUB_SCALE     = [48, 36, 28, 22, 18, 14] as const
const SUB_RATIO     = 0.7
const SUB_MIN_PT    = 14
const SUB_MAX_LINES = 2
const SUB_CHAR_W    = 0.62              // heading-scale text wraps earlier than body text
const SUB_GAP_RATIO = 0.25 * 0.72       // title → subtitle, as a share of the title's line

export type LayoutInput = {
  compId: string
  titleText?: string
  subtitleText?: string
  /** ПІДПИС_N band for two_columns_labeled, 0 elsewhere. */
  labelBand?: number
}

export type SlideLayout = {
  titlePt: number
  /** y of the title's first line (text, not box). */
  titleTop: number
  /** height of the title's line boxes — what the box is sized to. */
  titleH: number
  /** y where the glyphs of the last line end — everything below is measured from here. */
  titleBottom: number
  subtitlePt: number
  subtitleY: number
  subtitleH: number
  /** y where the content (cards, columns, body) starts. */
  contentTop: number
  /** height available to the content, down to the page margin. */
  contentH: number
}

function lineBox(pt: number): number { return pt * 2.667 * LINE_FACTOR }

function longestWordPx(text: string, pt: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
  return words.length ? Math.max(...words.map(w => w.length)) * pt * 2.667 * WORD_CHAR_W : 0
}

/** Lines a title occupies, explicit newlines included. */
export function titleLines(text: string, pt: number, width = TITLE_W): number {
  const t = text.trim()
  if (!t) return 0
  return t.split('\n').reduce((n, part) => n + Math.max(1, wrappedLines(part, width, pt, TITLE_CHAR_W)), 0)
}

function titleMaxH(compId: string): number {
  return compId.endsWith('_timeline') ? TIMELINE_TITLE_MAX_H : TITLE_MAX_H
}

/**
 * The largest step that fits BOTH limits: no word may cross the width up to the logo, and
 * the block may not grow past what the content's minimum leaves it.
 */
export function pickTitlePt(compId: string, titleText: string, width = TITLE_W): number {
  const t = titleText.trim()
  if (!t) return TITLE_PT_STEPS[0]
  const maxH = titleMaxH(compId)
  for (const pt of TITLE_PT_STEPS) {
    if (longestWordPx(t, pt) * WORD_SAFETY > width) continue
    if (titleLines(t, pt, width) * lineBox(pt) <= maxH) return pt
  }
  return TITLE_PT_STEPS[TITLE_PT_STEPS.length - 1]
}

export function subtitlePt(titlePt: number, subtitleText: string): number {
  const t = subtitleText.trim()
  let start = SUB_MIN_PT
  let bestDiff = Infinity
  for (const pt of SUB_SCALE) {
    const diff = Math.abs(pt - titlePt * SUB_RATIO)
    if (diff < bestDiff) { bestDiff = diff; start = pt }
  }
  start = Math.max(SUB_MIN_PT, Math.min(start, titlePt - 4))
  if (!t) return start
  // Breathing room below is not negotiable: an over-long sentence gives up size, never the
  // gap. Never below half the title.
  const floor = Math.max(SUB_MIN_PT, Math.round(titlePt / 2))
  let pt = start
  for (const step of SUB_SCALE) {
    if (step > start || step < floor) continue
    pt = step
    if (titleLines(t, step) <= SUB_MAX_LINES) break
  }
  return pt
}

/** The whole top of the slide, in one answer. */
export function slideLayout(input: LayoutInput): SlideLayout {
  const title    = (input.titleText ?? '').trim()
  const subtitle = (input.subtitleText ?? '').trim()

  const titlePt = pickTitlePt(input.compId, title)
  const lines   = titleLines(title, titlePt)
  const titleH  = Math.ceil(lines * lineBox(titlePt))
  // Measured at the glyphs, not at the bottom of the line box: a line box carries ~15% of
  // air below the descender, and counting it made every gap under a title depend on the
  // title's size rather than on the design.
  const titleBottom = title
    ? PAD + Math.ceil((lines - 1) * lineBox(titlePt) + GLYPH_OF_LINE * lineBox(titlePt))
    : PAD

  const subPt = subtitle ? subtitlePt(titlePt, subtitle) : 0
  const subH  = subtitle
    ? Math.ceil(subtitle.split('\n').reduce(
        (n, part) => n + Math.max(1, wrappedLines(part, TITLE_W, subPt, SUB_CHAR_W)), 0) * lineBox(subPt))
    : 0
  const subY = subtitle ? titleBottom + Math.round(SUB_GAP_RATIO * lineBox(titlePt)) : 0

  const blockBottom = subtitle ? subY + subH : titleBottom
  const contentTop  = blockBottom + TITLE_GAP + (input.labelBand ?? 0)

  return {
    titlePt,
    titleTop: PAD,
    titleH,
    titleBottom,
    subtitlePt: subPt,
    subtitleY: subY,
    subtitleH: subH,
    contentTop,
    contentH: Math.max(0, BOTTOM - contentTop),
  }
}
