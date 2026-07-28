// ─── One ruler for text height ────────────────────────────────────────────────
// Text height was measured by two different rulers: the generator budgeted with a
// deliberately pessimistic one (0.65 char width, 1.2 line factor) while the validator
// measured what is actually drawn (0.5, 1.1). Both were "right" on their own terms, and
// every bug in this area lived in the gap between them — either the generator picked a
// font for space the renderer never uses (cards a third empty at 11pt where 13pt fits),
// or a late tweak pushed the real text past a box the generator had already approved.
//
// This module is that single ruler. The generator chooses fonts with it and keeps a small
// margin (FIT_MARGIN); the validator asks the same question with no margin — "does it
// actually spill?". They can no longer disagree, because there is only one answer.
//
// The numbers are the RENDERED reality, measured on real decks:
//   CHAR_W 0.5      — average Inter Medium advance, Cyrillic included
//   LINE_FACTOR 1.1 — lineSpacing 90% × Inter's ~1.21em line box
// Word-fit (does one long WORD stick out sideways) is NOT part of this — it stays
// pessimistic at 0.65 in lib/google.ts, because a broken word is a visible defect while
// a slightly-too-small font is not.

export const CHAR_W      = 0.5
export const LINE_FACTOR = 1.1

// Air after each list item, as a fraction of the font size (written as spaceBelow).
export const LIST_ITEM_GAP_EM = 0.5

// The generator aims to leave this much of the box unused, so that rounding, NBSP and
// Google's own line-breaking never turn "exactly fits" into a 3px overflow.
export const FIT_MARGIN = 0.95

export function ptToPx(pt: number): number { return pt * 2.667 }

// How many lines a single paragraph wraps into at this width and size.
export function wrappedLines(text: string, wPx: number, pt: number, charW = CHAR_W): number {
  if (!text.trim()) return 0
  const cpl   = Math.max(1, Math.floor(wPx / (ptToPx(pt) * charW)))
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) cur = w.length
    else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
    else { lines++; cur = w.length }
  }
  return lines
}

export type Para = { text: string; pt: number; spaceBelowPt: number }

// Height of a block of paragraphs as the renderer draws it. Per-paragraph pt, because a
// group header is one step larger than the list under it — measuring the whole box at one
// size is exactly how that bump escaped its card.
export function renderedHeight(paras: Para[], wPx: number): number {
  let h = 0
  for (const p of paras) {
    // \v is a soft break inside one paragraph — still starts its own line
    for (const seg of p.text.replace(/\n$/, '').split('\v')) {
      h += wrappedLines(seg, wPx, p.pt) * ptToPx(p.pt) * LINE_FACTOR
    }
    h += ptToPx(p.spaceBelowPt)
  }
  return h
}

// Same, for text that is uniform in size — the common case at font-picking time.
// `listGaps` mirrors hasListItems(): items separated by \n or \v get air between them.
export function renderedHeightUniform(text: string, wPx: number, pt: number, listGaps: boolean): number {
  const items = text.split(/[\n\v]/).filter(s => s.trim())
  const paras: Para[] = items.map(t => ({
    text: t,
    pt,
    spaceBelowPt: listGaps ? Math.round(LIST_ITEM_GAP_EM * pt * 10) / 10 : 0,
  }))
  return renderedHeight(paras, wPx)
}
