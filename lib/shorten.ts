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

  // Item count is structure, and structure belongs to whoever wrote the brief. Every point
  // must still be there — reworded, not removed. This replaces a weaker rule that only
  // objected when a whole list collapsed into one paragraph, which let 5 bullets come back
  // as 3 and call it shortening.
  const origList = original.split('\n').map(l => l.trim()).filter(Boolean)
  const newList  = shortened.split('\n').map(l => l.trim()).filter(Boolean)
  if (origList.length !== newList.length) {
    problems.push(`змінилась кількість пунктів: було ${origList.length}, стало ${newList.length}`)
  }

  // Per-line limits. The count above stops whole points from vanishing; these stop a point
  // from being gutted while its neighbours are spared. That came from the same instinct —
  // the model meets the overall target by taking it out of whichever line gives way easiest,
  // and what gives way easiest is usually the clause carrying the meaning:
  //
  //   "Fast-track у компанію, куди складно потрапити" → "Fast-track у компанію"   (-53%)
  //   "Ростеш так, як люди навколо. Обирай оточення"  → "Ростеш як люди навколо"  (-50%)
  //   "Фокус-групи, «краш дамі», опитування"          → "Фокус-групи, опитування" (-36%)
  //
  // on slots whose targets were 33% and 20%. So no line may be cut far past the slot's own
  // target; the floor of 25 points keeps a small target from making the task impossible.
  //
  // And no line may grow. "Відбір, тестування" came back as "Відбір і тестування" — a line
  // rewritten for nothing, longer than it started, on a slot being shortened.
  if (origList.length === newList.length) {
    const cap = Math.max(25, Math.round(targetCutPct * 1.4))
    for (let i = 0; i < origList.length; i++) {
      const before = origList[i].length
      const after  = newList[i].length
      if (!before) continue
      const lineCut = Math.round((1 - after / before) * 100)
      if (lineCut < 0) {
        problems.push(`рядок став довшим: "${origList[i].slice(0, 32)}"`)
      } else if (lineCut > cap) {
        problems.push(`рядок зрізано на ${lineCut}% при цілі ${targetCutPct}%: "${origList[i].slice(0, 40)}"`)
      }
    }
  }

  // The first line of a card is its group heading — the generator draws it a step larger,
  // and it is what reads as the highlight on the slide. Dropping it is not shortening, it is
  // restructuring: the card loses its heading and the line beneath is promoted into a role
  // it was not written for.
  //
  // Detected exactly rather than by similarity: if the new opening line is a line that stood
  // LATER in the original, the heading was deleted rather than trimmed. Rewording the
  // heading stays allowed — that produces a first line matching nothing, which passes.
  // Seen on deck 1sOCs…HPPg, slide 6: "Proof of Talents" and "Місце для амбітного старту"
  // both gone, while the untouched sibling variant kept them.
  if (origList.length > 1 && newList.length && origList.slice(1).includes(newList[0])) {
    problems.push(`викинуто заголовок групи: "${origList[0].slice(0, 40)}"`)
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

// The number of items on a slide is the slide's structure, and structure is the client's,
// not ours. An earlier version let the model delete whole bullets once the required cut went
// past a quarter — that reached the target, and it did so by removing points the brief made
// ("Створення ефекту word of mouth", "Університет навчив тебе думати. Ми навчимо тебе
// діяти"). Shortening a deck must not decide which of someone's arguments survives.
//
// The trade was backwards. That version also forbade rephrasing — "remove words, do not
// restate" — and trimming words inside fixed sentences tops out somewhere near a fifth of
// the text, which is exactly why deleting an item became the only way to reach 39%.
//
// So: rephrasing is allowed, deleting is not. Saying the same point in fewer words
// compresses far more than shaving adjectives, and it leaves every point standing. When even
// that cannot reach the target, the honest answer is to refuse and say so — the person can
// then shorten the brief themselves, where they know what matters.
export function shortenPrompt(text: string, targetCutPct: number): string {
  const lines = text.split('\n').filter(l => l.trim()).length

  return `Скороти цей текст для слайда презентації приблизно на ${targetCutPct}%.

ГОЛОВНЕ ПРАВИЛО: рядків має лишитись рівно ${lines} — стільки ж, скільки зараз.
Кожен пункт лишається на місці. Жоден не можна викинути чи злити з іншим.

ЯК СКОРОЧУВАТИ:
1. Перефразуй кожен пункт коротше — тією ж мовою, зберігаючи його думку повністю.
2. Скорочуй ВСІ рядки приблизно однаково. Не можна вирізати половину одного рядка, щоб не чіпати інші: саме в тій половині зазвичай і лежить сенс.
3. Уточнення — це не зайве слово. «у компанію, куди складно потрапити» без другої частини втрачає те, заради чого написане. «Обирай оточення» після «ростеш як люди навколо» — це заклик, не повтор.
4. Перелік через кому всередині рядка — теж перелік. Його елементи не викидати.
5. Якщо рядок уже короткий і зрізати в ньому нема чого — лиши його дослівно. Переписувати заради переписування не треба, і рядок у жодному разі не має стати довшим.
6. НЕ додавай жодного числа, назви, імені чи факту, якого немає в оригіналі.
7. ПЕРШИЙ рядок — заголовок картки. Він лишається першим: скоротити можна, викинути ні.
8. Не додавай заголовків, пояснень, лапок, коментарів і нумерації, якої не було.
9. Мова та сама, що в оригіналі.

Якщо скоротити на ${targetCutPct}% без втрати жодного пункту неможливо — скороти настільки, наскільки виходить, але рядків лиши ${lines}.

Поверни ТІЛЬКИ скорочений текст, без нічого зайвого.

ОРИГІНАЛ:
${text}`
}
