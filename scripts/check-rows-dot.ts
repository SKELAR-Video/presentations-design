import {
  rowsDotLayout, titlePtFor, pickBentoCardPts,
  _RD_DOT_SZ, _RD_TEXT_X, _RD_TEXT_W, _RD_BOTTOM, _TITLE_W,
} from '../lib/google'
import { getComposition } from '../lib/compositions'

// rows_dot — the numbers, not the intent. The composition draws 2 or 3 full-width rows,
// each with a red dot; where those rows land is the whole design, so this asserts the
// coordinates the layout actually returns rather than that the code "looks right".
//
// The three-row case is the geometry the user drew by hand and approved. Everything else
// here is a consequence of it: the two-row case centres in the same band, and a tall
// heading may push the band down but never off the page.

const PAD = 100
const H   = 1080
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

// ── The drawn layout, reproduced exactly ────────────────────────────────────
const SHORT = 'Три речі, які вирішують'
const pt3 = titlePtFor('rows_dot', SHORT)
check('заголовок короткий → 44pt', pt3, 44)

const three = rowsDotLayout(3, SHORT, pt3)
check('3 рядки — координати з макета', three.tops, [474, 662, 850])
check('висота рядка', three.rowH, 116)
check('крок між рядками', [three.tops[1] - three.tops[0], three.tops[2] - three.tops[1]], [188, 188])
checkTrue('низ останнього рядка не заходить у мертву зону',
  three.tops[2] + three.rowH <= H - PAD,
  `${three.tops[2] + three.rowH} ≤ ${H - PAD}`)

// ── Two rows: centred in the same band, not left hanging ────────────────────
const two = rowsDotLayout(2, SHORT, pt3)
check('2 рядки — центровані у тій самій смузі', two.tops, [568, 756])
checkTrue('центр блоку з 2 рядків = центр смуги з 3',
  (two.tops[0] + two.tops[1] + two.rowH) / 2 === (474 + _RD_BOTTOM) / 2,
  `блок ${(two.tops[0] + two.tops[1] + two.rowH) / 2} | смуга ${(474 + _RD_BOTTOM) / 2}`)
checkTrue('крок між двома рядками той самий',
  two.tops[1] - two.tops[0] === 188,
  `${two.tops[1] - two.tops[0]}`)

// ── Horizontal grid: everything left-aligned on the dead zone ───────────────
check('крапка стоїть на мертвій зоні', PAD, 100)
check('текст починається після крапки + 52px', _RD_TEXT_X, PAD + _RD_DOT_SZ + 52)
check('правий край рядка = правий край заголовка', _RD_TEXT_X + _RD_TEXT_W, PAD + _TITLE_W)

// ── A tall heading pushes the rows down, never off the slide ────────────────
const LONG = 'Чому саме зараз варто перебудувати весь процес найму і що це дасть команді вже цього кварталу'
const ptL  = titlePtFor('rows_dot', LONG)
const tall = rowsDotLayout(3, LONG, ptL)
checkTrue('довгий заголовок: рядки нижчі за короткий випадок',
  tall.tops[0] >= three.tops[0],
  `${tall.tops[0]} ≥ ${three.tops[0]} (заголовок ${ptL}pt)`)
checkTrue('довгий заголовок: останній рядок усе одно на слайді',
  tall.tops[2] + tall.rowH <= H - PAD,
  `${tall.tops[2] + tall.rowH} ≤ ${H - PAD}`)

// ── Font: what the 116px row is actually worth ──────────────────────────────
// The row's height comes from the drawing, and the drawing is two lines of 18pt. So 22pt
// is reachable only by a row that stays on ONE line; anything that wraps steps down. That
// is the intended trade (the row keeps its place on the slide, the font gives way) — this
// pins both halves of it so a later change to _RD_ROW_H cannot move one without the other.
const SENTENCE = 'Кандидати відповідають швидше, коли перший лист приходить у день заявки'
const pts = pickBentoCardPts('rows_dot', {
  'ЗАГОЛОВОК': SHORT, 'ПУНКТ_1': SENTENCE, 'ПУНКТ_2': SENTENCE, 'ПУНКТ_3': SENTENCE,
})
check('три речення по ~70 символів (два рядки) → 18pt', pts?.['ПУНКТ_1'], 18)

const ptsShort = pickBentoCardPts('rows_dot', {
  'ЗАГОЛОВОК': SHORT, 'ПУНКТ_1': 'Швидший перший контакт', 'ПУНКТ_2': 'Менше етапів',
})
check('короткі тези в один рядок → стеля 22pt', ptsShort?.['ПУНКТ_1'], 22)
checkTrue('кегль однаковий у всіх рядках',
  pts?.['ПУНКТ_1'] === pts?.['ПУНКТ_2'] && pts?.['ПУНКТ_2'] === pts?.['ПУНКТ_3'],
  `${pts?.['ПУНКТ_1']} / ${pts?.['ПУНКТ_2']} / ${pts?.['ПУНКТ_3']}`)

// A row that fills its two lines must step DOWN, never overflow the 116px box.
const LONGROW = 'Коли перший контакт із кандидатом відбувається в день заявки, конверсія у скрин зростає майже вдвічі, а середній час до офера скорочується на тиждень і більше'
const ptsLong = pickBentoCardPts('rows_dot', {
  'ЗАГОЛОВОК': SHORT, 'ПУНКТ_1': LONGROW, 'ПУНКТ_2': SENTENCE,
})
checkTrue('довгий рядок опускає кегль, а не вилазить із боксу',
  (ptsLong?.['ПУНКТ_1'] ?? 99) < 22,
  `${ptsLong?.['ПУНКТ_1']}pt (стеля 22)`)

// ── The slot contract the mapper is told about ──────────────────────────────
const comp = getComposition('rows_dot')
check('слоти композиції', comp?.slots.map(s => s.name),
  ['ЗАГОЛОВОК', 'ПУНКТ_1', 'ПУНКТ_2', 'ПУНКТ_3'])
check('третій пункт опціональний', comp?.slots.map(s => !!s.optional),
  [false, false, false, true])

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
