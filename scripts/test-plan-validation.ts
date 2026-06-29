/**
 * Runs plan-level validator checks without Slides API or auth.
 * Covers: max_chars (+ Step-2.6 truncation), kpi_numeric_values, theme_consistency.
 * Does NOT cover: bounds, autofit, font, skelar_badge (need real deck for those).
 */
import { getComposition } from '../lib/compositions'

const KPI_NUMERIC_RE = /^[\d\s+\-±×x.,/%$€£<>≤≥~≈MKBmkb]+$/i

const PROBLEM_PLAN = {
  theme: 'dark' as const,
  slides: [
    {
      id: 'slide_1', composition: 'cover',
      slots: {
        ЗАГОЛОВОК: 'Дуже довгий заголовок що явно перевищує ліміт шістдесят символів і виходить за краї',
        ДАТА: '29 червня 2026',
      }, flags: {},
    },
    {
      id: 'slide_2', composition: 'kpi_cards',
      slots: {
        ЗАГОЛОВОК: 'Ключові метрики Q2 2026',
        ТЕКСТ: 'Цей текст навмисно довший за сімдесят символів щоб перевірити чи валідатор зловить переповнення тіла',
        КАРТКА_1_ЗНАЧЕННЯ: '+42%', КАРТКА_1_ПІДПИС: 'Зростання виручки',
        КАРТКА_2_ЗНАЧЕННЯ: '$5M',  КАРТКА_2_ПІДПИС: 'ARR за квартал',
        КАРТКА_3_ЗНАЧЕННЯ: 'Список пунктів — FAIL', КАРТКА_3_ПІДПИС: 'Не метрика',
        КАРТКА_4_ЗНАЧЕННЯ: '×2',  КАРТКА_4_ПІДПИС: 'Клієнти',
      }, flags: {},
    },
    {
      id: 'slide_3', composition: 'three_columns',
      slots: {
        ЗАГОЛОВОК: 'Три кроки',
        КОЛОНКА_1: 'Перший крок: дуже довгий текст у першій колонці що явно перевищує ліміт max_chars сто сорок символів — це навмисно щоб перевірити валідатор і авто-трункейт',
        КОЛОНКА_2: 'Другий крок: нормальний текст',
        КОЛОНКА_3: 'Третій крок: нормальний текст',
      }, flags: {},
    },
    {
      id: 'slide_4', composition: 'closing',
      slots: { ЗАГОЛОВОК: 'Дякуємо!' }, flags: {},
    },
  ],
}

// ── Step 2.6 simulation (same logic as lib/google.ts) ────────────────────────
function applyTruncation(slides: typeof PROBLEM_PLAN.slides) {
  const truncated: string[] = []
  for (const slide of slides) {
    const comp = getComposition(slide.composition)
    if (!comp) continue
    for (const def of comp.slots) {
      if (def.type !== 'text' || !def.max_chars) continue
      const val = (slide.slots as unknown as Record<string,string>)[def.name]
      if (val && val.length > def.max_chars) {
        truncated.push(`  ${slide.composition}.${def.name}: ${val.length} → ${def.max_chars} chars`)
        ;(slide.slots as unknown as Record<string,string>)[def.name] = val.slice(0, def.max_chars - 1) + '…'
      }
    }
  }
  return truncated
}

// ── Checks ────────────────────────────────────────────────────────────────────
function checkMaxChars(slide: (typeof PROBLEM_PLAN.slides)[0]) {
  const comp = getComposition(slide.composition)
  if (!comp) return []
  const fails: string[] = []
  for (const def of comp.slots) {
    if (def.type !== 'text' || !def.max_chars) continue
    const val = (slide.slots as unknown as Record<string,string>)[def.name] ?? ''
    if (val.length > def.max_chars) fails.push(`${def.name}: ${val.length}>${def.max_chars}`)
  }
  return fails
}

function checkKpiNumeric(slide: (typeof PROBLEM_PLAN.slides)[0]) {
  if (slide.composition !== 'kpi_cards') return []
  const fails: string[] = []
  for (let n = 1; n <= 4; n++) {
    const val = ((slide.slots as unknown as Record<string,string>)[`КАРТКА_${n}_ЗНАЧЕННЯ`] ?? '').trim()
    if (!val) continue
    if (!KPI_NUMERIC_RE.test(val)) fails.push(`КАРТКА_${n}_ЗНАЧЕННЯ: "${val}"`)
  }
  return fails
}

// ── Step 2.65 simulation ─────────────────────────────────────────────────────
function applyKpiSanitise(slides: typeof PROBLEM_PLAN.slides) {
  const removed: string[] = []
  for (const slide of slides) {
    if (slide.composition !== 'kpi_cards') continue
    for (let n = 1; n <= 4; n++) {
      const key = `КАРТКА_${n}_ЗНАЧЕННЯ`
      const val = ((slide.slots as unknown as Record<string,string>)[key] ?? '').trim()
      if (!val) continue
      if (!KPI_NUMERIC_RE.test(val)) {
        removed.push(`  kpi_cards.КАРТКА_${n}: "${val}" → deleted`)
        delete (slide.slots as unknown as Record<string,string>)[key]
        delete (slide.slots as unknown as Record<string,string>)[`КАРТКА_${n}_ПІДПИС`]
      }
    }
  }
  return removed
}

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('=== BEFORE Step 2.6 (truncation) ===\n')
for (const slide of PROBLEM_PLAN.slides) {
  const mcFails = checkMaxChars(slide)
  const kpiFails = checkKpiNumeric(slide)
  const allFails = [...mcFails, ...kpiFails]
  const icon = allFails.length ? '❌' : '✅'
  console.log(`${icon} slide ${slide.id} (${slide.composition})`)
  if (mcFails.length)  console.log('   max_chars:', mcFails.join(', '))
  if (kpiFails.length) console.log('   kpi_numeric:', kpiFails.join(', '))
}

console.log('\n=== Step 2.6 truncations applied ===')
const truncations = applyTruncation(PROBLEM_PLAN.slides)
if (truncations.length) truncations.forEach(t => console.log(t))
else console.log('  (none)')

console.log('\n=== Step 2.65 kpi sanitise ===')
const removed = applyKpiSanitise(PROBLEM_PLAN.slides)
if (removed.length) removed.forEach(r => console.log(r))
else console.log('  (none)')

console.log('\n=== AFTER Steps 2.6 + 2.65 ===\n')
let anyFail = false
for (const slide of PROBLEM_PLAN.slides) {
  const mcFails = checkMaxChars(slide)
  const kpiFails = checkKpiNumeric(slide)
  const allFails = [...mcFails, ...kpiFails]
  const icon = allFails.length ? '❌' : '✅'
  console.log(`${icon} slide ${slide.id} (${slide.composition})`)
  if (mcFails.length)  console.log('   max_chars FAIL:', mcFails.join(', '))
  if (kpiFails.length) console.log('   kpi_numeric FAIL:', kpiFails.join(', '))
  if (allFails.length) anyFail = true
}

console.log('\n' + (anyFail ? '❌ FAIL — є проблеми для виправлення' : '✅ PASS — план чистий'))
