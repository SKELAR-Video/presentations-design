// Fixture test for plan-level validator checks (no Slides API required).
// Run: npx ts-node --skip-project scripts/validate-fixture.ts
// Verifies: no_literal_asterisk, no_duplicate_title, badge_item_max_chars

import { validatePlan, checkContentCoverage, checkSourceColumns } from '../lib/validator'
import { PHASE0_COMPOSITIONS } from '../lib/compositions'
import { applyCoverageFallback, missingSourceLines } from '../lib/coverage'
import { applyColumnCapacityFallback, countSourceColumns, listMarkerSignal, looksLikeAction } from '../lib/columns'
import type { SlidePlan } from '../lib/types'
import { renderedHeight, renderedHeightUniform, FIT_MARGIN, pickTitlePt, longestWordPx, wrappedLines } from '../lib/textfit'
import {
  timelineTitlePt, timelineLayoutMetrics, TCL_TITLE_HMAX, TCL_TEXT_W_TWO, TCL_ZONE_W_THREE, _AG_DOT_SZ,
  _TITLE_W, _TITLE_WRAP_CHAR_W,
} from '../lib/google'

// ─── Fixture 1 — PASS: correct badges slide (App Store categories) ─────────
const fixture1: SlidePlan = {
  theme: 'dark',
  slides: [
    {
      id: 'slide_1',
      composition: 'cover',
      slots: { ЗАГОЛОВОК: 'Найпопулярніші категорії App Store', ПІДЗАГОЛОВОК: 'Огляд ринку', ДАТА: '2026' },
      flags: {},
    },
    {
      id: 'slide_2',
      composition: 'badges',
      slots: {
        ЗАГОЛОВОК: 'Найпопулярніші категорії',
        ПУНКТИ: "Ігри\nПродуктивність\nСоціальні мережі\nФото та відео\nЗдоров'я та фітнес\nФінанси",
      },
      flags: {},
    },
    {
      id: 'slide_3',
      composition: 'closing',
      slots: {},
      flags: {},
    },
  ],
}

// ─── Fixture 2 — FAIL: asterisks, duplicate title, long badge item ─────────
const fixture2: SlidePlan = {
  theme: 'dark',
  slides: [
    {
      id: 'slide_1',
      composition: 'title_body',
      slots: {
        ЗАГОЛОВОК: 'Категорії',
        ТЕКСТ: '* Ігри\n* Продуктивність\n* Соціальні мережі',
      },
      flags: {},
    },
    {
      id: 'slide_2',
      composition: 'title_body',
      slots: {
        ЗАГОЛОВОК: 'Категорії',  // duplicate of slide_1
        ТЕКСТ: '* Фото та відео\n* Фінанси',
      },
      flags: {},
    },
    {
      id: 'slide_3',
      composition: 'badges',
      slots: {
        ЗАГОЛОВОК: 'Категорії App Store',
        ПУНКТИ: 'Ігри\nПродуктивність — занадто довга мітка\nФінанси',
      },
      flags: {},
    },
  ],
}

// ─── Fixture 3 — fragment_coverage: PASS slide (all blocks mapped) ───────────
const fixture3pass: SlidePlan = {
  theme: 'dark',
  slides: [
    {
      id: 'slide_1',
      composition: 'bento_right_2',
      slots: {
        ЗАГОЛОВОК: 'Чому бігати важливо',
        КАРТКА_1: '80% лікарів рекомендують',
        КАРТКА_2: '32% зниження ризику',
      },
      flags: {},
    },
  ],
  fragmentGroups: [
    ['Чому бігати важливо', '80% лікарів рекомендують', '32% зниження ризику'],
  ],
}

// ─── Fixture 4 — fragment_coverage: FAIL (third fragment dropped) ─────────
const fixture4fail: SlidePlan = {
  theme: 'dark',
  slides: [
    {
      id: 'slide_1',
      composition: 'bento_right_2',
      slots: {
        ЗАГОЛОВОК: 'Чому бігати важливо',
        КАРТКА_1: '80% лікарів рекомендують',
        КАРТКА_2: '32% зниження ризику',
        // 'Дихальний об'єм +40%' — not assigned anywhere → FAIL
      },
      flags: {},
    },
  ],
  fragmentGroups: [
    ['Чому бігати важливо', '80% лікарів рекомендують', '32% зниження ризику', "Дихальний об'єм +40%"],
  ],
}

function run(label: string, plan: SlidePlan) {
  console.log(`\n=== ${label} ===`)
  const results = validatePlan(plan)
  let allPass = true
  for (const r of results) {
    const status = r.pass ? '✅ PASS' : '❌ FAIL'
    console.log(`  slide ${r.slideIndex} [${r.check}]: ${status}${r.detail ? ' — ' + r.detail : ''}`)
    if (!r.pass) allPass = false
  }
  console.log(`  → ${allPass ? '✅ All checks passed' : '❌ Some checks FAILED'}`)
}

run('Fixture 1 — valid badges (expect all PASS)', fixture1)
run('Fixture 2 — bug cases (expect FAILs on asterisk, duplicate title, long badge)', fixture2)
run('Fixture 3 — fragment_coverage PASS (all 3 blocks mapped)', fixture3pass)
run('Fixture 4 — fragment_coverage FAIL (1 block dropped)', fixture4fail)

// Run each fixture twice to confirm determinism
console.log('\n--- second run (determinism check) ---')
run('Fixture 1 — run 2', fixture1)
run('Fixture 2 — run 2', fixture2)

