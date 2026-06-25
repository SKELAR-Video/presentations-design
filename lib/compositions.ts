import type { Composition } from './types'

// Phase 0: 6 compositions for end-to-end pipeline testing
export const PHASE0_COMPOSITIONS: Composition[] = [
  {
    id: 'cover',
    name: 'Обкладинка',
    when_to_use: 'перший слайд презентації',
    themes: ['dark', 'red', 'light'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h1' },
      { name: 'ДАТА', type: 'text', max_chars: 20, style: 'caption' },
      { name: 'ЗОБРАЖЕННЯ_1', type: 'image', ratio: '16:9', role: 'background' },
    ],
  },
  {
    id: 'title_body',
    name: 'Заголовок + текст',
    when_to_use: 'одна теза з поясненням',
    themes: ['dark', 'red'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h1' },
      { name: 'ТЕКСТ', type: 'text', max_chars: 320, style: 'body' },
      { name: 'ПІДПИС', type: 'text', max_chars: 160, style: 'caption', optional: true },
    ],
  },
  {
    id: 'two_columns',
    name: 'Дві колонки',
    when_to_use: 'дві паралельні тези',
    themes: ['dark', 'red'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 70, style: 'h2', optional: true },
      { name: 'КОЛОНКА_1', type: 'text', max_chars: 180, style: 'body' },
      { name: 'КОЛОНКА_2', type: 'text', max_chars: 180, style: 'body' },
    ],
  },
  {
    id: 'three_columns',
    name: 'Три колонки',
    when_to_use: 'три кроки/пункти',
    themes: ['dark', 'red'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h2' },
      { name: 'КОЛОНКА_1', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КОЛОНКА_2', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КОЛОНКА_3', type: 'text', max_chars: 140, style: 'body' },
    ],
  },
  {
    id: 'kpi_cards',
    name: 'KPI-картки',
    when_to_use: 'набір метрик (2–4 картки)',
    themes: ['dark', 'red'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 50, style: 'h2' },
      { name: 'ТЕКСТ', type: 'text', max_chars: 220, style: 'body', optional: true },
      { name: 'КАРТКА_1_ЗНАЧЕННЯ', type: 'text', max_chars: 10, style: 'h2' },
      { name: 'КАРТКА_1_ПІДПИС', type: 'text', max_chars: 40, style: 'caption' },
      { name: 'КАРТКА_2_ЗНАЧЕННЯ', type: 'text', max_chars: 10, style: 'h2' },
      { name: 'КАРТКА_2_ПІДПИС', type: 'text', max_chars: 40, style: 'caption' },
      { name: 'КАРТКА_3_ЗНАЧЕННЯ', type: 'text', max_chars: 10, style: 'h2', optional: true },
      { name: 'КАРТКА_3_ПІДПИС', type: 'text', max_chars: 40, style: 'caption', optional: true },
      { name: 'КАРТКА_4_ЗНАЧЕННЯ', type: 'text', max_chars: 10, style: 'h2', optional: true },
      { name: 'КАРТКА_4_ПІДПИС', type: 'text', max_chars: 40, style: 'caption', optional: true },
    ],
  },
  {
    id: 'section',
    name: 'Секція — темна',
    when_to_use: 'перехідний слайд між розділами, розділювач теми',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h1' },
      { name: 'ПІДЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h2', optional: true },
    ],
  },
  {
    id: 'section_red',
    name: 'Секція — червона',
    when_to_use: 'яскравий перехідний слайд, ключовий тезис, акцент',
    themes: ['red'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h1' },
      { name: 'ПІДЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h2', optional: true },
    ],
  },
  {
    id: 'closing',
    name: 'Фінальний слайд',
    when_to_use: 'останній слайд',
    themes: ['dark', 'red', 'light'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h1' },
      { name: 'ЗОБРАЖЕННЯ_1', type: 'image', ratio: '16:9', role: 'background', optional: true },
    ],
  },
  {
    id: 'bento_right_2',
    name: 'Бенто праворуч — 2 картки',
    when_to_use: 'велика теза або пояснення ліворуч + 2 ключові пункти у картках праворуч',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h1' },
      { name: 'ТЕКСТ', type: 'text', max_chars: 320, style: 'body', optional: true },
      { name: 'КАРТКА_1', type: 'text', max_chars: 200, style: 'body' },
      { name: 'КАРТКА_2', type: 'text', max_chars: 200, style: 'body' },
    ],
  },
  {
    id: 'bento_right_3',
    name: 'Бенто праворуч — 3 картки',
    when_to_use: 'теза ліворуч + 3 пункти/кроки у картках праворуч',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h1' },
      { name: 'ТЕКСТ', type: 'text', max_chars: 320, style: 'body', optional: true },
      { name: 'КАРТКА_1', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КАРТКА_2', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КАРТКА_3', type: 'text', max_chars: 140, style: 'body' },
    ],
  },
  {
    id: 'bento_right_2x2',
    name: 'Бенто праворуч — 2×2',
    when_to_use: 'теза ліворуч + 4 пункти у сітці 2×2 праворуч',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h1' },
      { name: 'ТЕКСТ', type: 'text', max_chars: 320, style: 'body', optional: true },
      { name: 'КАРТКА_1', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КАРТКА_2', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КАРТКА_3', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КАРТКА_4', type: 'text', max_chars: 140, style: 'body' },
    ],
  },
]

export function getComposition(id: string): Composition | undefined {
  return PHASE0_COMPOSITIONS.find((c) => c.id === id)
}

export function getTextSlots(composition: Composition) {
  return composition.slots.filter((s) => s.type === 'text')
}
