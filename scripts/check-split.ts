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
const applied = applySplits(plan, [{ ...CASES[0].overload, slideIndex: 1 }], new Map([[1, 'split' as const]]))
const orderOk = applied.slides[0].id === 'a' && applied.slides[applied.slides.length - 1].id === 'c'
const countOk = applied.slides.length === 4
const groupOk = applied.slides.filter(s => s.splitGroup === 'split_1').length === 2
const applyOk = orderOk && countOk && groupOk
if (!applyOk) failed++
console.log(`${applyOk ? 'PASS' : 'FAIL'}  applySplits: порядок і група`)
console.log(`      слайдів: ${applied.slides.length} (очікували 4), у групі: ${applied.slides.filter(s => s.splitGroup).length} (очікували 2)`)
console.log(`      ${applied.notes.join(' | ')}`)

// ─── A declined offer is recorded, not forgotten ──────────────────────────────
// Two slides offered, one split, one declined. The declined one must come back carrying
// keepSmall (or the rebuild asks the same question again), and the parts of the split one
// must NOT carry it (an answer about their parent was not an answer about them).
const twoOffered: Slide[] = [
  CASES[0].slide,                                    // splittable — chosen
  { ...CASES[2].slide, id: 'kept' },                 // declined
]
const bothOverloads = [
  { ...CASES[0].overload, slideIndex: 0 },
  { ...CASES[2].overload, slideIndex: 1 },
]
const decided = applySplits(twoOffered, bothOverloads, new Map([[0, 'split' as const], [1, 'keep' as const]]))
const keptFlagged  = decided.slides.filter(s => s.keepSmall).length === 1
const keptIsRight  = decided.slides.find(s => s.keepSmall)?.id === 'kept'
const partsClean   = decided.slides.filter(s => s.splitGroup).every(s => !s.keepSmall)
const decideOk = keptFlagged && keptIsRight && partsClean
if (!decideOk) failed++
console.log(`${decideOk ? 'PASS' : 'FAIL'}  відмова запам'ятовується, частини її не успадковують`)
console.log(`      з keepSmall: ${decided.slides.filter(s => s.keepSmall).map(s => s.id).join(', ') || '—'} (очікували: kept)`)
console.log(`      частин розкладеного: ${decided.slides.filter(s => s.splitGroup).length}, з них помилково прийнятих: ${decided.slides.filter(s => s.splitGroup && s.keepSmall).length} (очікували 0)`)

// A slide sent to shortening must come back untouched by applySplits — in particular
// without keepSmall, which would silence the very next measurement of a slide that was just
// rewritten so it could be measured again.
const shortened = applySplits(twoOffered, bothOverloads, new Map([[1, 'shorten' as const]]))
const shortenOk = shortened.slides.length === 2
  && shortened.slides.every(s => !s.keepSmall)
  && shortened.slides.every(s => !s.splitGroup)
if (!shortenOk) failed++
console.log(`${shortenOk ? 'PASS' : 'FAIL'}  слайд, відданий на скорочення, не позначається прийнятим`)
console.log(`      слайдів: ${shortened.slides.length} (очікували 2), з keepSmall: ${shortened.slides.filter(s => s.keepSmall).length} (очікували 0)`)

// ─── The slot being divided is never treated as an introduction ───────────────
// ПІДЗАГОЛОВОК introduces the sheet on a column layout and IS the body on `closing`.
// Dropping it from parts 2+ left a closing slide holding nothing but its heading, and took
// five lines of the client's text with it (deck 1bOXi…QfSZw, slides 35–36).
const closing = slide('close', 'closing', {
  'ЗАГОЛОВОК': 'Wording directions',
  'ПІДЗАГОЛОВОК': [
    'Ми не чекаємо, поки ти будеш готовий',
    'Питання «навіщо?» вітаються більше',
    'Тут не соромляться амбіцій',
    'Ти не гвинтик',
  ].join('\n'),
})
const closeSplit = splitSlide(closing, overload([{ slot: 'ПІДЗАГОЛОВОК', needed: 900, avail: 540 }], 2))
const closeParts = closeSplit?.slides ?? []
const closeOk = closeParts.length === 2
  && closeParts.every(s => (s.slots['ПІДЗАГОЛОВОК'] ?? '').trim().length > 0)
  && closeParts.flatMap(s => linesOf(s.slots['ПІДЗАГОЛОВОК'] ?? '')).length === 4