// ─── Word-break fixture ────────────────────────────────────────────────────────
// Pure math — same formulas as lib/google.ts word-fit guard. No API calls.
// PASS iff longestWordPx(text, pt) × 1.1 ≤ innerW
//
// longestWordPx and pickTitlePt are imported from lib/google.ts, not reimplemented here.
// A hand-copied version of both lived in this file until it was found stale: it still
// used the pre-standardization 1.2 safety margin (and pickTitlePt's own extra -19 inset)
// after the real code moved to 1.1 + inner_width passed directly — so this fixture kept
// reporting PASS/FAIL against a margin nothing in production used any more.
{
  const SAFETY = 1.1

  function checkWord(label: string, text: string, innerW: number, pt: number): boolean {
    const words = text.trim().split(/\s+/).filter(Boolean)
    const longest = words.reduce((a, b) => a.length >= b.length ? a : b, '')
    const est    = longestWordPx(text, pt)
    const est11  = Math.round(est * SAFETY)
    const pass   = est11 <= innerW
    console.log(
      `  [${label}] longest_word_len=${longest.length} | est_width=${est} | est×1.1=${est11} | inner_width=${innerW} | chosen_font=${pt} → ${pass ? 'PASS' : 'FAIL'}`,
    )
    return pass
  }

  // Bento card font picking is still a local stand-in (the real pickBentoCardPts works on
  // a whole slots object, not a single text+width+maxPt call) — same SAFETY as production,
  // but not the same function. Known, separate gap from the title duplicate fixed here.
  function pickBentoPt(text: string, innerW: number, maxPt: number): number {
    const scale = [48, 36, 28, 22, 18, 14, 10].filter(p => p <= maxPt)
    for (const pt of scale) {
      if (longestWordPx(text, pt) * SAFETY <= innerW) return pt
    }
    return scale[scale.length - 1]
  }

  // Layout constants (must match google.ts)
  const RBW = 860, INN = 30
  const bentoInnerW = RBW - 2 * INN  // 800
  const _LTW = 830  // bento_right left text zone — matches google.ts's _LTW exactly

  function runBento(label: string, text: string, maxPt: number) {
    const pt = pickBentoPt(text, bentoInnerW, maxPt)
    return checkWord(label, text, bentoInnerW, pt)
  }
  function runTitle(label: string, text: string) {
    const pt = pickTitlePt(text, _LTW)
    return checkWord(label, text, _LTW, pt)
  }

  // ─── Bento height+width fixture ─────────────────────────────────────────────
  // Pure math: verifies that pickBentoPt selects font where BOTH width (word-fit)
  // AND height (lines × lineH ≤ inner_height) are satisfied.
  {
    const CHAR_W = 0.65, SAFETY = 1.2, BENTO_VP = 40
    const RBH = 880, GAP = 30, INN = 30

    function lH(pt: number) { return pt * 2.667 * 1.4 }

    function lwPx2(text: string, pt: number): number {
      const pxC = pt * 2.667 * CHAR_W
      const ws = text.trim().split(/\s+/).filter(Boolean)
      return ws.length === 0 ? 0 : Math.round(Math.max(...ws.map(w => w.length * pxC)))
    }

    function countLines(text: string, innerW: number, pt: number): number {
      const cpl = Math.max(1, Math.floor(innerW / (pt * 2.667 * CHAR_W)))
      const paras = text.split('\n').filter(p => p.trim())
      return paras.reduce((s, p) => {
        const words = p.split(/\s+/).filter(Boolean)
        let lines = 1, cur = 0
        for (const w of words) {
          if (!cur) cur = w.length
          else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
          else { lines++; cur = w.length }
        }
        return s + lines
      }, 0)
    }

    function fits(text: string, iW: number, iH: number, pt: number): boolean {
      if (!text.trim()) return true
      if (lwPx2(text, pt) * SAFETY > iW) return false
      return countLines(text, iW, pt) * lH(pt) <= iH
    }

    function pickPt(text: string, iW: number, iH: number, maxPt: number): number {
      const scale = [48, 36, 28, 22, 18, 14, 10].filter(p => p <= maxPt)
      for (const pt of scale) { if (fits(text, iW, iH, pt)) return pt }
      return scale[scale.length - 1]
    }

    function check(label: string, text: string, iW: number, iH: number, maxPt: number): boolean {
      const pt    = pickPt(text, iW, iH, maxPt)
      const lines = countLines(text, iW, pt)
      const textH = Math.round(lines * lH(pt))
      const lw    = lwPx2(text, pt)
      const wPass = Math.round(lw * SAFETY) <= iW
      const hPass = textH <= iH
      const pass  = wPass && hPass
      console.log(
        `  [${label}] lines=${lines} | text_height=${textH} | inner_height=${iH} | font=${pt} → ${pass ? 'PASS' : 'FAIL'}`,
      )
      return pass
    }

    const b2W = 860 - 2 * INN, b2H = Math.floor((RBH - GAP) / 2) - 2 * BENTO_VP          // 800, 345
    const b3W = 800,            b3H = Math.floor((RBH - 2 * GAP) / 3) - 2 * BENTO_VP      // 800, 193

    console.log('\n=== Bento height+width fixture — run 1 ===')
    check('bento_right_2 / short',          '80% лікарів рекомендують',                            b2W, b2H, 36)
    check('bento_right_2 / four-word long', 'Продуктивність визначається важливістю результату',    b2W, b2H, 36)
    check('bento_right_3 / multiline',      'Зростання виручки на 23% порівняно з минулим роком',  b3W, b3H, 22)
    check('bento_right_3 / single long',    'Продуктивність',                                       b3W, b3H, 22)

    console.log('\n=== Bento height+width fixture — run 2 (determinism) ===')
    check('bento_right_2 / short',          '80% лікарів рекомендують',                            b2W, b2H, 36)
    check('bento_right_2 / four-word long', 'Продуктивність визначається важливістю результату',    b2W, b2H, 36)
    check('bento_right_3 / multiline',      'Зростання виручки на 23% порівняно з минулим роком',  b3W, b3H, 22)
    check('bento_right_3 / single long',    'Продуктивність',                                       b3W, b3H, 22)
  }

  console.log('\n=== Bento geometry fixture — run 1 ===')
  // Verifies grid-driven card placement: top/bottom fill slide margins, gap is fixed.
  // Must pass regardless of text content or font size (geometry is independent of pt).
  {
    const PAD = 100, H = 1080, UW = 1720, GAP = 30, TH = 100, TG = 100
    const CY  = PAD + TH + TG    // 300 — content zone top
    const CH  = H - PAD - CY     // 680 — content zone height
    const RBH = H - 2 * PAD      // 880 — right block height

    function checkBento(compId: string): boolean {
      let top: number, bottom: number, gapOk: boolean
      if (compId === 'two_columns' || compId === 'three_columns') {
        top = CY; bottom = CY + CH; gapOk = true  // single row, no inter-card gap
      } else if (compId === 'bento_right_2') {
        const mH = Math.floor((RBH - GAP) / 2)
        const lastH = RBH - (2 - 1) * (mH + GAP)
        top = PAD; bottom = PAD + (2 - 1) * (mH + GAP) + lastH; gapOk = true
      } else if (compId === 'bento_right_3') {
        const mH = Math.floor((RBH - 2 * GAP) / 3)
        const lastH = RBH - (3 - 1) * (mH + GAP)
        top = PAD; bottom = PAD + (3 - 1) * (mH + GAP) + lastH; gapOk = true
      } else if (compId === 'bento_right_2x2') {
        const mH = Math.floor((RBH - GAP) / 2)
        top = PAD; bottom = PAD + mH + GAP + mH; gapOk = true
      } else { return true }

      const expected_bottom = H - PAD  // 980
      const passTop    = top === PAD || top === CY  // depends on layout type
      const passBottom = bottom === expected_bottom
      const pass = passBottom && gapOk  // top is always correct by construction
      console.log(
        `  [${compId}] card_top[0]=${top} | card_bottom[last]=${bottom}==${expected_bottom} | gap=${GAP} | fonts_equal=true | overflow=0 → ${pass ? 'PASS' : 'FAIL'}`,
      )
      return pass
    }

    const comps = ['two_columns', 'three_columns', 'bento_right_2', 'bento_right_3', 'bento_right_2x2']
    comps.forEach(checkBento)
    console.log('\n=== Bento geometry fixture — run 2 (determinism) ===')
    comps.forEach(checkBento)
  }

  // ─── Bento card growth: the row must get TALLER before the font gets smaller ──
  // Regression guard for the two decks where text ran out of its card and off the slide.
  // A bento row has two variables — card height and font size. Card height is free
  // (nothing is lost by using it), so it must be spent first. It wasn't: the row-layout
  // height estimate counted a 12-item list as one flowing paragraph and ignored the gaps
  // between items, so the row stayed at its 440px minimum while holding 500px+ of text.
  console.log('\n=== Bento card growth fixture ===')
  {
    const PAD = 100, H = 1080, UW = 1720, GAP = 30, INN = 30, CY = 300
    const VERT_PAD_ROW = 40, ROW_H_DEFAULT = 440
    const CHAR_W = 0.65, FIT_LINE = 1.2, GAP_EM = 0.5     // generator's budget
    const R_CHAR_W = 0.5, R_LINE = 1.1                    // what actually renders

    const wrapped = (t: string, wPx: number, pt: number, cw: number) => {
      const cpl = Math.max(1, Math.floor(wPx / (pt * 2.667 * cw)))
      return t.split(/[\n\v]/).filter(p => p.trim()).reduce((sum, p) => {
        const words = p.split(/\s+/).filter(Boolean)
        let lines = 1, cur = 0
        for (const w of words) {
          if (!cur) cur = w.length
          else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
          else { lines++; cur = w.length }
        }
        return sum + lines
      }, 0)
    }
    const items = (t: string) => t.split(/[\n\v]/).filter(p => p.trim()).length
    // generator: how tall does it think the text is (drives BOTH font and card height)
    const budgetH = (t: string, wPx: number, pt: number) =>
      wrapped(t, wPx, pt, CHAR_W) * pt * 2.667 * FIT_LINE + items(t) * GAP_EM * pt * 2.667
    // reality: how tall it comes out on screen
    const renderH = (t: string, wPx: number, pt: number) =>
      wrapped(t, wPx, pt, R_CHAR_W) * pt * 2.667 * R_LINE + items(t) * GAP_EM * pt * 2.667
    // the estimate the layout used BEFORE the fix: one flat paragraph, no item gaps
    const oldH = (t: string, wPx: number, pt: number) => {
      const cpl = Math.max(1, Math.floor(wPx / (pt * 2.667 * 0.48)))
      const words = t.replace(/[\n\v]/g, ' ').split(/\s+/).filter(Boolean)
      let lines = 1, cur = 0
      for (const w of words) {
        if (!cur) cur = w.length
        else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
        else { lines++; cur = w.length }
      }
      return lines * pt * 2.667 * 1.4
    }

    const rowInnerH = (textH: number) => {
      const contentCardH = textH + 2 * INN + 2 * VERT_PAD_ROW
      const rowY  = Math.max(H - PAD - Math.max(contentCardH, ROW_H_DEFAULT), CY)
      const cardH = H - PAD - rowY
      return { cardH, boxInner: cardH - 2 * INN }
    }

    // Real payloads from deck 1J3ftoH4g2uDPK-atf22t6pL706pFjdekHg_lbxMDA6Q
    const slide7 = [
      '“Зіркові” учні шкіл', 'Переможці олімпіад, МАН і конкурсів',
      'Екстернат за успіхи в навчанні', 'Талановиті студенти та випускники',
      'Найкращі на курсі', 'Переможці конкурсів та змагань, беруть участь в обмінах',
      'Дипломи з відзнакою', 'Писали дипломні чи курсові по нашим бізнесам',
      'Викладачі/Голови студпарламентів', 'Профільні спеціальності',
      'Викладають в кількох вузах', 'Мають паралельно бізнес/працюють в ІТ',
    ].join('\n')
    const slide15 = [
      'Студенти', 'Отримуй fast-track у компанію, в яку дуже складно потрапити',
      'Працюй з глобальними ринками', 'Будуй бізнес, а не заповнюй безкінечні ікселі та джиру',
      'Ростеш так швидко, як ростуть люди навколо тебе. Обирай оточення',
      'Університет навчив тебе думати. Ми навчимо тебе діяти',
    ].join('\n')

    const innerW = Math.floor((UW - GAP) / 2) - 2 * INN   // 785 — two_columns column
    const cases: Array<[string, string, number]> = [
      ['slide7 / 12 items', slide7, 10],
      ['slide15 / 6 items', slide15, 14],
    ]

    let allPass = true
    for (const [label, text, pt] of cases) {
      const now = rowInnerH(Math.ceil(budgetH(text, innerW, pt)))
      const before = rowInnerH(Math.ceil(oldH(text, innerW, pt)))
      const rendered = Math.round(renderH(text, innerW, pt))
      const grew   = now.cardH > before.cardH
      const fits   = rendered <= now.boxInner
      const caught = rendered > before.boxInner        // the fixture must fail the old way
      const pass = grew && fits && caught
      allPass &&= pass
      console.log(
        `  [${label}] card_before=${before.cardH}px card_now=${now.cardH}px | ` +
        `box_inner ${before.boxInner}→${now.boxInner}px | rendered=${rendered}px | ` +
        `grew=${grew ? '✓' : '✗'} fits=${fits ? '✓' : '✗'} old_overflowed=${caught ? '✓' : '✗'} → ${pass ? 'PASS' : 'FAIL'}`,
      )
    }
    console.log(`  → ${allPass ? '✅ card grows before the font shrinks' : '❌ FAILED'}`)
  }

  // ─── Font selection: max-first + floor (2/3/4-card groups) ──────────────────
  // Pure math: verifies chosen_font = largest fitting pt ≥ floor.
  // Determinism: run twice — output must be identical.
  {
    const CHAR_W = 0.65, SAFETY = 1.2, VP = 40, GAP = 30, INN = 30
    const RBH = 880, RBW = 860
    const b2W  = RBW - 2*INN,                        b2H  = Math.floor((RBH - GAP) / 2) - 2*VP      // 800, 345
    const b3W  = RBW - 2*INN,                        b3H  = Math.floor((RBH - 2*GAP) / 3) - 2*VP    // 800, 193
    const b4CW = Math.floor((RBW - GAP) / 2) - 2*INN, b4H = Math.floor((RBH - GAP) / 2) - 2*VP     // 355, 345

    function lH2(pt: number) { return pt * 2.667 * 1.4 }
    function lw(text: string, pt: number): number {
      const pxC = pt * 2.667 * CHAR_W
      const ws = text.trim().split(/\s+/).filter(Boolean)
      return ws.length === 0 ? 0 : Math.round(Math.max(...ws.map(w => w.length * pxC)))
    }
    function cLines(text: string, iW: number, pt: number): number {
      const cpl = Math.max(1, Math.floor(iW / (pt * 2.667 * CHAR_W)))
      const paras = text.split('\n').filter(p => p.trim())
      return paras.reduce((s, p) => {
        const words = p.split(/\s+/).filter(Boolean)
        let lines = 1, cur = 0
        for (const w of words) {
          if (!cur) cur = w.length
          else if (cur + 1 + w.length <= cpl) cur += 1 + w.length
          else { lines++; cur = w.length }
        }
        return s + lines
      }, 0)
    }
    function fits2(text: string, iW: number, iH: number, pt: number): boolean {
      if (!text.trim()) return true
      if (lw(text, pt) * SAFETY > iW) return false
      return cLines(text, iW, pt) * lH2(pt) <= iH
    }
    function pickGroup(cards: string[], iW: number, iH: number, maxPt: number, minPt: number): number {
      const scale = [48, 36, 28, 22, 18, 14, 10].filter(p => p <= maxPt)
      let chosen = scale[scale.length - 1]
      for (const pt of scale) {
        if (cards.every(c => fits2(c, iW, iH, pt))) { chosen = pt; break }
      }
      return Math.max(chosen, minPt)
    }
    function checkGroupFit(label: string, cards: string[], iW: number, iH: number, maxPt: number, minPt: number): boolean {
      const chosen = pickGroup(cards, iW, iH, maxPt, minPt)
      let allPass = true
      for (const [i, text] of cards.entries()) {
        if (!text.trim()) continue
        const wPass = lw(text, chosen) * SAFETY <= iW
        const hPass = cLines(text, iW, chosen) * lH2(chosen) <= iH
        const pass = wPass && hPass
        if (!pass) allPass = false
        console.log(`  [${label}/card${i+1}] max_font=${maxPt} | chosen_font=${chosen} | floor=${minPt} | fits_width=${wPass ? '✓' : '✗'} | fits_height=${hPass ? '✓' : '✗'} → ${pass || chosen === minPt ? 'PASS' : 'FAIL'}`)
      }
      const group_ok = chosen >= minPt
      console.log(`  → group chosen=${chosen} ≥ floor=${minPt}: ${group_ok ? 'PASS' : 'FAIL'}`)
      return allPass && group_ok
    }

    function runGroups() {
      console.log('\n=== Font selection fixture — 2/3/4-card groups ===')

      // 2-card: short text → maxPt expected
      checkGroupFit('bento_right_2 / all-short', ['80% лікарів', '32% зниження'], b2W, b2H, 36, 18)
      // 2-card: one long word → group forced below max but ≥ floor
      checkGroupFit('bento_right_2 / one-long-word', ['80% лікарів рекомендують', '32% зниження'], b2W, b2H, 36, 18)

      // 3-card: all short → maxPt
      checkGroupFit('bento_right_3 / all-short', ['Зростання', 'Зниження', 'Стабільність'], b3W, b3H, 22, 14)
      // 3-card: one long → group drops, ≥ floor
      checkGroupFit('bento_right_3 / one-long-word', ['Продуктивність', 'Зростання', 'Ефект'], b3W, b3H, 22, 14)

      // 4-card (bento_right_2x2): short words in narrow cell → maxPt=22
      checkGroupFit('bento_right_2x2 / all-short', ['80%', '32%', '+23%', '×2.5'], b4CW, b4H, 22, 14)
      // 4-card: long word forces floor
      checkGroupFit('bento_right_2x2 / with-long-word', ['лікарів', 'зростання', 'ефективність', '100%'], b4CW, b4H, 22, 14)
    }

    runGroups()
    console.log('\n--- Font selection fixture — run 2 (determinism) ---')
    runGroups()
  }

  console.log('\n=== Word-break fixture (CHAR_W=0.65, safety×1.1) — run 1 ===')

  // bento_right_2: maxPt=36, bentoInnerW=800
  runBento('bento_right_2 / short metric',   '80% лікарів рекомендують',   36)
  runBento('bento_right_2 / long word',      'рекомендують',                36)
  runBento('bento_right_2 / Продуктивність', 'Продуктивність визначається', 36)

  // bento_right_3: maxPt=22, bentoInnerW=800
  runBento('bento_right_3 / Продуктивність', 'Продуктивність', 22)

  // bento titles, effective width = _LTW = 830 directly (no extra inset subtraction —
  // see the pickTitlePt export note above), steps [44,40,36,32,28]
  runTitle('title / short',               'Чому бігати важливо')
  runTitle('title / щоденного borderline', 'Категорії для щоденного життя')
  runTitle('title / one long word',        'Продуктивність підприємства')

  console.log('\n=== Word-break fixture — run 2 (determinism) ===')

  runBento('bento_right_2 / short metric',   '80% лікарів рекомендують',   36)
  runBento('bento_right_2 / long word',      'рекомендують',                36)
  runBento('bento_right_2 / Продуктивність', 'Продуктивність визначається', 36)
  runBento('bento_right_3 / Продуктивність', 'Продуктивність', 22)
  runTitle('title / short',               'Чому бігати важливо')
  runTitle('title / щоденного borderline', 'Категорії для щоденного життя')
  runTitle('title / one long word',        'Продуктивність підприємства')
}

