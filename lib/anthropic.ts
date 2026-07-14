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
5. Перший слайд → cover (якщо є ПІДЗАГОЛОВОК або дата) або cover_title_only (якщо є ЛИШЕ заголовок). Останній → closing. ЗАГОЛОВОК closing-слайда = перший рядок останнього аркуша. ПІДЗАГОЛОВОК = решта рядків через [i1, i2, ...] або null якщо є тільки один рядок.
6. Ігноруй image-слоти (ЗОБРАЖЕННЯ_*) — залишай null.
7. ДАТА: індекс фрагмента, що містить дату (≤20 символів). Якщо немає — null.
8. Призначай КОЖЕН значущий фрагмент — ніколи не пропускай через «здається довгим».
9. Якщо вхід розбитий на аркуші (=== Аркуш N ===):
   - РІВНО стільки слайдів, скільки аркушів — НІКОЛИ не більше й НІКОЛИ не менше.
   - Аркуш з 1 коротким рядком (перехідний заголовок) → composition "section", ЗАГОЛОВОК = той рядок. НЕ зливай із сусіднім аркушем.
   - Аркуш 1 → cover (якщо є підзаголовок або дата) або cover_title_only (якщо є лише заголовок). Останній аркуш → closing (ЗАГОЛОВОК: перший фрагмент аркуша, ПІДЗАГОЛОВОК: решта фрагментів через [i1,i2,...] або null).
   - Кожен слайд використовує ТІЛЬКИ фрагменти свого аркуша.

## Як обирати композицію
- cover → перший слайд (якщо є підзаголовок або дата); cover_title_only → перший слайд (якщо є лише заголовок).
- closing → останній слайд.
- section / section_red → перехід між темами.
- title_body → одна теза з поясненням, АБО плоский список довгих пунктів (ТЕКСТ = пункти через \n).
- badges → плоский список КОРОТКИХ міток (1–2 слова, СУВОРО ≤20 символів КОЖНА мітка). ПУНКТИ = мітки через \n. ЗАВЖДИ 1 слайд. Якщо мітка >20 символів — скороти або заміни синонімом.
- two_columns → дві паралельні тези.
- three_columns → три кроки / пункти (відкриті колонки без нумерації).
- three_columns_num → три послідовних кроки або категорії з акцентними номерами 1/2/3. Тільки dark-тема.
- kpi_cards → набір метрик (2–4 картки). ЗНАЧЕННЯ = тільки число або одиниця ≤10 символів: «35», «2M+», «42%». ПІДПИС = короткий опис без повторення числа (НЕ «2 000 000+ застосунків», а «застосунків доступно»). ТЕКСТ ≤70 символів — субтитул, не абзац.
- bento_right_2/3/2x2 → велика теза + 2/3/4 числових або структурованих пунктів. Порожніх карток не лишати.
- bento_bottom_4 → заголовок зверху + 4 рівні пункти в рядок знизу. Тільки dark-тема.

