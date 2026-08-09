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
    name: 'переказало кожен пункт коротше — усі на місці',
    original: 'Перший напрямок — аналітика ринку\nДругий напрямок — робота з партнерами Rozetka та Comfy\nТретій напрямок — маркетинг і залучення',
    shortened: 'Аналітика ринку\nПартнери Rozetka та Comfy\nМаркетинг і залучення',
    target: 40,
    expectOk: true,
  },
  {
    name: 'ВИКИНУЛО ПУНКТ — має відхилити',
    original: 'Репутація\nTop of mind employer brand серед студентів\nСтворення ефекту word of mouth\nЕкосистема бренд-амбасадорів',
    shortened: 'Репутація\nTop of mind серед студентів\nЕкосистема амбасадорів',
    target: 40,
    expectOk: false,
    expectMentions: 'змінилась кількість пунктів',
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
    expectMentions: 'змінилась кількість пунктів',
  },
  {
    name: 'ВИПОТРОШИЛО ОДИН РЯДОК заради інших — має відхилити',
    original: 'Студенти\nFast-track у компанію, куди складно потрапити\nБудуй бізнес, а не заповнюй таблиці',
    shortened: 'Студенти\nFast-track у компанію\nБудуй бізнес, не таблиці',
    target: 30,
    expectOk: false,
    expectMentions: 'рядок зрізано на',
  },
  {
    name: 'РЯДОК СТАВ ДОВШИМ — має відхилити',
    original: 'Цільові спеціальності\nВідбір, тестування\nУчасть у реальних кейсах (лімітоване залучення)',
    shortened: 'Цільові спеціальності\nВідбір і тестування\nУчасть у кейсах',
    target: 20,
    expectOk: false,
    expectMentions: 'рядок став довшим',
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
  'Аналітика ринку і збір усіх даних\nРобота з нашими партнерами\nМаркетинг і залучення людей',
  '1. Аналітика і збір даних\n2. Робота з партнерами\n3. Маркетинг і залучення',
  20,
)
const enumOk = numbered.ok
if (!enumOk) failed++
console.log(`${enumOk ? 'PASS' : 'FAIL'}  нумерація списку не рахується вигаданими числами`)
console.log(`      ${numbered.ok ? 'прийнято' : `відхилено: ${numbered.problems.join('; ')}`}`)

// The prompt must fix the item count and permit rephrasing. The reverse — forbid rephrasing,
// permit deletion — is what removed real points from a real deck.
const body = ['Перший пункт про щось важливе', 'Другий пункт про інше', 'Третій пункт',
              'Четвертий пункт', 'П’ятий пункт', 'Шостий пункт'].join('\n')
const deep = shortenPrompt(body, 53)
const promptOk = deep.includes('рядків має лишитись рівно 6')
  && deep.includes('Перефразуй кожен пункт коротше')
  && deep.includes('Скорочуй ВСІ рядки приблизно однаково')
  && deep.includes('Перелік через кому всередині рядка')
  && !deep.toLowerCase().includes('прибрати найменш важливі')
if (!promptOk) failed++
console.log(`${promptOk ? 'PASS' : 'FAIL'}  промпт фіксує кількість пунктів і дозволяє перефразувати`)
console.log(`      кількість зафіксована: ${deep.includes('рядків має лишитись рівно 6')}; перефразування дозволено: ${deep.includes('Перефразуй кожен пункт коротше')}`)

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
