import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google } from 'googleapis'
import { readServiceCredentials } from '@/lib/stats'

// Why this exists: logging is deliberately silent — a bookkeeping row must never break a
// generation — so when nothing appears in the sheet there is nothing to look at either.
// The failure could be the API not enabled, the sheet not shared with the robot, a wrong
// id, or a key in an unexpected format, and from the outside they are indistinguishable.
// This walks the same path the logger takes and says which step failed, in the same words
// the person setting it up would use.
export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const steps: { step: string; ok: boolean; detail?: string }[] = []
  const sheetId = process.env.USAGE_SHEET_ID

  steps.push({
    step: 'USAGE_SHEET_ID заданий',
    ok: !!sheetId,
    detail: sheetId ? `${sheetId.slice(0, 8)}…` : 'змінна відсутня у Vercel',
  })

  const creds = readServiceCredentials()
  steps.push({
    step: 'ключ сервіс-акаунта читається',
    ok: creds.ok,
    detail: creds.ok ? `робот: ${creds.email}` : creds.reason,
  })

  if (sheetId && creds.ok) {
    try {
      const sheets = google.sheets({
        version: 'v4',
        auth: new google.auth.GoogleAuth({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          credentials: creds.credentials as any,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        }),
      })
      const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
      steps.push({ step: 'таблиця доступна роботу', ok: true, detail: `назва: «${meta.data.properties?.title ?? '—'}»` })

      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'A1',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[new Date().toISOString(), 'ПЕРЕВІРКА', 'тестовий рядок — можна видалити']] },
      })
      steps.push({ step: 'запис у таблицю', ok: true, detail: 'додано тестовий рядок' })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      let hint = msg
      if (/has not been used|is disabled/i.test(msg)) {
        hint = 'Sheets API не увімкнений у проєкті Google Cloud. Увімкніть: console.cloud.google.com/apis/library/sheets.googleapis.com'
      } else if (/permission|forbidden|403/i.test(msg)) {
        hint = `Таблиця не розшарена на робота (${creds.email}) з правом Editor`
      } else if (/not found|404/i.test(msg)) {
        hint = 'USAGE_SHEET_ID вказує на неіснуючу таблицю — перевірте, що взяли частину адреси між /d/ та /edit'
      }
      steps.push({ step: 'доступ до таблиці', ok: false, detail: hint })
    }
  }

  // Spelled out because a browser opening this URL directly guesses the encoding otherwise,
  // and guesses Latin-1 — which turns every Ukrainian word in these messages into mojibake.
  // The messages are the entire point of the endpoint.
  return NextResponse.json(
    { ok: steps.every(s => s.ok), steps },
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  )
}
