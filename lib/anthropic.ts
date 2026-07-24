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
- two_columns → СТРОГО 2 паралельні тези (не більше, не менше). ЗАГОЛОВОК ОБОВ'ЯЗКОВИЙ — без нього слайд виглядає як фрагмент без контексту.
- three_columns → СТРОГО 3 кроки / пункти без нумерації (не більше, не менше).
- three_columns_num → СТРОГО 3 послідовних кроки з акцентними номерами 1/2/3. Тільки dark-тема.
- four_columns → СТРОГО 4 рівних пункти у картках без нумерації. Слоти: КОЛОНКА_1..4. Тільки dark-тема.
- four_columns_num → СТРОГО 4 послідовних кроки з акцентними номерами 01/02/03/04. Слоти: КОЛОНКА_1..4. Тільки dark-тема.
- columns_flex → 2–4 паралельних пункти чисто текстом (без карток і нумерації). Слоти: КОЛОНКА_1, КОЛОНКА_2, КОЛОНКА_3? (опціонально), КОЛОНКА_4? (опціонально). НІКОЛИ не використовуй КАРТКА_N для columns_flex.
- kpi_cards → набір метрик (2–4 картки). ЗНАЧЕННЯ = тільки число або одиниця ≤10 символів: «35», «2M+», «42%». ПІДПИС = короткий опис без повторення числа (НЕ «2 000 000+ застосунків», а «застосунків доступно»). ТЕКСТ ≤70 символів — субтитул, не абзац.
- bento_right_2/3/2x2 → велика теза + 2/3/4 числових або структурованих пунктів. Порожніх карток не лишати.
- bento_bottom_4 → заголовок зверху + 4 рівні пункти в рядок знизу. Тільки dark-тема.
- agenda_3 → РІВНО 3 пункти (3 колонки × 1 рядок). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..ПУНКТ_3 БЕЗ нумерації. Тільки якщо пунктів рівно 3.
- agenda_4 → РІВНО 4 пункти (2 колонки × 2 рядки). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..ПУНКТ_4 БЕЗ нумерації. Тільки якщо пунктів рівно 4.
- agenda_5 → РІВНО 5 пунктів (3 кол. × рядок 1 + 2 кол. × рядок 2). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..ПУНКТ_5 БЕЗ нумерації. Тільки якщо пунктів рівно 5.
- agenda_6 → РІВНО 6 пунктів (3 колонки × 2 рядки). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..ПУНКТ_6 БЕЗ нумерації (номери 01..06 автоматичні). Тільки якщо пунктів рівно 6.
- agenda_7 → РІВНО 7 пунктів (4 кол. × рядок 1 + 3 кол. × рядок 2). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..ПУНКТ_7 БЕЗ нумерації. Тільки якщо пунктів рівно 7.
- agenda_8 → РІВНО 8 пунктів (4 колонки × 2 рядки). ЗАГОЛОВОК = "Адженда". ПУНКТ_1..ПУНКТ_8 БЕЗ нумерації. Тільки якщо пунктів рівно 8.
- title_photo → Як title_body, але з фото справа (половина екрану). ЗАГОЛОВОК(≤80) — теза. ТЕКСТ?(≤300) — опціональний абзац. ФОТО?(≤300) — URL (http...) якщо вказано в ТЗ, інакше null (рандомне фото автоматично). Обирай замість title_body коли слайд виграє від візуального акценту: відкриття теми, ключова думка, closing.

