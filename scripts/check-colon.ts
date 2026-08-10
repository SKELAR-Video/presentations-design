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

// ── Одна фраза чи вже речення ────────────────────────────────────────────────
// Обидва випадки — з реальних деків, 41 і 57 символів. Жодна символьна межа їх не
// розрізняє, тому 60 фарбувала пів речення (дек 1F2YV…ft4ic), а 30 лишала лід-ін сірим
// (дек 1NUS9…PhXgU, слот ТЕКСТ у bento_right_2). Розрізняє їх кома всередині префікса.

// Точний текст зі слайда: одним абзацом, двокрапка на 41-му символі всередині рядка.
const leadIn = 'Зручні застосунки формують щоденні звички: люди відкривають улюблені сервіси десятки разів на день. Обрана категорія напряму впливає на утримання аудиторії.'
check('лід-ін без коми — білий разом із двокрапкою, хоч і 41 символ',
  findColonLabelRanges(leadIn).map(r => leadIn.slice(r.start, r.end)),
  ['Зручні застосунки формують щоденні звички:'])

check('коротка мітка в колонці',
  findColonLabelRanges('Фінанси: банкінг, бюджет та інвестиції')
    .map(r => 'Фінанси: банкінг, бюджет та інвестиції'.slice(r.start, r.end)),
  ['Фінанси:'])

const shortLeadIn = 'Метрики:\nохоплення\nзалученість'
check('лід-ін, що закінчується рядком, теж білий',
  findColonLabelRanges(shortLeadIn).map(r => shortLeadIn.slice(r.start, r.end)),
  ['Метрики:'])

// Кома означає, що речення почалось раніше за двокрапку.
const withComma = 'Ми довго думали, і ось що вирішили: почати з малого'
check('кома перед двокрапкою — це речення, не мітка',
  findColonLabelRanges(withComma).map(r => withComma.slice(r.start, r.end)),
  [])

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
