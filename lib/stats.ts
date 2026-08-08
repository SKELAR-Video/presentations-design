import { google } from 'googleapis'

// ─── Usage log ────────────────────────────────────────────────────────────────
// One row per generated deck, in ONE spreadsheet, whoever generated it.
//
// Why a service account and not the user's own token: the app now holds drive.file, which
// can only write to files the app created — for a user, that means a table in THEIR Drive.
// Fine for them, useless for the question being asked here ("how much does the tool spend
// in total"), which needs every generation landing in the same place. A service account is
// a separate identity that does not depend on who signed in, so it can.
//
// The users' own permissions are untouched by this: nothing here runs on their token, and
// the spreadsheet is not in their Drive. They neither see the log nor grant anything for it.
//
// Setup, once:
//   1. create a blank spreadsheet in the owner's Drive
//   2. share it with the service account's email (Editor)
//   3. put its id in USAGE_SHEET_ID
// Unset id = logging off. Deliberately: a tool that refuses to generate because a
// bookkeeping row failed would be trading the product for the paperwork.

const HEADER = [
  'Дата', 'Користувач', 'Бриф', 'Презентація',
  'Токени вхід', 'Токени вихід', 'Викликів моделі', 'Слайдів',
]

// Only what writing rows to one known sheet requires. The service account helper that
// already existed in lib/google.ts asks for full drive + presentations, which is far more
// than a log needs and was never wired to anything.
const SHEETS_SCOPE = ['https://www.googleapis.com/auth/spreadsheets']

// Accepts the key either base64-encoded or as plain JSON. The helper this replaces assumed
// base64, but it was dead code — nothing ever called it — so the assumption was never once
// tested against the value actually sitting in the deployment. Trying both costs a line and
// removes a whole class of silent failure.
export function readServiceCredentials(): { ok: true; email: string; credentials: unknown } | { ok: false; reason: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!raw) return { ok: false, reason: 'GOOGLE_SERVICE_ACCOUNT_KEY не заданий' }

  const attempts: string[] = [raw.trim()]
  try { attempts.push(Buffer.from(raw.trim(), 'base64').toString('utf-8')) } catch { /* not base64 */ }

  for (const text of attempts) {
    try {
      const parsed = JSON.parse(text) as { client_email?: string }
      if (parsed.client_email) return { ok: true, email: parsed.client_email, credentials: parsed }
    } catch { /* try the next form */ }
  }
  return { ok: false, reason: 'GOOGLE_SERVICE_ACCOUNT_KEY не є ні JSON, ні base64 від JSON (або в ньому немає client_email)' }
}

function serviceAuth(): InstanceType<typeof google.auth.GoogleAuth> | null {
  const creds = readServiceCredentials()
  if (!creds.ok) {
    console.warn(`[stats] ${creds.reason}`)
    return null
  }
  return new google.auth.GoogleAuth({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentials: creds.credentials as any,
    scopes: SHEETS_SCOPE,
  })
}

export type UsageRow = {
  userEmail?: string
  briefName?: string
  deckUrl: string
  inputTokens: number
  outputTokens: number
  calls: number
  slideCount: number
}

// Never throws. A deck that generated is worth more than a row that did not.
export async function logGeneration(row: UsageRow): Promise<void> {
  const sheetId = process.env.USAGE_SHEET_ID
  if (!sheetId) return
  const auth = serviceAuth()
  if (!auth) return

  try {
    const sheets = google.sheets({ version: 'v4', auth })

    // Write the header once, on the first row ever appended, so a freshly created blank
    // sheet is readable without anyone having to set it up by hand.
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A1:A1',
    })
    if (!existing.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'A1',
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER] },
      })
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'A1',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          new Date().toISOString(),
          row.userEmail ?? '',
          row.briefName ?? '',
          row.deckUrl,
          row.inputTokens,
          row.outputTokens,
          row.calls,
          row.slideCount,
        ]],
      },
    })
    console.log(`[stats] logged: in=${row.inputTokens} out=${row.outputTokens} slides=${row.slideCount}`)
  } catch (e) {
    console.warn(`[stats] не вдалося записати рядок: ${e instanceof Error ? e.message : String(e)}`)
  }
}
