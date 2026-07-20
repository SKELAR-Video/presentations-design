import type { Composition } from './types'

// Phase 0: 6 compositions for end-to-end pipeline testing
export const PHASE0_COMPOSITIONS: Composition[] = [
  {
    id: 'cover',
    name: 'Обкладинка',
    when_to_use: 'перший слайд презентації',
    themes: ['dark', 'red', 'light'],
    slots: [
      // Anchor fixed at (PAD, PAD) = (100, 100); grows down to max_h before truncation
      // max_w = TITLE_W = 1610 (right edge at 1710, 20px clear of logo at x=1730)
      { name: 'ЗАГОЛОВОК',    type: 'text', max_chars: 60,  anchor: { x: 100, y: 100 }, max_w: 1610, max_h: 400, style: 'h1' },
      // Optional subtitle — floats 60px below ЗАГОЛОВОК, 22pt MUTED
      { name: 'ПІДЗАГОЛОВОК', type: 'text', max_chars: 160, anchor: { x: 100, y: 100 }, max_w: 1610, max_h: 200, float_after: 'ЗАГОЛОВОК', float_gap: 60, style: 'h2', optional: true },
      // Date — floats 30px below ПІДЗАГОЛОВОК (or ЗАГОЛОВОК if subtitle absent)
      { name: 'ДАТА',         type: 'text', max_chars: 20,  anchor: { x: 100, y: 100 }, max_w: 1610, max_h: 80,  float_after: 'ПІДЗАГОЛОВОК', float_gap: 30, style: 'caption' },
      { name: 'ЗОБРАЖЕННЯ_1', type: 'image', ratio: '16:9', role: 'background' },
    ],
  },
  {
    id: 'cover_title_only',
    name: 'Обкладинка — тільки заголовок',
    when_to_use: 'перший слайд коли є лише заголовок, без підзаголовка і дати — дата підставляється автоматично',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 200, style: 'h1' },
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
      { name: 'ТЕКСТ', type: 'text', max_chars: 320, style: 'body', float_after: 'ЗАГОЛОВОК', float_gap: 60 },
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
      { name: 'КОЛОНКА_4', type: 'text', max_chars: 140, style: 'body', optional: true },
    ],
  },
  {
    id: 'bento_bottom_4',
    name: 'Чотири картки знизу',
    when_to_use: 'заголовок зверху + 4 рівні пункти в рядок знизу',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h2' },
      { name: 'КАРТКА_1', type: 'text', max_chars: 120, style: 'body' },
      { name: 'КАРТКА_2', type: 'text', max_chars: 120, style: 'body' },
      { name: 'КАРТКА_3', type: 'text', max_chars: 120, style: 'body' },
      { name: 'КАРТКА_4', type: 'text', max_chars: 120, style: 'body' },
    ],
  },
  {
    id: 'three_columns_num',
    name: 'Три колонки з нумерацією',
    when_to_use: '3 послідовних кроки або категорії з акцентними номерами 1/2/3',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h2' },
      { name: 'КОЛОНКА_1', type: 'text', max_chars: 180, style: 'body' },
      { name: 'КОЛОНКА_2', type: 'text', max_chars: 180, style: 'body' },
      { name: 'КОЛОНКА_3', type: 'text', max_chars: 180, style: 'body' },
      { name: 'КОЛОНКА_4', type: 'text', max_chars: 180, style: 'body', optional: true },
    ],
  },
  {
    id: 'columns_flex',
    name: 'Гнучкі колонки (2–4)',
    when_to_use: '2–4 паралельних пункти або кроки — підходить коли контент природно ділиться на 2, 3 або 4 рівних частини. Ширина колонок підлаштовується автоматично. КОЛОНКА_3 і КОЛОНКА_4 — опціональні.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h1' },
      { name: 'КОЛОНКА_1', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КОЛОНКА_2', type: 'text', max_chars: 140, style: 'body' },
      { name: 'КОЛОНКА_3', type: 'text', max_chars: 140, style: 'body', optional: true },
      { name: 'КОЛОНКА_4', type: 'text', max_chars: 120, style: 'body', optional: true },
    ],
  },
  {
    id: 'kpi_cards',
    name: 'KPI-картки',
    when_to_use: 'набір метрик (2–4 картки). ЗНАЧЕННЯ = тільки число/одиниця ≤10 символів («35», «2M+», «42%»). ПІДПИС = що це число означає.',
    themes: ['dark', 'red'],
    card_min_h: 180,
    card_max_h: 680,  // H - PAD - kCY_min (kCY_min = PAD+TH+TG = 300)
    gap_min: 30,
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 50, style: 'h2' },
      { name: 'ТЕКСТ', type: 'text', max_chars: 70, style: 'body', optional: true },
      { name: 'КАРТКА_1_ЗНАЧЕННЯ', type: 'text', max_chars: 10, style: 'h2' },
      { name: 'КАРТКА_1_ПІДПИС', type: 'text', max_chars: 50, style: 'caption' },
      { name: 'КАРТКА_2_ЗНАЧЕННЯ', type: 'text', max_chars: 10, style: 'h2' },
      { name: 'КАРТКА_2_ПІДПИС', type: 'text', max_chars: 50, style: 'caption' },
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
      { name: 'ПІДЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h2', optional: true, float_after: 'ЗАГОЛОВОК', float_gap: 60 },
    ],
  },
  {
    id: 'section_red',
    name: 'Секція — червона',
    when_to_use: 'яскравий перехідний слайд, ключовий тезис, акцент',
    themes: ['red'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h1' },
      { name: 'ПІДЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h2', optional: true, float_after: 'ЗАГОЛОВОК', float_gap: 60 },
    ],
  },
  {
    id: 'closing',
    name: 'Фінальний слайд',
    when_to_use: 'останній слайд',
    themes: ['dark', 'red', 'light'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 60, style: 'h1' },
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
      { name: 'КОЛОНКА_1', type: 'text', max_chars: 140, style: 'body', optional: true },
      { name: 'КОЛОНКА_2', type: 'text', max_chars: 140, style: 'body', optional: true },
      { name: 'КОЛОНКА_3', type: 'text', max_chars: 140, style: 'body', optional: true },
      { name: 'КОЛОНКА_4', type: 'text', max_chars: 140, style: 'body', optional: true },
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
  {
    id: 'badges',
    name: 'Бейджі — плоский список',
    // ЖОРСТКЕ ПРАВИЛО: плоский список = ЗАВЖДИ 1 слайд. ПУНКТИ = мітки через \n (1–3 слова, ≤20 символів).
    when_to_use: 'плоский список коротких міток (1–3 слова, до 20 символів). ЗАВЖДИ 1 слайд — НІКОЛИ не розбивати.',
    themes: ['dark', 'red'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h1' },
      { name: 'ПУНКТИ', type: 'text', max_chars: 400, style: 'body' },
    ],
  },
  {
    id: 'agenda_3',
    name: 'Адженда — 3 пункти',
    when_to_use: 'слайд адженди або порядку денного з рівно 3 пунктами (timeline-дизайн: 3 колонки × 1 рядок). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..3 = стислий текст кожного пункту БЕЗ нумерації.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 40, style: 'h1' },
      { name: 'ПУНКТ_1', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_2', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_3', type: 'text', max_chars: 80, style: 'body' },
    ],
  },
  {
    id: 'agenda_4',
    name: 'Адженда — 4 пункти',
    when_to_use: 'слайд адженди або порядку денного з рівно 4 пунктами (timeline-дизайн: 4 колонки × 1 рядок). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..4 = стислий текст кожного пункту БЕЗ нумерації.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 40, style: 'h1' },
      { name: 'ПУНКТ_1', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_2', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_3', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_4', type: 'text', max_chars: 80, style: 'body' },
    ],
  },
  {
    id: 'agenda_5',
    name: 'Адженда — 5 пунктів',
    when_to_use: 'слайд адженди або порядку денного з рівно 5 пунктами (timeline-дизайн: 3 колонки × рядок 1 + 2 колонки × рядок 2). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..5 = стислий текст кожного пункту БЕЗ нумерації.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 40, style: 'h1' },
      { name: 'ПУНКТ_1', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_2', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_3', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_4', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_5', type: 'text', max_chars: 80, style: 'body' },
    ],
  },
  {
    id: 'agenda_7',
    name: 'Адженда — 7 пунктів',
    when_to_use: 'слайд адженди або порядку денного з рівно 7 пунктами (timeline-дизайн: 4 колонки × рядок 1 + 3 колонки × рядок 2). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..7 = стислий текст кожного пункту БЕЗ нумерації.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 40, style: 'h1' },
      { name: 'ПУНКТ_1', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_2', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_3', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_4', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_5', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_6', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_7', type: 'text', max_chars: 60, style: 'body' },
    ],
  },
  {
    id: 'agenda_8',
    name: 'Адженда — 8 пунктів',
    when_to_use: 'слайд адженди або порядку денного з рівно 8 пунктами (timeline-дизайн: 4 колонки × 2 рядки). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..8 = стислий текст кожного пункту БЕЗ нумерації.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 40, style: 'h1' },
      { name: 'ПУНКТ_1', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_2', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_3', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_4', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_5', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_6', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_7', type: 'text', max_chars: 60, style: 'body' },
      { name: 'ПУНКТ_8', type: 'text', max_chars: 60, style: 'body' },
    ],
  },
  {
    id: 'agenda_6',
    name: 'Адженда — 6 пунктів',
    when_to_use: 'слайд адженди або порядку денного з рівно 6 пунктами (timeline-дизайн: 3 колонки × 2 рядки). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..6 = стислий текст кожного пункту.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 40, style: 'h1' },
      { name: 'ПУНКТ_1', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_2', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_3', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_4', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_5', type: 'text', max_chars: 80, style: 'body' },
      { name: 'ПУНКТ_6', type: 'text', max_chars: 80, style: 'body' },
    ],
  },
  {
    id: 'title_photo',
    name: 'Заголовок + фото (половина екрану)',
    when_to_use: 'Слайд із великим заголовком та текстом зліва і фото справа на половину екрану. Обирай коли є одна сильна теза + потрібен емоційний візуал: відкриття теми, ключова думка розділу, closing без стандартного слайда. ФОТО — опціональне посилання на зображення (http...); якщо не вказано — підставляється автоматично.',
    themes: ['dark'],
    slots: [
      { name: 'ЗАГОЛОВОК', type: 'text', max_chars: 80, style: 'h1' },
      { name: 'ТЕКСТ', type: 'text', max_chars: 300, style: 'body', optional: true },
      { name: 'ФОТО', type: 'text', max_chars: 300, style: 'body', optional: true },
    ],
  },
]

export function getComposition(id: string): Composition | undefined {
  return PHASE0_COMPOSITIONS.find((c) => c.id === id)
}

export function getTextSlots(composition: Composition) {
  return composition.slots.filter((s) => s.type === 'text')
}
