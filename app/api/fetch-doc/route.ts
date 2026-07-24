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

// texts[i] / columns[i] are parallel arrays (same order as the source pageElements,
// empty ones filtered out together) — texts stays pure verbatim text (unchanged
// contract: mapSlides1to1 copies source.texts[idx] verbatim into slots), columns is
// a side-channel hint for the LLM about which fragments sit visually side-by-side.
export type SourceSlide = { index: number; texts: string[]; columns: (number | null)[] }

// Recursively extract text from page elements, including grouped elements.
// Bulleted paragraphs get a "• " (nested: "  • ") prefix from paragraphMarker.bullet —
// otherwise a shape with a header line + bullet lines flattens into indistinguishable
// plain text and the LLM can't tell "group heading + its bullets" from a plain list.
function extractElementText(el: slides_v1.Schema$PageElement): string {
  if (el.elementGroup?.children?.length) {
    return el.elementGroup.children
      .map(extractElementText)
      .filter(Boolean)
      .join('\n')
  }
  const textElements = el.shape?.text?.textElements ?? []
  const paragraphs: string[] = []
  let current = ''
  let bulletLevel: number | null = null
  const flush = () => {
    const trimmed = current.replace(/\n+$/, '')
    if (trimmed) {
      paragraphs.push(bulletLevel !== null ? `${'  '.repeat(bulletLevel)}• ${trimmed}` : trimmed)
    }
    current = ''
    bulletLevel = null
  }
  for (const te of textElements) {
    if (te.paragraphMarker) {
      flush()
      bulletLevel = te.paragraphMarker.bullet?.nestingLevel ?? null
      continue
    }
    if (te.textRun?.content) current += te.textRun.content
  }
  flush()
  return paragraphs.join('\n').trim()
}

// Groups page elements by horizontal position so the LLM can see "these boxes sit
// side-by-side = columns" instead of guessing from text alone. Elements spanning most
// of the slide width (titles, full-width bodies) are excluded from clustering — their
// wide, centered bounding box would otherwise land "between" real columns when sorted
// by x and falsely split a clean 2-column layout into three groups.
// Returns one column index (or null = no clear column signal) per input element, same order.
function assignColumns(elements: slides_v1.Schema$PageElement[], slideWidthEmu: number): (number | null)[] {
  type Item = { idx: number; x: number; w: number }
  const items: Item[] = elements.map((el, idx) => {
    const w = (el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1)
    const x = (el.transform?.translateX ?? 0) + w / 2
    return { idx, x, w }
  })
  const WIDE_THRESHOLD = slideWidthEmu * 0.6
  const candidates = items.filter(it => it.w > 0 && it.w <= WIDE_THRESHOLD)
  if (candidates.length < 2) return elements.map(() => null)

  const sorted = [...candidates].sort((a, b) => a.x - b.x)
  const groups: Item[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const gap = cur.x - prev.x
    const threshold = Math.min(prev.w, cur.w) * 0.6  // real gutter is wider than this
    if (gap > threshold) groups.push([cur])
    else groups[groups.length - 1].push(cur)
  }
  if (groups.length < 2) return elements.map(() => null)  // single flow, nothing to tag

  const colByIdx = new Map<number, number>()
  groups.forEach((g, colIdx) => g.forEach(it => colByIdx.set(it.idx, colIdx)))
  return elements.map((_, idx) => colByIdx.get(idx) ?? null)
}

async function extractSlides(
  auth2: ReturnType<typeof getOAuth2Client>,
  id: string,
): Promise<SourceSlide[]> {
  const slidesApi = google.slides({ version: 'v1', auth: auth2 })
  const res = await slidesApi.presentations.get({ presentationId: id })
  const slideWidthEmu = res.data.pageSize?.width?.magnitude ?? 9144000
  return (res.data.slides ?? []).map((slide, i) => {
    const elements = slide.pageElements ?? []
    const columnByEl = assignColumns(elements, slideWidthEmu)
    const texts: string[] = []
    const columns: (number | null)[] = []
    elements.forEach((el, ei) => {
      const text = extractElementText(el)
      if (!text) return
      texts.push(text)
      columns.push(columnByEl[ei])
    })
    return { index: i, texts, columns }
  })
}