## ЖОРСТКІ ЗАБОРОНИ
- НЕ розбивати плоский список на кілька слайдів — завжди один слайд.
- Не дублювати ЗАГОЛОВОК між сусідніми слайдами.
- Ніколи не вставляти символ «*» в жоден слот.
- Логіка: короткі мітки → badges; довгі пункти → title_body; 2+ іменовані групи → bento; метрики → kpi_cards.
- **closing ЗАВЖДИ фінальний слайд** — після closing НІЧОГО. Якщо Q&A або подяка є ОКРЕМИМ аркушем — це section/section_red перед closing. Якщо є лише один останній аркуш з Q&A чи подякою — це і є closing (ЗАГОЛОВОК = той рядок).

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
2. Перший → cover (якщо є підзаголовок або дата) або cover_title_only (якщо є лише заголовок). Останній → closing.
3. Використовуй ТІЛЬКИ слоти з обраної композиції. Пропускай image-слоти (ЗОБРАЖЕННЯ_*).
4. Якщо texts[] порожній — assignment = {} (порожній обʼєкт).
5. Для bento_right_2/3/2x2 — обирай ТІЛЬКИ якщо пункти є числовими метриками або чітко структурованими переліками (не просто короткі речення). Якщо пунктів 2 — bento_right_2, 3 — bento_right_3, 4 — bento_right_2x2. Порожніх карток (КАРТКА_N: null без реального тексту) не лишати.
6. Не змішуй числові метрики і текстові пояснення в одних бенто-картках.
7. Якщо слайд містить плоский список коротких міток (1–2 слова, ≤20 символів КОЖНА) — ЗАВЖДИ badges. ПУНКТИ = [масив індексів всіх міток]. НЕ РОЗБИВАТИ на кілька слайдів. Мітки >20 символів НЕ підходять для badges — використовуй title_body.
8. Ніколи не вставляти «*» в жоден слот. Не дублювати ЗАГОЛОВОК між сусідніми слайдами.
9. closing ЗАВЖДИ останній — після нього НІЧОГО. Q&A та подібні → section/section_red перед closing.

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
    max_tokens: 8192,
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
// Only delimiter-based splits are authoritative (1 sheet = 1 slide guarantee).
// Each fragment IS a literal substring of the original text (verbatim guarantee).
type SheetParse = {
  sheets: string[][]                   // lines grouped per sheet
  fragments: string[]                  // flat array (global indices for LLM)
  sheetRanges: Array<[number, number]> // [startIdx, endIdx] inclusive per sheet
  hasDelimiters: boolean               // true only when explicit ___ was found
}

function parseSheets(text: string): SheetParse {
  const DELIMITER = /^[_\-]{3,}$/
  const lines = text.replace(/\r\n/g, '\n').replace(//g, '\n').split('\n').map(l => l.trim())

  const hasDelimiters = lines.some(l => DELIMITER.test(l))
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
  console.log(`[parseSheets] hasDelimiters=${hasDelimiters} sheets=${nonEmpty.length} fragments=${fragments.length}`)
  return { sheets: nonEmpty, fragments, sheetRanges, hasDelimiters }
}

// Called by google.ts after validateDeck — intentionally returns nothing.
// Verbatim guarantee: text from the source ТЗ is NEVER modified after insertion.
// Overflow (max_chars FAIL) surfaces in the validation report for the user to decide.
export async function fixOverflowSlots(
  _items: Array<{ id: string; slotName: string; currentText: string; limit: number }>,
): Promise<Array<{ id: string; value: string }>> {
  return []
}

// Detect number of logical sections via Haiku — asks for a NUMBERED LIST so we can
// count items instead of trusting a single integer output (more robust).
async function detectSectionCount(text: string): Promise<number> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: 'Відповідай ТІЛЬКИ пронумерованим списком. Одна секція — один рядок.',
    messages: [{
      role: 'user',
      content: `Визнач усі тематичні секції (слайди) у цьому брифі для презентації.\nДля кожної секції виведи рядок у форматі: "1. <перші кілька слів заголовку>"\nПерша — обкладинка. Остання — закриваючий слайд.\n\n${text.slice(0, 4000)}`,
    }],
  })
  const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : ''
  const lines = raw.split('\n').filter(l => /^\d+\./.test(l.trim()))
  const n = lines.length
  console.log(`[detectSectionCount] haiku lines=${n} output=${JSON.stringify(raw.slice(0, 300))}`)
  return n < 2 ? 0 : n
}

