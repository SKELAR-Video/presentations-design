// ─── Shortening: the only repair that rewrites the client's words ─────────────
// Everywhere else in this tool the model maps and the builder inserts text verbatim
// (docs/rules/content-mapping.md). This is the one deliberate exception, and it exists
// because splitting cannot help a sheet written as one unbroken paragraph — the case that
// showed up on the very first real deck.
//
// The guard is not "trust the prompt". It is a machine check, and its direction matters:
//
//   we verify that every figure and every name in the SHORTENED text exists in the
//   ORIGINAL — not the other way round.
//
// Dropping content is the entire point of shortening, so requiring the original's facts to
// survive would reject almost every honest result. What must never happen is the opposite:
// a number or a company name appearing on a slide that the client never wrote. That is
// invention, and invention is what this check catches.

// Digits, keeping decimal separators, dropping the spaces used as thousands separators
// (including the non-breaking ones this project inserts on purpose — see numbers.md).
const FIGURE = /\d[\d\s  .,]*/g

// A name we care about: an abbreviation (2+ capitals), or a Latin-script word inside
// otherwise Cyrillic copy — product and company names in these briefs are nearly always
// one of the two. Capitalised Cyrillic words are handled separately, because most of them
// are just sentence openings.
const ABBREV = /\b[\p{Lu}]{2,}\b/gu
const LATIN  = /\b[A-Za-z][A-Za-z0-9&.'-]{1,}\b/g

export function normalizeFigure(raw: string): string {
  return raw
    .replace(/[\s  ]/g, '')
    .replace(/,/g, '.')
    .replace(/\.$/, '')
}

// A leading "1." or "2)" is the shape of a list, not a fact about the world. Counting it as
// a figure made the audit reject an honest rewrite for "inventing" the number 1, purely
// because the model numbered its bullets — see the first live run.
const ENUMERATION = /^\s*\d{1,2}\s*[.)]\s+/

export function extractFigures(text: string): string[] {
  const body = text.split('\n').map(l => l.replace(ENUMERATION, '')).join('\n')
  return (body.match(FIGURE) ?? [])
    .map(normalizeFigure)
    .filter(f => /\d/.test(f))
}

// Capitalised words that are not simply starting a sentence. A word opening a line, or
// following . ! ? : … is skipped — treating "Компанія" at the head of a sentence as a
// protected name would make almost every rewrite look like invention.
export function extractCapitalised(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const tokens = line.split(/\s+/).filter(Boolean)
    let atSentenceStart = true
    for (const token of tokens) {
      const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      if (word && !atSentenceStart && /^\p{Lu}/u.test(word) && word.length > 2) {
        out.push(word)
      }
      atSentenceStart = /[.!?:;…]$/.test(token)
    }
  }
  return out
}

export function extractNames(text: string): string[] {
  const abbrev = text.match(ABBREV) ?? []
  const latin  = text.match(LATIN) ?? []
  return [...new Set([...abbrev, ...latin, ...extractCapitalised(text)])]
}

export type ShortenAudit = {
  ok: boolean
  problems: string[]
  cutPct: number
}

// Everything a shortened slot must satisfy before it is allowed anywhere near a slide.
// Fails closed: an unclear result is a rejected result, and the person keeps the deck they
// already had.
export function auditShortening(
  original: string,
  shortened: string,
  targetCutPct: number,
): ShortenAudit {
  const problems: string[] = []
  const before = original.trim().length
  const after  = shortened.trim().length
  const cutPct = before === 0 ? 0 : Math.round((1 - after / before) * 100)

  if (!shortened.trim()) {
    return { ok: false, problems: ['порожній результат'], cutPct: 100 }
  }
  if (after >= before) {
    problems.push(`не скоротилось: було ${before}, стало ${after} символів`)
  }

  const origFigures = new Set(extractFigures(original))
  const newFigures  = extractFigures(shortened).filter(f => !origFigures.has(f))
  if (newFigures.length) {
    problems.push(`вигадані числа: ${[...new Set(newFigures)].join(', ')}`)
  }

  const origNames = new Set(extractNames(original).map(n => n.toLowerCase()))
  const newNames  = extractNames(shortened).filter(n => !origNames.has(n.toLowerCase()))
  if (newNames.length) {
    problems.push(`вигадані назви: ${[...new Set(newNames)].join(', ')}`)
  }

  // A cut far short of the target leaves the slide just as unreadable as before, so it is
  // not worth rewriting the client's words for. Half the target is the bar: the measurement
  // is a ceiling on what is needed, not a quota to hit exactly.
  if (targetCutPct > 0 && cutPct < targetCutPct / 2) {
    problems.push(`скоротилось на ${cutPct}%, потрібно було близько ${targetCutPct}%`)
  }

  // Line count is structure, not text: a bulleted list that comes back as one paragraph is
  // a different slide, whatever the words say.
  const origLines = original.split('\n').filter(l => l.trim()).length
  const newLines  = shortened.split('\n').filter(l => l.trim()).length
  if (origLines > 1 && newLines === 1) {
    problems.push(`список злився в один абзац: було ${origLines} рядків, став 1`)
  }

  return { ok: problems.length === 0, problems, cutPct }
}

// The note written into a shortened slide's speaker notes. Plain prose, not JSON: this one
// is for a person — the client asking "where did my paragraph go" — while the ##SLOTS##
// block beside it is for the deck inspector. Returns null when nothing was shortened, so
// untouched slides carry no note at all.
export function originalTextNote(
  shortenedFrom: Record<string, string> | undefined,
): string | null {
  const entries = Object.entries(shortenedFrom ?? {}).filter(([, v]) => v?.trim())
  if (!entries.length) return null
  const blocks = entries.map(([slot, original]) => `[${slot}]\n${original.trim()}`)
  return `ОРИГІНАЛ З ТЗ (текст на слайді скорочено за рішенням людини)\n\n${blocks.join('\n\n')}\n`
}

// How much has to go decides what the model is allowed to do. Trimming words inside every
// line has a ceiling somewhere around a fifth of the text; asking for half while also
// forbidding the removal of any item is asking for something arithmetically impossible.
// The first live run proved it: 8% cut where 53% was needed, 15% where 39% was, on a prompt
// that ordered "as many lines out as came in".
const DROP_ITEMS_ABOVE_PCT = 25

export function shortenPrompt(text: string, targetCutPct: number): string {
  const lines = text.split('\n').filter(l => l.trim()).length
  const mayDropItems = targetCutPct > DROP_ITEMS_ABOVE_PCT && lines > 2

  const structureRule = mayDropItems
    ? `3. Щоб зрізати стільки, доведеться ПРИБРАТИ найменш важливі пункти цілком — це дозволено і очікувано. Залиши приблизно ${Math.max(2, Math.round(lines * (1 - targetCutPct / 100)))} з ${lines} пунктів, кожен окремим рядком. Пункти, які лишились, не зливай в один абзац.`
    : `3. Зберігай структуру: скільки рядків було, стільки має лишитись. Кожен рядок скорочуй окремо.`

  return `Скороти цей текст для слайда презентації приблизно на ${targetCutPct}%.

ПРАВИЛА:
1. Прибирай слова й цілі пункти — не переписуй зміст своїми словами.
2. НЕ додавай жодного числа, назви, імені чи факту, якого немає в оригіналі.
${structureRule}
4. Не додавай заголовків, пояснень, лапок, коментарів і нумерації, якої не було.
5. Мова та сама, що в оригіналі.

Поверни ТІЛЬКИ скорочений текст, без нічого зайвого.

ОРИГІНАЛ:
${text}`
}
