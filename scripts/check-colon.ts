import { formatTitleBodyText, findGroupHeaderRanges, findColonLabelRanges } from '../lib/google'

// "Up to and including the colon is white, the rest grey" — stated as one rule, and for a
// long time implemented as three separate copies, each reading the whole slot with a single
// indexOf. On a multi-line body that painted everything from the top of the box down to the
// first colon anywhere in it: "Медіа: охо|плення" on the KPI slide, reported three times
// across three decks before the last copy was found.
//
// One helper now, and this asserts what it produces on the exact text that kept failing.

const VT = '\v'
let failed = 0

function check(name: string, got: string[], want: string[]) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`      біле: ${got.length ? got.map(s => JSON.stringify(s)).join(', ') : '—'}`)
  if (!ok) console.log(`      ✗ очікували: ${want.map(s => JSON.stringify(s)).join(', ')}`)
}

const kpi = 'Кількість учасників, конверсії в учасників програм, конверсії в найм' + VT +
            'Медіа: охоплення, залученість, сантімент' + VT +
            'Бренд: спонтанне знання, атрибути' + VT +
            'Ефективність реферальних програм'
const body = formatTitleBodyText(kpi)
check('KPI: білі лише мітки, рядок без двокрапки не чіпається',
  findColonLabelRanges(body).map(r => body.slice(r.start, r.end)),
  ['Медіа:', 'Бренд:'])

// A line whose colon sits deep inside a sentence is punctuation, not a label.
const prose = 'Ми зробили це так, щоб усе працювало правильно і надійно: без винятків'
check('двокрапка в кінці довгого речення — не мітка',
  findColonLabelRanges(prose).map(r => prose.slice(r.start, r.end)),
  [])

// Header + list, the shape formatTitleBodyText builds from a \n-separated group.
const withHeader = formatTitleBodyText('Метрики\nМедіа: охоплення\nБренд: знання')
check('заголовок групи лишається окремим правилом',
  findGroupHeaderRanges(withHeader).map(r => withHeader.slice(r.start, r.end)),
  ['Метрики'])
check('мітки всередині того самого блоку теж знайдені',
  findColonLabelRanges(withHeader).map(r => withHeader.slice(r.start, r.end)),
  ['Медіа:', 'Бренд:'])

// ── Where the colon sits, not how far in ────────────────────────────────────
// A character bound alone cannot separate these two — they are 41 and 57 characters, so
// any threshold sacrifices one of them. Tightening it to 30 (deck 1F2YV…ft4ic) saved the
// sentence and cost the lead-in: deck 1OXp1…QAHc came back with the whole bento_right_2
// ТЕКСТ grey. Both are pinned here, by the real text off both slides.

const leadIn = 'Зручні застосунки формують щоденні звички:\nлюди відкривають улюблені сервіси десятки разів на день.\nОбрана категорія напряму впливає на утримання аудиторії.'
check('лід-ін, що закінчується двокрапкою, — білий, хоч і 41 символ',
  findColonLabelRanges(leadIn).map(r => leadIn.slice(r.start, r.end)),
  ['Зручні застосунки формують щоденні звички:'])

// The same text, with the body pulled up onto the lead-in's own line: now the colon is
// punctuation inside a running line, and the bound applies again.
const sameLine = 'Зручні застосунки формують щоденні звички: люди відкривають сервіси щодня'
check('той самий текст одним рядком — не мітка (двокрапка всередині)',
  findColonLabelRanges(sameLine).map(r => sameLine.slice(r.start, r.end)),
  [])

const shortLeadIn = 'Метрики:\nохоплення\nзалученість'
check('короткий лід-ін теж білий',
  findColonLabelRanges(shortLeadIn).map(r => shortLeadIn.slice(r.start, r.end)),
  ['Метрики:'])

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
