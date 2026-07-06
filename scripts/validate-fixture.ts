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

// Run each fixture twice to confirm determinism
console.log('\n--- second run (determinism check) ---')
run('Fixture 1 — run 2', fixture1)
run('Fixture 2 — run 2', fixture2)
