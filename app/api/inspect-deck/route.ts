import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google } from 'googleapis'
import type { slides_v1 } from 'googleapis'

const FPX = 9144000 / 1920

function toFpx(emu: number | null | undefined): number {
  return Math.round((emu ?? 0) / FPX)
}
function renderedPx(magnitude: number | null | undefined, scale: number | null | undefined): number {
  return toFpx((magnitude ?? 0) * (scale ?? 1))
}

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

function getSlideNotes(slide: slides_v1.Schema$Page): string {
  return (slide.slideProperties?.notesPage?.pageElements ?? [])
    .map(el => (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join(''))
    .join('')
}

function normalizeText(s: string): string {
  return s
    .replace(/ /g, ' ')   // NBSP → space
    .replace(/’/g, "'")   // curly apostrophe
    .replace(/\.$/,    '')     // trailing period
    .trim()
    .toLowerCase()
}

type SlotCheck = {
  name: string
  expected: string
  status: 'found' | 'missing' | 'empty'
}

type ContentCheck = {
  composition: string
  slots: SlotCheck[]
  pass: boolean
}

// Per-paragraph spacing facts. The "one canvas of text" defect is invisible in `text`
// and `paragraphs` alone: a list joined with \v is ONE paragraph, so the gap between two
// items is produced by the same lineSpacing as the wrap inside a single sentence. Only
// paragraph COUNT + the actual lineSpacing/spaceBelow written to the file can tell the
// two apart, so both are reported here rather than inferred from the code.
type ParagraphFact = {
  index: number
  text: string
  chars: number
  soft_breaks: number          // \v inside this paragraph = item breaks that are NOT paragraphs
  fontSize_pt: number | null
  lineSpacing_pct: number | null
  spaceAbove_pt: number | null
  spaceBelow_pt: number | null
}

type ShapeInfo = {
  objectId: string
  shapeType: string
  x: number
  y: number
  w: number
  h: number
  text: string
  fontSize_pt: number | null
  all_fontSizes_pt: number[]
  paragraphs: string[]
  paragraph_count: number
  paragraph_facts: ParagraphFact[]
}

// Slides returns textElements as a flat list: a paragraphMarker opens each paragraph
// (carrying its ParagraphStyle), the textRuns after it are that paragraph's content.
function readParagraphFacts(
  textElements: Array<Record<string, any>>,
): ParagraphFact[] {
  const facts: ParagraphFact[] = []
  let cur: ParagraphFact | null = null

  for (const te of textElements) {
    if (te.paragraphMarker) {
      const st = te.paragraphMarker.style ?? {}
      cur = {
        index: facts.length,
        text: '',
        chars: 0,
        soft_breaks: 0,
        fontSize_pt: null,
        lineSpacing_pct: st.lineSpacing ?? null,
        spaceAbove_pt: st.spaceAbove?.magnitude ?? null,
        spaceBelow_pt: st.spaceBelow?.magnitude ?? null,
      }
      facts.push(cur)
      continue
    }
    const content: string = te.textRun?.content ?? te.autoText?.content ?? ''
    if (!content || !cur) continue
    cur.text += content
    // Per-paragraph size: "the box has 20pt and 14pt somewhere in it" cannot answer
    // "is the FIRST line the big one", which is the whole question when deciding
    // whether the source marked a line as a heading.
    const pt = te.textRun?.style?.fontSize?.magnitude
    if (pt) cur.fontSize_pt = Math.max(cur.fontSize_pt ?? 0, pt)
  }

  for (const f of facts) {
    f.soft_breaks = (f.text.match(/\v/g) ?? []).length
    f.text = f.text.replace(/\n$/, '')
    f.chars = f.text.length
  }
  return facts.filter(f => f.text.trim() || f.soft_breaks > 0)
}

type SlideInfo = {
  slideIndex: number
  pageObjectId: string
  notes: string
  shapeCount: number
  textBoxes: ShapeInfo[]
  content_check: ContentCheck | null
}

function parseSlotPlan(notes: string): { composition: string; slots: Record<string, string> } | null {
  const marker = '##SLOTS##\n'
  const idx = notes.indexOf(marker)
  if (idx < 0) return null
  const jsonStart = idx + marker.length
  const jsonEnd = notes.indexOf('\n', jsonStart)
  const raw = jsonEnd >= 0 ? notes.slice(jsonStart, jsonEnd) : notes.slice(jsonStart)
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function buildContentCheck(
  plan: { composition: string; slots: Record<string, string> },
  textBoxes: ShapeInfo[],
): ContentCheck {
  const allText = textBoxes.map(tb => normalizeText(tb.text)).join('\n')

  const slots: SlotCheck[] = Object.entries(plan.slots).map(([name, expected]) => {
    if (!expected || !expected.trim()) return { name, expected, status: 'empty' as const }
    const norm = normalizeText(expected)
    const found = norm.length > 0 && allText.includes(norm)
    return { name, expected, status: found ? 'found' as const : 'missing' as const }
  })

  const pass = slots.every(s => s.status !== 'missing')
  return { composition: plan.composition, slots, pass }
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const presentationId = searchParams.get('id')
  if (!presentationId) {
    return NextResponse.json(
      { error: 'Missing ?id=<presentationId> query param' },
      { status: 400 },
    )
  }

  const auth2 = getOAuth2Client(session.accessToken)
  const slidesApi = google.slides({ version: 'v1', auth: auth2 })

  const pres = await slidesApi.presentations.get({ presentationId })
  const slides = pres.data.slides ?? []

  const result: SlideInfo[] = slides.map((slide, slideIndex) => {
    const notes = getSlideNotes(slide)
    const textBoxes: ShapeInfo[] = []

    // Grouped elements are still elements: a designer's Ctrl+G hid whole columns from
    // this report (and from anything built on it), which is why a brief's column
    // formatting could not be inspected at all. Children carry their own transforms.
    const flatten = (els: slides_v1.Schema$PageElement[]): slides_v1.Schema$PageElement[] =>
      els.flatMap(e => (e.elementGroup?.children?.length ? flatten(e.elementGroup.children) : [e]))

    for (const el of flatten(slide.pageElements ?? [])) {
      if (!el.shape) continue
      if (!el.objectId || !el.size || !el.transform) continue

      const textElements = el.shape?.text?.textElements ?? []
      const fullText = textElements.map(te => te.textRun?.content ?? '').join('')
      const paragraphs = fullText.split('\n').filter(p => p.trim())

      const fontSizes: number[] = textElements
        .map(te => te.textRun?.style?.fontSize?.magnitude ?? null)
        .filter((n): n is number => n !== null)

      const paragraphFacts = readParagraphFacts(textElements as Array<Record<string, any>>)

      const uniqueFontSizes = [...new Set(fontSizes)]
      const firstFontSize = fontSizes[0] ?? null

      const sW  = el.size.width?.magnitude ?? 0
      const sH  = el.size.height?.magnitude ?? 0
      const scX = el.transform.scaleX ?? 1
      const scY = el.transform.scaleY ?? 1
      const txX = el.transform.translateX ?? 0
      const txY = el.transform.translateY ?? 0

      textBoxes.push({
        objectId: el.objectId,
        shapeType: el.shape?.shapeType ?? 'UNKNOWN',
        x: toFpx(txX),
        y: toFpx(txY),
        w: renderedPx(sW, scX),
        h: renderedPx(sH, scY),
        text: fullText.replace(/\n$/, ''),
        fontSize_pt: firstFontSize,
        all_fontSizes_pt: uniqueFontSizes,
        paragraphs,
        paragraph_count: paragraphFacts.length,
        paragraph_facts: paragraphFacts,
      })
    }

    const plan = parseSlotPlan(notes)
    const content_check = plan ? buildContentCheck(plan, textBoxes) : null

    return {
      slideIndex,
      pageObjectId: slide.objectId ?? '',
      notes,
      shapeCount: (slide.pageElements ?? []).length,
      textBoxes,
      content_check,
    }
  })

  const totalSlots   = result.flatMap(s => s.content_check?.slots ?? []).filter(s => s.status !== 'empty')
  const missingSlots = totalSlots.filter(s => s.status === 'missing')

  return NextResponse.json({
    presentationId,
    title: pres.data.title ?? '',
    slideCount: slides.length,
    content_summary: {
      total_slots: totalSlots.length,
      found: totalSlots.filter(s => s.status === 'found').length,
      missing: missingSlots.length,
      pass: missingSlots.length === 0,
      missing_detail: missingSlots.map(s => s.expected),
    },
    slides: result,
  })
}