## ЖОРСТКІ ЗАБОРОНИ
- НЕ розбивати плоский список на кілька слайдів — завжди один слайд.
- Не дублювати ЗАГОЛОВОК між сусідніми слайдами.
- Ніколи не вставляти символ «*» в жоден слот.
- Логіка: короткі мітки → badges; довгі пункти → title_body; 2+ іменовані групи → bento; метрики → kpi_cards.
- **closing ЗАВЖДИ фінальний слайд** — після closing НІЧОГО. Якщо Q&A або подяка є ОКРЕМИМ аркушем — це section/section_red перед closing. Якщо є лише один останній аркуш з Q&A чи подякою — це і є closing (ЗАГОЛОВОК = той рядок).
- **НЕ фрагментуй контент з іншого слайду.** Якщо 4 пункти вже показані разом (bento_bottom_4 / four_columns), НЕ створюй окремий two_columns із 2 з цих 4 пунктів — це виглядає як уривок без сенсу. Або всі 4 разом, або новий слайд з новим контентом.
- **КОЛОНКА_N і КАРТКА_N — РІВНО ОДИН фрагмент кожен.** Ніколи не присвоюй масив [i, j, ...] у КОЛОНКА_N або КАРТКА_N. Якщо пунктів рівно 4 і не метрики — ОБОВ'ЯЗКОВО four_columns або four_columns_num (КОЛОНКА_1..4), НІКОЛИ не three_columns або three_columns_num. columns_flex — тільки для тексту без карток.
- **bento_right_N використовує КАРТКА_N, не КОЛОНКА_N.** Для bento_right_2 → КАРТКА_1, КАРТКА_2. Для bento_right_3 → КАРТКА_1..3. Для bento_right_2x2 → КАРТКА_1..4. НІКОЛИ не використовуй КОЛОНКА_N для bento. Якщо пунктів 4 і всі є метриками — kpi_cards.

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

