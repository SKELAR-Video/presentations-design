import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google } from 'googleapis'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const deckId = searchParams.get('deckId')
  if (!deckId) return NextResponse.json({ error: 'Missing deckId' }, { status: 400 })

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: session.accessToken })
  const slidesApi = google.slides({ version: 'v1', auth: oauth2 })

  const pres = await slidesApi.presentations.get({
    presentationId: deckId,
    fields: 'slides.objectId',
  })
  const slides = pres.data.slides ?? []

  const thumbnails = await Promise.all(
    slides.map(async (slide, index) => {
      const thumb = await slidesApi.presentations.pages.getThumbnail({
        presentationId: deckId,
        pageObjectId: slide.objectId!,
        'thumbnailProperties.thumbnailSize': 'MEDIUM',
        'thumbnailProperties.mimeType': 'PNG',
      })
      return { index, pageId: slide.objectId!, imageUrl: thumb.data.contentUrl ?? '' }
    })
  )

  return NextResponse.json({ thumbnails })
}
