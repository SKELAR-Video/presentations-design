import {
  BODY_MAX_PT, stripsTrailingPeriod, pickBentoCardPts, computeKpiAdaptive,
} from '../lib/google'

// Дві правки з одного дня, обидві про те, як тіло слайда виглядає:
//   1. крапка в кінці картки/колонки/підпису зрізається, навіть якщо вона є в ТЗ;
//   2. тіло не буває більшим за BODY_MAX_PT, а підпис KPI більше не прибитий до 14pt.
//
// Перевіряються ЧИСЛА, які повертають самі функції рендеру, а не наміри коду.
// Живий дек однаково лишається джерелом правди — це лише сітка перед генерацією.

let failed = 0

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`      ${JSON.stringify(got)}`)
  if (!ok) console.log(`      ✗ очікували: ${JSON.stringify(want)}`)
}

function checkTrue(name: string, ok: boolean, detail: string) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`      ${detail}`)
}

// ── 1. Кому зрізаємо крапку ─────────────────────────────────────────────────
console.log('\n── крапка в кінці ──')

check('заголовок',                stripsTrailingPeriod('kpi_cards', 'ЗАГОЛОВОК'),          true)
check('бенто-картка',             stripsTrailingPeriod('bento_right_2', 'КАРТКА_1'),       true)
check('колонка',                  stripsTrailingPeriod('two_columns', 'КОЛОНКА_1'),        true)
check('рядок rows_dot',           stripsTrailingPeriod('rows_dot', 'ПУНКТ_2'),             true)
check('підпис KPI — слайд 8',     stripsTrailingPeriod('kpi_cards', 'КАРТКА_1_ПІДПИС'),    true)
check('значення KPI',             stripsTrailingPeriod('kpi_cards', 'КАРТКА_2_ЗНАЧЕННЯ'),  true)

// Проза лишає крапку: там вона закриває останнє з кількох справжніх речень.
check('тіло title_body',          stripsTrailingPeriod('title_body', 'ТЕКСТ'),             false)
check('тіло bento_right_2',       stripsTrailingPeriod('bento_right_2', 'ТЕКСТ'),          false)
check('підзаголовок section',     stripsTrailingPeriod('section', 'ПІДЗАГОЛОВОК'),         false)

// ── 2. Стеля 24pt на всіх композиціях з картками ────────────────────────────
console.log('\n── стеля тіла ──')

// Короткий текст бере максимум, який композиція взагалі дозволяє, — тому це і є
// прямий вимір стелі, а не здогад.
const SHORT = 'Ігри'
const COMPS: Array<[string, string[]]> = [
  ['two_columns',            ['КОЛОНКА_1', 'КОЛОНКА_2']],
  ['two_columns_plain',      ['КОЛОНКА_1', 'КОЛОНКА_2']],
  ['two_columns_labeled',    ['КОЛОНКА_1', 'КОЛОНКА_2']],
  ['two_columns_timeline',   ['КОЛОНКА_1', 'КОЛОНКА_2']],
  ['three_columns',          ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3']],
  ['three_columns_timeline', ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3']],
  ['bento_right_2',          ['КАРТКА_1', 'КАРТКА_2']],
  ['bento_right_3',          ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3']],
  ['bento_right_2x2',        ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4']],
  ['four_columns',           ['КАРТКА_1', 'КАРТКА_2', 'КАРТКА_3', 'КАРТКА_4']],
  ['rows_dot',               ['ПУНКТ_1', 'ПУНКТ_2']],
]

for (const [compId, tokens] of COMPS) {
  const slots: Record<string, string> = { ЗАГОЛОВОК: 'Три категорії, що ведуть за доходом' }
  for (const t of tokens) slots[t] = SHORT
  const pts = pickBentoCardPts(compId, slots)
  const max = pts ? Math.max(...Object.values(pts)) : -1
  checkTrue(`${compId} ≤ ${BODY_MAX_PT}pt`, max > 0 && max <= BODY_MAX_PT, `${max}pt`)
}

// ── 3. KPI-підпис: рос­те, поки картка влазить ───────────────────────────────
console.log('\n── підпис KPI ──')

// Контент слайда 8 із дека 1XfcL… — саме той, де підпис вийшов 14pt при вільній картці.
const kpi = computeKpiAdaptive({
  ЗАГОЛОВОК: 'App Store у цифрах',
  КАРТКА_1_ЗНАЧЕННЯ: '2M+',
  КАРТКА_1_ПІДПИС:   'Застосунків доступно користувачам',
  КАРТКА_2_ЗНАЧЕННЯ: '20+',
  КАРТКА_2_ПІДПИС:   'Офіційних категорій у магазині',
}, 180, 680, 30)

check('значення лишається 48pt', kpi.valPt, 48)
checkTrue('підпис більший за старі 14pt', kpi.lblPt > 14, `${kpi.lblPt}pt`)
checkTrue(`підпис ≤ ${BODY_MAX_PT}pt`,     kpi.lblPt <= BODY_MAX_PT, `${kpi.lblPt}pt`)
checkTrue('підпис нижчий за значення',     kpi.lblPt <= Math.floor(kpi.valPt * 0.8), `${kpi.lblPt}pt проти ${kpi.valPt}pt`)
checkTrue('картка в межах слайда',         kpi.kCY + kpi.cardH === 980, `низ ${kpi.kCY + kpi.cardH}`)
checkTrue('вміст влазить у картку',
  kpi.valH + kpi.lblH + 2 * 30 + 2 * 30 <= kpi.cardH,
  `вміст ${kpi.valH + kpi.lblH + 120} ≤ картка ${kpi.cardH}`)

// Довгий підпис не має розпирати картку за межі слайда.
const kpiLong = computeKpiAdaptive({
  ЗАГОЛОВОК: 'App Store у цифрах',
  КАРТКА_1_ЗНАЧЕННЯ: '2M+',
  КАРТКА_1_ПІДПИС:   'Застосунків доступно користувачам у понад 175 країнах світу, і кожен із них проходить ручну перевірку перед публікацією',
  КАРТКА_2_ЗНАЧЕННЯ: '20+',
  КАРТКА_2_ПІДПИС:   'Офіційних категорій у магазині',
}, 180, 680, 30)
checkTrue('довгий підпис — картка все одно в межах',
  kpiLong.kCY >= 100 && kpiLong.kCY + kpiLong.cardH === 980,
  `kCY=${kpiLong.kCY}, низ=${kpiLong.kCY + kpiLong.cardH}, підпис=${kpiLong.lblPt}pt`)

console.log(`\n${failed === 0 ? '✅ Усі перевірки зелені' : `❌ ${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
