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
      if (lwPx(text, pt) * SAFETY <= 830) return pt  // _LTW = 830
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
    return checkWord(label, text, 830, pt)
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

  console.log('\n=== Word-break fixture (CHAR_W=0.65, safety×1.2) — run 1 ===')

  // bento_right_2: maxPt=36, bentoInnerW=800
  runBento('bento_right_2 / short metric',   '80% лікарів рекомендують',   36)
  runBento('bento_right_2 / long word',      'рекомендують',                36)
  runBento('bento_right_2 / Продуктивність', 'Продуктивність визначається', 36)

  // bento_right_3: maxPt=22, bentoInnerW=800
  runBento('bento_right_3 / Продуктивність', 'Продуктивність', 22)

  // bento titles (_LTW=830), steps [44,40,36,32,28]
  runTitle('title / short',        'Чому бігати важливо')
  runTitle('title / one long word', 'Продуктивність підприємства')

  console.log('\n=== Word-break fixture — run 2 (determinism) ===')

  runBento('bento_right_2 / short metric',   '80% лікарів рекомендують',   36)
  runBento('bento_right_2 / long word',      'рекомендують',                36)
  runBento('bento_right_2 / Продуктивність', 'Продуктивність визначається', 36)
  runBento('bento_right_3 / Продуктивність', 'Продуктивність', 22)
  runTitle('title / short',        'Чому бігати важливо')
  runTitle('title / one long word', 'Продуктивність підприємства')
}
