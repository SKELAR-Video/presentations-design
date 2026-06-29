import Anthropic from '@anthropic-ai/sdk'
import { PHASE0_COMPOSITIONS } from './compositions'
import type { SlidePlan, Theme } from './types'
import type { SourceSlide } from '@/app/api/fetch-doc/route'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `Твоє завдання: з очищеного контенту ТЗ скласти план слайдів — послідовність композицій із заповненими слотами. Ти НЕ малюєш слайди й НЕ рахуєш геометрію. Ти лише обираєш композиції з каталогу й розкладаєш текст по слотах.

## Жорсткі правила
1. Використовуй ТІЛЬКИ композиції з наданого каталогу. Не вигадуй нових.
2. Використовуй ТІЛЬКИ слоти, визначені для обраної композиції.
3. Не перевищуй max_chars слота — скороти до суті якщо потрібно.
4. Тема всього деку одна: dark АБО red.
5. Перший слайд — завжди cover. Останній — завжди closing.
6. Ігноруй image-слоти (ЗОБРАЖЕННЯ_N) — залишай їх порожніми.

## Як обирати композицію
- Перший слайд → cover. Останній → closing.
- Перехід між темами → section (темна) або section_red (червона).
- Одна теза з поясненням → title_body.
- Дві паралельні тези → two_columns.
- Три кроки / пункти → three_columns.
- Набір метрик (2–4 числа) → kpi_cards. ТЕКСТ у kpi_cards — лише короткий субтитул (≤70 символів), не повний абзац.
- Велика теза + рівно 2 числових/структурованих пункти → bento_right_2.
- Велика теза + рівно 3 числових/структурованих пункти → bento_right_3.
- Велика теза + рівно 4 числових/структурованих пункти (2×2) → bento_right_2x2.

## Коли обирати bento_right_* (суворо)
Бенто ТІЛЬКИ для паралельних однорідних пунктів одного з двох типів:
1. Числові метрики/показники: "< 0.5%", "x2 зростання", "$5M ARR", "100+ клієнтів"
2. Структуровані переліки: "Напрям 1: ...", "Крок 1: ...", "Ринок А / Ринок Б"

НЕ обирай bento_right_* для:
- Звичайних речень-пояснень (навіть коротких) без числових значень
- Суміші числових та текстових пунктів — числові йдуть у bento КАРТКА_*, текстовий контекст → ТЕКСТ зліва

ВАЖЛИВО: кількість карток = кількість пунктів. Порожніх карток не повинно бути.

## Формат виходу — ТІЛЬКИ валідний JSON, без markdown

{
  "theme": "dark",
  "slides": [
    {
      "id": "slide_1",
      "composition": "cover",
      "slots": {
        "ЗАГОЛОВОК": "Текст заголовка",
        "ДАТА": "25 червня 2026"
      },
      "flags": {}
    }
  ]
}`

// ─── 1:1 mode ────────────────────────────────────────────────────────────────
// LLM outputs ONLY composition + slot→index mapping.
// Actual text is copied programmatically from source slides (verbatim, guaranteed).

const SYSTEM_1TO1 = `Ти маппінг-агент Google Slides → SKELAR.

Отримуєш масиви texts[] для кожного слайду і повинен:
1. Обрати SKELAR-композицію
2. Вказати ІНДЕКС (число) тексту для кожного слоту — НЕ копіювати сам текст

assignment — Record<назва_слоту, індекс | [масив_індексів] | null>
Наприклад: "ЗАГОЛОВОК": 0  →  ЗАГОЛОВОК = texts[0]
           "ТЕКСТ": [1, 2] →  ТЕКСТ = texts[1] + "\\n" + texts[2]
           "ДАТА": null    →  слот залишається порожнім

Правила:
1. Кількість слайдів у виході = кількість у вході. Без злиття, без розбиття.
2. Перший → cover. Останній → closing.
3. Використовуй ТІЛЬКИ слоти з обраної композиції. Пропускай image-слоти (ЗОБРАЖЕННЯ_*).
4. Якщо texts[] порожній — assignment = {} (порожній обʼєкт).
5. Для bento_right_2/3/2x2 — обирай ТІЛЬКИ якщо пункти є числовими метриками або чітко структурованими переліками (не просто короткі речення). Якщо пунктів 2 — bento_right_2, 3 — bento_right_3, 4 — bento_right_2x2. Порожніх карток (КАРТКА_N: null без реального тексту) не лишати.
6. Не змішуй числові метрики і текстові пояснення в одних бенто-картках.

Виводь ТІЛЬКИ JSON (без markdown):
{ "slides": [ { "composition": "cover", "assignment": { "ЗАГОЛОВОК": 0, "ДАТА": null } } ] }`

