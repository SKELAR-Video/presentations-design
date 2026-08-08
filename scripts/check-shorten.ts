import { auditShortening, extractFigures, extractNames, originalTextNote, shortenPrompt } from '../lib/shorten'

// The audit is the whole safety of shortening, so it is tested the way a lock is tested:
// by trying to open it. Each case states what the audit must SAY, not merely that it runs.
//
// Direction under test: a figure or name may disappear (that is what shortening is), but
// nothing may appear that the original did not contain.

type Case = {
  name: string
  original: string
  shortened: string
  target: number
  expectOk: boolean
  expectMentions?: string   // substring the verdict must contain when it rejects
}

const CASES: Case[] = [
  {
    name: 'чесне скорочення — прибрані слова, факти на місці',
    original: 'Ми запустили новий процес онбордингу для 12 команд у 3 країнах\nЦе скоротило час виходу на роботу з 14 днів до 5 днів',
    shortened: 'Новий онбординг для 12 команд у 3 країнах\nВихід на роботу: з 14 до 5 днів',
    target: 30,
    expectOk: true,
  },
  {
    name: 'викинуло частину — це дозволено, це і є скорочення',
    original: 'Перший напрямок — аналітика ринку\nДругий — робота з партнерами Rozetka та Comfy\nТретій — маркетинг',
    shortened: 'Аналітика ринку\nПартнери\nМаркетинг',
    target: 50,
    expectOk: true,
  },
  {
    name: 'ВИГАДАЛО ЧИСЛО — має відхилити',
    original: 'Виручка зросла за рахунок нових каналів залучення клієнтів',
    shortened: 'Виручка зросла на 40% за рахунок нових каналів',
    target: 30,
    expectOk: false,
    expectMentions: 'вигадані числа',
  },
  {
    name: 'ВИГАДАЛО НАЗВУ — має відхилити',
    original: 'Ми працюємо з кількома великими мережами електроніки',
    shortened: 'Працюємо з Rozetka та Comfy',
    target: 30,
    expectOk: false,
    expectMentions: 'вигадані назви',
  },
  {
    name: 'нічого не скоротило — має відхилити',
    original: 'Короткий рядок про результати кварталу',
    shortened: 'Короткий рядок про результати кварталу за підсумками',
    target: 40,
    expectOk: false,
    expectMentions: 'не скоротилось',
  },
  {
    name: 'скоротило замало — має відхилити',
    original: 'А'.repeat(200),
    shortened: 'А'.repeat(195),
    target: 50,
    expectOk: false,
    expectMentions: 'скоротилось на',
  },
  {
    name: 'список злився в абзац — має відхилити',
    original: 'Перший пункт списку про щось\nДругий пункт списку про інше\nТретій пункт списку',
    shortened: 'Перший, другий і третій пункти',
    target: 50,
    expectOk: false,
    expectMentions: 'злився в один абзац',
  },
  {
    name: 'порожньо — має відхилити',
    original: 'Будь-який текст',
    shortened: '   ',
    target: 50,
    expectOk: false,
    expectMentions: 'порожній',
  },
]

let failed = 0

for (const c of CASES) {
  const audit = auditShortening(c.original, c.shortened, c.target)
  const problems: string[] = []

  if (audit.ok !== c.expectOk) {
    problems.push(`вердикт ${audit.ok ? 'ok' : 'відхилено'}, очікували ${c.expectOk ? 'ok' : 'відхилено'}`)
  }
  if (c.expectMentions && !audit.problems.join(' ').includes(c.expectMentions)) {
    problems.push(`причина не згадує «${c.expectMentions}»`)
  }

  const ok = problems.length === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  const delta = `${audit.cutPct >= 0 ? '-' : '+'}${Math.abs(audit.cutPct)}%`
  console.log(`      ${delta}  ${audit.ok ? 'прийнято' : `відхилено: ${audit.problems.join('; ')}`}`)
  for (const p of problems) console.log(`      ✗ ${p}`)
}

