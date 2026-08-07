import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google } from 'googleapis'
import { createMasterDeck } from '@/lib/master'

// Thin wrapper. The template builder itself lives in lib/master.ts so the generator can
// call it too: an app-built template is covered by the narrow drive.file scope, while a
// shared one has to be readable — which is what forces broad Drive access on every user,
// and what made every new account hit "File not found" until someone shared it by hand.
function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

export async function POST() {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const presentationId = await createMasterDeck(getOAuth2Client(session.accessToken))
    return NextResponse.json({
      presentationId,
      url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[create-master]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
