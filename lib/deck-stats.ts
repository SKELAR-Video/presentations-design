import { google } from 'googleapis'
import { readServiceCredentials } from './stats'

// ─── Лічильник деків Клод Дизайну ─────────────────────────────────────────────
// Інший продукт, та сама таблиця — окрема вкладка. Чому взагалі тут: Клод Дизайн
// не вміє писати нікуди (GitHub у нього read-only), тому ввімкнути облік на його
// боці неможливо. Єдина дія, яку він виконує САМ перед кожним деком, — читає
// правила з мережі. Отже лічильником стає саме це читання: правила віддає наш
// ендпоінт, і кожна генерація лишає по собі рядок без жодної дії людини.
//
// Попередній облік будувався на тому, що людина перенесе рядок-слід із нотаток
// дека в журнал руками. За два місяці — жодного запису при десятках реальних
// деків. Звідси правило, яке тут і реалізоване: облік не може залежати від того,
// що хтось не забуде.

const TAB = 'Клод Дизайн'
const SHEETS_SCOPE = ['https://www.googleapis.com/auth/spreadsheets']

export const DECK_HEADER = [
  'Дата', 'Подія', 'Тіма', 'Версія правил', 'Дек', 'Файл', 'Джерело',
]

function sheetTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export type DeckEvent = {
  event: string        // deck | sync | інше, що передали
  team?: string
  rulesVersion?: string
  deck?: string
  file: string         // який файл правил читали
  source?: string      // user-agent, щоб відрізнити Клод Дизайн від браузера
}

// Ніколи не кидає. Правила мають доїхати до генерації навіть тоді, коли
// бухгалтерія лягла: дек дорожчий за рядок у таблиці.
export async function logDeckEvent(ev: DeckEvent): Promise<void> {
  const sheetId = process.env.USAGE_SHEET_ID
  if (!sheetId) return
  const creds = readServiceCredentials()
  if (!creds.ok) { console.warn(`[deck-stats] ${creds.reason}`); return }

  try {
    const sheets = google.sheets({
      version: 'v4',
      auth: new google.auth.GoogleAuth({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        credentials: creds.credentials as any,
        scopes: SHEETS_SCOPE,
      }),
    })

    // Вкладки може не бути: append у неіснуючий аркуш — це помилка, а не
    // створення. Тому перший запис її заводить разом із шапкою.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const exists = meta.data.sheets?.some(s => s.properties?.title === TAB)
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
      })
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `'${TAB}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [DECK_HEADER] },
      })
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${TAB}'!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          sheetTimestamp(),
          ev.event,
          ev.team ?? '',
          ev.rulesVersion ?? '',
          ev.deck ?? '',
          ev.file,
          ev.source ?? '',
        ]],
      },
    })
    console.log(`[deck-stats] ${ev.event} · ${ev.team ?? '—'} · ${ev.file}`)
  } catch (e) {
    console.warn(`[deck-stats] не вдалося записати рядок: ${e instanceof Error ? e.message : String(e)}`)
  }
}
