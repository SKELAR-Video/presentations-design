import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { readServiceCredentials } from '@/lib/stats'

// Зведення по деках Клод Дизайну — щоб статистику можна було подивитись
// звідки завгодно, а не тільки відкривши таблицю очима.
//
// Публічний і БЕЗ сесії навмисно, тому віддає лише агреговані числа: скільки
// деків, по тімах, по версіях правил, по місяцях. Назв деків, пошт і посилань
// тут немає — інакше внутрішні назви відкрились би назовні заради зручності
// підрахунку. Хто хоче подробиць — відкриває таблицю.

const TAB = 'Клод Дизайн'
const SHEETS_SCOPE = ['https://www.googleapis.com/auth/spreadsheets.readonly']

export async function GET() {
  const sheetId = process.env.USAGE_SHEET_ID
  if (!sheetId) return NextResponse.json({ error: 'USAGE_SHEET_ID не заданий' }, { status: 503 })
  const creds = readServiceCredentials()
  if (!creds.ok) return NextResponse.json({ error: creds.reason }, { status: 503 })

  try {
    const sheets = google.sheets({
      version: 'v4',
      auth: new google.auth.GoogleAuth({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        credentials: creds.credentials as any,
        scopes: SHEETS_SCOPE,
      }),
    })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${TAB}'!A2:G`,
    })
    const rows = res.data.values ?? []

    // Генерація — це подія 'deck'. Решта (sync, read, test) рахується окремо:
    // синк читає ті самі файли, і змішати їх означало б показати вдесятеро
    // більше деків, ніж було насправді.
    const count = (pred: (r: string[]) => boolean) => rows.filter(pred).length
    const by = (pred: (r: string[]) => boolean, col: number) => {
      const m: Record<string, number> = {}
      rows.filter(pred).forEach(r => { const k = r[col] || '—'; m[k] = (m[k] ?? 0) + 1 })
      return m
    }
    const isDeck = (r: string[]) => r[1] === 'deck'

    return NextResponse.json({
      деків: count(isDeck),
      поТімах: by(isDeck, 2),
      поВерсіях: by(isDeck, 3),
      поМісяцях: (() => {
        const m: Record<string, number> = {}
        rows.filter(isDeck).forEach(r => { const k = (r[0] || '').slice(0, 7); m[k] = (m[k] ?? 0) + 1 })
        return m
      })(),
      іншіПодії: by(r => !isDeck(r), 1),
      рядківУсього: rows.length,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const hint = /Unable to parse range|not found/i.test(msg)
      ? `вкладки «${TAB}» ще немає — жодного запису не було`
      : msg
    return NextResponse.json({ error: hint }, { status: 502 })
  }
}
