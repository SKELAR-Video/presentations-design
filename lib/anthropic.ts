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
9. Якщо вхід розбитий на аркуші (=== Аркуш N ===): виводь РІВНО стільки слайдів, скільки аркушів. Кожен слайд використовує ТІЛЬКИ фрагменти свого аркуша — не виходь за межі аркуша.

## Як обирати композицію
- cover → перший слайд.
- closing → останній слайд.
- section / section_red → перехід між темами.
- title_body → одна теза з поясненням, АБО плоский список довгих пунктів (ТЕКСТ = пункти через \n).
- badges → плоский список КОРОТКИХ міток (1–3 слова, до 20 символів кожна). ПУНКТИ = мітки через \n. ЗАВЖДИ 1 слайд.
- two_columns → дві паралельні тези.
- three_columns → три кроки / пункти.
- kpi_cards → набір метрик (2–4 числа). ТЕКСТ ≤70 символів — субтитул, не абзац.
- bento_right_2/3/2x2 → велика теза + 2/3/4 числових або структурованих пунктів. Порожніх карток не лишати.

## ЖОРСТКІ ЗАБОРОНИ
- НЕ розбивати плоский список на кілька слайдів — завжди один слайд.
- Не дублювати ЗАГОЛОВОК між сусідніми слайдами.
- Ніколи не вставляти символ «*» в жоден слот.
- Логіка: короткі мітки → badges; довгі пункти → title_body; 2+ іменовані групи → bento; метрики → kpi_cards.

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
7. Якщо слайд містить плоский список коротких міток (1–3 слова, ≤20 символів) — ЗАВЖДИ badges. ПУНКТИ = [масив індексів всіх міток]. НЕ РОЗБИВАТИ на кілька слайдів.
8. Ніколи не вставляти «*» в жоден слот. Не дублювати ЗАГОЛОВОК між сусідніми слайдами.

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

// ─── Sheet + fragment parsing ─────────────────────────────────────────────────
// Splits ТЗ by ___ / --- delimiters into sheets, then into verbatim line fragments.
// When sheets.length >= 2 the 1-sheet-per-slide invariant is enforced.
// Each fragment IS a literal substring of the original text (verbatim guarantee).
type SheetParse = {
  sheets: string[][]                  // lines grouped per sheet
  fragments: string[]                 // flat array (global indices for LLM)
  sheetRanges: Array<[number, number]> // [startIdx, endIdx] inclusive per sheet
}

function parseSheets(text: string): SheetParse {
  const DELIMITER = /^[_\-]{3,}$/
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim())

  const sheets: string[][] = [[]]
  for (const line of lines) {
    if (DELIMITER.test(line)) {
      if (sheets[sheets.length - 1].length > 0) sheets.push([])
    } else if (line) {
      sheets[sheets.length - 1].push(line)
    }
  }

  const nonEmpty = sheets.filter(s => s.length > 0)
  const fragments: string[] = []
  const sheetRanges: Array<[number, number]> = []
  for (const sheet of nonEmpty) {
    const start = fragments.length
    fragments.push(...sheet)
    sheetRanges.push([start, fragments.length - 1])
  }
  return { sheets: nonEmpty, fragments, sheetRanges }
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
  const { sheets, fragments, sheetRanges } = parseSheets(text)
  const hasSheets = sheets.length >= 2

  // Compact catalog: slot names + max_chars so LLM knows what fits
  const catalogDescription = PHASE0_COMPOSITIONS.map((c) => {
    const textSlots = c.slots
      .filter(s => s.type === 'text')
      .map(s => `${s.name}${s.optional ? '?' : ''}(≤${s.max_chars ?? '∞'})`)
      .join(', ')
    return `- ${c.id}: [${textSlots}]  ← ${c.when_to_use}`
  }).join('\n')

  // When sheets detected: show fragments grouped by sheet so LLM knows boundaries.
  // When no delimiter: fall back to flat list (legacy behaviour, no 1:1 constraint).
  const fragmentsList = hasSheets
    ? sheets.map((sheetLines, si) => {
        const [start] = sheetRanges[si]
        const items = sheetLines.map((line, li) => {
          const idx = start + li
          return `  [${idx}] ${JSON.stringify(line.length > 200 ? line.slice(0, 200) + '…' : line)}`
        }).join('\n')
        return `=== Аркуш ${si + 1} ===\n${items}`
      }).join('\n\n')
    : fragments
        .map((f, i) => `[${i}] ${JSON.stringify(f.length > 200 ? f.slice(0, 200) + '…' : f)}`)
        .join('\n')

  const sheetConstraint = hasSheets
    ? `\nБриф містить РІВНО ${sheets.length} аркушів — виведи РІВНО ${sheets.length} слайдів.`
    : ''

  const userMessage = `Тема: ${theme}.${sheetConstraint}

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

  // Enforce 1 sheet = 1 slide when delimiter was used
  if (hasSheets && mapping.slides.length !== sheets.length) {
    throw new Error(
      `LLM повернув ${mapping.slides.length} слайдів, але бриф містить ${sheets.length} аркушів. ` +
      `Очікується рівно ${sheets.length} слайдів.`,
    )
  }

  // Build SlidePlan — verbatim text from fragments, LLM never touched it.
  // NO truncation. If a slot exceeds max_chars → validator reports FAIL with details.
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

  return { theme, slides, sourceText: text, sheetCount: hasSheets ? sheets.length : undefined }
}
