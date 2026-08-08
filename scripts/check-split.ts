import { splitSlide, applySplits } from '../lib/split'
import type { Slide } from '../lib/types'
import type { SlideOverload } from '../lib/validator'

// Numbers, not opinions. Each case states what must be true of the result before the
// splitter runs; a case that cannot be stated that way is not a test, it is a hope.
//
// What every split must satisfy, whatever the strategy:
//   1. no word is lost — the parts concatenated hold every line of the original
//   2. no word is invented — every line in a part came from the original
//   3. no part is empty
//   4. the heading is on every part
//   5. slot names are ones the master can place (renumbered from 1)

type Case = {
  name: string
  slide: Slide
  overload: SlideOverload
  expect: { parts: number; strategy: 'cards' | 'lines' }
}

function slide(id: string, composition: string, slots: Record<string, string>): Slide {
  return { id, composition, slots, flags: {} }
}

function overload(slots: { slot: string; needed: number; avail: number }[], slidesNeeded: number): SlideOverload {
  return {
    slideIndex: 0,
    composition: 'x',
    slidesNeeded,
    slots: slots.map(s => ({
      slot: s.slot, pt: 12, neededPx: s.needed, availPx: s.avail,
      slidesNeeded, cutPct: Math.round((1 - s.avail / s.needed) * 100),
    })),
  }
}

const CASES: Case[] = [
  {
    name: 'чотири колонки → дві по дві',
    slide: slide('s1', 'four_columns', {
      'ЗАГОЛОВОК': 'Напрямки роботи',
      'КОЛОНКА_1': 'Аналітика\nЗбір даних по ринку',
      'КОЛОНКА_2': 'Продукт\nДослідження і гіпотези',
      'КОЛОНКА_3': 'Маркетинг\nКанали залучення',
      'КОЛОНКА_4': 'Партнерства\nРобота з мережами',
    }),
    overload: overload([{ slot: 'КОЛОНКА_2', needed: 730, avail: 540 }], 2),
    expect: { parts: 2, strategy: 'cards' },
  },
  {
    name: 'один блок тексту → три частини',
    slide: slide('s2', 'title_body', {
      'ЗАГОЛОВОК': 'Що зроблено за квартал',
      'ПІДЗАГОЛОВОК': 'Коротко про головне',
      'ТЕКСТ': [
        'Запустили новий онбординг для користувачів',
        'Переписали розрахунок комісій під нові тарифи',
        'Додали двофакторну автентифікацію',
        'Скоротили час відповіді підтримки вдвічі',
        'Перевели звітність на автоматичний збір',
        'Оновили дизайн-систему до другої версії',
      ].join('\n'),
    }),
    overload: overload([{ slot: 'ТЕКСТ', needed: 1600, avail: 540 }], 3),
    expect: { parts: 3, strategy: 'lines' },
  },
  {
    name: 'нема на чому ділити — один рядок',
    slide: slide('s3', 'title_body', {
      'ЗАГОЛОВОК': 'Висновок',
      'ТЕКСТ': 'Єдине суцільне речення без жодного переносу всередині нього.',
    }),
    overload: overload([{ slot: 'ТЕКСТ', needed: 900, avail: 540 }], 2),
    expect: { parts: 0, strategy: 'lines' },
  },
]

function linesOf(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean)
}

function contentLines(s: Slide): string[] {
  return Object.entries(s.slots)
    .filter(([k]) => k !== 'ЗАГОЛОВОК')
    .flatMap(([, v]) => linesOf(v))
}

let failed = 0

for (const c of CASES) {
  const result = splitSlide(c.slide, c.overload)
  const parts = result?.slides.length ?? 0
  const problems: string[] = []

  if (parts !== c.expect.parts) {
    problems.push(`частин ${parts}, очікували ${c.expect.parts}`)
  }
  if (result && result.strategy !== c.expect.strategy) {
    problems.push(`стратегія ${result.strategy}, очікували ${c.expect.strategy}`)
  }

  if (result) {
    const before = contentLines(c.slide).sort()
    const after  = result.slides.flatMap(contentLines).sort()

    const lost    = before.filter(l => !after.includes(l))
    const invented = after.filter(l => !before.includes(l))
    if (lost.length)     problems.push(`ЗАГУБЛЕНО ${lost.length}: ${lost[0].slice(0, 30)}…`)
    if (invented.length) problems.push(`ВИГАДАНО ${invented.length}: ${invented[0].slice(0, 30)}…`)

    const empty = result.slides.filter(s => contentLines(s).length === 0)
    if (empty.length) problems.push(`порожніх частин: ${empty.length}`)

    const headless = result.slides.filter(s => !s.slots['ЗАГОЛОВОК']?.trim())
    if (headless.length) problems.push(`без заголовка: ${headless.length}`)

    const badKeys = result.slides.flatMap(s =>
      Object.keys(s.slots).filter(k => {
        const m = k.match(/_(\d+)$/)
        if (!m) return false
        const n = Number(m[1])
        const sameFamily = Object.keys(s.slots).filter(o => o.replace(/_\d+$/, '') === k.replace(/_\d+$/, ''))
        return n > sameFamily.length
      }))
    if (badKeys.length) problems.push(`слоти поза шкалою майстра: ${badKeys.join(', ')}`)
  }

  const ok = problems.length === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  console.log(`      частин: ${parts}${result ? `  стратегія: ${result.strategy}  ${result.note}` : '  (не ділиться)'}`)
  if (result) {
    result.slides.forEach((s, i) => {
      console.log(`      ${i + 1}) ${contentLines(s).length} рядків у ${Object.keys(s.slots).filter(k => k !== 'ЗАГОЛОВОК').length} слотах`)
    })
  }
  for (const p of problems) console.log(`      ✗ ${p}`)
}

// applySplits over a whole plan: order preserved, untouched slides untouched.
const plan: Slide[] = [
  slide('a', 'cover', { 'ЗАГОЛОВОК': 'Обкладинка' }),
  CASES[0].slide,
  slide('c', 'closing', { 'ЗАГОЛОВОК': 'Дякую' }),
]
const applied = applySplits(plan, [{ ...CASES[0].overload, slideIndex: 1 }], new Set([1]))
const orderOk = applied.slides[0].id === 'a' && applied.slides[applied.slides.length - 1].id === 'c'
const countOk = applied.slides.length === 4
const groupOk = applied.slides.filter(s => s.splitGroup === 'split_1').length === 2
const applyOk = orderOk && countOk && groupOk
if (!applyOk) failed++
console.log(`${applyOk ? 'PASS' : 'FAIL'}  applySplits: порядок і група`)
console.log(`      слайдів: ${applied.slides.length} (очікували 4), у групі: ${applied.slides.filter(s => s.splitGroup).length} (очікували 2)`)
console.log(`      ${applied.notes.join(' | ')}`)

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