export async function mapToPlan(text: string, theme: Theme): Promise<SlidePlan> {
  const { sheets, fragments, sheetRanges, hasDelimiters } = parseSheets(text)
  // Only explicit ___ delimiters guarantee 1-sheet-per-slide
  const hasSheets = hasDelimiters && sheets.length >= 2

  // Target count: delimiter count (authoritative) OR Haiku numbered-list detection
  const targetCount = hasSheets ? sheets.length : await detectSectionCount(text)

  // Compact catalog: slot names + max_chars so LLM knows what fits
  const catalogDescription = PHASE0_COMPOSITIONS.map((c) => {
    const textSlots = c.slots
      .filter(s => s.type === 'text')
      .map(s => `${s.name}${s.optional ? '?' : ''}(≤${s.max_chars ?? '∞'})`)
      .join(', ')
    return `- ${c.id}: [${textSlots}]  ← ${c.when_to_use}`
  }).join('\n')

  // When sheets detected: show fragments grouped by sheet so LLM knows boundaries.
  // Otherwise: flat list with count constraint from auto-detection.
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

  const slideConstraint = targetCount >= 2
    ? `\nБриф містить РІВНО ${targetCount} логічних блоків — виведи РІВНО ${targetCount} слайдів.`
    : ''

  const userMessage = `Тема: ${theme}.${slideConstraint}

Каталог SKELAR-композицій:
${catalogDescription}

Фрагменти ТЗ (${fragments.length} шт.):
${fragmentsList}

Поверни JSON з планом слайдів.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: SYSTEM_VERBATIM,
    messages: [{ role: 'user', content: userMessage }],
  })
  const content = response.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic')

  const parseJSON = (raw: string) => {
    const j = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw
    return JSON.parse(j) as { slides: SlideAssignment[] }
  }

  let raw = content.text.trim()
  let mapping = parseJSON(raw)
  console.log(`[mapToPlan] first pass: ${mapping.slides.length} slides, expected ${targetCount}`)

  // Retry once if count is wrong (only meaningful when hasSheets — we know exact count)
  if (hasSheets && mapping.slides.length !== targetCount) {
    console.warn(`[mapToPlan] retrying: got ${mapping.slides.length}, need ${targetCount}`)
    const sheetSummary = sheets.map((s, i) =>
      `Аркуш ${i + 1}: "${(s[0] ?? '').slice(0, 60)}"${s.length === 1 ? ' (тільки заголовок → composition: section)' : ''}`
    ).join('\n')
    const retryPrompt = `ПОМИЛКА: ти повернув ${mapping.slides.length} слайдів, потрібно РІВНО ${targetCount}.
Список аркушів (кожен = РІВНО 1 слайд):
${sheetSummary}
Поверни JSON з РІВНО ${targetCount} слайдами. Аркуш з одним рядком → "section". Не зливай аркуші.`
    const retry = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: SYSTEM_VERBATIM,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: raw },
        { role: 'user', content: retryPrompt },
      ],
    })
    const retryContent = retry.content[0]
    if (retryContent.type !== 'text') throw new Error('Unexpected retry response type')
    raw = retryContent.text.trim()
    mapping = parseJSON(raw)
    console.log(`[mapToPlan] retry result: ${mapping.slides.length} slides`)
  }

  if (hasSheets && mapping.slides.length !== targetCount) {
    throw new Error(
      `LLM повернув ${mapping.slides.length} слайдів після retry, але бриф містить ${targetCount} аркушів.`,
    )
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  function buildSlides(m: { slides: SlideAssignment[] }) {
    return m.slides.map((s, i) => {
      const slots: Record<string, string> = {}
      for (const [slotName, ref] of Object.entries(s.assignment ?? {})) {
        if (ref === null || ref === undefined) continue
        const indices = Array.isArray(ref) ? ref : [ref]
        const slotText = indices
          .map(idx => (typeof idx === 'number' ? (fragments[idx] ?? '') : ''))
          .filter(Boolean)
          .join('\n')
        if (slotText) slots[slotName] = slotText
      }
      return { id: `slide_${i + 1}`, composition: s.composition || 'title_body', slots, flags: {} }
    })
  }

  // Returns per-slide list of fragments that did NOT make it into any slot.
  function findMissing(builtSlides: ReturnType<typeof buildSlides>): string[][] {
    if (!hasSheets) return builtSlides.map(() => [])
    return builtSlides.map((slide, i) => {
      const [start, end] = sheetRanges[i] ?? [0, -1]
      const sheetFrags = fragments.slice(start, end + 1).filter(Boolean)
      const allSlotText = Object.values(slide.slots).join('\n')
      return sheetFrags.filter(frag => !allSlotText.includes(frag))
    })
  }

  let slides = buildSlides(mapping)
  let missing = findMissing(slides)
  const hasMissing = missing.some(m => m.length > 0)

  // ── Content-integrity retry ───────────────────────────────────────────────
  if (hasMissing && hasSheets) {
    const missingReport = missing
      .map((m, i) => m.length > 0 ? `Аркуш ${i + 1}: не призначено ${m.length} фрагм.: ${m.map(f => `"${f.slice(0, 60)}"`).join(', ')}` : null)
      .filter(Boolean)
      .join('\n')
    console.warn(`[content-integrity] FAIL before retry:\n${missingReport}`)

    const retryPrompt = `ПОМИЛКА: частина фрагментів не потрапила в жоден слот — контент буде ВТРАЧЕНО.
${missingReport}

Правила виправлення (виконай ВСІ):
1. Аркуш з 1 коротким рядком ("Дякуємо!", "Q&A", будь-який перехідний заголовок) → ОБОВ'ЯЗКОВО призначай ЗАГОЛОВОК = індекс того рядка. Не залишай assignment порожнім. Залишай composition section / section_red / closing — НЕ міняй на bento/kpi.
2. Аркуш з кількома рядками → обери підходящу composition і призначай кожен рядок у окремий слот. Якщо не вистачає слотів — обери bento_right_3, title_body тощо.
3. НЕ змінюй кількість слайдів і НЕ зливай аркуші.
Поверни виправлений JSON з РІВНО ${mapping.slides.length} слайдами.`

    const ciRetry = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: SYSTEM_VERBATIM,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: raw },
        { role: 'user', content: retryPrompt },
      ],
    })
    const ciContent = ciRetry.content[0]
    if (ciContent.type === 'text') {
      try {
        const ciMapping = parseJSON(ciContent.text.trim())
        if (ciMapping.slides.length === mapping.slides.length) {
          slides  = buildSlides(ciMapping)
          missing = findMissing(slides)
        }
      } catch { /* keep original if JSON parse fails */ }
    }
  }

  // ── Per-sheet content-integrity log ──────────────────────────────────────
  if (hasSheets) {
    let anyFail = false
    slides.forEach((slide, i) => {
      const [start, end] = sheetRanges[i] ?? [0, -1]
      const sheetFrags = fragments.slice(start, end + 1).filter(Boolean)
      const m = missing[i] ?? []
      const mappedCount = sheetFrags.length - m.length
      const pass = m.length === 0
      if (!pass) anyFail = true
      console.log(
        `[content-integrity] sheet ${i + 1} "${(sheets[i]?.[0] ?? '').slice(0, 40)}": ` +
        `input_blocks=${sheetFrags.length} | mapped_blocks=${mappedCount} | ` +
        `missing_texts=${JSON.stringify(m.map(t => t.slice(0, 50)))} → ${pass ? 'PASS' : 'FAIL'}`,
      )
    })
    if (anyFail) {
      const lost = missing.flatMap((m, i) => m.map(t => `sheet ${i + 1}: "${t.slice(0, 80)}"`))
      throw new Error(`[content-integrity] Контент втрачено після retry. Фрагменти без слота:\n${lost.join('\n')}`)
    }
  }

  // Per-sheet composition log
  if (hasSheets) {
    slides.forEach((slide, i) => {
      const firstWords = (sheets[i]?.[0] ?? '').slice(0, 50)
      console.log(`[mapToPlan] sheet ${i + 1} "${firstWords}" → slide ${i + 1} (${slide.composition})`)
    })
    console.log(`[mapToPlan] total: ${sheets.length} sheets → ${slides.length} slides`)
  }

  const fragmentGroups: string[][] | undefined = hasSheets
    ? sheetRanges.map(([start, end]) => fragments.slice(start, end + 1).filter(Boolean))
    : undefined

  return { theme, slides, sourceText: text, sheetCount: targetCount >= 2 ? targetCount : undefined, fragmentGroups }
}
