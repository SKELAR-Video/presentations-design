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
export type SourceSlide = {
  index: number
  texts: string[]
  columns: (number | null)[]
  // true for a fragment that sits full-width between the title and the columns — the
  // brief's own way of writing a slide subtitle. Without this signal it reads exactly
  // like a column label and lands in ПІДПИС_N, which is how "Викладачі, голови
  // студпарламентів" ended up captioning a column instead of the slide.
  subtitles: boolean[]
  // true when the SOURCE itself marks this block's first line as a heading — a larger
  // font (or bold) than the lines under it. Whether a line is a marker is the author's
  // decision, written into the brief; guessing it from length made "Підтримка проявів
  // бренду" a heading in a list where every line is an item.
  markers: boolean[]
}

// Recursively extracts a shape's text as one or more BLOCKS. Bulleted paragraphs get a
// "• " (nested: "  • ") prefix from paragraphMarker.bullet — otherwise a header line +
// bullet lines flattens into indistinguishable plain text and the LLM can't tell "group
// heading + its bullets" from a plain list.
//
// A blank paragraph inside the shape (an empty line the author typed to visually
// separate two named groups within ONE text box — e.g. "Залучення талантів\n...\n\n
// Репутація\n...") splits the shape into multiple blocks. mapSlides1to1 assigns whole
// fragments to slots, so without this split a two-group single-shape slide could only
// ever become one flat title_body ТЕКСТ — there was no way to hand КОЛОНКА_1/КОЛОНКА_2
// two DIFFERENT fragments when they both lived inside one shape. A single leading/
// trailing blank line (common Slides artifact) does not produce an extra empty block.
// Matches an icon font family (Material Symbols/Icons) Slides uses when someone types a
// name like "verified" with an icon font applied to render it as a small glyph —
// visually an icon in the source, but the API returns its literal text content like any
// other run. Checked against the RUN'S ACTUAL FONT, not the text's shape — an earlier
// version guessed from content shape (single all-lowercase-ASCII word) and wrongly
// deleted real content that happened to look the same way (an "apndx" section title).
const ICON_FONT_RE = /material\s*(icons|symbols)/i

function isIconFontRun(te: slides_v1.Schema$TextElement): boolean {
  const style = te.textRun?.style
  const family = style?.weightedFontFamily?.fontFamily ?? style?.fontFamily ?? ''
  return ICON_FONT_RE.test(family)
}

// A grouped element is a DESIGN grouping, not a content one: three columns a designer
// selected and hit Ctrl+G are still three columns. Merging their text into one block
// destroyed that before the LLM ever saw the slide — brief sheet "Цільові групи" arrived
// as a single 12-line blob and could only be rendered as one column instead of three.
// Groups are flattened into their leaves by flattenElements() below, so this function
// only ever sees a leaf; the branch stays as a guard for a group that reaches it anyway.
function extractElementBlocks(el: slides_v1.Schema$PageElement): string[] {
  if (el.elementGroup?.children?.length) {
    return el.elementGroup.children.flatMap(extractElementBlocks).filter(Boolean)
  }
  const textElements = el.shape?.text?.textElements ?? []
  const lines: (string | null)[] = []  // null = blank paragraph (block separator)
  let current = ''
  let bulletLevel: number | null = null
  const flush = () => {
    const trimmed = current.replace(/\n+$/, '')
    lines.push(trimmed ? (bulletLevel !== null ? `${'  '.repeat(bulletLevel)}• ${trimmed}` : trimmed) : null)
    current = ''
    bulletLevel = null
  }
  for (const te of textElements) {
    if (te.paragraphMarker) {
      flush()
      bulletLevel = te.paragraphMarker.bullet?.nestingLevel ?? null
      continue
    }
    if (isIconFontRun(te)) continue  // decorative icon glyph — skip this run's content
    if (te.textRun?.content) current += te.textRun.content
  }
  flush()

  const blocks: string[] = []
  let block: string[] = []
  for (const line of lines) {
    if (line === null) {
      if (block.length) { blocks.push(block.join('\n')); block = [] }
    } else {
      block.push(line)
    }
  }
  if (block.length) blocks.push(block.join('\n'))
  return blocks
}

// Does this shape's first paragraph stand out from the rest — bigger, or bold where the
// rest is not? That is the brief's own way of saying "this line is the marker".
const _MARKER_PT_DELTA = 1
function hasSourceMarker(el: slides_v1.Schema$PageElement): boolean {
  const paras: Array<{ pt: number; bold: boolean; text: string }> = []
  let cur: { pt: number; bold: boolean; text: string } | null = null
  for (const te of el.shape?.text?.textElements ?? []) {
    if (te.paragraphMarker) { cur = { pt: 0, bold: false, text: '' }; paras.push(cur); continue }
    if (isIconFontRun(te)) continue   // a decorative glyph is not the line's size
    const run = te.textRun
    if (!run?.content || !cur) continue
    cur.text += run.content
    cur.pt = Math.max(cur.pt, run.style?.fontSize?.magnitude ?? 0)
    cur.bold = cur.bold || run.style?.bold === true
  }
  const filled = paras.filter(p => p.text.trim())
  if (filled.length < 2) return false
  const first = filled[0]
  const rest  = filled.slice(1)
  const restPt = Math.max(...rest.map(p => p.pt))
  if (first.pt && restPt && first.pt >= restPt + _MARKER_PT_DELTA) return true
  return first.bold && !rest.some(p => p.bold)
}