Кожен фрагмент може мати підказки структури з оригінального слайду:
- "• текст" / "  • текст" — рядок був буліт-пунктом (відступ = вкладеність). Рядок без "•" перед буліт-пунктами тієї ж фігури — це заголовок групи, а буліти під ним — її вміст. Не змішуй заголовок групи з пунктом списку в один "рівнозначний" фрагмент.
- "(колонка N)" — фігура на слайді візуально стоїть у N-й колонці (зліва направо). Фрагменти з однаковим N розташовані в одній колонці й стосуються однієї теми/групи — фрагменти з різним N є ПАРАЛЕЛЬНИМИ, окремими групами (типовий кандидат на two_columns/three_columns з КОЛОНКА_N по кожній), а не одним цілим текстом.

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
10. КОЛОНКА_N і КАРТКА_N — РІВНО ОДИН індекс кожен (ніколи масив). two_columns → СТРОГО 2. three_columns / three_columns_num → СТРОГО 3. four_columns / four_columns_num → СТРОГО 4 (КОЛОНКА_1..4). Якщо пунктів рівно 4 і не метрики — four_columns або four_columns_num, НІКОЛИ three_columns. bento_right_N → КАРТКА_N (не КОЛОНКА_N): bento_right_2→КАРТКА_1/2, bento_right_3→КАРТКА_1/2/3, bento_right_2x2→КАРТКА_1/2/3/4.
11. agenda_3/4/5/6/7/8 → слайди адженди. ЗАГОЛОВОК="Адженда". ПУНКТ_N = по одному індексу, текст БЕЗ нумерації (номери 01..0N автоматичні). Вибирай СТРОГО за кількістю пунктів: 3→agenda_3, 4→agenda_4, 5→agenda_5, 6→agenda_6, 7→agenda_7, 8→agenda_8. Якщо пунктів не рівно N — НЕ використовуй agenda_N.
12. title_photo → Як title_body з фото справа. ЗАГОЛОВОК(обов'язково) + ТЕКСТ?(опціонально) + ФОТО?(URL якщо є в тексті, інакше null). Обирай замість title_body коли тема виграє від візуального акценту.

Виводь ТІЛЬКИ JSON (без markdown):
{ "slides": [ { "composition": "cover", "assignment": { "ЗАГОЛОВОК": 0, "ДАТА": null } } ] }`

type SlideAssignment = {
  composition: string
  assignment: Record<string, number | number[] | null>
}

// Max chars per column/card slot — calibrated to real overflow cases (150-270 chars).
// If any slot exceeds this → text overflows even at minimum font size.
const COMP_SLOT_MAX_CHARS: Record<string, number> = {
  columns_flex:           160,
  two_columns:            200,
  two_columns_labeled:    200,
  two_columns_plain:      200,
  two_columns_timeline:   200,
  bento_right_2:          200,
  three_columns:          150,
  three_columns_num:      150,
  three_columns_timeline: 150,
  bento_right_3:          150,
  bento_right_2x2:        130,
  four_columns:           130,
  four_columns_num:       130,
  bento_bottom_4:         130,
  four_columns_paren:     110,
  four_columns_bubble:    110,
}

const COL_SLOT_KEYS = ['КОЛОНКА_1','КОЛОНКА_2','КОЛОНКА_3','КОЛОНКА_4',
                       'КАРТКА_1','КАРТКА_2','КАРТКА_3','КАРТКА_4']

// Corrects common LLM slot-naming mistakes — runs in both 1to1 and free-form paths.
function applyMappingGuards(composition: string, slots: Record<string, string>, slideNum: number): string {
  // Caption-guard: title_body's caption slot is named ПІДПИС (no suffix). The LLM
  // sometimes still emits ПІДПИС_1/ПІДПИС_2 (pattern-matched from two_columns_labeled) —
  // that key doesn't exist on title_body, so it would silently vanish. Reattach it.
  if (composition === 'title_body') {
    for (const key of ['ПІДПИС_1', 'ПІДПИС_2']) {
      const val = (slots[key] ?? '').trim()
      if (!val) continue
      if (!(slots['ПІДПИС'] ?? '').trim()) {
        slots['ПІДПИС'] = val
      } else {
        slots['ТЕКСТ'] = [slots['ТЕКСТ'], val].filter(Boolean).join('\n')
      }
      delete slots[key]
      console.warn(`[caption-guard] slide ${slideNum}: title_body ${key} → ПІДПИС`)
    }
  }

  // Long-text guard: if any column/card slot exceeds the composition char limit → title_body.
  // Merges all column/card values into ТЕКСТ (paragraph-separated).
  // No upper bound on merged length: title_body at min font always fits more than any column layout.
  const slotMax = COMP_SLOT_MAX_CHARS[composition]
  if (slotMax !== undefined) {
    const longestSlot = COL_SLOT_KEYS.reduce((max, k) => Math.max(max, (slots[k] ?? '').length), 0)
    if (longestSlot > slotMax) {
      const parts = COL_SLOT_KEYS.map(k => slots[k]).filter(Boolean)
      const merged = parts.join('\n\n')
      for (const k of COL_SLOT_KEYS) delete slots[k]
      slots['ТЕКСТ'] = merged
      console.warn(`[long-text-guard] slide ${slideNum}: ${composition}→title_body (longest=${longestSlot}>${slotMax}, merged=${merged.length})`)
      return 'title_body'
    }
  }

  // columns_flex uses КОЛОНКА_N — if LLM put КАРТКА_N, rename.
  if (composition === 'columns_flex') {
    for (let n = 1; n <= 4; n++) {
      const k = `КАРТКА_${n}`
      if (slots[k] !== undefined) {
        slots[`КОЛОНКА_${n}`] = slots[k]
        delete slots[k]
        console.warn(`[columns_flex-guard] slide ${slideNum}: renamed КАРТКА_${n} → КОЛОНКА_${n}`)
      }
    }
  }
  // three_columns/three_columns_num support only 3 columns — upgrade to four_columns/four_columns_num if 4 items.
  if ((composition === 'three_columns' || composition === 'three_columns_num') && slots['КОЛОНКА_4']) {
    const target = composition === 'three_columns_num' ? 'four_columns_num' : 'four_columns'
    console.warn(`[four-col-guard] slide ${slideNum}: ${composition} has КОЛОНКА_4 → remapped to ${target}`)
    composition = target
  }
  // bento_right_N uses КАРТКА_N — if LLM put КОЛОНКА_N, rename and pick correct variant.
  if (composition.startsWith('bento_right_') && slots['КОЛОНКА_1'] !== undefined) {
    const colCount = [1, 2, 3, 4].filter(n => slots[`КОЛОНКА_${n}`] !== undefined).length
    for (let n = 1; n <= 4; n++) {
      if (slots[`КОЛОНКА_${n}`] !== undefined) {
        slots[`КАРТКА_${n}`] = slots[`КОЛОНКА_${n}`]
        delete slots[`КОЛОНКА_${n}`]
      }
    }
    const fixed = colCount === 4 ? 'bento_right_2x2' : colCount === 2 ? 'bento_right_2' : 'bento_right_3'
    console.warn(`[bento-right-guard] slide ${slideNum}: КОЛОНКА_N → КАРТКА_N, ${composition} → ${fixed} (${colCount} items)`)
    composition = fixed
  }
  return composition
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
      const items = s.texts.map((t, ti) => {
        const col = s.columns?.[ti]
        const colTag = col !== null && col !== undefined ? ` (колонка ${col + 1})` : ''
        return `  [${ti}]${colTag} ${JSON.stringify(t.slice(0, 300))}`
      })
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
  let json = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '').trim() : raw
  let mapping: { slides: SlideAssignment[] }
  try {
    mapping = JSON.parse(json) as { slides: SlideAssignment[] }
  } catch {
    const start = json.indexOf('{'), end = json.lastIndexOf('}')
    if (start !== -1 && end > start) {
      json = json.slice(start, end + 1)
      mapping = JSON.parse(json) as { slides: SlideAssignment[] }
    } else {
      throw new SyntaxError(`No JSON object found in 1to1 LLM response (len=${json.length})`)
    }
  }

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

      const composition = applyMappingGuards(m.composition || 'title_body', slots, i + 1)
      return {
        id: `slide_${i + 1}`,
        composition,
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
    let s = raw.trim()
    // Strip markdown fences
    if (s.startsWith('```')) s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '').trim()
    // Try direct parse first
    try { return JSON.parse(s) as { slides: SlideAssignment[] } } catch { /* fall through */ }
    // Extract JSON object between first { and last } — handles leading/trailing prose
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start !== -1 && end > start) {
      const extracted = s.slice(start, end + 1)
      console.warn(`[parseJSON] extracted JSON from position ${start}..${end} (raw len=${s.length})`)
      return JSON.parse(extracted) as { slides: SlideAssignment[] }
    }
    throw new SyntaxError(`No JSON object found in LLM response (len=${s.length})`)
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

      // Detect "collapsed mapping": LLM assigned [all indices] to every slot → all slots identical.
      // Fix: re-assign each sheet fragment to one composition slot in order.
      if (hasSheets) {
        const filledValues = Object.values(slots).filter(Boolean)
        const allSame = filledValues.length >= 2 && filledValues.every(v => v === filledValues[0])
        if (allSame) {
          const [start, end] = sheetRanges[i] ?? [0, -1]
          const sheetFrags = fragments.slice(start, end + 1).filter(Boolean)
          if (sheetFrags.length >= 2) {
            const compDef = PHASE0_COMPOSITIONS.find(c => c.id === s.composition)
            if (compDef) {
              let orderedSlotNames: string[]
              if (s.composition === 'kpi_cards') {
                // Skip ПІДПИС — auto-filled by kpi_sanitise from ЗНАЧЕННЯ.
                // If second fragment is body text (not starting with digit), assign to ТЕКСТ.
                const secondFrag = sheetFrags[1] ?? ''
                const isBodyText = secondFrag.length > 40 && !/^[\d$€£±~≈<>]/.test(secondFrag.trim())
                orderedSlotNames = ['ЗАГОЛОВОК']
                if (isBodyText) orderedSlotNames.push('ТЕКСТ')
                const metricStart = isBodyText ? 2 : 1
                for (let n = 1; n <= 4 && metricStart + n - 1 < sheetFrags.length; n++) {
                  orderedSlotNames.push(`КАРТКА_${n}_ЗНАЧЕННЯ`)
                }
              } else {
                orderedSlotNames = compDef.slots
                  .filter(sl => sl.type === 'text' && !sl.name.startsWith('ЗОБРАЖЕННЯ'))
                  .map(sl => sl.name)
              }
              for (const k of Object.keys(slots)) delete slots[k]
              orderedSlotNames.forEach((slotName, idx) => {
                if (sheetFrags[idx]) slots[slotName] = sheetFrags[idx]
              })
              console.warn(
                `[auto-remap] slide ${i + 1} (${s.composition}): collapsed-mapping → ` +
                `re-assigned ${Math.min(sheetFrags.length, orderedSlotNames.length)} frags: ${orderedSlotNames.slice(0, sheetFrags.length).join(', ')}`
              )
            }
          }
        }
      }

      const composition = applyMappingGuards(s.composition || 'title_body', slots, i + 1)
      return { id: `slide_${i + 1}`, composition, slots, flags: {} }
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

  // Detect "allSame" slides where auto-remap couldn't split (1-fragment sheet).
  const allSameIdxs = slides
    .map((slide, i) => {
      const vals = Object.values(slide.slots).filter(Boolean)
      return vals.length >= 2 && vals.every(v => v === vals[0]) ? i : -1
    })
    .filter(n => n >= 0)
  const hasAllSame = allSameIdxs.length > 0

  // ── Content-integrity retry ───────────────────────────────────────────────
  if ((hasMissing || hasAllSame) && hasSheets) {
    const retryParts: string[] = []

    if (hasMissing) {
      const missingReport = missing
        .map((m, i) => m.length > 0 ? `Аркуш ${i + 1}: не призначено ${m.length} фрагм.: ${m.map(f => `"${f.slice(0, 60)}"`).join(', ')}` : null)
        .filter(Boolean)
        .join('\n')
      console.warn(`[content-integrity] FAIL before retry:\n${missingReport}`)
      retryParts.push(`ПОМИЛКА: частина фрагментів не потрапила в жоден слот — контент буде ВТРАЧЕНО.\n${missingReport}`)
    }

    if (hasAllSame) {
      const allSameReport = allSameIdxs.map(i => {
        const slide = slides[i]
        const val = Object.values(slide.slots)[0] ?? ''
        return `Аркуш ${i + 1} (${slide.composition}): усі слоти однакові "${val.slice(0, 60)}…" — призначай різний контент у кожен слот АБО зміни composition`
      }).join('\n')
      console.warn(`[allSame-retry] before retry:\n${allSameReport}`)
      retryParts.push(`ПОМИЛКА "всі слоти однакові" — контент дублюється:\n${allSameReport}`)
    }

    const retryPrompt = `${retryParts.join('\n\n')}

Правила виправлення (виконай ВСІ):
1. Аркуш з 1 коротким рядком ("Дякуємо!", "Q&A", будь-який перехідний заголовок) → ОБОВ'ЯЗКОВО призначай ЗАГОЛОВОК = індекс того рядка. Не залишай assignment порожнім. Залишай composition section / section_red / closing — НЕ міняй на bento/kpi.
2. Аркуш з кількома рядками → обери підходящу composition і призначай кожен рядок у окремий слот. Якщо не вистачає слотів — обери bento_right_3, title_body тощо.
3. Якщо аркуш містить 1 довгий рядок-список — ЗМІНИ composition на title_body або badges і призначай весь fragment в 1 слот (ТЕКСТ або ПУНКТИ). НЕ дублюй один fragment у кількох слотах.
4. Для kpi_cards: ТЕКСТ ≤70 символів — якщо вміст аркуша довший і немає окремих числових значень/підписів (ЗНАЧЕННЯ ≤10 символів), ОБОВ'ЯЗКОВО зміни composition на title_body.
5. НЕ змінюй кількість слайдів і НЕ зливай аркуші.
6. Якщо в аркуші більше фрагментів ніж слотів у будь-якій одній композиції (наприклад, 5+ пронумерованих пунктів agenda) — ОБОВ'ЯЗКОВО використовуй title_body і поклади ПЕРШИЙ фрагмент у ЗАГОЛОВОК, а решту через "\\n" в ТЕКСТ. НЕ кидай жоден фрагмент без слота.
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
      // Deterministic fallback: downgrade slides with missing fragments to title_body,
      // concatenating all sheet fragments so no content is lost.
      slides.forEach((slide, i) => {
        if ((missing[i]?.length ?? 0) === 0) return
        const [start, end] = sheetRanges[i] ?? [0, -1]
        const sheetFrags = fragments.slice(start, end + 1).filter(Boolean)
        slide.composition = 'title_body'
        slide.slots = {}
        if (sheetFrags[0]) slide.slots['ЗАГОЛОВОК'] = sheetFrags[0]
        if (sheetFrags.length > 1) slide.slots['ТЕКСТ'] = sheetFrags.slice(1).join('\n')
        missing[i] = []
        console.warn(`[content-integrity-fallback] slide ${i + 1}: downgraded to title_body, preserved ${sheetFrags.length} frags`)
      })
    }
  }

  // ── Final-split: fix remaining allSame slides with 1-fragment sheets ──────
  // If LLM retry still produces allSame (it can't split a single fragment),
  // split the fragment deterministically by punctuation (;  .  ,) into sub-parts.
  if (hasSheets) {
    slides.forEach((slide, i) => {
      const vals = Object.values(slide.slots).filter(Boolean)
      if (vals.length < 2 || !vals.every(v => v === vals[0])) return
      const [start, end] = sheetRanges[i] ?? [0, -1]
      const sheetFrags = fragments.slice(start, end + 1).filter(Boolean)
      if (sheetFrags.length !== 1) return  // multi-frag case handled by auto-remap

      const raw = sheetFrags[0]
      let subFrags: string[] = []

      // 1. Semicolons — most reliable list separator
      const bySemi = raw.split(/;\s*/).map(s => s.trim()).filter(s => s.length > 5)
      if (bySemi.length >= 2) subFrags = bySemi

      // 2. Periods followed by a space (sentence boundary)
      if (!subFrags.length) {
        const bySent = raw.split(/\.\s+/).map(s => s.trim()).filter(s => s.length > 5)
        if (bySent.length >= 2) subFrags = bySent
      }

      // 3. Any comma — broad fallback, keep only chunks > 15 chars to filter noise
      if (!subFrags.length) {
        const byComma = raw.split(/,\s*/).map(s => s.trim()).filter(s => s.length > 15)
        if (byComma.length >= 2) subFrags = byComma
      }

      // 4. Hard fallback: assign entire fragment to the first non-optional body slot;
      //    clears all duplicated slots so the slide at least renders something useful.
      if (subFrags.length < 2) {
        const compDef4 = PHASE0_COMPOSITIONS.find(c => c.id === slide.composition)
        if (!compDef4) return
        const bodySlot = compDef4.slots.find(
          sl => sl.type === 'text' && sl.name !== 'ЗАГОЛОВОК' && !sl.name.includes('ПІДПИС') && !sl.optional
        ) ?? compDef4.slots.find(sl => sl.type === 'text')
        if (!bodySlot) return
        for (const k of Object.keys(slide.slots)) delete slide.slots[k]
        slide.slots[bodySlot.name] = raw
        console.warn(`[final-split] slide ${i + 1} (${slide.composition}): no delimiter → assigned all to ${bodySlot.name}`)
        return
      }

      const compDef = PHASE0_COMPOSITIONS.find(c => c.id === slide.composition)
      if (!compDef) return

      let orderedSlotNames: string[]
      if (slide.composition === 'kpi_cards') {
        const secondFrag = subFrags[1] ?? ''
        const isBodyText = secondFrag.length > 40 && !/^[\d$€£±~≈<>]/.test(secondFrag.trim())
        orderedSlotNames = ['ЗАГОЛОВОК']
        if (isBodyText) orderedSlotNames.push('ТЕКСТ')
        const metricStart = isBodyText ? 2 : 1
        for (let n = 1; n <= 4 && metricStart + n - 1 < subFrags.length; n++) {
          orderedSlotNames.push(`КАРТКА_${n}_ЗНАЧЕННЯ`)
        }
      } else {
        orderedSlotNames = compDef.slots
          .filter(sl => sl.type === 'text' && !sl.name.startsWith('ЗОБРАЖЕННЯ'))
          .map(sl => sl.name)
      }

      for (const k of Object.keys(slide.slots)) delete slide.slots[k]
      orderedSlotNames.forEach((slotName, idx) => {
        if (subFrags[idx]) slide.slots[slotName] = subFrags[idx]
      })
      console.warn(
        `[final-split] slide ${i + 1} (${slide.composition}): allSame 1-frag → ` +
        `split → ${subFrags.length} sub-frags → ${orderedSlotNames.slice(0, subFrags.length).join(', ')}`,
      )
    })
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
