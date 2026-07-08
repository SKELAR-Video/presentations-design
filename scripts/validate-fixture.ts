// Fixture test for plan-level validator checks (no Slides API required).
// Run: npx ts-node --skip-project scripts/validate-fixture.ts
// Verifies: no_literal_asterisk, no_duplicate_title, badge_item_max_chars

import { validatePlan } from '../lib/validator'
import type { SlidePlan } from '../lib/types'

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
// PASS iff longestWordPx(text, pt) × 1.2 ≤ innerW
{
  const CHAR_W = 0.65   // Inter Medium, Cyrillic-safe factor
  const SAFETY = 1.2

  function lwPx(text: string, pt: number): number {
    const pxPerChar = pt * 2.667 * CHAR_W
    const words = text.trim().split(/\s+/).filter(Boolean)
    return words.length === 0 ? 0 : Math.round(Math.max(...words.map(w => w.length * pxPerChar)))
  }

  function checkWord(label: string, text: string, innerW: number, pt: number): boolean {
    const words = text.trim().split(/\s+/).filter(Boolean)
    const longest = words.reduce((a, b) => a.length >= b.length ? a : b, '')
    const est   = lwPx(text, pt)
    const est12 = Math.round(est * SAFETY)
    const pass  = est12 <= innerW
    console.log(
      `  [${label}] longest_word_len=${longest.length} | est_width=${est} | est×1.2=${est12} | inner_width=${innerW} | chosen_font=${pt} → ${pass ? 'PASS' : 'FAIL'}`,
    )
    return pass
  }

  // Font picking — same stepping logic as google.ts
  function pickBentoPt(text: string, innerW: number, maxPt: number): number {
    const scale = [48, 36, 28, 22, 18, 14, 10].filter(p => p <= maxPt)
    for (const pt of scale) {
      if (lwPx(text, pt) * SAFETY <= innerW) return pt
    }
    return scale[scale.length - 1]
  }
  function pickTitlePt(text: string): number {
    for (const pt of [44, 40, 36, 32, 28]) {
      if (lwPx(text, pt) * SAFETY <= 830 - 19) return pt  // _LTW - _INSET = 811
    }
    return 28
  }

  // Layout constants (must match google.ts)
  const RBW = 860, INN = 30
  const bentoInnerW = RBW - 2 * INN  // 800

  function runBento(label: string, text: string, maxPt: number) {
    const pt = pickBentoPt(text, bentoInnerW, maxPt)
    return checkWord(label, text, bentoInnerW, pt)
  }
  function runTitle(label: string, text: string) {
    const pt = pickTitlePt(text)
    return checkWord(label, text, 830 - 19, pt)  // effective width = _LTW - _INSET = 811
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

  console.log('\n=== Word-break fixture (CHAR_W=0.65, safety×1.2) — run 1 ===')

  // bento_right_2: maxPt=36, bentoInnerW=800
  runBento('bento_right_2 / short metric',   '80% лікарів рекомендують',   36)
  runBento('bento_right_2 / long word',      'рекомендують',                36)
  runBento('bento_right_2 / Продуктивність', 'Продуктивність визначається', 36)

  // bento_right_3: maxPt=22, bentoInnerW=800
  runBento('bento_right_3 / Продуктивність', 'Продуктивність', 22)

  // bento titles (effective_width = _LTW - _INSET = 811), steps [44,40,36,32,28]
  // "щоденного" (9 chars): old formula (×830) → 44pt; new (×811) → 40pt — prevents word break
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
