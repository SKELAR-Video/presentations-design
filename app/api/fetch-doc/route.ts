import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google, docs_v1, slides_v1 } from 'googleapis'

type SourceType = 'gdoc' | 'gslides'

function parseUrl(input: string): { id: string; type: SourceType } | null {
  const s = input.trim()
  const slidesMatch = s.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/)
  if (slidesMatch) return { id: slidesMatch[1], type: 'gslides' }

  const docMatch =
    s.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/) ??
    s.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) ??
    s.match(/^([a-zA-Z0-9_-]{25,})$/)
  if (docMatch) return { id: docMatch[1], type: 'gdoc' }

  return null
}

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

export type SourceSlide = { index: number; texts: string[] }

// Recursively extract text from page elements, including grouped elements
function extractElementText(el: slides_v1.Schema$PageElement): string {
  if (el.elementGroup?.children?.length) {
    return el.elementGroup.children
      .map(extractElementText)
      .filter(Boolean)
      .join('\n')
  }
  return (el.shape?.text?.textElements ?? [])
    .map(te => te.textRun?.content ?? '')
    .join('')
    .trim()
}

async function extractSlides(
  auth2: ReturnType<typeof getOAuth2Client>,
  id: string,
): Promise<SourceSlide[]> {
  const slidesApi = google.slides({ version: 'v1', auth: auth2 })
  const res = await slidesApi.presentations.get({ presentationId: id })
  return (res.data.slides ?? []).map((slide, i) => ({
    index: i,
    texts: (slide.pageElements ?? [])
      .map(extractElementText)
      .filter(Boolean),
  }))
}

// Extract plain text from a Google Docs structural element tree
function readDocContent(content: docs_v1.Schema$StructuralElement[]): string {
  return content.map(el => {
    if (el.paragraph) {
      return (el.paragraph.elements ?? [])
        .map(pe => pe.textRun?.content ?? '')
        .join('')
    }
    if (el.table) {
      return (el.table.tableRows ?? []).map(row =>
        (row.tableCells ?? []).map(cell =>
          readDocContent(cell.content ?? [])
        ).join('\t')
      ).join('\n')
    }
    if (el.sectionBreak) return '\n'
    return ''
  }).join('')
}

async function fetchGoogleDocText(
  auth2: ReturnType<typeof getOAuth2Client>,
  fileId: string,
): Promise<string> {
  // Primary: Drive export — fast, no extra API scope needed
  try {
    const drive = google.drive({ version: 'v3', auth: auth2 })
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' },
    )
    return typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data)
  } catch {
    // Fallback: Google Docs API — handles cases where Drive export returns fileNotExportable.
    // Requires "Google Docs API" to be enabled in Google Cloud Console.
    try {
      const docsApi = google.docs({ version: 'v1', auth: auth2 })
      const res = await docsApi.documents.get({ documentId: fileId })
      const body = res.data.body?.content ?? []
      return readDocContent(body).trim()
    } catch (docsErr) {
      const msg = docsErr instanceof Error ? docsErr.message : String(docsErr)
      if (msg.includes('has not been used') || msg.includes('is disabled')) {
        throw new Error('Увімкни Google Docs API у Google Cloud Console: https://console.developers.google.com/apis/api/docs.googleapis.com/overview')
      }
      if (msg.includes('Office file') || msg.includes('not supported for this document')) {
        throw new Error('Документ у форматі Office (.docx). Відкрий його в Google Docs → Файл → Зберегти як Google Docs — і вставте посилання на новий файл.')
      }
      throw docsErr
    }
  }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accessToken = session.accessToken
  if (!accessToken) return NextResponse.json({ error: 'No Google access token' }, { status: 401 })

  const { url } = await req.json() as { url: string }
  const parsed = parseUrl(url)
  if (!parsed) {
    return NextResponse.json(
      { error: 'Не вдалося розпізнати посилання. Вставте посилання на Google Doc або Google Slides.' },
      { status: 400 },
    )
  }

  try {
    const auth2 = getOAuth2Client(accessToken)
    let text = ''

    if (parsed.type === 'gslides') {
      const slides = await extractSlides(auth2, parsed.id)
      const text = slides.map(s => s.texts.join('\n')).join('\n')
      if (!text.trim()) {
        return NextResponse.json({ error: 'Презентація порожня або недоступна' }, { status: 400 })
      }
      return NextResponse.json({ text: text.trim(), type: 'gslides', slides })
    } else {
      text = await fetchGoogleDocText(auth2, parsed.id)
    }

    if (!text?.trim()) {
      return NextResponse.json({ error: 'Документ порожній або недоступний' }, { status: 400 })
    }

    return NextResponse.json({ text: text.trim(), type: parsed.type })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: `Не вдалося отримати документ: ${msg}` },
      { status: 500 },
    )
  }
}