if (!closeOk) failed++
console.log(`${closeOk ? 'PASS' : 'FAIL'}  слот, який ділимо, не вважається вступним`)
console.log(`      частин: ${closeParts.length}, рядків у них: ${closeParts.map(s => linesOf(s.slots['ПІДЗАГОЛОВОК'] ?? '').length).join(' + ') || '—'} (очікували 4 разом, жодної порожньої)`)

// ─── A short row is not split at all ──────────────────────────────────────────
// Two cards dealt into one and one are two slides that each look like a mistake. The first
// real run did exactly that to ten sheets; the person's word for the result was "купа
// пустих слайдів". Splitting must refuse here so the panel offers shortening instead.
for (const n of [2, 3]) {
  const slots: Record<string, string> = { 'ЗАГОЛОВОК': 'Напрямки' }
  for (let k = 1; k <= n; k++) slots[`КОЛОНКА_${k}`] = `Блок ${k}\nОпис блоку номер ${k}`
  const short = splitSlide(slide(`row${n}`, 'three_columns', slots), overload([{ slot: 'КОЛОНКА_1', needed: 730, avail: 540 }], 2))
  const ok = short === null
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ряд із ${n} карток не ділиться`)
  console.log(`      результат: ${short ? `${short.slides.length} частин — ${short.note}` : 'не ділиться (очікували саме це)'}`)
}

// ─── Downgrade takes the content with it ──────────────────────────────────────
// Changing the composition does not rename the slots. A two_columns slide with one filled
// column becomes title_body — which has no КОЛОНКА_1 — and the text ends up addressed to a
// slot the master cannot place. That is what rendered ten blank slides.
import { rehomeSlotsAfterDowngrade } from '../lib/google'

const orphaned = rehomeSlotsAfterDowngrade(
  { 'ЗАГОЛОВОК': 'Один блок', 'КОЛОНКА_1': 'Аналітика\nЗбір даних по ринку' },
  'two_columns',
  'title_body',
)
const rehomeOk = orphaned['ЗАГОЛОВОК'] === 'Один блок'
  && (orphaned['ТЕКСТ'] ?? '').includes('Збір даних по ринку')
  && !('КОЛОНКА_1' in orphaned)
if (!rehomeOk) failed++
console.log(`${rehomeOk ? 'PASS' : 'FAIL'}  зниження композиції переносить текст у слот нової`)
console.log(`      слоти після: ${Object.keys(orphaned).join(', ')} (КОЛОНКА_1 не має лишитись)`)

// Same move where the target still has cards, just fewer of them.
const narrowed = rehomeSlotsAfterDowngrade(
  { 'ЗАГОЛОВОК': 'Два блоки', 'КОЛОНКА_1': 'Перший', 'КОЛОНКА_3': 'Третій' },
  'three_columns',
  'two_columns',
)
const renumberOk = narrowed['КОЛОНКА_1'] === 'Перший' && narrowed['КОЛОНКА_2'] === 'Третій'
if (!renumberOk) failed++
console.log(`${renumberOk ? 'PASS' : 'FAIL'}  картки перенумеровуються з 1 під нову композицію`)
console.log(`      ${Object.entries(narrowed).filter(([k]) => k.startsWith('КОЛОНКА')).map(([k, v]) => `${k}=${v}`).join(', ')}`)

// ─── Re-expansion is idempotent ───────────────────────────────────────────────
// The repair flow feeds an already-expanded plan back into the generator, so expanding
// twice must give the same deck as expanding once. Before the variantOf marker it did not:
// every design variant was expanded into variants of its own, one sheet became N², and a
// slide numbered 8 came back numbered 20 without a word of its content changing.
import { expandPlanWithVariants } from '../lib/google'
import type { SlidePlan } from '../lib/types'

const variantPlan: SlidePlan = {
  theme: 'dark',
  slides: [
    slide('v1', 'three_columns', {
      'ЗАГОЛОВОК': 'Три напрямки',
      'КОЛОНКА_1': 'Перший\nОпис першого напрямку',
      'КОЛОНКА_2': 'Другий\nОпис другого напрямку',
      'КОЛОНКА_3': 'Третій\nОпис третього напрямку',
    }),
    slide('v2', 'title_body', { 'ЗАГОЛОВОК': 'Підсумок', 'ТЕКСТ': 'Один\nДва' }),
  ],
}

const once  = expandPlanWithVariants(variantPlan).expanded
const twice = expandPlanWithVariants(once).expanded
const stable = once.slides.length === twice.slides.length
if (!stable) failed++
console.log(`${stable ? 'PASS' : 'FAIL'}  повторне розгортання варіантів нічого не додає`)
console.log(`      один раз: ${once.slides.length} слайдів, двічі: ${twice.slides.length} (мають збігатись)`)

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
