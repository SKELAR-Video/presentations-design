#!/usr/bin/env npx tsx
// Card fit — both bounds, on real slides from deck 10_Weplw…4Fs80.
//
// One fault, two faces: the font is chosen against one rectangle and the text is written
// into another. Overflow (>100%) and emptiness (<MIN_FILL) are the same bug seen from
// opposite sides, so both are asserted here. Overflow alone was checked before, which is
// why a card filled to 17% shipped without anyone noticing.
//
//   npm run check-card-fill

import { cardFitFacts } from '../lib/google'

const MIN_FILL = 55   // below this the card reads as empty (slide 46 shipped at 17%)
const MAX_FILL = 100  // above this the text is outside its box

type Case = { name: string; comp: string; slots: Record<string, string>; note: string }

const CASES: Case[] = [
  {
    name: 'слайд 58 — переповнення',
    comp: 'three_columns',
    note: '24pt, 6 рядків ≈346px у боксі 341px',
    slots: {
      'ЗАГОЛОВОК': 'Три помилки при виборі категорії',
      'КОЛОНКА_1': 'Обрати найбільшу категорію заради обсягу аудиторії',
      'КОЛОНКА_2': 'Обрати вузьку категорію, у якій немає добірок',
      'КОЛОНКА_3': 'Змінювати категорію після того, як зʼявились перші позиції',
    },
  },
  {
    name: 'слайд 46 — недобір 17%',
    comp: 'four_columns',
    note: '15pt, текст на 72px у картці 418px',
    slots: {
      'ЗАГОЛОВОК': 'Чотири сигнали здорової категорії',
      'КАРТКА_1': 'Стабільні завантаження',
      'КАРТКА_2': 'Висока частота відкриттів',
      'КАРТКА_3': 'Низький відтік у перший тиждень',
      'КАРТКА_4': 'Зростання платних підписок',
    },
  },
  {
    name: 'слайд 19 — найдовша картка 60%',
    comp: 'bento_bottom_4',
    note: '15pt, 91 символ',
    slots: {
      'ЗАГОЛОВОК': 'Що впливає на видимість',
      'КАРТКА_1': 'Категорія визначає, у яких добірках застосунок зʼявляється і з ким конкурує за місце в топі.',
      'КАРТКА_2': 'Назва та іконка — перше, що бачить людина у списку.',
      'КАРТКА_3': 'Оцінки та відгуки — сигнал довіри для алгоритму магазину.',
      'КАРТКА_4': 'Оновлення — регулярність показує, що продукт живий.',
    },
  },
  {
    name: 'слайд 26 — bento праворуч',
    comp: 'bento_right_2',
    note: '23pt у картці 273px',
    slots: {
      'ЗАГОЛОВОК': 'Два способи знайти застосунок',
      'КАРТКА_1': 'Пошук — людина вже знає, що їй потрібно, і вводить назву або ключове слово.',
      'КАРТКА_2': 'Добірки — редакція магазину показує те, про що людина ще не думала.',
    },
  },
]

let fails = 0
for (const c of CASES) {
  const facts = cardFitFacts(c.comp, c.slots)
  console.log(`\n${c.name}  [${c.comp}]  — ${c.note}`)
  if (!facts.length) { console.log('  (немає карток)'); continue }
  console.log('  слот            pt   під кегль   намальовано   треба   заповнення')
  for (const f of facts) {
    const drawn = f.drawnH > 0 ? String(f.drawnH) : '—'
    const gap   = f.drawnH > 0 ? f.measuredH - f.drawnH : 0
    const bad   = f.fillPct > MAX_FILL || f.fillPct < MIN_FILL
    if (bad) fails++
    console.log(
      `  ${f.token.padEnd(14)} ${String(f.pt).padStart(2)}   ` +
      `${String(f.measuredH).padStart(9)}   ${drawn.padStart(11)}   ` +
      `${String(f.textH).padStart(5)}   ${String(f.fillPct).padStart(3)}%  ${bad ? '❌' : '✓'}` +
      (gap ? `   розбіжність ${gap > 0 ? '+' : ''}${gap}px` : ''),
    )
  }
}

console.log(
  `\n=== ${fails} карток поза межами ${MIN_FILL}–${MAX_FILL}% ===\n` +
  'Колонка «під кегль» — прямокутник, проти якого добирався розмір шрифту.\n' +
  '«Намальовано» — той, який лейаут реально малює. Вони мають збігатись.',
)
process.exit(fails > 0 ? 1 : 0)