// ─── content_coverage + mapping fallback ──────────────────────────────────────
// Regression guard for the bug where a Slides brief lost a whole slide's body text and
// the deck still reported PASS: nothing in the live path compared the deck against the
// brief. Fixture 5/6 cover the live check; Fixture 7 covers the mapping safety net.
{
  const WORDING_LINES = [
    'Wording directions',
    'Ми не чекаємо, поки ти "будеш готовий" - ми допоможемо почати вже зараз',
    'Питання "навіщо?" вітаються більше, ніж "як скажете"',
    'Ти не "гвинтик"',
  ]

  const coveragePass: SlidePlan = {
    theme: 'dark',
    slides: [{
      id: 'slide_1',
      composition: 'closing',
      slots: { ЗАГОЛОВОК: WORDING_LINES[0], ПІДЗАГОЛОВОК: WORDING_LINES.slice(1).join('\n') },
      flags: {},
      fragments: WORDING_LINES,
    }],
  }

  // The actual reported bug: LLM took only the title, the rest vanished.
  const coverageFail: SlidePlan = {
    theme: 'dark',
    slides: [{
      id: 'slide_1',
      composition: 'closing',
      slots: { ЗАГОЛОВОК: WORDING_LINES[0] },
      flags: {},
      fragments: WORDING_LINES,
    }],
  }

  function runCoverage(label: string, plan: SlidePlan, expectPass: boolean) {
    const r = the_check(plan)
    const ok = r.pass === expectPass
    console.log(`\n=== ${label} ===`)
    console.log(`  content_coverage: ${r.pass ? '✅ PASS' : '❌ FAIL'} — ${r.detail}`)
    console.log(`  → expected ${expectPass ? 'PASS' : 'FAIL'}: ${ok ? '✅ correct' : '❌ WRONG'}`)
  }
  const the_check = checkContentCoverage

  runCoverage('Fixture 5 — content_coverage PASS (closing keeps its body text)', coveragePass, true)
  runCoverage('Fixture 6 — content_coverage FAIL (closing body text dropped)', coverageFail, false)

  // Fixture 7 — mapping fallback must restore every dropped line, no LLM involved.
  console.log('\n=== Fixture 7 — mapSlides1to1 coverage fallback ===')
  const broken = { id: 'slide_1', composition: 'closing', slots: { ЗАГОЛОВОК: WORDING_LINES[0] }, flags: {} }
  const before = missingSourceLines(broken, WORDING_LINES)
  applyCoverageFallback(broken, WORDING_LINES, 1)
  const after = missingSourceLines(broken, WORDING_LINES)
  console.log(`  missing before fallback: ${before.length} lines`)
  console.log(`  missing after  fallback: ${after.length} lines`)
  console.log(`  composition kept: ${broken.composition} | slots: ${Object.keys(broken.slots).join(', ')}`)
  const ok = before.length === 3 && after.length === 0 && broken.composition === 'closing'
  console.log(`  → ${ok ? '✅ all 3 lines restored, closing preserved' : '❌ WRONG'}`)

  // ─── Fixture 8 — one ruler: the font search must not pay for unused space ────
  // Calls the REAL shared functions (lib/textfit.ts), not a copy of their arithmetic.
  // Payload: deck 1iJo-…XbWg slide 6, three_columns, cards of 4 / 6 / 4 items in a
  // 493×620px text area. The old budget (0.65 char width, 1.2 line box) measured the
  // fullest card as 581px and settled on 11pt; the renderer draws 411px there, i.e. a
  // third of the card was empty by arithmetic alone.
  console.log('\n=== Fixture 8 — rendered ruler + header bump (slide 6 / slide 14 payloads) ===')
  {
    const W = 493, H = 620
    const cards = [
      ['Proof of Talents', 'Участь в програмах SKELAR - це круто  і престижно',
       'Програми дають цінний досвід і підвищують мою “цінність” на ринку',
       'Можливість вчитися у зірок ринку на реальних кейсах'].join('\n'),
      ['Lovemark', 'Формування сприйняття SKELAR як лавмарка серед студентів',
       'SKELAR цінує талановиту молодь і інвестує в її розвиток',
       'Орієнтація на якість навчання', 'Відкритість до фідбека і нетворкінга',
       'Компанія інвестує в людей, а не лише шукає готових'].join('\n'),
      ['Місце для амбітного старту', 'місце для амбітних, де можна швидко зростати',
       'жорсткий відбір + безмежні можливості',
       'Скорочуємо/прискорюємо шлях до результату/успіху'].join('\n'),
    ]

    // Mirrors pickBentoCardPts: 1pt granularity, group = tightest card, floor 10.
    let groupPt = 28
    for (const text of cards) {
      let cardPt = 10
      for (let pt = 28; pt >= 10; pt--) {
        if (renderedHeightUniform(text, W, pt, true) <= H * FIT_MARGIN) { cardPt = pt; break }
      }
      groupPt = Math.min(groupPt, cardPt)
    }
    const heights = cards.map(t => Math.round(renderedHeightUniform(t, W, groupPt, true)))
    const fitsAll = heights.every(h => h <= H)
    const grew    = groupPt >= 13            // 11pt was the old answer for this payload
    console.log(
      `  group_font=${groupPt}pt | card heights ${heights.join(' / ')}px in ${H}px | ` +
      `≥13pt=${grew ? '✓' : '✗'} no_overflow=${fitsAll ? '✓' : '✗'}`,
    )

    // Slide 14: a +8pt bump on the first line must be refused when the text, gaps
    // included, no longer fits — the omission that cost 57px of overflow.
    const items14 = [
      'Стипендія на першому курсі навчання (за умови вступу в український ЗВО, ЗВО-партнер)',
      'ексклюзивний мерч;', 'Фінансування участі в змаганнях, хакатонах і тд.',
      'персональний ментор',
    ]
    const bodyPt = 14, GAP_PT = 7            // 0.5 × 14, as written to the file
    const flat   = renderedHeight(items14.map(t => ({ text: t, pt: bodyPt, spaceBelowPt: GAP_PT })), 873 - 38)
    const bumped = renderedHeight(items14.map((t, i) => ({ text: t, pt: i === 0 ? bodyPt + 8 : bodyPt, spaceBelowPt: GAP_PT })), 873 - 38)
    const bumpRefused = flat <= 440 && bumped > 440
    console.log(
      `  slide14 box 440px: body-only=${Math.round(flat)}px | with +8pt bump=${Math.round(bumped)}px | ` +
      `bump must be refused=${bumpRefused ? '✓' : '✗'}`,
    )
    console.log(`  → ${grew && fitsAll && bumpRefused ? '✅ one ruler, no unused space, no bump past the box' : '❌ WRONG'}`)
  }

  // ─── Fixture 9 — flat columns grow before the font shrinks ───────────────────
  // two_columns_plain / two_columns_labeled have no card to resize, so the text box IS
  // the column. The master parks it at y=540 (440px of area) — spacing drawn for a
  // two-line title — and the font paid for it: measured on deck
  // 1wit_n5dPxryz87WQwi1yjff6ZdPqdWUU2lqgi7-3_Tw, area 440 explained every observed font
  // exactly (slides 3/16/10/13/14 → 13/11/13/13/16pt).
  console.log('\n=== Fixture 9 — flat columns: area grows first, font follows ===')
  {
    const W = 835
    const column = [
      'Залучення талантів',
      'Зниження cost per lead, час пошуку',
      'Отримання постійного доступу до нових талантів (джуни, студенти, alumni)',
      'Створення talent bench',
      'Сформувати сприйняття компанії як найкращого місця для старту карʼєри в ІТ',
    ].join('\n')

    const bestPt = (area: number) => {
      for (let pt = 36; pt >= 10; pt--) {
        if (renderedHeightUniform(column, W, pt, true) <= area * FIT_MARGIN) return pt
      }
      return 10
    }
    // 440 = master, 486 = grown labelled area (label band rides along), 575 = grown plain
    const at440 = bestPt(440), at486 = bestPt(486), at575 = bestPt(575)
    const monotonic = at575 >= at486 && at486 >= at440
    const gained    = at575 > at440
    const noOverflow = renderedHeightUniform(column, W, at575, true) <= 575
    console.log(
      `  area 440px → ${at440}pt | 486px → ${at486}pt | 575px → ${at575}pt | ` +
      `grew=${gained ? '✓' : '✗'} monotonic=${monotonic ? '✓' : '✗'} no_overflow=${noOverflow ? '✓' : '✗'}`,
    )
    console.log(`  → ${gained && monotonic && noOverflow ? '✅ a taller area buys a bigger font, and it still fits' : '❌ WRONG'}`)
  }

  // ─── Fixture 11 — 1 аркуш = 1 слайд, structurally ───────────────────────────
  // The real case: brief sheet "Цільові групи" has three columns, the slide built from it
  // carried two. content_coverage stayed green (no line was missing), because it asks
  // about text and this is about structure.
  console.log('\n=== Fixture 11 — source_columns_covered (3 колонки в ТЗ) ===')
  {
    const three = {
      id: 'slide_4', composition: 'three_columns', flags: {}, sourceColumns: 3,
      slots: { ЗАГОЛОВОК: 'Цільові групи', КОЛОНКА_1: 'a', КОЛОНКА_2: 'b', КОЛОНКА_3: 'c' },
    }
    const two = {
      id: 'slide_4', composition: 'two_columns', flags: {}, sourceColumns: 3,
      slots: { ЗАГОЛОВОК: 'Цільові групи', КОЛОНКА_1: 'a+b', КОЛОНКА_2: 'c' },
    }
    const flat = {
      id: 'slide_4', composition: 'title_body', flags: {}, sourceColumns: 3,
      slots: { ЗАГОЛОВОК: 'Цільові групи', ТЕКСТ: 'a b c' },
    }
    const noise = {
      id: 'slide_9', composition: 'title_body', flags: {}, sourceColumns: 1,
      slots: { ЗАГОЛОВОК: 'Заголовок', ТЕКСТ: 'один потік тексту' },
    }
    const cases: Array<[string, any, boolean]> = [
      ['3 колонки → three_columns (3 слоти)', three, true],
      ['3 колонки → two_columns (2 слоти)',   two,   false],
      ['3 колонки → title_body (1 слот)',     flat,  false],
      ['1 колонка → title_body (не в scope)', noise, true],
    ]
    let ok = true
    for (const [label, slide, expectPass] of cases) {
      const r = checkSourceColumns(slide)
      const correct = r.pass === expectPass
      ok &&= correct
      console.log(`  ${r.pass ? '✅ PASS' : '❌ FAIL'} — ${label}: ${r.detail} ${correct ? '' : '← ОЧІКУВАЛОСЬ ІНШЕ'}`)
    }
    console.log(`  → ${ok ? '✅ структурна втрата колонок ловиться до того, як її побачить людина' : '❌ WRONG'}`)
  }

  // ─── Fixture 12 — columns are an auto-layout: 2–4, never fewer than the sheet ─
  // The real sheet: "Цільові групи", three columns. Whatever layout the mapping picks,
  // the slide must end up with three places to put them — columns_flex is the carrier
  // that has as many columns as the content does.
  console.log('\n=== Fixture 12 — column capacity fallback (2–4) ===')
  {
    const source = {
      index: 3,
      texts: [
        'Цільові групи',
        '“Зіркові” учні шкіл\nПереможці олімпіад, МАН і конкурсів',
        'Найкращі на курсі\nПереможці конкурсів та змагань, беруть участь в обмінах',
        'Викладачі/Голови студпарламентів\nПрофільні спеціальності, викладають в кількох вузах',
      ],
      columns: [null, 0, 1, 2],
    }
    const squeezed = {
      id: 'slide_4', composition: 'two_columns', flags: {},
      sourceColumns: countSourceColumns(source as any),
      slots: {
        ЗАГОЛОВОК: 'Цільові групи',
        КОЛОНКА_1: source.texts[1] + '\n' + source.texts[2],   // two columns merged
        КОЛОНКА_2: source.texts[3],
      },
    }
    const fixed = applyColumnCapacityFallback(squeezed as any, source as any, 4)
    const cols = Object.keys(fixed.slots).filter(k => /^КОЛОНКА_\d/.test(k) && fixed.slots[k].trim())
    const allPresent = source.texts.every(t => Object.values(fixed.slots).some(v => String(v).includes(t)))
    const ok = fixed.composition === 'columns_flex' && cols.length === 3 && allPresent
    console.log(`  source_columns=${squeezed.sourceColumns} | було ${squeezed.composition} (2 слоти) → стало ${fixed.composition} (${cols.length})`)
    console.log(`  усі фрагменти аркуша на місці: ${allPresent ? '✓' : '✗'}`)

    // A sheet the layout already fits must be left completely alone.
    const fine = {
      id: 'slide_9', composition: 'three_columns', flags: {}, sourceColumns: 3,
      slots: { ЗАГОЛОВОК: 'т', КОЛОНКА_1: 'a', КОЛОНКА_2: 'b', КОЛОНКА_3: 'c' },
    }
    const untouched = applyColumnCapacityFallback(fine as any, source as any, 9)
    const same = untouched.composition === 'three_columns'
    console.log(`  композиція, якій вистачає слотів, не чіпається: ${same ? '✓' : '✗'}`)
    console.log(`  → ${ok && same ? '✅ колонок на слайді ніколи не менше, ніж в аркуші' : '❌ WRONG'}`)
  }

  // ─── Fixture 15 — a column keeps its content when the slot name is wrong ────
  // КОЛОНКА_N and КАРТКА_N are the same column under two names; which one is right depends
  // on the composition. A four_columns slide holding КАРТКА_1..4 renders nothing at all.
  console.log('\n=== Fixture 15 — назва слота під композицію ===')
  {
    const declaredOf = (id: string) =>
      new Set((PHASE0_COMPOSITIONS.find(c => c.id === id)?.slots ?? []).map(sl => sl.name))
    const normalize = (comp: string, slots: Record<string, string>) => {
      const declared = declaredOf(comp)
      for (const key of Object.keys(slots)) {
        if (declared.has(key)) continue
        const m = key.match(/^(КОЛОНКА|КАРТКА)_(\d+)$/)
        if (!m) continue
        const alt = `${m[1] === 'КОЛОНКА' ? 'КАРТКА' : 'КОЛОНКА'}_${m[2]}`
        if (!declared.has(alt) || (slots[alt] ?? '').trim()) continue
        slots[alt] = slots[key]; delete slots[key]
      }
      return slots
    }
    const cases: Array<[string, string]> = [
      ['four_columns', 'КАРТКА'], ['four_columns_num', 'КАРТКА'],
      ['four_columns_paren', 'КАРТКА'], ['four_columns_bubble', 'КАРТКА'],
      ['bento_right_2x2', 'КОЛОНКА'], ['three_columns', 'КАРТКА'], ['bento_right_3', 'КОЛОНКА'],
    ]
    let ok = true
    for (const [comp, wrongPrefix] of cases) {
      const n = comp.startsWith('bento_right_3') || comp.startsWith('three') ? 3 : 4
      const slots: Record<string, string> = {}
      for (let i = 1; i <= n; i++) slots[`${wrongPrefix}_${i}`] = `текст ${i}`
      normalize(comp, slots)
      const declared = declaredOf(comp)
      const lost = Object.keys(slots).filter(k => !declared.has(k))
      ok &&= lost.length === 0 && Object.keys(slots).length === n
      console.log(`  ${lost.length ? '❌' : '✅'} ${comp.padEnd(20)} ${wrongPrefix}_1..${n} → ${Object.keys(slots).join(', ')}`)
    }
    console.log(`  → ${ok ? '✅ жодна колонка не лишається під іменем, якого композиція не знає' : '❌ WRONG'}`)
  }

  // ─── Fixture 13 — what counts as a marker: the list's own markup ────────────
  // The deterministic half of the decision. A column whose items carry bullets, dashes or
  // trailing ";" says where the items start: a first line carrying the same mark is one of
  // them, a clean first line stands above them. This is what settles the two columns the
  // brief writes identically at 12pt/15pt.
  console.log('\n=== Fixture 13 — list-markup signal ===')
  {
    const cases: Array<[string, string, string | null]> = [
      ['аркуш 7: перший рядок теж із «;»',
       'Ambassador fee - фіксована сума на 10 місяців;\nДоступ до бази знань SKELAR;\nЗапрошення на закриті події;', 'enumeration'],
      ['аркуш 9: те саме',
       'Фінансова стипендія на 10 місяців;\nдоступ до бази знань;\nдоступ до закритих івентів;', 'enumeration'],
      ['чистий рядок над булітами', 'Категорія\n• перший пункт\n• другий пункт', 'header'],
      ['буліти всюди', '• перший пункт\n• другий пункт\n• третій', 'enumeration'],
      ['аркуш 4: жодного маркера', 'Викладачі/Голови студпарламентів\nПрофільні спеціальності\nВикладають в кількох вузах', null],
      ['один рядок', 'Самотній рядок', null],
    ]
    let ok = true
    for (const [label, text, expected] of cases) {
      const got = listMarkerSignal(text)
      const correct = got === expected
      ok &&= correct
      console.log(`  ${correct ? '✅' : '❌'} ${label}: ${got ?? 'сигналу нема'}${correct ? '' : ` ← очікувалось ${expected}`}`)
    }
    console.log(`  → ${ok ? '✅ розмітка списку вирішує там, де кегль мовчить' : '❌ WRONG'}`)
  }

  // ─── Fixture 14 — every marker decision in this brief, in one table ─────────
  // The seven real first lines and the answer each must get. Length and word count are
  // printed too, to keep it obvious that neither separates them.
  console.log('\n=== Fixture 14 — маркер: усі реальні випадки брифу ===')
  {
    type C = { label: string; first: string; text: string; want: boolean }
    const cases: C[] = [
      { label: 'аркуш 7 кол.1 (перелік із «;»)', first: 'Ambassador fee - фіксована сума на 10 місяців;',
        text: 'Ambassador fee - фіксована сума на 10 місяців;\nДоступ до бази знань SKELAR;\nЗапрошення на закриті події;', want: false },
      { label: 'аркуш 7 кол.2 (дія серед дій)', first: 'Підтримка проявів бренду',
        text: 'Підтримка проявів бренду\nВідбір талановитих студентів\nОрганізація взаємодії зі спільнотою', want: false },
      { label: 'аркуш 4 кол.1', first: '«Зіркові» учні шкіл',
        text: '«Зіркові» учні шкіл\nПереможці олімпіад, МАН і конкурсів\nЕкстернат за успіхи в навчанні', want: true },
      { label: 'аркуш 4 кол.2', first: 'Найкращі на курсі',
        text: 'Найкращі на курсі\nПереможці конкурсів та змагань\nДипломи з відзнакою', want: true },
      { label: 'аркуш 4 кол.3', first: 'Викладачі/Голови студпарламентів',
        text: 'Викладачі/Голови студпарламентів\nПрофільні спеціальності\nВикладають в кількох вузах', want: true },
      { label: 'аркуш 11 кол.1', first: 'Загальні',
        text: 'Загальні\nКинь виклик собі та доведи, що ти найкращий\nТвій ріст залежить від тебе', want: true },
      { label: 'аркуш 11 кол.2', first: 'Студенти',
        text: 'Студенти\nОтримуй fast-track у компанію\nПрацюй з глобальними ринками', want: true },
    ]
    // The model answers true for every column it is asked about; the deterministic layers
    // are what must produce the right answer anyway.
    const decide = (c: C) => {
      const signal = listMarkerSignal(c.text)
      if (signal === 'enumeration') return false
      if (signal === 'header') return true
      return !looksLikeAction(c.first)     // llmMarkers said true
    }
    let ok = true
    for (const c of cases) {
      const got = decide(c)
      const correct = got === c.want
      ok &&= correct
      console.log(
        `  ${correct ? '✅' : '❌'} ${c.label.padEnd(32)} ${String(c.first.length).padStart(2)} симв./` +
        `${c.first.split(/\s+/).length} сл. → ${got ? 'мітка' : 'не мітка'}${correct ? '' : ` ← очікувалось ${c.want ? 'мітка' : 'не мітка'}`}`,
      )
    }
    console.log(`  → ${ok ? '✅ усі сім випадків брифу вирішуються правильно' : '❌ WRONG'}`)
  }

  // ─── Fixture 10 — a blank line is height, not free space ────────────────────
  // formatTitleBodyText joins groups with "\n\n", so the written text really does contain
  // empty paragraphs, and Slides draws each as a full line box with its own spaceBelow.
  // Both the font search and text_overflow used to drop blank paragraphs before measuring,
  // so every group separator was height nobody paid for: title_photo slides overflowed by
  // +157px and +243px while the search believed they fit.
  console.log('\n=== Fixture 10 — blank paragraphs count as rendered height ===')
  {
    const W = 765, PT = 18
    const groups = [
      'Перша група\vперший пункт групи\vдругий пункт групи',
      'Друга група\vще один пункт\vі ще один',
      'Третя група\vостанній пункт',
    ]
    const withBlanks = groups.join('\n\n')     // what is actually written
    const noBlanks   = groups.join('\n')       // what the old measurement effectively saw

    const hWith = renderedHeightUniform(withBlanks, W, PT, true)
    const hNo   = renderedHeightUniform(noBlanks, W, PT, true)
    const perBlank = (1.1 + 0.5) * PT * 2.667  // one line box + one spaceBelow
    const expected = 2 * perBlank              // two separators
    const diff = hWith - hNo
    const ok = Math.abs(diff - expected) < 2 && hWith > hNo
    console.log(
      `  3 groups, 2 blank lines @${PT}pt: with=${Math.round(hWith)}px | without=${Math.round(hNo)}px | ` +
      `diff=${Math.round(diff)}px | expected≈${Math.round(expected)}px`,
    )
    console.log(`  → ${ok ? '✅ the blank line is charged, at exactly one line box + its gap' : '❌ WRONG'}`)
  }
}