// Extraction itself, since everything above rests on it.
const figText = 'Зросло з 1 200 до 3,5 тис. за 14 днів, це +40%'
const figures = extractFigures(figText)
const figOk = figures.includes('1200') && figures.includes('3.5') && figures.includes('14') && figures.includes('40')
if (!figOk) failed++
console.log(`${figOk ? 'PASS' : 'FAIL'}  числа читаються разом із пробілами й комами`)
console.log(`      ${figures.join(' | ')}`)

// A capital opening a sentence is not a name — otherwise almost every honest rewrite would
// read as invention.
const nameText = 'Компанія вийшла на ринок. Партнером став Rozetka, підтримку дала EBRD у Києві'
const names = extractNames(nameText).map(n => n.toLowerCase())
const nameOk = names.includes('rozetka') && names.includes('ebrd') && names.includes('києві')
  && !names.includes('компанія') && !names.includes('партнером')
if (!nameOk) failed++
console.log(`${nameOk ? 'PASS' : 'FAIL'}  назви ловляться, початок речення — ні`)
console.log(`      ${extractNames(nameText).join(' | ')}`)

// The note that keeps the client's words in the file. Untouched slides must carry none —
// a note on every slide is noise, and noise is how a real one gets skipped.
const noNote = originalTextNote(undefined) === null && originalTextNote({}) === null
  && originalTextNote({ 'ТЕКСТ': '   ' }) === null
const note = originalTextNote({ 'ТЕКСТ': 'Повний абзац із ТЗ, який скоротили' }) ?? ''
const noteOk = noNote
  && note.includes('Повний абзац із ТЗ, який скоротили')
  && note.includes('[ТЕКСТ]')
  && note.includes('ОРИГІНАЛ З ТЗ')
if (!noteOk) failed++
console.log(`${noteOk ? 'PASS' : 'FAIL'}  оригінал іде в нотатки, і тільки коли є що класти`)
console.log(`      без скорочення: ${noNote ? 'нотатки немає' : 'НОТАТКА Є — помилка'}`)
console.log(`      зі скороченням: ${note.split('\n')[0]}`)

// Numbering a bullet is the shape of a list, not a claim about the world. Counting it as a
// figure rejected an honest rewrite for "inventing" the number 1 on the first live run.
const numbered = auditShortening(
  'Аналітика ринку і збір даних\nРобота з партнерами\nМаркетинг і залучення',
  '1. Аналітика ринку\n2. Партнери\n3. Маркетинг',
  30,
)
const enumOk = numbered.ok
if (!enumOk) failed++
console.log(`${enumOk ? 'PASS' : 'FAIL'}  нумерація списку не рахується вигаданими числами`)
console.log(`      ${numbered.ok ? 'прийнято' : `відхилено: ${numbered.problems.join('; ')}`}`)

// Trimming words inside every line tops out around a fifth of the text. Demanding half while
// also forbidding the removal of any item is arithmetically impossible — and that is exactly
// what the first live run asked for: 8% delivered where 53% was needed.
const body = ['Перший пункт про щось важливе', 'Другий пункт про інше', 'Третій пункт',
              'Четвертий пункт', 'П’ятий пункт', 'Шостий пункт'].join('\n')
const deep    = shortenPrompt(body, 53)
const shallow = shortenPrompt(body, 15)
const promptOk = deep.includes('ПРИБРАТИ найменш важливі пункти')
  && !shallow.includes('ПРИБРАТИ найменш важливі пункти')
  && shallow.includes('скільки рядків було, стільки має лишитись')
if (!promptOk) failed++
console.log(`${promptOk ? 'PASS' : 'FAIL'}  глибокий зріз дозволяє викидати пункти, дрібний — ні`)
console.log(`      53%: ${deep.includes('ПРИБРАТИ') ? 'можна викидати' : 'НЕ можна — помилка'}; 15%: ${shallow.includes('ПРИБРАТИ') ? 'можна — помилка' : 'структура зберігається'}`)

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