// Extract plain text from a Google Docs structural element tree.
// Section delimiters (\n___\n) are emitted for:
//   1. Horizontal rules (auto-converted from ___ by Google Docs)
//   2. Explicit page breaks (Ctrl+Enter)
//   3. HEADING_1 / HEADING_2 paragraphs (delimiter placed BEFORE heading text)
function readDocContent(content: docs_v1.Schema$StructuralElement[]): string {
  const parts: string[] = []
  for (const el of content) {
    if (el.paragraph) {
      const elements = el.paragraph.elements ?? []
      // 1. Horizontal rule
      if (elements.some(pe => pe.horizontalRule)) {
        parts.push('\n___\n')
        continue
      }
      const text = elements
        .filter(pe => !pe.pageBreak)
        .map(pe => (pe.textRun?.content ?? '').replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, ''))
        .join('')

      // 2. pageBreakBefore — Google Docs sets this on first paragraph of each new page
      if (el.paragraph.paragraphStyle?.pageBreakBefore) {
        parts.push('\n___\n' + text)
        continue
      }

      // 3. Inline page break element (older format)
      if (elements.some(pe => pe.pageBreak)) {
        if (text.trim()) parts.push(text)
        parts.push('\n___\n')
        continue
      }

      // 4. Heading style — delimiter BEFORE heading text
      const style = el.paragraph.paragraphStyle?.namedStyleType ?? ''
      if (style === 'HEADING_1' || style === 'HEADING_2') {
        parts.push('\n___\n' + text)
        continue
      }
      parts.push(text)
      continue
    }
    if (el.table) {
      const tableText = (el.table.tableRows ?? []).map(row =>
        (row.tableCells ?? []).map(cell =>
          readDocContent(cell.content ?? [])
        ).join('\t')
      ).join('\n')
      parts.push(tableText)
      continue
    }
    if (el.sectionBreak) {
      parts.push('\n')
      continue
    }
  }
  return parts.join('')
}

async function fetchGoogleDocText(
  auth2: ReturnType<typeof getOAuth2Client>,
  fileId: string,
): Promise<string> {
  // Primary: Docs API — preserves structure (horizontal rules → ___), requires drive scope.
  try {
    const docsApi = google.docs({ version: 'v1', auth: auth2 })
    const res = await docsApi.documents.get({ documentId: fileId })
    const body = res.data.body?.content ?? []

    // Diagnostic: count structural markers BEFORE text extraction
    let diagPB = 0, diagHR = 0, diagH1 = 0, diagH2 = 0, diagPBbefore = 0
    for (const el of body) {
      if (!el.paragraph) continue
      const els = el.paragraph.elements ?? []
      if (els.some(pe => pe.pageBreak))  diagPB++
      if (els.some(pe => pe.horizontalRule)) diagHR++
      const style = el.paragraph.paragraphStyle?.namedStyleType ?? ''
      if (style === 'HEADING_1') diagH1++
      if (style === 'HEADING_2') diagH2++
      if (el.paragraph.paragraphStyle?.pageBreakBefore) diagPBbefore++
    }
    console.log(`[fetch-doc] doc structure: pageBreak=${diagPB} pageBreakBefore=${diagPBbefore} HR=${diagHR} H1=${diagH1} H2=${diagH2} totalParagraphs=${body.filter(e => e.paragraph).length}`)

    const text = readDocContent(body).trim()
    if (text) {
      const delimCount = (text.match(/___/g) ?? []).length
      console.log(`[fetch-doc] docsApi ok  len=${text.length}  delimiters=${delimCount}`)
      return text
    }
  } catch (docsErr) {
    const msg = docsErr instanceof Error ? docsErr.message : String(docsErr)
    if (msg.includes('has not been used') || msg.includes('is disabled')) {
      throw new Error('Увімкни Google Docs API у Google Cloud Console: https://console.developers.google.com/apis/api/docs.googleapis.com/overview')
    }
    if (msg.includes('Office file') || msg.includes('not supported for this document')) {
      throw new Error('Документ у форматі Office (.docx). Відкрий його в Google Docs → Файл → Зберегти як Google Docs — і вставте посилання на новий файл.')
    }
    console.warn('[fetch-doc] docsApi failed, falling back to Drive export:', msg)
  }
  // Fallback: Drive export — no structural info (horizontal rules lost), but handles edge cases.
  const drive = google.drive({ version: 'v3', auth: auth2 })
  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' },
  )
  const text = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data)
  console.log(`[fetch-doc] drive export fallback  len=${text.length}  ___=${text.includes('___')}`)
  return text
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
