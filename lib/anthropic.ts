import Anthropic from '@anthropic-ai/sdk'
import { PHASE0_COMPOSITIONS } from './compositions'
import type { SlidePlan, Theme } from './types'
import type { SourceSlide } from '@/app/api/fetch-doc/route'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `Твоє завдання: з очищеного контенту ТЗ скласти план слайдів — послідовність композицій із заповненими слотами. Ти НЕ малюєш слайди й НЕ рахуєш геометрію. Ти лише обираєш композиції з каталогу й розкладаєш текст по слотах.

## Жорсткі правила
1. Використовуй ТІЛЬКИ композиції з наданого каталогу. Не вигадуй нових.
2. Використовуй ТІЛЬКИ слоти, визначені для обраної композиції.
3. **max_chars — абсолютний ліміт.** Рахуй символи перед тим як записати. Якщо не вміщається — постав менше тексту, обери головне. Ніколи не обрізай речення посередині і не додавай «…».
4. Тема всього деку одна: dark АБО red.
5. Перший слайд — завжди cover. Останній — завжди closing.
6. Ігноруй image-слоти (ЗОБРАЖЕННЯ_N) — залишай їх порожніми.
7. ДАТА — тільки коротка дата, наприклад «25 червня 2026» (≤20 символів). Не пиши опис чи назву події.

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
        "ЗАГОЛОВОК": "Назва або тема презентації",
        "ПІДЗАГОЛОВОК": "Короткий підзаголовок або опис події (необов'язково)",
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

type SlotViolation = {
  slideId: string
  composition: string
  slotName: string
  currentValue: string
  limit: number
  hint?: string  // slot-specific guidance for the LLM
}

// Slot-specific hints for slots that are systematically over-filled
const SLOT_HINTS: Record<string, string> = {
  ДАТА:  'тільки дата, наприклад «29 червня 2026» — без назви події чи опису',
  ТЕКСТ: 'максимум 1 коротке речення-субтитул; не абзац і не список',
}

function getPlanViolations(plan: SlidePlan): SlotViolation[] {
  const violations: SlotViolation[] = []
  for (const slide of plan.slides) {
    const comp = PHASE0_COMPOSITIONS.find(c => c.id === slide.composition)
    if (!comp) continue
    for (const def of comp.slots) {
      if (def.type !== 'text' || !def.max_chars) continue
      const val = slide.slots[def.name] ?? ''
      if (val.length > def.max_chars) {
        violations.push({
          slideId:      slide.id,
          composition:  slide.composition,
          slotName:     def.name,
          currentValue: val,
          limit:        def.max_chars,
          hint:         SLOT_HINTS[def.name],
        })
      }
    }
  }
  return violations
}

// Ask the LLM to return ONLY the fixes for violating slots — not the full plan.
async function fixSlotViolations(violations: SlotViolation[]): Promise<void> {
  const items = violations.map(v => {
    const hint = v.hint ? ` (${v.hint})` : ''
    return `- ${v.slideId} → ${v.slotName} [ліміт ${v.limit} символів${hint}]:\n  Поточний текст (${v.currentValue.length} символів): "${v.currentValue}"`
  }).join('\n')

  const prompt = `Ці слоти перевищують ліміт символів. Скороти кожен — поклади головну думку в менше слів, не обрізай речення посередині.

${items}

Поверни ТІЛЬКИ JSON-масив виправлень (без markdown):
[{"slideId":"...","slotName":"...","value":"..."}]`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })
  const content = response.content[0]
  if (content.type !== 'text') return

  const raw = content.text.trim()
  const clean = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw
  const fixes = JSON.parse(clean) as { slideId: string; slotName: string; value: string }[]

  // Patch violations in-place — only update slots that were fixed
  for (const fix of fixes) {
    const v = violations.find(v => v.slideId === fix.slideId && v.slotName === fix.slotName)
    if (!v) continue
    if (fix.value.length <= v.limit) {
      v.currentValue = fix.value  // used to patch plan below
    } else {
      console.warn(`[fix] ${fix.slideId}.${fix.slotName}: still ${fix.value.length}>${v.limit} after fix`)
    }
  }
}

const POST_GEN_SLOT_HINTS: Record<string, string> = {
  ДАТА:  'тільки дата, наприклад «29 червня 2026» — без назви події чи опису',
  ТЕКСТ: 'підпис-субтитул: ТІЛЬКИ ключові слова або 1-2 цифри. Викинь усі пояснення. Фраза, не речення.',
}

// Called by google.ts after validateDeck — repairs slides that still have max_chars FAILs.
// Each item carries the objectId of the text box so fixes are applied by ID, not by re-matching.
export async function fixOverflowSlots(
  items: Array<{ id: string; slotName: string; currentText: string; limit: number }>,
): Promise<Array<{ id: string; value: string }>> {
  const lines = items.map(it => {
    const hint = POST_GEN_SLOT_HINTS[it.slotName] ? ` (${POST_GEN_SLOT_HINTS[it.slotName]})` : ''
    return `- id: ${it.id}\n  слот: ${it.slotName}${hint}\n  ліміт: ${it.limit} символів\n  текст (${it.currentText.length} символів): "${it.currentText}"`
  }).join('\n\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Ці слоти перевищують ліміт символів. Перепиши кожен як короткий заголовок-підпис — ТІЛЬКИ ключові слова або цифри, без пояснень. ОБОВ'ЯЗКОВО вкластися в ліміт символів.\n\n${lines}\n\nПоверни ТІЛЬКИ JSON-масив (без markdown):\n[{"id":"...","value":"..."}]`,
    }],
  })

  const content = response.content[0]
  if (content.type !== 'text') return []
  const raw = content.text.trim()
  const clean = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw
  try {
    return JSON.parse(clean) as Array<{ id: string; value: string }>
  } catch {
    return []
  }
}

function parseJsonPlan(raw: string): SlidePlan {
  const clean = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw
  return JSON.parse(clean) as SlidePlan
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })
  const content = response.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic')

  const plan = parseJsonPlan(content.text.trim())

  // Surgical slot-level fix — up to 2 passes
  for (let pass = 0; pass < 2; pass++) {
    const violations = getPlanViolations(plan)
    if (violations.length === 0) break
    console.warn(`[mapToPlan] pass ${pass + 1}: ${violations.length} max_chars violation(s) — fixing slots`)
    try {
      await fixSlotViolations(violations)
      // Apply fixes back to plan
      for (const v of violations) {
        const slide = plan.slides.find(s => s.id === v.slideId)
        if (slide) slide.slots[v.slotName] = v.currentValue
      }
    } catch (e) {
      console.warn('[mapToPlan] slot fix failed:', e instanceof Error ? e.message : String(e))
      break
    }
  }

  const remaining = getPlanViolations(plan)
  if (remaining.length > 0) {
    console.warn('[mapToPlan] remaining violations after fixes:', remaining.map(v => `${v.slideId}.${v.slotName}: ${v.currentValue.length}>${v.limit}`).join(', '))
  }

  return plan
}
