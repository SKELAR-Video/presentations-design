import Anthropic from '@anthropic-ai/sdk'
import { PHASE0_COMPOSITIONS } from './compositions'
import type { SlidePlan, Theme } from './types'
import type { SourceSlide } from '@/app/api/fetch-doc/route'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Verbatim mapping mode ────────────────────────────────────────────────────
// LLM assigns input fragment INDICES to slots — it never writes prose.
// Text in each slot = verbatim line(s) from the original input.

const SYSTEM_VERBATIM = `Ти маппінг-агент: ТЗ → SKELAR-презентація.

Вхід: пронумерований список рядків (фрагментів) з ТЗ.
Завдання: обрати композиції й вказати, який фрагмент іде в який слот.

## Жорсткі правила
1. Виводь ТІЛЬКИ JSON без markdown.
2. Ти НЕ пишеш і НЕ переписуєш текст. Тільки призначаєш індекси фрагментів.
3. assignment: { "СЛОТ": index | [i1,i2,...] | null }
   - index → fragments[index] іде в слот дослівно
   - [i1,i2] → fragments[i1] + "\\n" + fragments[i2]
   - null → слот порожній
4. Тема всього деку: dark АБО red (як вказано).
5. Перший слайд → cover. Останній → closing (ЗАГОЛОВОК: null — майстер дає дефолт).
6. Ігноруй image-слоти (ЗОБРАЖЕННЯ_*) — залишай null.
7. ДАТА: індекс фрагмента, що містить дату (≤20 символів). Якщо немає — null.
8. Призначай КОЖЕН значущий фрагмент — ніколи не пропускай через «здається довгим».

## Як обирати композицію
- cover → перший слайд.
- closing → останній слайд.
- section / section_red → перехід між темами.
- title_body → одна теза з поясненням.
- two_columns → дві паралельні тези.
- three_columns → три кроки / пункти.
- kpi_cards → набір метрик (2–4 числа). ТЕКСТ ≤70 символів — субтитул, не абзац.
- bento_right_2/3/2x2 → велика теза + 2/3/4 числових або структурованих пунктів. Порожніх карток не лишати.

Формат:
{ "slides": [ { "composition": "cover", "assignment": { "ЗАГОЛОВОК": 0, "ПІДЗАГОЛОВОК": 1, "ДАТА": 2 } } ] }`

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

// ─── Fragment parsing ─────────────────────────────────────────────────────────
// Splits ТЗ text into verbatim lines (one fragment per line).
// Each fragment IS a literal substring of the original text, enabling
// the verbatim content-integrity validator check.
function parseFragments(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

// Called by google.ts after validateDeck — intentionally returns nothing.
// Verbatim guarantee: text from the source ТЗ is NEVER modified after insertion.
// Overflow (max_chars FAIL) surfaces in the validation report for the user to decide.
export async function fixOverflowSlots(
  _items: Array<{ id: string; slotName: string; currentText: string; limit: number }>,
): Promise<Array<{ id: string; value: string }>> {
  return []
}

export async function mapToPlan(text: string, theme: Theme): Promise<SlidePlan> {
  // Split ТЗ into verbatim line fragments — each is a literal substring of `text`
  const fragments = parseFragments(text)

  // Compact catalog: slot names + max_chars so LLM knows what fits
  const catalogDescription = PHASE0_COMPOSITIONS.map((c) => {
    const textSlots = c.slots
      .filter(s => s.type === 'text')
      .map(s => `${s.name}${s.optional ? '?' : ''}(≤${s.max_chars ?? '∞'})`)
      .join(', ')
    return `- ${c.id}: [${textSlots}]  ← ${c.when_to_use}`
  }).join('\n')

  const fragmentsList = fragments
    .map((f, i) => `[${i}] ${JSON.stringify(f.length > 200 ? f.slice(0, 200) + '…' : f)}`)
    .join('\n')

  const userMessage = `Тема: ${theme}.

Каталог SKELAR-композицій:
${catalogDescription}

Фрагменти ТЗ (${fragments.length} шт.):
${fragmentsList}

Поверни JSON з планом слайдів.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_VERBATIM,
    messages: [{ role: 'user', content: userMessage }],
  })
  const content = response.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic')

  const raw = content.text.trim()
  const json = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw
  const mapping = JSON.parse(json) as { slides: SlideAssignment[] }

  // Build SlidePlan — verbatim text from fragments, LLM never touched it.
  // NO truncation. If a slot exceeds max_chars → validator reports FAIL with details.
  // The user decides how to shorten the source text; code never cuts it silently.
  const slides = mapping.slides.map((m, i) => {
    const slots: Record<string, string> = {}
    for (const [slotName, ref] of Object.entries(m.assignment ?? {})) {
      if (ref === null || ref === undefined) continue
      const indices = Array.isArray(ref) ? ref : [ref]
      const slotText = indices
        .map(idx => (typeof idx === 'number' ? (fragments[idx] ?? '') : ''))
        .filter(Boolean)
        .join('\n')
      if (slotText) slots[slotName] = slotText
    }
    return { id: `slide_${i + 1}`, composition: m.composition || 'title_body', slots, flags: {} }
  })

  return { theme, slides, sourceText: text }
}