// A leaf page element with its absolute horizontal placement — groups are unwrapped, so
// three columns inside a group are three leaves standing side by side, exactly as they
// look on the slide. Child transforms are relative to their group, hence the composition.
type Leaf = { el: slides_v1.Schema$PageElement; x: number; y: number; w: number; h: number }

function flattenElements(
  elements: slides_v1.Schema$PageElement[],
  parentX = 0,
  parentY = 0,
  parentScaleX = 1,
  parentScaleY = 1,
): Leaf[] {
  const out: Leaf[] = []
  for (const el of elements) {
    const scaleX = (el.transform?.scaleX ?? 1) * parentScaleX
    const scaleY = (el.transform?.scaleY ?? 1) * parentScaleY
    const x      = parentX + (el.transform?.translateX ?? 0) * parentScaleX
    const y      = parentY + (el.transform?.translateY ?? 0) * parentScaleY
    if (el.elementGroup?.children?.length) {
      out.push(...flattenElements(el.elementGroup.children, x, y, scaleX, scaleY))
    } else {
      out.push({
        el, x, y,
        w: (el.size?.width?.magnitude  ?? 0) * scaleX,
        h: (el.size?.height?.magnitude ?? 0) * scaleY,
      })
    }
  }
  return out
}

// Which leaves are the slide's subtitle: a full-width block sitting BELOW the title and
// ABOVE the columns. That is how this brief writes a subtitle, and it is a placement
// fact, not a guess about the wording — a line like "Викладачі, голови студпарламентів"
// is indistinguishable from a column label by text alone, which is exactly where it kept
// landing. Requires real columns on the slide: without them "below the title" is just
// body text.
const SUBTITLE_MAX_CHARS = 200
function assignSubtitles(
  leaves: Leaf[],
  columnByEl: (number | null)[],
  slideWidthEmu: number,
): boolean[] {
  const withText = leaves.map((l, i) => ({ l, i })).filter(({ l }) => extractElementBlocks(l.el).join('').trim())
  const columnTops = withText.filter(({ i }) => columnByEl[i] !== null).map(({ l }) => l.y)
  if (columnTops.length < 2) return leaves.map(() => false)
  const columnTop = Math.min(...columnTops)
  const titleBottom = Math.min(...withText.map(({ l }) => l.y + l.h))  // topmost block's bottom

  const WIDE = slideWidthEmu * 0.6
  return leaves.map((leaf, i) => {
    if (columnByEl[i] !== null) return false
    if (leaf.w <= WIDE) return false                       // narrow → it is a column, not a subtitle
    if (leaf.y + leaf.h <= titleBottom) return false        // the title itself
    if (leaf.y >= columnTop) return false                   // below the columns → a footnote, not a subtitle
    return extractElementBlocks(leaf.el).join(' ').trim().length <= SUBTITLE_MAX_CHARS
  })
}

// Groups page elements by horizontal position so the LLM can see "these boxes sit
// side-by-side = columns" instead of guessing from text alone. Elements spanning most
// of the slide width (titles, full-width bodies) are excluded from clustering — their
// wide, centered bounding box would otherwise land "between" real columns when sorted
// by x and falsely split a clean 2-column layout into three groups.
// Returns one column index (or null = no clear column signal) per input element, same order.
function assignColumns(elements: Leaf[], slideWidthEmu: number): (number | null)[] {
  type Item = { idx: number; x: number; w: number }
  const items: Item[] = elements.map((leaf, idx) => ({ idx, x: leaf.x + leaf.w / 2, w: leaf.w }))
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
    const elements = flattenElements(slide.pageElements ?? [])
    const columnByEl = assignColumns(elements, slideWidthEmu)
    const subtitleByEl = assignSubtitles(elements, columnByEl, slideWidthEmu)
    const texts: string[] = []
    const columns: (number | null)[] = []
    const subtitles: boolean[] = []
    const markers: boolean[] = []
    elements.forEach((leaf, ei) => {
      const blocks = extractElementBlocks(leaf.el).filter(Boolean)
      if (!blocks.length) return
      if (blocks.length === 1) {
        texts.push(blocks[0])
        columns.push(columnByEl[ei])
        subtitles.push(subtitleByEl[ei])
        markers.push(hasSourceMarker(leaf.el))
        return
      }
      // One shape, multiple blank-line-separated blocks (e.g. two named categories
      // typed into a single text box) — expose each block as its own fragment, tagged
      // like columns so the LLM can map them to separate slots instead of one flat blob.
      blocks.forEach((block, bi) => {
        texts.push(block)
        columns.push(bi)
        subtitles.push(false)
        markers.push(false)
      })
    })
    return { index: i, texts, columns, subtitles, markers }
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
