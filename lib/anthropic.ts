import Anthropic from '@anthropic-ai/sdk'
import { PHASE0_COMPOSITIONS } from './compositions'
import type { SlidePlan, Theme } from './types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `Твоє завдання: з очищеного контенту ТЗ скласти план слайдів — послідовність композицій із заповненими слотами. Ти НЕ малюєш слайди й НЕ рахуєш геометрію. Ти лише обираєш композиції з каталогу й розкладаєш текст по слотах.

## Жорсткі правила (ніколи не порушувати)

1. Використовуй ТІЛЬКИ композиції з наданого каталогу. Не вигадуй нових.
2. Використовуй ТІЛЬКИ слоти, визначені для обраної композиції.
3. НЕ перевищуй max_chars слота. Якщо текст довший — познач слот як overflow: true і збережи повний текст у raw.
4. Не змінюй шрифти, кольори, розміри, позиції.
5. Тема всього деку одна: dark АБО red.
6. Перший слайд — завжди cover. Останній — завжди closing.
7. Ігноруй image-слоти (ЗОБРАЖЕННЯ_N) — залишай їх порожніми.

## Як обирати композицію

- Перший слайд → cover. Останній → closing.
- Одна теза з поясненням → title_body.
- Дві паралельні тези → two_columns.
- Три кроки/пункти → three_columns.
- Набір метрик → kpi_cards.

## Формат виходу — ТІЛЬКИ валідний JSON, без markdown

{
  "theme": "dark",
  "slides": [
    {
      "id": "slide_1",
      "composition": "cover",
      "slots": {
        "ЗАГОЛОВОК": "Текст заголовка",
        "ДАТА": "24 червня 2026"
      },
      "flags": {}
    }
  ]
}`

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
  // Strip markdown code fences if present
  const json = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw

  const plan = JSON.parse(json) as SlidePlan
  return plan
}
