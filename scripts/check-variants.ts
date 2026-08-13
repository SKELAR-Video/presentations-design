import { expandPlanWithVariants } from '../lib/google'
import { getComposition } from '../lib/compositions'
import type { Slide, SlidePlan } from '../lib/types'

// Варіант дизайну — це той самий контент, намальований інакше. Якщо варіант не вміщає
// весь текст аркуша, він не варіант: у деку з'являються чотири плитки «Варіант дизайну N»,
// з яких лише одна несе абзац із ТЗ, і людина обирає між ними, не бачачи, що три з чотирьох
// коштують їй тексту.
//
// Саме це й ловить перевірка. Раніше слот, якого немає в цільовій композиції, вважався
// «свідомим структурним дропом» і варіант проходив: two_columns / two_columns_plain /
// two_columns_timeline не мають ТЕКСТ, тож абзац зникав мовчки.
//
// Останній блок — негативний: перевірка має вміти падати. Він відтворює стару логіку
// (дроп дозволено) і стверджує, що на цих самих даних вона дала б інший результат.

let failed = 0

function checkTrue(name: string, ok: boolean, detail: string) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`      ${detail}`)
}

function slide(over: Partial<Slide>): Slide {
  return { id: 's1', composition: 'bento_right_2', slots: {}, flags: {}, ...over }
}

function plan(s: Slide): SlidePlan {
  return { theme: 'dark', slides: [s] }
}

function comps(p: SlidePlan): string[] {
  return expandPlanWithVariants(p).expanded.slides.map(sl => sl.composition)
}

// ── Аркуш із скріншота: заголовок, абзац і дві картки з числами ──────────────
const TEXT = 'Зручні застосунки формують щоденні звички: люди відкривають улюблені ' +
  'сервіси десятки разів на день. Обрана категорія напряму впливає на утримання аудиторії.'
const withText = slide({
  composition: 'bento_right_2',
  slots: {
    ЗАГОЛОВОК: 'Чому користувачі повертаються',
    ТЕКСТ: TEXT,
    КАРТКА_1: '4.2 — середня оцінка топових застосунків',
    КАРТКА_2: '80% часу користувач проводить у 5 улюблених застосунках',
  },
})

const got = comps(plan(withText))
const noTextComps = got.filter(c => !(getComposition(c)?.slots ?? []).some(s => s.name === 'ТЕКСТ'))
checkTrue('аркуш з ТЕКСТ → жодного варіанта без слота ТЕКСТ',
  noTextComps.length === 0,
  `видано: ${got.join(', ') || '—'}${noTextComps.length ? ` | без ТЕКСТ: ${noTextComps.join(', ')}` : ''}`)

checkTrue('текст із ТЗ лишився в кожному виданому слайді',
  expandPlanWithVariants(plan(withText)).expanded.slides.every(sl =>
    Object.values(sl.slots).some(v => (v ?? '').includes(TEXT))),
  `слайдів: ${got.length}`)

// Один варіант — це не вибір: плитки не з'являються, аркуш лишається собою.
checkTrue('немає альтернатив → один слайд, композиція не змінилась',
  got.length === 1 && got[0] === 'bento_right_2',
  `видано: ${got.join(', ')}`)

// ── Той самий аркуш без ТЕКСТ: варіанти мають лишитись ───────────────────────
// Інакше правило вилікувало б хворобу, вбивши пацієнта — панель варіантів зникла б скрізь.
const noText = slide({
  composition: 'bento_right_2',
  slots: {
    ЗАГОЛОВОК: 'Чому користувачі повертаються',
    КАРТКА_1: '4.2 — середня оцінка топових застосунків',
    КАРТКА_2: '80% часу користувач проводить у 5 улюблених застосунках',
  },
})
const gotNoText = comps(plan(noText))
checkTrue('без ТЕКСТ варіанти лишаються',
  gotNoText.length > 1,
  `видано ${gotNoText.length}: ${gotNoText.join(', ')}`)

checkTrue('серед них є таймлайн і плоскі колонки',
  gotNoText.includes('two_columns_timeline') && gotNoText.includes('two_columns_plain'),
  `видано: ${gotNoText.join(', ')}`)

// ── ПІДПИС_N вливається в колонку — це не втрата ─────────────────────────────
// remapSlotsForVariant склеює «Мітка — тіло», тож слова на місці, хоч і не окремим
// значенням. Перевірка порівнює з усім текстом варіанта саме тому.
const labeled = slide({
  composition: 'two_columns_labeled',
  slots: {
    ЗАГОЛОВОК: 'Два напрями',
    ПІДПИС_1: 'Продукт',
    КОЛОНКА_1: 'Швидкість релізів і якість збірок',
    ПІДПИС_2: 'Маркетинг',
    КОЛОНКА_2: 'Вартість залучення і повернення користувачів',
  },
})
const gotLabeled = comps(plan(labeled))
checkTrue('склеєний ПІДПИС не рахується втратою — варіанти є',
  gotLabeled.length > 1,
  `видано ${gotLabeled.length}: ${gotLabeled.join(', ')}`)

// ── Негативний: стара логіка на тих самих даних дала б інше ──────────────────
// Відтворюємо дозвіл на структурний дроп і показуємо, що він пропускає композиції
// без ТЕКСТ. Якщо цей блок колись стане зеленим у сенсі «різниці немає» — перевірка
// вище перестала щось означати.
const oldWouldOffer = ['two_columns', 'two_columns_plain', 'two_columns_timeline']
  .filter(c => !(getComposition(c)?.slots ?? []).some(s => s.name === 'ТЕКСТ'))
checkTrue('негативний: стара логіка пропускала б композиції без ТЕКСТ',
  oldWouldOffer.length > 0 && got.length < 1 + oldWouldOffer.length,
  `стара віддала б ще ${oldWouldOffer.length}: ${oldWouldOffer.join(', ')} | нова видала ${got.length}`)

console.log(failed === 0 ? '\nвсі перевірки зелені' : `\n${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
