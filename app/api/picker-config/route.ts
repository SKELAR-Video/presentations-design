import { NextResponse } from 'next/server'
import { auth } from '@/auth'

// The Picker has to be told which app a picked file is being granted to — without
// setAppId, Google shows the chooser, returns a file, and then refuses every read of it:
//   "The user has not granted the app <number> read access to the file <id>"
// The number it names is the Cloud project number, and that is the front half of the OAuth
// client id (<project-number>-<random>.apps.googleusercontent.com).
//
// Served from here rather than added as another NEXT_PUBLIC_ variable: the value already
// exists in the deployment, and one more thing to configure by hand is one more thing to
// get wrong. It is not a secret — it appears in the OAuth URL of every sign-in — but the
// client id it comes from is not otherwise exposed to the browser, so only the number is
// returned.
export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const appId = (process.env.GOOGLE_CLIENT_ID ?? '').split('-')[0]
  if (!/^\d+$/.test(appId)) {
    return NextResponse.json({ error: 'GOOGLE_CLIENT_ID має неочікуваний формат' }, { status: 500 })
  }
  return NextResponse.json({ appId })
}