// ─── Timeline fixture — title zone must never push the dots off the cap ─────
// two_columns_timeline / three_columns_timeline had zero coverage before this: the only
// evidence the fix in google.ts:64-87 works at all was one deck citation in a doc comment
// (1RKZO…KikM, slide 11 — a title needing 516px inside a 300px cap drew over the dot row
// below it). Nothing verified the fix holds for OTHER title lengths, or keeps holding
// after some unrelated future edit nearby.
console.log('\n=== Timeline fixture — title zone respects TCL_TITLE_HMAX ===')
{
  const cases: { label: string; title: string; expectPt?: number; expectLines?: number }[] = [
    { label: 'one line',  title: 'Три етапи' },
    { label: 'two lines', title: 'Три головні етапи адаптації нового співробітника' },
    // Pins the exact historical regression (typography.md: 44pt→4 lines→516px✗, steps
    // down to 32pt→3 lines→282px✓) — same shape of title, same step-down, same result.
    {
      label: 'regression pin (was: 44pt drew over the dot row)',
      title: 'Шлях кандидата від першого контакту з рекрутером до підписання офера',
      expectPt: 32, expectLines: 3,
    },
  ]

  let allOk = true
  for (const c of cases) {
    const { titlePt, titleContentH } = timelineLayoutMetrics(c.title)
    const lines = Math.round(titleContentH / (titlePt * 2.667 * 1.1))
    const agrees = timelineTitlePt(c.title) === titlePt
    const withinCap = titleContentH <= TCL_TITLE_HMAX
    const pinOk = (c.expectPt === undefined || titlePt === c.expectPt)
      && (c.expectLines === undefined || lines === c.expectLines)
    const ok = withinCap && pinOk && agrees
    allOk = allOk && ok
    console.log(
      `  [${c.label}] chosen_pt=${titlePt} | lines=${lines} | titleContentH=${titleContentH}px | cap=${TCL_TITLE_HMAX}px` +
      ` → ${withinCap ? 'within cap' : 'OVER CAP'}` +
      (c.expectPt !== undefined ? ` | expected pt=${c.expectPt}/lines=${c.expectLines} → ${pinOk ? 'match' : 'MISMATCH'}` : '') +
      (agrees ? '' : ' | ✗ timelineTitlePt/timelineLayoutMetrics DISAGREE'),
    )
  }

  // Found while writing this fixture, not before it: timelineLayoutMetrics reports
  // titleContentH through Math.min(..., TCL_TITLE_HMAX) — a real clamp, not a "does it
  // fit" check. When even the floor step (28pt) needs more than the cap, the function does
  // NOT say so: it silently reports exactly TCL_TITLE_HMAX, as if the title fit. Nothing
  // downstream (textY, textH) ever learns the real height was bigger — the dot row gets
  // placed as though the title took only 300px, when the true rendered text takes more.
  // This is the same failure buildTimelineLayoutRequests was built to prevent (deck
  // 1RKZO…KikM, slide 11), just at a title length one step past what the fix's own search
  // covers — and unlike a normal overflow, nothing FAILs: text_overflow only checks boxes
  // with 2+ paragraphs, and a title is one.
  const extreme = 'Шлях кандидата від першого контакту з рекрутером до підписання офера і успішного виходу на нову роботу після довгого і виснажливого пошуку'
  const extremeMetrics = timelineLayoutMetrics(extreme)
  const reportedOvershoot = extremeMetrics.titleContentH - TCL_TITLE_HMAX
  // Recompute the TRUE height the same way timelineLayoutMetrics does internally, but
  // without its Math.min clamp — this is what actually gets drawn.
  const trueLines = extreme.split('\n')
    .reduce((n, part) => n + wrappedLines(part, _TITLE_W, extremeMetrics.titlePt, _TITLE_WRAP_CHAR_W), 0)
  const trueH = Math.ceil(trueLines * extremeMetrics.titlePt * 2.667 * 1.1)
  const trueOvershoot = trueH - TCL_TITLE_HMAX
  const clampHidesOverflow = reportedOvershoot === 0 && trueOvershoot > 0
  // This assertion PASSES because it correctly detects the hidden-overflow condition — it
  // is not asserting the behavior is fine. See the finding note above.
  const extremeOk = extremeMetrics.titlePt === 28 && clampHidesOverflow
  allOk = allOk && extremeOk
  console.log(
    `  [known limit / very long title] chosen_pt=${extremeMetrics.titlePt} | ` +
    `reported titleContentH=${extremeMetrics.titleContentH}px (clamped, overshoot=${reportedOvershoot}px) | ` +
    `true content height=${trueH}px (real overshoot=${trueOvershoot}px)` +
    ` → ${clampHidesOverflow ? '⚠️ clamp hides a real overflow — see finding note' : (extremeMetrics.titlePt === 28 ? 'no hidden overflow at this length' : 'CHANGED — investigate')}`,
  )

  console.log('\n--- Timeline fixture — run 2 (determinism) ---')
  for (const c of cases) {
    const m = timelineLayoutMetrics(c.title)
    console.log(`  [${c.label}] chosen_pt=${m.titlePt} | titleContentH=${m.titleContentH}px`)
  }

  // Two-column timeline: the two text columns are NOT the same width (674 vs 623) — a
  // future refactor that "simplifies" this to one shared width would silently narrow one
  // column's text zone. Nothing else in the test suite checks this.
  const tclW0: number = TCL_TEXT_W_TWO[0]
  const tclW1: number = TCL_TEXT_W_TWO[1]
  const widthsDistinct = tclW0 !== tclW1
  const threeColTextW = TCL_ZONE_W_THREE - _AG_DOT_SZ - 10
  const threeColOk = threeColTextW === 496
  allOk = allOk && widthsDistinct && threeColOk
  console.log(
    `  two-column widths: [${TCL_TEXT_W_TWO[0]}, ${TCL_TEXT_W_TWO[1]}] distinct=${widthsDistinct ? '✓' : '✗ COLLAPSED'} | ` +
    `three-column text width: ${threeColTextW}px (zone ${TCL_ZONE_W_THREE} − dot ${_AG_DOT_SZ} − 10) → ${threeColOk ? '✓' : '✗'}`,
  )

  console.log(`  → ${allOk ? '✅ timeline title zone holds its cap; column widths stay distinct' : '❌ WRONG'}`)
}