type SlideAssignment = {
  composition: string
  assignment: Record<string, number | number[] | null>
}

export async function mapSlides1to1(
  slides: SourceSlide[],
  theme: Theme,
): Promise<SlidePlan> {
  // Compact catalog — slot names only, no max_chars (LLM assigns indices, not text)
  const catalogDescription = PHASE0_COMPOSITIONS.map((c) => {
    const textSlots = c.slots
      .filter(s => s.type === 'text')
      .map(s => s.name + (s.optional ? '?' : ''))
      .join(', ')
    return `- ${c.id}: [${textSlots}]  ← ${c.when_to_use}`
  }).join('\n')

  const slidesText = slides
    .map((s, i) => {
      const items = s.texts.map((t, ti) => `  [${ti}] ${JSON.stringify(t.slice(0, 300))}`)
      return `--- Слайд ${i + 1} (${s.texts.length} текстів) ---\n${items.join('\n') || '  (порожній)'}`
    })
    .join('\n\n')

  const userMessage = `Тема: ${theme}. Вхідних / вихідних слайдів: ${slides.length}.

Каталог SKELAR-композицій:
${catalogDescription}

Слайди-джерела:
${slidesText}

JSON з рівно ${slides.length} елементами в "slides".`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_1TO1,
    messages: [{ role: 'user', content: userMessage }],
  })

  const content = message.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic')
  const raw = content.text.trim()
  const json = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw
  const mapping = JSON.parse(json) as { slides: SlideAssignment[] }

  // Build SlidePlan — text copied verbatim from source, LLM never touched it
  return {
    theme,
    slides: slides.map((source, i) => {
      const m = mapping.slides[i] ?? { composition: 'title_body', assignment: {} }
      const slots: Record<string, string> = {}

      for (const [slotName, ref] of Object.entries(m.assignment ?? {})) {
        if (ref === null || ref === undefined) continue
        const indices = Array.isArray(ref) ? ref : [ref]
        const text = indices
          .map(idx => (typeof idx === 'number' ? (source.texts[idx] ?? '') : ''))
          .filter(Boolean)
          .join('\n')
        if (text) slots[slotName] = text
      }

      return {
        id: `slide_${i + 1}`,
        composition: m.composition || 'title_body',
        slots,
        flags: {},
      }
    }),
  }
}

export async function mapToPlan(text: string, theme: Theme): Promise<SlidePlan> {
  const catalogDescription = PHASE0_COMPOSITIONS.map((c) => {
    const slots = c.slots
      .map((s) => `    - ${s.name} (${s.type}${s.max_chars ? `, max ${s.max_chars} символів` : ''}${s.optional ? ', опційний' : ''})`)
      .join('\n')
    return `- ${c.id}: ${c.name}\n  Коли: ${c.when_to_use}\n  Слоти:\n${slots}`
  }).join('\n\n')

  const userMessage = `Тема презентації: ${theme}

Каталог доступних композицій:
${catalogDescription}

Текст ТЗ:
---
${text}
---

Склади план слайдів у форматі JSON.`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  const content = message.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic')

  const raw = content.text.trim()
  const json = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw

  return JSON.parse(json) as SlidePlan
}
